import { generateKeyPairSync,randomBytes } from "node:crypto";
import { chmodSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach,describe,expect,it } from "vitest";

import { BUSINESS_TOKEN_AUDIENCE,type BusinessJwtClaims } from "../../services/access-gateway/portal/business-access/contracts";
import { createProductionBusinessAccessCrypto } from "../../services/access-gateway/portal/business-access/production-crypto";

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function protectedRoot(){const root=mkdtempSync(join(tmpdir(),"business-production-crypto-"));chmodSync(root,0o700);roots.push(root);return root;}
function key(path:string){const pair=generateKeyPairSync("rsa",{modulusLength:2048});writeFileSync(path,pair.privateKey.export({format:"pem",type:"pkcs8"}),{mode:0o600});return pair;}
const claims=(now:number):BusinessJwtClaims=>({iss:"https://portal.example.test/",aud:BUSINESS_TOKEN_AUDIENCE,sub:"bkey_123",token_use:"business_api",tenant_id:"tenant",client_id:"client",application_id:"app",credential_id:"bkey_123",operations:["customs.query"],iat:now,nbf:now,exp:now+300,jti:"jti_12345678"});

describe("production Business Access crypto",()=>{
  it("uses persistent protected RS256 files and retains the previous verification key",async()=>{const root=protectedRoot(),privateKey=join(root,"jwt.pem"),historyPath=join(root,"jwt-history.json"),pepperPath=join(root,"pepper"),pepperHistory=join(root,"pepper-history.json"),now=Math.floor(Date.now()/1000);key(privateKey);writeFileSync(pepperPath,randomBytes(32),{mode:0o600});const options={issuer:"https://portal.example.test/",pepper:{pepperPath,pepperVersion:"pepper-v1",historyPath:pepperHistory},jwt:{privateKeyPath:privateKey,historyPath,nowSeconds:()=>now,retentionSeconds:1_230}};const first=await createProductionBusinessAccessCrypto(options),oldToken=await first.tokenSigner.sign(claims(now));expect(await first.tokenVerifier.verify(oldToken)).toMatchObject({aud:BUSINESS_TOKEN_AUDIENCE});const oldKid=(await first.getJwks()).keys[0]!.kid;key(privateKey);const second=await createProductionBusinessAccessCrypto(options),keys=(await second.getJwks()).keys;expect(keys).toHaveLength(2);expect(keys[0]!.kid).not.toBe(oldKid);expect(keys[1]!.kid).toBe(oldKid);await expect(second.tokenVerifier.verify(oldToken)).resolves.toMatchObject({credential_id:"bkey_123"});});

  it("keeps pepper history able to verify existing hashes after rotation",async()=>{const root=protectedRoot(),privateKey=join(root,"jwt.pem"),historyPath=join(root,"jwt-history.json"),pepperPath=join(root,"pepper"),pepperHistory=join(root,"pepper-history.json"),now=Math.floor(Date.now()/1000);key(privateKey);writeFileSync(pepperPath,randomBytes(32),{mode:0o600});const common={issuer:"https://portal.example.test/",jwt:{privateKeyPath:privateKey,historyPath,nowSeconds:()=>now,retentionSeconds:1_230}};const first=await createProductionBusinessAccessCrypto({...common,pepper:{pepperPath,pepperVersion:"pepper-v1",historyPath:pepperHistory}}),salt=randomBytes(16),hash=await first.secretProvider.hash("x".repeat(43),salt);writeFileSync(pepperPath,randomBytes(32),{mode:0o600});const second=await createProductionBusinessAccessCrypto({...common,pepper:{pepperPath,pepperVersion:"pepper-v2",historyPath:pepperHistory}});await expect(second.secretProvider.verify("x".repeat(43),{salt,hash,pepperVersion:"pepper-v1"})).resolves.toBe(true);await expect(second.secretProvider.verify("y".repeat(43),{salt,hash,pepperVersion:"pepper-v1"})).resolves.toBe(false);});
});
