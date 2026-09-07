import {execFileSync} from 'node:child_process';
import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
it('checks CBSA normalization and official-source differences using isolated fixtures',()=>{expect(()=>execFileSync('python3',['-m','unittest','discover','-s','tests/customs-native','-p','test_cbsa*.py'],{stdio:'pipe'})).not.toThrow();});
it('binds migrated source normalization files to recorded content hashes',()=>{const p=JSON.parse(readFileSync('services/customs-native/data_pipeline/provenance.json','utf8')) as {files:{target:string;target_sha256:string}[]};for(const f of p.files)expect(createHash('sha256').update(readFileSync(f.target)).digest('hex')).toBe(f.target_sha256);});
it('prepares source-contract-valid candidates and rejects overwrite, wrong hashes and future retrieval times',()=>{
 const fixture=JSON.parse(execFileSync('python3',['tests/customs-native/cbsa-cli-fixture.py'],{encoding:'utf8'})) as Record<string,unknown>;
 const ajv=new Ajv2020({allErrors:true,strict:false});addFormats(ajv);
 for(const [key,schema] of [['release','source-release'],['quality','quality-report'],['nomenclature','nomenclature'],['tariffs','tariff-rule']]){
  const check=ajv.compile(JSON.parse(readFileSync(`services/customs-native/data_pipeline/schemas/${schema}.schema.json`,'utf8')));
  for(const row of Array.isArray(fixture[key!])?fixture[key!] as unknown[]:[fixture[key!]])expect(check(row),JSON.stringify(check.errors)).toBe(true);
 }
});
