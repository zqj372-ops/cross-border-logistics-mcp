import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createCustomsReferenceClient, customsReferenceData } from '../../services/customs-native/reference';
import { exportPKCS8, generateKeyPair } from 'jose';
import { loadPortalBusinessService } from '../../services/access-gateway/portal/business/config';
import { dataset } from './publication-fixture';
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'customs-reference-'));dirs.push(dir);const path=join(dir,'data.sqlite'),db=new DatabaseSync(path);
 const insert=(name:string,rows:Record<string,unknown>[])=>{const keys=Object.keys(rows[0]!);db.exec(`CREATE TABLE ${name} (${keys.map(k=>`"${k}" ${typeof rows[0]![k]==='number'?'INTEGER':'TEXT'}`).join(',')})`);for(const row of rows)db.prepare(`INSERT INTO ${name} VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k] as SQLInputValue));};
 insert('source_release',dataset.sources.map(s=>({...s,status:'staged'})));
 const strip=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).filter(([k])=>k==='release_id'||!k.startsWith('release_')));
 insert('nomenclature',dataset.nomenclature.map(strip));insert('tariff_rule',dataset.tariffs.map(strip));db.close();
 const config={snapshotFile:path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};return{config,client:createCustomsReferenceClient(config)};
}
const request={input:{query:'732393',ruleDate:'2026-09-27',codeCountry:'CN',attributes:{originCountry:'CN'}},actor:{type:'service' as const,id:'fixture'},requestId:'req_reference_0001'};
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
