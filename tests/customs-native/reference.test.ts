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
function fixture(longName=false,nomenclature=dataset.nomenclature,tariffs=dataset.tariffs,sources=dataset.sources){
 const dir=mkdtempSync(join(tmpdir(),'customs-reference-'));dirs.push(dir);const path=join(dir,'data.sqlite'),db=new DatabaseSync(path);
 const insert=(name:string,rows:Record<string,unknown>[])=>{const keys=Object.keys(rows[0]!);db.exec(`CREATE TABLE ${name} (${keys.map(k=>`"${k}" ${typeof rows[0]![k]==='number'?'INTEGER':'TEXT'}`).join(',')})`);for(const row of rows)db.prepare(`INSERT INTO ${name} VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k] as SQLInputValue));};
 insert('source_release',sources.map(s=>({...s,status:'staged'})));
 const strip=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).filter(([k])=>k==='release_id'||!k.startsWith('release_')));
 insert('nomenclature',nomenclature.map(row=>strip(longName?{...row,description_original:'Synthetic long source description '.repeat(2800)}:row)));insert('tariff_rule',tariffs.map(strip));db.close();
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
 for(const query of ['不存在的中文商品','保温杯 未知条件','保温杯 '.repeat(8)+'未知条件']){
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
 expect(customsReferenceData.parse(result.data).candidates[0]!.item.description_original.length).toBeGreaterThan(50_000);
 expect(fetchImpl).not.toHaveBeenCalled();
});
it('ranks goods before mentions in components and does not match a different compound product',async()=>{
 const cn=dataset.nomenclature.find(row=>row.country==='CN')!,ca=dataset.nomenclature.find(row=>row.country==='CA')!;
 const names=[['7003190000','手机或平板电脑盖板用原板玻璃'],['8517130000','智能手机'],['8471301000','平板电脑'],['8501101000','玩具用电动机'],['9503006000','智力玩具'],['8205400000','螺丝刀'],['8524919000','专用于笔记本电脑的液晶模组']];
 const rows=names.flatMap(([code,name],i)=>[{...cn,id:i*2+1,code:code!,description_original:name!},{...ca,id:i*2+2,code:code!,description_original:'Synthetic destination goods'}]);
 const {client}=fixture(false,rows);
 for(const [query,prefix] of [['手机','851713'],['平板电脑','847130'],['玩具','950300']]){
  const data=customsReferenceData.parse((await client.query({...request,input:{...request.input,query,codeCountry:'CA'}})).data);
  expect(data.candidates.filter(c=>c.item.country==='CA').map(c=>c.item.code.slice(0,6))).toEqual([prefix]);
 }
 for(const query of ['螺丝','笔记本电脑'])expect(await client.query({...request,input:{...request.input,query,codeCountry:'CA'}})).toMatchObject({data:{candidates:[]}});
});
it('limits distinct codes before retaining both Canadian legal languages',async()=>{
 const ca=dataset.nomenclature.find(row=>row.country==='CA')!;
 const rows=Array.from({length:12},(_,i)=>['en','fr'].map((language,j)=>({...ca,id:i*2+j+1,language,code:`123456${String(i).padStart(4,'0')}`,description_original:'Synthetic goods'}))).flat();
 const {client}=fixture(false,rows);
 const data=customsReferenceData.parse((await client.query({...request,input:{...request.input,query:'123456',codeCountry:'CA'}})).data);
 expect(new Set(data.candidates.map(c=>c.item.code)).size).toBe(9);
 expect(data.candidates).toHaveLength(18);
 expect(data.candidates.every(c=>data.candidates.some(other=>other.item.code===c.item.code&&other.item.language!==c.item.language))).toBe(true);
});
it('matches whole English words and plurals without confusing screws with screwdrivers',async()=>{
 const ca=dataset.nomenclature.find(row=>row.country==='CA')!;
 const names=[['7318120000','Wood screws'],['8205400000','Screwdrivers'],['9900000000','Parts for screws']];
 const {client}=fixture(false,names.map(([code,description_original],i)=>({...ca,id:i+1,code:code!,description_original:description_original!})));
 for(const query of ['screw','screws']){
  const data=customsReferenceData.parse((await client.query({...request,input:{...request.input,query,codeCountry:'CA'}})).data);
  expect(data.candidates.map(c=>c.item.code)).toEqual(['7318120000']);
 }
});
it('matches a commodity across valid parent and child names without borrowing sibling or foreign headings',async()=>{
 const ca=dataset.nomenclature.find(row=>row.country==='CA')!;
 const names=[['6109','T-shirts, singlets and other vests, knitted or crocheted',null],['610910','Of cotton','6109'],['610990','Of other textile materials','6109'],['620910','Of cotton','6109']];
 const {client}=fixture(false,names.map(([code,description_original,parent_code],i)=>({...ca,id:i+1,code:code!,description_original:description_original!,parent_code:parent_code??null})));
 const data=customsReferenceData.parse((await client.query({...request,input:{...request.input,query:'cotton T-shirt',codeCountry:'CA'}})).data);
 expect(data.candidates.map(c=>c.item.code)).toEqual(['610910']);
});
it('ranks a destination name above other goods sharing its Chinese HS6 anchor',async()=>{
 const cn=dataset.nomenclature.find(row=>row.country==='CN')!,ca=dataset.nomenclature.find(row=>row.country==='CA')!;
 const {config}=fixture(false,[{...cn,id:1,code:'6307909000',description_original:'口罩'},...[
  ['6307903000','Furniture moving pads'],['6307909920','Face-masks'],['9999990000','Mask parts'],
 ].map(([code,name],i)=>({...ca,id:i+2,code:code!,description_original:name!}))]);
 const client=createCustomsReferenceClient(config,undefined,()=>Promise.resolve({terms:[{language:'en',text:'face masks'}]}));
 const data=customsReferenceData.parse((await client.query({...request,input:{...request.input,query:'口罩',codeCountry:'CA'}})).data);
 expect(data.candidates.filter(c=>c.item.country==='CA')[0]?.item.code).toBe('6307909920');
});
it('only uses suggested HS6 directions that exist in current official data, ahead of broad word matches',async()=>{
 const cn=dataset.nomenclature.find(row=>row.country==='CN')!,ca=dataset.nomenclature.find(row=>row.country==='CA')!;
 const {config}=fixture(false,[{...cn,id:1,code:'2309900000',description_original:'动物饲料'},...[
  ['2309900000','Other animal feed'],['2309100000','Dog or cat food, put up for retail sale'],
 ].map(([code,name],i)=>({...ca,id:i+2,code:code!,description_original:name!}))]);
 const client=createCustomsReferenceClient(config,undefined,()=>Promise.resolve({terms:[{language:'zh',text:'动物饲料'},{language:'en',text:'animal feed'}],hs6:['000000','230910']}));
 const data=customsReferenceData.parse((await client.query({...request,input:{...request.input,query:'狗粮',codeCountry:'CA'}})).data);
 expect(data.candidates.filter(c=>c.item.country==='CA')[0]?.item.code).toBe('2309100000');
 expect(data.search).toMatchObject({hs6_hints:['230910']});
});
it('keeps direct official name matches ahead of conflicting model families while retaining translation ranking',async()=>{
 const cn=dataset.nomenclature.find(row=>row.country==='CN')!,ca=dataset.nomenclature.find(row=>row.country==='CA')!;
 const {config}=fixture(false,[{...cn,id:1,code:'8517130000',description_original:'智能手机'},...[
  ['8517130000','Smartphones'],['8517620000','Routing apparatus'],
 ].map(([code,name],i)=>({...ca,id:i+2,code:code!,description_original:name!}))]);
 const suggest=vi.fn().mockResolvedValue({terms:[{language:'en',text:'smartphones'}],hs6:['851712','851762']});
 const data=customsReferenceData.parse((await createCustomsReferenceClient(config,undefined,suggest).query({...request,input:{...request.input,query:'智能手机',codeCountry:'CA'}})).data);
 expect(data.candidates.filter(c=>c.item.country==='CA')[0]?.item.code).toBe('8517130000');
 expect(data.search).toMatchObject({terms:['智能手机','smartphones'],assisted:true});
 expect(data.search).not.toHaveProperty('hs6_hints');
});
it('ranks stated material within suggested families and uses a broad heading before unrelated specific goods',async()=>{
 const ca=dataset.nomenclature.find(row=>row.country==='CA')!;
 const names=[['9617000000','Vacuum flasks',null],['7323','Table, kitchen or other household articles and parts thereof, of iron or steel',null],['732393','Of stainless steel','7323'],['7323931000','Parts for use in the manufacture of cookware','732393'],['7323939000','Other','732393'],['420292','With outer surface of textile materials',null],['4202921000','Golf bags','420292']];
 const {config}=fixture(false,names.map(([code,description_original,parent_code],i)=>({...ca,id:i+1,code:code!,description_original:description_original!,parent_code:parent_code??null})));
 const suggest=vi.fn().mockResolvedValue({terms:[{language:'en',text:'stainless steel drinking cup'}],hs6:['961700','732393']});
 const client=createCustomsReferenceClient(config,undefined,suggest);
 const cup=customsReferenceData.parse((await client.query({...request,input:{...request.input,query:'不锈钢水杯',codeCountry:'CA'}})).data);
 expect(cup.candidates.find(c=>c.item.country==='CA')?.item.code).toBe('732393');
 suggest.mockResolvedValue({terms:[{language:'en',text:'backpack'}],hs6:['420292']});
 const bag=customsReferenceData.parse((await client.query({...request,input:{...request.input,query:'背包',codeCountry:'CA'}})).data);
 expect(bag.candidates.find(c=>c.item.country==='CA')?.item.code).toBe('420292');
});
it('does not match a commodity only mentioned in an exclusion',async()=>{
 const ca=dataset.nomenclature.find(row=>row.country==='CA')!,cn=dataset.nomenclature.find(row=>row.country==='CN')!;
 const {client}=fixture(false,[{...ca,id:1,code:'85411000',description_original:'Diodes, other than photosensitive or light-emitting diodes (LED)'},{...ca,id:2,code:'85414100',description_original:'Light-emitting diodes (LED)'},{...cn,id:3,code:'85411000',description_original:'二极管，但光敏二极管或发光二极管除外'},{...cn,id:4,code:'85414100',description_original:'发光二极管（LED）'}]);
 for(const query of ['light emitting diodes','发光二极管']){
  const data=customsReferenceData.parse((await client.query({...request,input:{...request.input,query,codeCountry:'CA'}})).data);
  expect(data.candidates.filter(c=>c.item.country==='CA').map(c=>c.item.code)).toEqual(['85414100']);
 }
});
it('keeps the suggested propulsion family ahead of an equally partial short bicycle heading',async()=>{
 const ca=dataset.nomenclature.find(row=>row.country==='CA')!;
 const names=[['8711600000','Cycles with electric motor for propulsion'],['87120000','Bicycles and other cycles, not motorized']];
 const {config}=fixture(false,names.map(([code,description_original],i)=>({...ca,id:i+1,code:code!,description_original:description_original!})));
 const suggest=()=>Promise.resolve({terms:[{language:'en' as const,text:'electric bicycle'}],hs6:['871160','871200']});
 const data=customsReferenceData.parse((await createCustomsReferenceClient(config,undefined,suggest).query({...request,input:{...request.input,query:'电动自行车',codeCountry:'CA'}})).data);
 expect(data.candidates.find(c=>c.item.country==='CA')?.item.code).toBe('8711600000');
});
it('uses effective same-country prefix ancestors and never takes a sibling parent rate',async()=>{
 const us=dataset.nomenclature.find(row=>row.country==='US')!,rate=dataset.tariffs.find(row=>row.country==='US')!;
 const rows=[{...us,id:1,code:'8470210000',parent_code:'84701000',description_original:'Incorporating a printing device'},
  {...us,id:2,code:'84701000',parent_code:'8470',description_original:'Wrong sibling'},
  {...us,id:3,code:'8470',description_original:'Calculating machines'},
  {...us,id:4,code:'84702100',description_original:'Expired parent',effective_to:'2026-01-01'}];
 const tariffs=['8470210000','84701000','8470'].map((code,i)=>({...rate,id:'rate_'+i,code,code_match_type:'exact' as const}));
 const {client}=fixture(false,rows,tariffs);
 const data=customsReferenceData.parse((await client.query({...request,input:{...request.input,query:'8470210000',codeCountry:'US'}})).data);
 const selected=data.candidates.find(c=>c.item.code==='8470210000')!;
 expect(selected.hierarchy.map(p=>p.code)).toEqual(['8470']);
 expect(selected.rates.map(r=>r.code)).toEqual(['8470','8470210000']);
 expect(selected.item.parent_code).toBe('84701000'); // Preserve raw evidence; do not repair its hash in place.
 expect(data.warnings.join(' ')).toContain('层级');
});
it('looks up opt-in search terms only in official rows, preserves evidence, and keeps attributes local',async()=>{
 const {config}=fixture(),suggest=vi.fn().mockResolvedValue({terms:[{language:'en',text:'Vacuum flasks'}]});
 const client=createCustomsReferenceClient(config,undefined,suggest);
 const result=await client.query({...request,input:{...request.input,query:'客户俗称',codeCountry:'CA',attributes:{originCountry:'CN',material:'private material',use:'private use'}}});
 const data=customsReferenceData.parse(result.data);
 expect(suggest.mock.calls).toEqual([['客户俗称']]);
 expect(data.candidates.find(c=>c.item.country==='CA')?.item.description_original).toBe('Vacuum flasks and vessels');
 expect(data.search).toEqual({terms:['客户俗称','Vacuum flasks'],assisted:true});
 expect(result.status).toBe('manual_review');expect(data.formal_ready).toBe(false);
 expect(data.warnings.join(' ')).toContain('机器建议检索词');
 suggest.mockClear();await client.query(request);expect(suggest).not.toHaveBeenCalled();
 suggest.mockResolvedValue(null);
 const fallback=customsReferenceData.parse((await client.query({...request,input:{...request.input,query:'保温杯',codeCountry:'CA'}})).data);
 expect(fallback.candidates.length).toBeGreaterThan(0);expect(fallback.search?.assisted).toBe(false);
 expect(suggest).toHaveBeenCalledWith('保温杯');
 const missing=customsReferenceData.parse((await client.query({...request,input:{...request.input,query:'客户俗称',codeCountry:'CA'}})).data);
 expect(missing.warnings.join(' ')).toContain('已保留原始关键词');
});
it('connects an explicit GACC parent to same-year MOF only and rejects a different edition',async()=>{
 const cn=dataset.nomenclature.find(row=>row.country==='CN')!,source=dataset.sources.find(s=>s.country==='CN')!;
 const sources=[{...source,id:'gacc',authority:'GACC',edition:'2026'},{...source,id:'mof',authority:'MOF',dataset:'customs_tariff_8_digit',edition:'2026'}];
 const names=[{...cn,id:1,release_id:'gacc',code:'1234567890',parent_code:'12345678'},{...cn,id:2,release_id:'mof',code:'12345678',parent_code:null}];
 const input={...request.input,query:'1234567890'};
 const compatible=fixture(false,names,dataset.tariffs,sources);
 const data=customsReferenceData.parse((await compatible.client.query({...request,input})).data);
 expect(data.candidates[0]!.hierarchy.map(p=>p.release_id)).toEqual(['mof']);
 const incompatible=fixture(false,names,dataset.tariffs,sources.map(s=>s.id==='mof'?{...s,edition:'2025'}:s));
 expect(customsReferenceData.parse((await incompatible.client.query({...request,input})).data).candidates[0]!.hierarchy).toEqual([]);
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
 expect(result).toMatchObject({schema_version:'portal-customs-reference@2026-09-28.v4',status:'manual_review',data:{formal_ready:false}});
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
