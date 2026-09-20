import {afterEach,describe,expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {linkSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DocumentStore,DocumentService} from '../../services/quote-documents/service';
import {
  DocumentWorkflowService,
  DocumentWorkflowStore,
  assertNoExternalSqliteHandles,
  standardFeeTemplate,
  type FclDocumentWorkflowOptions,
} from '../../services/quote-documents/workflow';
import {
  FCL_DOCUMENT_WORKFLOW_VERSION,
  fclConfigSchema,
  type FclConfig,
} from '../../services/quote-documents/fcl-contracts';
import type {PortalContext} from '../../services/access-gateway/portal/contracts';
import type {PortalService} from '../../services/access-gateway/portal/service';
import {template} from './fixtures';

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));

const receiverId='fcl-document-receiver';
const otherId='fcl-document-other';
const portal={getState:(ctx:PortalContext)=>({data:{current_organization:ctx.organizationId?{organizationId:ctx.organizationId,status:'active'}:null,memberships:ctx.organizationId?[{userId:ctx.identity.userId,organizationId:ctx.organizationId,status:'active',role:'owner'}]:[]}})} as unknown as Pick<PortalService,'getState'>;
const receiver:PortalContext={organizationId:null,identity:{userId:receiverId,displayName:'FCL Receiver',email:'receiver@example.test',emailVerified:true,platformRole:null}};
const other:PortalContext={organizationId:null,identity:{...receiver.identity,userId:otherId,email:'other@example.test'}};
const enterprise:PortalContext={organizationId:'org-a',identity:{...receiver.identity,userId:'owner',email:'owner@example.test'}};

const freshFcl={fcl:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}} as const;
const verifiedFcl={fcl:{mode:'exclusive_verified',authorized:true,oldWritersStopped:true,assertExclusive:()=>undefined}} as const;
const reopenFcl={fcl:{mode:'reopen'}} as const;

function root(){const value=mkdtempSync(join(tmpdir(),'fcl-document-config-'));roots.push(value);return value;}

function fclInput(overrides:Partial<FclConfig>= {}):FclConfig{
  return {
    issuer_name:'Synthetic Issuer',
    issuer_address:'Synthetic address',
    issuer_phone:'+1 555 0100',
    issuer_email:'issuer@example.test',
    terms:'Synthetic FCL terms.',
    standard_fee_template_v1:{template_id:'freightclaw-standard-v1',template_version:1,items:[]},
    ...overrides,
  };
}

function saveBody(input:FclConfig=fclInput(),expectedVersion=0){
  return {contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,expected_version:expectedVersion,input,confirmed:true as const};
}

function enterpriseDraft(){
  return {
    schema_version:'quote-document-draft@2026-09-15.v1' as const,
    quote_no:'V4-ENTERPRISE-001',
    customer_name:'Synthetic Enterprise',
    quote_date:'2026-09-20',
    valid_until:'2026-12-31',
    origin:null,
    destination:null,
    route_name:null,
    job_no:null,
    so_no:null,
    container_no:null,
    remark:null,
    exchange_rates:{USD:null,CAD:null},
    fee_items:[{id:randomUUID(),source_kind:'manual' as const,template_ref:null,name:'Freight',description:null,group:'B' as const,quantity:'1',unit:'shipment',unit_price:'10',currency:'USD' as const,display:'detail' as const,merge_name:null,note:null}],
  };
}

function service(
  documentStore:DocumentStore,
  options:FclDocumentWorkflowOptions= {receiverUserId:receiverId,receiverIsActive:()=>true,now:()=> '2026-09-20T12:00:00.000Z'},
  workflowOptions:ConstructorParameters<typeof DocumentWorkflowStore>[1]=freshFcl,
){
  const workflow=new DocumentWorkflowStore(documentStore,workflowOptions);
  return new DocumentWorkflowService(workflow,new DocumentService(documentStore,portal),portal,undefined,options);
}

