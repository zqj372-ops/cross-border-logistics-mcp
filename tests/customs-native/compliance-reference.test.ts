import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {loadComplianceReference} from '../../services/customs-native/compliance-reference';

it('binds evidence to its hash, country and origin; treats codes as hints and preserves gaps and scope exclusions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'compliance-reference-'));
 const source={url:'https://www.cbsa-asfc.gc.ca/sima-lmsi/mif-mev/test-eng.html',retrieved_at:'2026-09-28T01:00:00Z',source_sha256:'a'.repeat(64)};
 const record={...source,id:'CA-test',case_id:'test',country:'CA',origin_country:'CN',kind:'anti_dumping',title:'Synthetic goods',codes:['1234567890'],scope:'Synthetic scope, excluding toys. '.repeat(200),source_kind:'measure_in_force'};
 const data={schema_version:'customs-compliance-reference@2026-09-28.v1',collected_at:source.retrieved_at,catalogues:[{...source,country:'CA',expected:1,collected:1}],remedies:[record],guidance:[{...source,id:'ca-docs',country:'CA',authority:'CBSA',category:'documents',code_prefixes:[],summary:'合成单证参考',condition:'按实际商品核对'}],failures:[]};
 const save=(value:unknown)=>{const text=JSON.stringify(value),path=join(dir,'reference.json');writeFileSync(path,text);return{snapshotFile:path,sha256:createHash('sha256').update(text).digest('hex')};};
 try{
  const config=save(data),reference=loadComplianceReference(config);
  const result=reference([{country:'CA',code:'12345678'},{country:'US',code:'1234567890'}],'2026-09-28');
  expect(result.remedies).toHaveLength(1);expect(result.remedies[0]).toMatchObject({matched_codes:['12345678'],scope_truncated:true});
  expect(result.remedies[0]?.scope_excerpt).toContain('excluding toys');
  expect(result.guidance[0]?.summary).toBe('合成单证参考');
  expect(reference([{country:'CA',code:'990000'}],'2020-01-01')).toMatchObject({remedies:[],date_mismatch:true});
  expect(()=>loadComplianceReference({...config,sha256:'0'.repeat(64)})).toThrow('customs_compliance_hash_mismatch');
  expect(()=>loadComplianceReference(save({...data,remedies:[{...record,url:'https://evil.invalid/'}]}))).toThrow();
  expect(()=>loadComplianceReference(save({...data,remedies:[{...record,origin_country:'US'}]}))).toThrow();
  expect(()=>loadComplianceReference(save({...data,catalogues:[{...source,country:'CA',expected:2,collected:2}]}))).toThrow();
  const gaps=loadComplianceReference(save({...data,catalogues:[{...source,country:'CA',expected:2,collected:1}]}));
  expect(gaps([],'2026-09-28').catalogues[0]).toMatchObject({expected:2,collected:1,missing_details:0});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
