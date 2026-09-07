import { z } from 'zod';
import { nativeSchemas } from '../../services/access-gateway/portal/native-admin-contracts';
import { it,expect } from 'vitest';
import { readFileSync,readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
it('compiles every native admin Draft 2020-12 schema',()=>{const ajv=new Ajv2020({strict:false});addFormats(ajv);const root=resolve('schemas/admin-control/native-business');for(const file of readdirSync(root)){const schema=JSON.parse(readFileSync(resolve(root,file),'utf8')) as object;expect(()=>ajv.compile(schema),file).not.toThrow();}});
it('verifies both frozen source migration manifests against shipped files',()=>{for(const folder of ['customs-native','quote-native']){const manifest=JSON.parse(readFileSync(resolve('services',folder,'provenance.json'),'utf8')) as {files:Array<{target:string;target_sha256:string}>};for(const item of manifest.files){expect(createHash('sha256').update(readFileSync(resolve(item.target))).digest('hex'),item.target).toBe(item.target_sha256);}}});

it("keeps native schema files synchronized with server and CLI validators",()=>{for(const [name,schema]of Object.entries(nativeSchemas))expect(JSON.parse(readFileSync(`schemas/admin-control/native-business/${name}.schema.json`,"utf8")) as unknown).toEqual(z.toJSONSchema(schema,{target:"draft-2020-12"}));});