describe('personal FCL document configuration',()=>{
  it('saves and reopens one personal configuration without exposing it to enterprise readers',()=>{
    const dir=root(),path=join(dir,'documents.sqlite');
    let documentStore=new DocumentStore(path,freshFcl);
    const first=service(documentStore);
    expect(first.fclConfig(receiver)).toEqual({
      contract_version:FCL_DOCUMENT_WORKFLOW_VERSION,
      version:0,
      input:null,
      catalog:standardFeeTemplate,
    });
    const saved=first.saveFclConfig(receiver,saveBody(),'fcl-document-config-0001');
    expect(saved).toMatchObject({version:1,input:fclInput()});
    expect(documentStore.db.prepare('SELECT org,personal_owner_id FROM document_configs').get()).toEqual({org:null,personal_owner_id:receiverId});
    expect(()=>first.config(enterprise)).not.toThrow();
    expect(first.config(enterprise)).toMatchObject({version:0,input:null});
    documentStore.close();

    documentStore=new DocumentStore(path,reopenFcl);
    const reopened=service(documentStore,undefined,reopenFcl);
    expect(reopened.fclConfig(receiver)).toMatchObject({version:1,input:fclInput()});
    documentStore.close();
  });

  it('rejects non-receivers, enterprise contexts, operators, inactive receivers, and missing configuration scope',()=>{
    const dir=root(),documentStore=new DocumentStore(join(dir,'documents.sqlite'),freshFcl),active={value:true};
    const fcl=service(documentStore,{receiverUserId:receiverId,receiverIsActive:()=>active.value,now:()=> '2026-09-20T12:00:00.000Z'});
    expect(()=>fcl.fclConfig(other)).toThrow('fcl_not_found');
    expect(()=>fcl.fclConfig(enterprise)).toThrow('fcl_not_found');
    expect(()=>fcl.fclConfig({organizationId:null,identity:{...receiver.identity,userId:'operator',platformRole:'operator'}})).toThrow('fcl_not_found');
    active.value=false;
    expect(()=>fcl.fclConfig(receiver)).toThrow('fcl_unavailable');
    documentStore.close();

    const plainDir=root(),plainStore=new DocumentStore(join(plainDir,'documents.sqlite'));
    const plain=new DocumentWorkflowService(new DocumentWorkflowStore(plainStore),new DocumentService(plainStore,portal),portal);
    expect(()=>plain.fclConfig(receiver)).toThrow('fcl_unavailable');
    plainStore.close();
  });

  it('enforces CAS and personal-actor idempotency without duplicating audit rows',()=>{
    const dir=root(),documentStore=new DocumentStore(join(dir,'documents.sqlite'),freshFcl),active={value:true},fcl=service(documentStore,{receiverUserId:receiverId,receiverIsActive:()=>active.value});
    const body=saveBody(),key='fcl-document-config-0002';
    fcl.saveFclConfig(receiver,body,key);
    const auditBefore=(documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_audit').get() as {n:number}).n;
    expect(fcl.saveFclConfig(receiver,body,key)).toMatchObject({version:1,input:body.input});
    expect((documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_audit').get() as {n:number}).n).toBe(auditBefore);
    expect(()=>fcl.saveFclConfig(receiver,{...body,input:fclInput({issuer_name:'Changed'})},key)).toThrow('idempotency_conflict');
    expect(()=>fcl.saveFclConfig(receiver,saveBody(fclInput({issuer_name:'Changed'}),0),'fcl-document-config-0003')).toThrow('version_conflict');
    const updated=fcl.saveFclConfig(receiver,saveBody(fclInput({issuer_name:'Updated'}),1),'fcl-document-config-0004');
    expect(updated).toMatchObject({version:2,input:{issuer_name:'Updated'}});
    expect(fcl.saveFclConfig(receiver,body,key)).toMatchObject({version:2,input:{issuer_name:'Updated'}});
    active.value=false;
    expect(()=>fcl.saveFclConfig(receiver,body,key)).toThrow('fcl_unavailable');
    documentStore.close();
  });

  it('rolls back configuration, audit, and idempotency when an AFTER trigger corrupts readback',()=>{
    const dir=root(),documentStore=new DocumentStore(join(dir,'documents.sqlite'),freshFcl),fcl=service(documentStore);
    documentStore.db.exec("CREATE TRIGGER fcl_config_tamper AFTER INSERT ON document_idempotency BEGIN UPDATE document_configs SET input=json_set(input,'$.issuer_name','CORRUPTED'); END;");
    expect(()=>fcl.saveFclConfig(receiver,saveBody(),'fcl-document-config-0004')).toThrow('document_readback_failed');
    expect(documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_configs').get()).toEqual({n:0});
    expect(documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_audit').get()).toEqual({n:0});
    expect(documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_idempotency').get()).toEqual({n:0});
    documentStore.close();
  });

  it('preserves v3 config, revisions, PDF bytes, digests, and signing secret during v4 migration',()=>{
    const dir=root(),path=join(dir,'documents.sqlite');
    let documentStore=new DocumentStore(path);
    const workflowStore=new DocumentWorkflowStore(documentStore,{oldWritersStopped:true,ownershipMode:'fresh-fixture'});
    workflowStore.ensureWritable();
    const legacy=new DocumentService(documentStore,portal);
    const workflow=new DocumentWorkflowService(workflowStore,legacy,portal);
    const enterpriseCtx:PortalContext={organizationId:'org-legacy',identity:{userId:'owner-legacy',displayName:'Legacy',email:'legacy@example.test',emailVerified:true,platformRole:null}};
    legacy.saveConfig(enterpriseCtx,{expected_version:0,input:{...template,company_name:'Synthetic Legacy'},confirmed:true},'fcl-document-legacy-0001');
    const document=workflow.save(enterpriseCtx,{contract_version:'quote-documents-workflow@2026-09-15.v1',operation:'create',document_kind:'manual',input:{schema_version:'quote-document-draft@2026-09-15.v1',quote_no:'LEGACY-FCL',customer_name:'Legacy',quote_date:'2026-09-20',valid_until:'2026-12-31',origin:null,destination:null,route_name:null,job_no:null,so_no:null,container_no:null,remark:null,exchange_rates:{USD:null,CAD:null},fee_items:[]},template_selection:{mode:'current'},save_intent:'save_draft'},'fcl-document-legacy-0002');
    const pdf=Buffer.from('%PDF-1.7\n'+'.'.repeat(120));
    documentStore.db.prepare('INSERT INTO document_pdfs VALUES(?,?,?,?)').run(document.id,1,createHash('sha256').update(pdf).digest('hex'),pdf);
    const beforeConfig=documentStore.db.prepare('SELECT version,input FROM document_configs WHERE org=?').get('org-legacy');
    const beforeRevision=documentStore.db.prepare('SELECT revision_id,document_id,org,owner,version,state,schema_version,payload,input_digest,template_digest,source_revision_id,review_hash,rejection_reason,created_by,created_at FROM document_revisions WHERE document_id=?').get(document.id);
    const beforeCurrent=documentStore.db.prepare('SELECT document_id,org,owner,revision_id,version,schema_version,projection_digest,updated_at FROM document_current_revisions WHERE document_id=?').get(document.id);
    const beforeAudit=documentStore.db.prepare('SELECT id,org,actor,action,digest,created FROM document_audit ORDER BY id').all();
    const beforePdf=documentStore.db.prepare('SELECT sha256,bytes FROM document_pdfs WHERE id=? AND version=1').get(document.id) as {sha256:string;bytes:Uint8Array};
    const secret=workflowStore.signingSecret;
    documentStore.close();

    documentStore=new DocumentStore(path,verifiedFcl);
    const migrated=service(documentStore,undefined,{...verifiedFcl,externalHandleProbe:()=>undefined});
    expect(migrated.store.signingSecret).toBe(secret);
    expect(documentStore.db.prepare('SELECT version,input FROM document_configs WHERE org=?').get('org-legacy')).toEqual(beforeConfig);
    expect(documentStore.db.prepare('SELECT revision_id,document_id,org,owner,version,state,schema_version,payload,input_digest,template_digest,source_revision_id,review_hash,rejection_reason,created_by,created_at FROM document_revisions WHERE document_id=?').get(document.id)).toEqual(beforeRevision);
    expect(documentStore.db.prepare('SELECT document_id,org,owner,revision_id,version,schema_version,projection_digest,updated_at FROM document_current_revisions WHERE document_id=?').get(document.id)).toEqual(beforeCurrent);
    expect(documentStore.db.prepare('SELECT id,org,actor,action,digest,created FROM document_audit ORDER BY id').all()).toEqual(beforeAudit);
    expect(documentStore.db.prepare('SELECT sha256,bytes FROM document_pdfs WHERE id=? AND version=1').get(document.id)).toEqual(beforePdf);
    expect(documentStore.db.prepare('PRAGMA user_version').get()).toEqual({user_version:4});
    documentStore.close();
  });

  it('keeps enterprise v3 behavior after v4 and does not list personal configuration as enterprise data',()=>{
    const dir=root(),documentStore=new DocumentStore(join(dir,'documents.sqlite'),freshFcl),fcl=service(documentStore),legacy=new DocumentService(documentStore,portal);
    const businessPortal={getState:(ctx:PortalContext)=>({data:{current_organization:{organizationId:'org-b',status:'active'},memberships:[{userId:ctx.identity.userId,organizationId:'org-b',status:'active',role:'owner'}]}})} as unknown as Pick<PortalService,'getState'>;
    const enterpriseCtx:PortalContext={organizationId:'org-b',identity:{userId:'owner-b',displayName:'Owner',email:'owner@example.test',emailVerified:true,platformRole:null}};
    const workflow=new DocumentWorkflowService(new DocumentWorkflowStore(documentStore,reopenFcl),new DocumentService(documentStore,businessPortal),businessPortal);
    workflow.saveConfig(enterpriseCtx,{contract_version:'quote-documents-workflow@2026-09-15.v1',expected_version:0,input:{...template,company_name:'Enterprise B'},confirmed:true},'fcl-document-enterprise-0001');
    fcl.saveFclConfig(receiver,saveBody(),'fcl-document-enterprise-0002');
    expect(workflow.config(enterpriseCtx)).toMatchObject({version:1,input:{company_name:'Enterprise B'}});
    expect(legacy.config(enterpriseCtx)).toMatchObject({version:1,input:{company_name:'Enterprise B'}});
    const saved=workflow.save(enterpriseCtx,{contract_version:'quote-documents-workflow@2026-09-15.v1',operation:'create',document_kind:'manual',input:enterpriseDraft(),template_selection:{mode:'current'},save_intent:'save_draft'},'fcl-document-enterprise-0003');
    expect(workflow.get(enterpriseCtx,{contract_version:'quote-documents-workflow@2026-09-15.v1',id:saved.id})).toMatchObject({id:saved.id,organization_id:'org-b',version:1});
    expect(workflow.list(enterpriseCtx,{contract_version:'quote-documents-workflow@2026-09-15.v1',limit:10,cursor:null,filters:{state:'all',quote_no:null,customer_name:null}}).items).toEqual(expect.arrayContaining([expect.objectContaining({id:saved.id,organization_id:'org-b'})]));
    expect(documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_configs').get()).toEqual({n:2});
    documentStore.close();
  });

  it('blocks a receiver switch when another personal owner already exists',()=>{
    const dir=root(),documentStore=new DocumentStore(join(dir,'documents.sqlite'),freshFcl);
    service(documentStore).saveFclConfig(receiver,saveBody(),'fcl-document-owner-switch-0001');
    expect(()=>service(documentStore,{receiverUserId:otherId,receiverIsActive:()=>true})).toThrow('fcl_receiver_configuration_mismatch');
    documentStore.close();
  });

  it('blocks a second same-process handle and an external process handle before v4 migration',async()=>{
    const dir=root(),path=join(dir,'documents.sqlite');
    let documentStore=new DocumentStore(path,freshFcl);
    const second=new DocumentStore(path,freshFcl);
    expect(()=>service(documentStore)).toThrow('fcl_upgrade_old_writer_open');
    second.close();
    documentStore.close();

    documentStore=new DocumentStore(path,freshFcl);
    const alias=join(dir,'documents-link.sqlite');
    linkSync(path,alias);
    const child=spawn(process.execPath,['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL;');console.log('ready');setInterval(()=>{},1000);",alias],{stdio:['ignore','pipe','inherit']});
    const childPid=child.pid;
    if(childPid===undefined)throw new Error('legacy writer did not start');
    try{
      await new Promise<void>((resolve,reject)=>{let output='';child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('ready'))resolve();});child.once('error',reject);child.once('exit',code=>{if(!output.includes('ready'))reject(new Error(`legacy writer exited ${code}`));});});
      expect(()=>service(documentStore,{receiverUserId:receiverId,receiverIsActive:()=>true},{oldWritersStopped:true,ownershipMode:'existing-database',externalHandleProbe:path=>assertNoExternalSqliteHandles(path,{onlyPids:new Set([childPid])})})).toThrow('fcl_upgrade_old_writer_open');
    }finally{
      child.kill('SIGTERM');
      await once(child,'close');
      documentStore.close();
    }
  });

  it('fails closed when external handles cannot be inspected',()=>{
    const dir=root(),path=join(dir,'documents.sqlite'),documentStore=new DocumentStore(path,verifiedFcl);
    expect(()=>service(documentStore,undefined,{fcl:{mode:'exclusive_verified',authorized:true,oldWritersStopped:true,assertExclusive:()=>{throw new Error('unverified');}}})).toThrow('fcl_upgrade_ownership_unverified');
    documentStore.close();
  });

  it('opens v4 read-only without DDL or writes',()=>{
    const dir=root(),path=join(dir,'documents.sqlite');
    let documentStore=new DocumentStore(path,freshFcl);
    service(documentStore).saveFclConfig(receiver,saveBody(),'fcl-document-readonly-0001');
    documentStore.close();
    documentStore=new DocumentStore(path,reopenFcl);
    const workflow=DocumentWorkflowStore.openReadOnly(documentStore);
    const fcl=new DocumentWorkflowService(workflow,new DocumentService(documentStore,portal),portal,undefined,{receiverUserId:receiverId,receiverIsActive:()=>true});
    const before=documentStore.db.prepare('SELECT version FROM document_configs WHERE personal_owner_id=?').get(receiverId);
    expect(fcl.fclConfig(receiver)).toMatchObject({version:1});
    expect(documentStore.db.prepare('SELECT version FROM document_configs WHERE personal_owner_id=?').get(receiverId)).toEqual(before);
    expect(()=>fcl.saveFclConfig(receiver,saveBody(fclInput({issuer_name:'Read only'}),1),'fcl-document-readonly-0002')).toThrow('document_v3_rollback_read_only');
    documentStore.close();
  });

  it('rolls back a failed v4 migration without changing the v3 schema or version',()=>{
    const dir=root(),path=join(dir,'documents.sqlite');
    let documentStore=new DocumentStore(path);
    new DocumentWorkflowStore(documentStore,{oldWritersStopped:true,ownershipMode:'fresh-fixture'}).ensureWritable();
    documentStore.db.prepare("INSERT INTO document_configs(org,version,input) VALUES(NULL,1,'{}')").run();
    documentStore.close();
    documentStore=new DocumentStore(path,verifiedFcl);
    expect(()=>new DocumentWorkflowStore(documentStore,{...verifiedFcl,externalHandleProbe:()=>undefined})).toThrow('CHECK constraint failed');
    expect(documentStore.db.prepare('PRAGMA user_version').get()).toEqual({user_version:3});
    expect(documentStore.db.prepare("PRAGMA table_info('document_configs')").all()).toEqual(expect.arrayContaining([expect.objectContaining({name:'org',notnull:0}),expect.objectContaining({name:'input',notnull:1})]));
    expect(documentStore.db.prepare("PRAGMA table_info('document_configs')").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({name:'personal_owner_id'})]));
    expect(documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_configs WHERE org IS NULL').get()).toEqual({n:1});
    documentStore.close();
  });

  it('fails closed and preserves unknown v3 triggers instead of silently dropping them',()=>{
    const dir=root(),path=join(dir,'documents.sqlite');
    let documentStore=new DocumentStore(path);
    new DocumentWorkflowStore(documentStore,{oldWritersStopped:true,ownershipMode:'fresh-fixture'}).ensureWritable();
    documentStore.db.exec("CREATE TRIGGER unsupported_document_config_trigger AFTER UPDATE ON document_configs BEGIN SELECT 1; END;");
    documentStore.close();
    documentStore=new DocumentStore(path,verifiedFcl);
    expect(()=>new DocumentWorkflowStore(documentStore,{...verifiedFcl,externalHandleProbe:()=>undefined})).toThrow('workflow_schema_unsupported');
    expect(documentStore.db.prepare('PRAGMA user_version').get()).toEqual({user_version:3});
    expect(documentStore.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='unsupported_document_config_trigger'").get()).toEqual({name:'unsupported_document_config_trigger'});
    documentStore.close();
  });

  it('rejects an unknown v3 column without dropping its value',()=>{
    const dir=root(),path=join(dir,'documents.sqlite');
    let documentStore=new DocumentStore(path);
    new DocumentWorkflowStore(documentStore,{oldWritersStopped:true,ownershipMode:'fresh-fixture'}).ensureWritable();
    documentStore.db.prepare("INSERT INTO document_configs(org,version,input) VALUES('org-extra',1,'{}')").run();
    documentStore.db.exec("ALTER TABLE document_configs ADD COLUMN extra_note TEXT; UPDATE document_configs SET extra_note='must-keep' WHERE org='org-extra';");
    documentStore.close();
    documentStore=new DocumentStore(path,verifiedFcl);
    expect(()=>new DocumentWorkflowStore(documentStore,{...verifiedFcl,externalHandleProbe:()=>undefined})).toThrow('workflow_schema_unsupported');
    expect(documentStore.db.prepare('PRAGMA user_version').get()).toEqual({user_version:3});
    expect(documentStore.db.prepare("SELECT extra_note FROM document_configs WHERE org='org-extra'").get()).toEqual({extra_note:'must-keep'});
    documentStore.close();
  });

  it('rejects a v4 reopen when a required named index is missing',()=>{
    const dir=root(),path=join(dir,'documents.sqlite');
    let documentStore=new DocumentStore(path,freshFcl);
    service(documentStore).saveFclConfig(receiver,saveBody(),'fcl-document-index-0001');
    documentStore.db.exec('DROP INDEX document_revisions_document;');
    documentStore.close();
    documentStore=new DocumentStore(path,verifiedFcl);
    expect(()=>new DocumentWorkflowStore(documentStore,verifiedFcl)).toThrow('workflow_schema_unsupported');
    expect(documentStore.db.prepare('PRAGMA user_version').get()).toEqual({user_version:4});
    documentStore.close();
  });

  it('validates the clock on every write and rejects tampered audit timestamps',()=>{
    const dir=root(),documentStore=new DocumentStore(join(dir,'documents.sqlite'),freshFcl);
    let now='2026-09-20T12:00:00.000Z';
    const fcl=new DocumentWorkflowService(new DocumentWorkflowStore(documentStore,freshFcl),new DocumentService(documentStore,portal),portal,undefined,{receiverUserId:receiverId,receiverIsActive:()=>true,now:()=>now});
    now='not-a-time';
    expect(()=>fcl.saveFclConfig(receiver,saveBody(),'fcl-document-clock-0001')).toThrow('fcl_clock_invalid');
    expect(documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_configs').get()).toEqual({n:0});
    now='2026-09-20T12:00:00.000Z';
    documentStore.db.exec("CREATE TRIGGER fcl_audit_time_tamper AFTER INSERT ON document_idempotency BEGIN UPDATE document_audit SET created='2026-09-20T13:00:00.000Z'; END;");
    expect(()=>fcl.saveFclConfig(receiver,saveBody(),'fcl-document-clock-0002')).toThrow('document_readback_failed');
    expect(documentStore.db.prepare('SELECT COUNT(*) AS n FROM document_audit').get()).toEqual({n:0});
    documentStore.close();
  });

  it('keeps default v3 readers from opening a v4 database',()=>{
    const dir=root(),path=join(dir,'documents.sqlite');
    const documentStore=new DocumentStore(path,freshFcl);
    new DocumentWorkflowStore(documentStore,freshFcl);
    documentStore.close();
    expect(()=>new DocumentStore(path)).toThrow('portal_database_version_unsupported');
  });

  it('validates generated personal FCL schemas as closed Draft 2020-12 contracts',()=>{
    expect(fclConfigSchema.safeParse(fclInput()).success).toBe(true);
    expect(fclConfigSchema.safeParse({...fclInput(),issuer_email:'not-an-email'}).success).toBe(false);
    expect(fclConfigSchema.safeParse({...fclInput(),extra:true}).success).toBe(false);
  });
});
