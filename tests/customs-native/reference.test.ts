import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createCustomsReferenceClient, customsReferenceData } from '../../services/customs-native/reference';
import { exportPKCS8, generateKeyPair } from 'jose';
import { loadPortalBusinessService } from '../../services/access-gateway/portal/business/config';
import { dataset } from './publication-fixture';
import { createCustomsNameTranslator } from '../../services/customs-native/name-translation';
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(longName=false,nomenclature=dataset.nomenclature){
 const dir=mkdtempSync(join(tmpdir(),'customs-reference-'));dirs.push(dir);const path=join(dir,'data.sqlite'),db=new DatabaseSync(path);
 const insert=(name:string,rows:Record<string,unknown>[])=>{const keys=Object.keys(rows[0]!);db.exec(`CREATE TABLE ${name} (${keys.map(k=>`"${k}" ${typeof rows[0]![k]==='number'?'INTEGER':'TEXT'}`).join(',')})`);for(const row of rows)db.prepare(`INSERT INTO ${name} VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k] as SQLInputValue));};
 insert('source_release',dataset.sources.map(s=>({...s,status:'staged'})));
 const strip=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).filter(([k])=>k==='release_id'||!k.startsWith('release_')));
 insert('nomenclature',nomenclature.map(row=>strip(longName?{...row,description_original:'Synthetic long source description '.repeat(1000)}:row)));insert('tariff_rule',dataset.tariffs.map(strip));db.close();
 const config={snapshotFile:path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};return{config,client:createCustomsReferenceClient(config)};
}
const request={input:{query:'732393',ruleDate:'2026-09-27',codeCountry:'CN',attributes:{originCountry:'CN'}},actor:{type:'service' as const,id:'fixture'},requestId:'req_reference_0001'};
it('finds destination-country candidates from Chinese official names and keeps each country’s own rates and evidence',async()=>{
 const {client}=fixture();
 for(const codeCountry of ['CA','US']){
  const result=await client.query({...request,input:{...request.input,query:'保温杯',codeCountry}});
  expect(result.status).toBe('manual_review');
  const data=customsReferenceData.parse(result.data);
  expect(new Set(data.candidates.map(c=>c.item.country))).toEqual(new Set(['CN','US','CA']));
  const destination=data.candidates.find(c=>c.item.country===codeCountry)!;
  expect(destination.item.description_original).toBe('Vacuum flasks and vessels');
  expect(destination.rates.length).toBeGreaterThan(0);
  expect(destination.rates.every(rate=>rate.country===codeCountry)).toBe(true);
  expect(data.warnings.join(' ')).toContain('中文品名');
  expect(data.formal_ready).toBe(false);
 }
});
it('does not invent Chinese aliases, discard query terms, use expired anchors, or override an explicit HS selection',async()=>{
 const {client}=fixture();
 for(const query of ['不存在的中文商品','保温杯 未知条件']){
  expect(await client.query({...request,input:{...request.input,query,codeCountry:'CA'}})).toMatchObject({status:'manual_review',data:{candidates:[]}});
 }
 const english=customsReferenceData.parse((await client.query({...request,input:{...request.input,query:'Vacuum',codeCountry:'CA'}})).data);
 expect(english.candidates.map(c=>c.item.country)).toEqual(['CA']);
 const selected=customsReferenceData.parse((await client.query({...request,input:{...request.input,query:'保温杯',codeCountry:'CA',selectedHs6:'732393'}})).data);
 expect(selected.candidates.every(c=>c.item.code.startsWith('732393'))).toBe(true);
 const expired=fixture(false,dataset.nomenclature.map(row=>row.country==='CN'?{...row,effective_to:'2026-01-01'}:row));
 expect(await expired.client.query({...request,input:{...request.input,query:'保温杯',codeCountry:'CA'}})).toMatchObject({status:'manual_review',data:{candidates:[]}});
});
it('keeps unusually long official source text readable when it exceeds the translation limit',async()=>{
 const {config}=fixture(true),fetchImpl=vi.fn<typeof fetch>();
 const result=await createCustomsReferenceClient(config,createCustomsNameTranslator({apiKey:'fixture-secret',model:'fixture-model'},fetchImpl)).query(request);
 expect(result).toMatchObject({status:'manual_review',data:{formal_ready:false}});
 expect(customsReferenceData.parse(result.data).candidates[0]!.item.description_original.length).toBeGreaterThan(9_000);
 expect(fetchImpl).not.toHaveBeenCalled();
});
it('returns staged official text as reference only with original rates and evidence; unknown codes never mean free',async()=>{
 const {client}=fixture();const r=await client.query(request);
 expect(r).toMatchObject({status:'manual_review',reason_codes:['customs_reference_only'],data:{formal_ready:false}});
 const data=customsReferenceData.parse(r.data);expect(data.candidates.length).toBeGreaterThan(0);
 expect(data.candidates[0]!.item.release_status).toBe('staged');expect(data.sources[0]!.status).toBe('staged');
 expect(data).not.toHaveProperty('customsPayable');expect(data).not.toHaveProperty('confirmedTotalPercent');
 const missing=await client.query({...request,input:{...request.input,query:'000000'}});expect(missing).toMatchObject({status:'manual_review',data:{candidates:[]}});
});
it('fails closed for snapshot mutation, hash mismatch and SQL-looking search input',async()=>{
 const {client,config}=fixture();
 expect(()=>createCustomsReferenceClient({...config,sha256:'0'.repeat(64)})).toThrow('hash_mismatch');
 expect(await client.query({...request,input:{...request.input,query:"' OR 1=1 --"}})).toMatchObject({data:{candidates:[]}});
 appendFileSync(config.snapshotFile,'changed');expect(await client.query(request)).toMatchObject({status:'unavailable',data:null,reason_codes:['customs_reference_changed']});
});

it('adds bilingual display names from source text only, preserving official rows and manual-review authority',async()=>{
 const {config,client}=fixture();
 const fetchImpl=vi.fn<typeof fetch>().mockImplementation((_url,options)=>{
  const body=JSON.parse(options?.body as string) as {messages:{content:string}[]};
  const {items}=JSON.parse(body.messages[1]!.content) as {items:{id:number;text:string;target_language:string}[]};
  expect(body.messages[1]!.content).not.toContain('private customer description');
  expect(body.messages[1]!.content).not.toContain('private material');
  return Promise.resolve(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:items.map(item=>({id:item.id,text:item.target_language==='zh'?'合成品名译文':'Synthetic translated name'}))})}}]})));
 });
 const input={...request.input,query:'private customer description',selectedHs6:'732393',attributes:{originCountry:'CN',material:'private material'}};
 const raw=customsReferenceData.parse((await client.query({...request,input})).data);
 const result=await createCustomsReferenceClient(config,createCustomsNameTranslator({apiKey:'fixture-secret',model:'fixture-model'},fetchImpl)).query({...request,input});
 expect(result).toMatchObject({schema_version:'portal-customs-reference@2026-09-27.v2',status:'manual_review',data:{formal_ready:false}});
 const data=customsReferenceData.parse(result.data);
 expect(data.candidates.length).toBeGreaterThan(0);
 data.candidates.forEach((candidate,index)=>{
  expect(candidate.item).toEqual(raw.candidates[index]!.item);expect(candidate.rates).toEqual(raw.candidates[index]!.rates);
  expect(candidate.name_translation?.status).toBe('machine');
 });
 expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('uses the configured reference only for an authenticated explicit unpublished response',async()=>{
 const {config}=fixture(),dir=dirs.at(-1)!;
 const {privateKey}=await generateKeyPair('RS256',{extractable:true});
 const secret=join(dir,'secret'),key=join(dir,'key.pem'),configPath=join(dir,'business.json');
 writeFileSync(secret,'fixture-secret',{mode:0o600});writeFileSync(key,await exportPKCS8(privateKey),{mode:0o600});
 writeFileSync(configPath,JSON.stringify({publicAccess:{organizationId:'org',tenantId:'tenant',applicationId:'app',clientId:'client',enabledOperations:['customs.query']},connections:[{organizationId:'org',tenantId:'tenant',enabledOperations:['customs.query'],customsReference:config,customs:{baseUrl:'https://customs.example.invalid/',serviceCallerId:'caller',applicationId:'app',connectionSecretFile:secret,issuer:'https://issuer.example.invalid/',audience:'customs',keyId:'key',delegationPrivateKeyFile:key}}]}));
 const unpublished={contractVersion:'riskcustoms-query.v1',serviceVersion:'fixture',publishedAt:null,evaluatedAt:null,lastSourceCheckAt:null,supportedOperations:['status','query'],ruleDate:'2026-09-27',releaseIds:[],snapshotHash:null,releaseHash:null,ready:false,testData:true,reasons:['unpublished'],error:{code:'data_not_ready',message:'Unpublished'}};
 for(const [status,body,expected] of [[503,unpublished,'manual_review'],[401,unpublished,'unavailable'],[503,{error:{code:'data_not_ready'}},'unavailable']] as const){
  const service=await loadPortalBusinessService({configPath,portalService:{getState:()=>{throw new Error('no user session');},requireBusinessApplication:()=>({organizationId:'org',tenantId:'tenant',applicationId:'app',clientId:'client',environment:'production',ownerUserId:'owner'})},publicAuthority:()=>Promise.resolve(),fetchImpl:()=>Promise.resolve(new Response(JSON.stringify(body),{status}))});
  const result=await service.executePublic('customs.query',request.input,request.requestId,false);
  expect(result.status).toBe(expected);if(expected==='manual_review')expect(result.data).toMatchObject({formal_ready:false});else expect(result.data).toBeNull();
 }
});
