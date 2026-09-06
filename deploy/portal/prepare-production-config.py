"""Run on the Oracle host. Never prints secrets; does not create Portal people.
Prepares private configuration for the new Portal and its source API bindings.
"""
from pathlib import Path
import hashlib,json,os,secrets,subprocess

root=Path('/data/logistics-mcp/portal')
private=root/'secrets';state=root/'state'
for p in [private,state]:p.mkdir(parents=True,exist_ok=True);os.chmod(p,0o700);os.chown(p,10001,10001)
def put(path,data,mode=0o400):
    if path.exists():return
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
    with os.fdopen(fd,'wb') as f:f.write(data if isinstance(data,bytes) else data.encode())
    os.chown(path,10001,10001)
for name in ['business-pepper.bin','source-quote.token','source-customs.token','quote-preview-handle.token']:
    put(private/name,secrets.token_bytes(32) if name.endswith('.bin') else secrets.token_urlsafe(48))
for name in ['business-signing','source-quote','source-customs']:
    key=private/(name+'.key')
    if not key.exists():
        old=os.umask(0o077)
        try:subprocess.run(['openssl','genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:3072','-out',str(key)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        finally:os.umask(old)
        os.chmod(key,0o400);os.chown(key,10001,10001)
    public=private/(name+'.public.pem')
    if not public.exists():
        public.write_bytes(subprocess.check_output(['openssl','pkey','-in',str(key),'-pubout'],stderr=subprocess.DEVNULL));os.chmod(public,0o400);os.chown(public,10001,10001)
# Organization IDs are deterministic targets of the actual onboarding operation,
# not synthetic rows. This script never inserts or activates that organization.
onboarding_key='freightclaw-production-onboarding-20260905'
def stable(prefix):return prefix+'_'+hashlib.sha256((prefix+'\0'+onboarding_key).encode()).hexdigest()[:24]
org,tenant=stable('org'),stable('tenant')
source_application='freightclaw-workbench'
connections=[]
entry={'organizationId':org,'tenantId':tenant,'enabledOperations':['customs.query','customs.tax.estimate','quote.zone_preview','quote.ai_extract_preview'],'recordOperations':['quote.record_save','quote.record_read','quote.review_read','quote.review_manage','quote.document_generate','quote.document_read']}
for source,url in [('quote','https://quote.freightclaw.net/'),('customs','https://www.clearddp.com/')]:
    entry[source]={'baseUrl':url,'serviceCallerId':'freightclaw-portal-'+source,'applicationId':source_application,'connectionSecretFile':'/run/portal-secrets/source-'+source+'.token','issuer':'https://www.freightclaw.net/','audience':'freightclaw-'+source+'-source','keyId':'portal-'+source+'-20260905','delegationPrivateKeyFile':'/run/portal-secrets/source-'+source+'.key'}
connections.append(entry)
put(private/'business-config.json',json.dumps({'connections':connections},indent=2)+'\n')
existing=json.loads(subprocess.check_output(['docker','inspect','logistics-mcp-access-gateway']))[0]
env=dict(x.split('=',1) for x in existing['Config']['Env'] if x.startswith('ACCESS_GATEWAY_'))
env.update({'PORTAL_STATE_ROOT':'/var/lib/freightclaw-portal','PORTAL_PUBLIC_ORIGIN':'https://www.freightclaw.net','PORTAL_HOST':'0.0.0.0','PORTAL_PORT':'8082','PORTAL_RELEASE_ID':'portal-20260905','PORTAL_BUILD_ID':'pending-artifact-hash','PORTAL_TRUSTED_PROXY_ADDRESSES':'172.19.0.5','PORTAL_STATIC_DIRECTORY':'dist/console','PORTAL_OIDC_ISSUER':'https://www.freightclaw.net/application/o/freightclaw-portal/','PORTAL_OIDC_CLIENT_ID':'freightclaw-portal-production','PORTAL_OIDC_CLIENT_SECRET_FILE':'/run/portal-secrets/oidc-client.secret','PORTAL_OIDC_OPERATOR_GROUP':'freightclaw-platform-operators','PORTAL_OIDC_REVIEWER_GROUP':'freightclaw-platform-reviewers','PORTAL_BUSINESS_CONFIG_FILE':'/run/portal-secrets/business-config.json','PORTAL_BUSINESS_TOKEN_ISSUER':'https://www.freightclaw.net/access/v2/business/','PORTAL_BUSINESS_PEPPER_FILE':'/run/portal-secrets/business-pepper.bin','PORTAL_BUSINESS_PEPPER_VERSION':'portal-business-20260905-v1','PORTAL_BUSINESS_PEPPER_HISTORY_FILE':'/var/lib/freightclaw-portal/business-pepper-history.json','PORTAL_BUSINESS_JWT_PRIVATE_KEY_FILE':'/run/portal-secrets/business-signing.key','PORTAL_BUSINESS_JWT_KEY_HISTORY_FILE':'/var/lib/freightclaw-portal/business-key-history.json','PORTAL_BUSINESS_JWT_RETENTION_SECONDS':'1230','PORTAL_T0_REST_AUDIENCE':'freightclaw-t0-rest-v2'})
put(private/'portal.env',''.join(k+'='+v+'\n' for k,v in sorted(env.items())))
quote=json.loads(subprocess.check_output(['docker','inspect','canada_quote_oracle-api-1']))[0]
qenv=dict(x.split('=',1) for x in quote['Config']['Env'] if not x.startswith(('PATH=','HOME=','HOSTNAME=')))
qenv.update({'QUOTE_M2M_ENABLED':'true','QUOTE_M2M_CONNECTION_SECRET_HASH':'sha256:'+hashlib.sha256((private/'source-quote.token').read_bytes()).hexdigest(),'QUOTE_M2M_TENANT_ID':tenant,'QUOTE_M2M_SERVICE_CALLER_ID':'freightclaw-portal-quote','QUOTE_M2M_APPLICATION_ID':source_application,'QUOTE_DELEGATION_ISSUER':'https://www.freightclaw.net/','QUOTE_DELEGATION_AUDIENCE':'freightclaw-quote-source','QUOTE_M2M_REVIEWER_ACTOR_IDS':''})
qenv['QUOTE_PREVIEW_HANDLE_SECRET']=(private/'quote-preview-handle.token').read_text()
put(private/'quote.env',''.join(k+'='+v+'\n' for k,v in sorted(qenv.items())))
put(private/'onboarding-target.json',json.dumps({'organization_id':org,'tenant_id':tenant,'onboarding_idempotency_key':onboarding_key,'state':'not-created-by-configuration','source_application_id':source_application},indent=2)+'\n')
print(json.dumps({'configuration_prepared':True,'organization_id':org,'tenant_id':tenant,'source_connections':2,'human_accounts_created':0}))
