import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {validateProductionPortalEnvironment} from '../../services/access-gateway/portal/production';

function environment(root:string,fcl:boolean){
  const file=(name:string,value='configured')=>{const path=join(root,name);writeFileSync(path,value,{mode:0o600});return path;};
  return {
    PORTAL_STATE_ROOT:join(root,'state'),PORTAL_PUBLIC_ORIGIN:'https://portal.example.test',PORTAL_OIDC_OPERATOR_GROUP:'operators',PORTAL_OIDC_REVIEWER_GROUP:'reviewers',PORTAL_TRUSTED_PROXY_ADDRESSES:'127.0.0.1',PORTAL_OIDC_CLIENT_SECRET_FILE:file('oidc-secret'),PORTAL_BUSINESS_CONFIG_FILE:file('business.json','{}'),PORTAL_BUSINESS_PEPPER_FILE:file('pepper'),PORTAL_BUSINESS_JWT_PRIVATE_KEY_FILE:file('jwt'),ACCESS_GATEWAY_APPLICATION_ROOT:root,ACCESS_GATEWAY_MANAGEMENT_TENANT_ID:'management',ACCESS_GATEWAY_INSTANCE_ID:'instance',ACCESS_GATEWAY_JWT_ISSUER:'https://issuer.example.test',ACCESS_GATEWAY_JWT_AUDIENCE:'mcp',ACCESS_GATEWAY_PEPPER_VERSION:'pepper-v1',PORTAL_T0_REST_AUDIENCE:'rest',PORTAL_RELEASE_ID:'release',PORTAL_BUILD_ID:'build',PORTAL_OIDC_ISSUER:'https://www.freightclaw.net/application/o/freightclaw-portal/',PORTAL_OIDC_CLIENT_ID:'portal',PORTAL_BUSINESS_TOKEN_ISSUER:'https://portal.example.test',PORTAL_BUSINESS_PEPPER_VERSION:'business-v1',PORTAL_BUSINESS_JWT_KEY_HISTORY_FILE:file('jwt-history'),...(fcl?{PORTAL_FCL_ENABLED:'true',PORTAL_QUOTE_DOCUMENTS_SQLITE_PATH:join(root,'quote-documents.sqlite'),PORTAL_PDF_BROWSER_EXECUTABLE:file('renderer'),PORTAL_FCL_RECEIVER_SUB:'00000000-0000-4000-8000-000000000004',PORTAL_FCL_RECEIVER_AUTHORITY_URL:'https://www.freightclaw.net/api/v3/core/users/4/',PORTAL_FCL_RECEIVER_AUTHORITY_TOKEN_FILE:file('authority-token'),PORTAL_FCL_CASE_CREDENTIAL_SECRET_FILE:file('case-secret','c'.repeat(32)),PORTAL_FCL_PUBLIC_SESSION_SECRET_FILE:file('public-secret','p'.repeat(32)),PORTAL_FCL_SMTP_CONFIG_FILE:file('smtp.json',JSON.stringify({host:'smtp.qq.com',port:465,secure:true,username:'synthetic@qq.com',password:'synthetic',from:'synthetic@qq.com'}))}:{}),
  } as NodeJS.ProcessEnv;
}

it('keeps existing production valid when FCL is disabled',()=>{
  const root=mkdtempSync(join(tmpdir(),'portal-fcl-env-disabled-'));
  try{expect(()=>validateProductionPortalEnvironment(environment(root,false))).not.toThrow();}
  finally{rmSync(root,{recursive:true,force:true});}
});

it('requires the complete private FCL authority, secret, renderer and SMTP projection when enabled',()=>{
  const root=mkdtempSync(join(tmpdir(),'portal-fcl-env-enabled-'));
  try{
    const env=environment(root,true);expect(()=>validateProductionPortalEnvironment(env)).not.toThrow();
    delete env.PORTAL_FCL_RECEIVER_AUTHORITY_TOKEN_FILE;expect(()=>validateProductionPortalEnvironment(env)).toThrow('PORTAL_FCL_RECEIVER_AUTHORITY_TOKEN_FILE is required.');
    env.PORTAL_FCL_RECEIVER_AUTHORITY_TOKEN_FILE=join(root,'does-not-exist');expect(()=>validateProductionPortalEnvironment(env)).toThrow('portal_secret_file_invalid');
  }finally{rmSync(root,{recursive:true,force:true});}
});
