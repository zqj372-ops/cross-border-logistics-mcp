import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {z} from 'zod';

const country=z.enum(['CA','US']);
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const officialHosts=new Set(['www.cbsa-asfc.gc.ca','access.trade.gov','beta.trade.gov','inspection.canada.ca','ised-isde.canada.ca','www.canada.ca','www.cpsc.gov','www.fda.gov','www.aphis.usda.gov','www.ecfr.gov','apps.fcc.gov']);
const source={url:z.url().max(2000).refine(value=>{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&officialHosts.has(u.hostname);}),retrieved_at:z.iso.datetime({offset:true}),source_sha256:sha};
const remedy=z.object({...source,id:z.string().min(1).max(120),case_id:z.string().min(1).max(100),country,origin_country:z.literal('CN'),kind:z.enum(['anti_dumping','countervailing']),title:z.string().min(1).max(600),codes:z.array(z.string().regex(/^\d{6,10}$/u)).max(2000),scope:z.string().max(100_000),source_kind:z.enum(['measure_in_force','active_proceeding'])}).strict();
const guidance=z.object({...source,id:z.string().min(1).max(100),country,authority:z.string().min(1).max(100),category:z.enum(['restriction','certification','documents']),code_prefixes:z.array(z.string().regex(/^\d{2,10}$/u)).max(100),summary:z.string().min(1).max(500),condition:z.string().min(1).max(500)}).strict();
const catalogue=z.object({...source,country,expected:z.number().int().nonnegative().max(5000),collected:z.number().int().nonnegative().max(5000),excluded_rescinded:z.number().int().nonnegative().max(5000).optional()}).strict();
const snapshot=z.object({schema_version:z.literal('customs-compliance-reference@2026-09-28.v1'),collected_at:z.iso.datetime({offset:true}),catalogues:z.array(catalogue).max(2),remedies:z.array(remedy).max(5000),guidance:z.array(guidance).max(64),failures:z.array(z.object({url:source.url,error:z.string().max(100),reason:z.string().max(200)}).strict()).max(500)}).strict();
export const complianceConfig=z.object({snapshotFile:z.string().min(1),sha256:sha}).strict();
export const complianceData=z.object({snapshot_sha256:sha,collected_at:z.iso.datetime({offset:true}),date_mismatch:z.boolean(),truncated:z.boolean(),catalogues:z.array(catalogue.extend({missing_details:z.number().int().nonnegative()})).max(2),remedies:z.array(remedy.omit({codes:true,scope:true}).extend({matched_codes:z.array(z.string().regex(/^\d{4,10}$/u)).max(27),scope_excerpt:z.string().max(2000),scope_truncated:z.boolean()})).max(60),guidance:z.array(guidance).max(64)}).strict();

export function loadComplianceReference(config:z.infer<typeof complianceConfig>){
 const stat=lstatSync(config.snapshotFile);
 if(!isAbsolute(config.snapshotFile)||!stat.isFile()||stat.isSymbolicLink()||stat.size>25_000_000)throw new Error('customs_compliance_file_invalid');
 const bytes=readFileSync(config.snapshotFile);
 if(createHash('sha256').update(bytes).digest('hex')!==config.sha256)throw new Error('customs_compliance_hash_mismatch');
 const data=snapshot.parse(JSON.parse(bytes.toString('utf8')) as unknown);
 if(new Set(data.remedies.map(r=>r.id)).size!==data.remedies.length||new Set(data.guidance.map(r=>r.id)).size!==data.guidance.length||new Set(data.catalogues.map(c=>c.country)).size!==data.catalogues.length)throw new Error('customs_compliance_duplicate');
 if([data.collected_at,...data.catalogues.map(c=>c.retrieved_at),...data.remedies.map(r=>r.retrieved_at),...data.guidance.map(r=>r.retrieved_at)].some(t=>Date.parse(t)>Date.now()+300_000))throw new Error('customs_compliance_time_invalid');
 for(const r of data.remedies){
  const host=new URL(r.url).hostname;
  if(r.country==='CA'?(host!=='www.cbsa-asfc.gc.ca'||r.source_kind!=='measure_in_force'):(host!=='beta.trade.gov'||r.source_kind!=='active_proceeding'||!/^US-[AC]-570-\d{3}$/u.test(r.id)||r.id!==`US-${r.case_id}`||new URL(r.url).searchParams.get('adcvdcase')!==r.case_id))throw new Error('customs_compliance_source_invalid');
 }
 for(const c of data.catalogues)if(c.collected!==data.remedies.filter(r=>r.country===c.country).length||c.collected+(c.excluded_rescinded??0)>c.expected)throw new Error('customs_compliance_count_invalid');
 // Read once: configuration/hash changes take effect only after process restart, like the tariff snapshot.
 return (items:readonly {country:string;code:string}[],ruleDate:string):z.infer<typeof complianceData>=>{
  const matches=data.remedies.flatMap(r=>{
   const codes=[...new Set(items.filter(item=>item.country===r.country&&r.codes.some(code=>item.code.startsWith(code)||code.startsWith(item.code))).map(item=>item.code))];
   if(!codes.length)return [];
   const record=remedy.omit({codes:true,scope:true}).parse(({url:r.url,retrieved_at:r.retrieved_at,source_sha256:r.source_sha256,id:r.id,case_id:r.case_id,country:r.country,origin_country:r.origin_country,kind:r.kind,title:r.title,source_kind:r.source_kind}));
   const scope=r.scope;
   return [{...record,matched_codes:codes,scope_excerpt:scope.slice(0,2000),scope_truncated:scope.length>2000}];
  });
  return complianceData.parse({snapshot_sha256:config.sha256,collected_at:data.collected_at,date_mismatch:ruleDate!==data.collected_at.slice(0,10),truncated:matches.length>60,catalogues:data.catalogues.map(c=>({...c,missing_details:data.remedies.filter(r=>r.country===c.country&&(!r.codes.length||!r.scope)).length})),remedies:matches.slice(0,60),guidance:data.guidance.filter(g=>!g.code_prefixes.length||items.some(item=>item.country===g.country&&g.code_prefixes.some(prefix=>item.code.startsWith(prefix)||prefix.startsWith(item.code))))});
 };
}
