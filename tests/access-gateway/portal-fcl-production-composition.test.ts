import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {CaseStore,CaseService} from '../../services/access-gateway/portal/cases';
import {NativeAdminStore,NativeAdminService} from '../../services/access-gateway/portal/native-admin';
import {DocumentStore,DocumentService} from '../../services/quote-documents/service';
import {DocumentWorkflowStore,DocumentWorkflowService} from '../../services/quote-documents/workflow';
import {composeProductionFcl,renderFclPdfWithFreshAuthority} from '../../services/access-gateway/portal/production-fcl';
import {runWithVerifiedFclReceiver,type FclReceiverAuthority,type FclReceiverProof} from '../../services/access-gateway/portal/fcl-receiver-authority';
import type {FclMailTransport} from '../../services/access-gateway/portal/cases';

const sub='00000000-0000-4000-8000-000000000004';
const proof:FclReceiverProof={sub,active:true,emailVerified:true};
const portal={getState:()=>({data:{current_organization:null,memberships:[]}})} as never;
const mail:FclMailTransport={send:()=>undefined};

function finalStores(root:string){
  const casePath=join(root,'business-cases.sqlite'),nativePath=join(root,'native-business.sqlite'),documentPath=join(root,'quote-documents.sqlite');
  const caseInitial=new CaseStore(casePath,{fcl:{mode:'exclusive_verified',authorized:true,oldWritersStopped:true,assertExclusive:()=>undefined}});caseInitial.close();
  const nativeInitial=new NativeAdminStore(nativePath,{fcl:{mode:'exclusive_verified',authorized:true,oldWritersStopped:true,assertExclusive:()=>undefined}});nativeInitial.close();
  const documentInitial=new DocumentStore(documentPath,{fcl:{mode:'exclusive_verified',authorized:true,oldWritersStopped:true,assertExclusive:()=>undefined}});
  const workflowInitial=new DocumentWorkflowStore(documentInitial,{oldWritersStopped:true,ownershipMode:'existing-database',externalHandleProbe:()=>undefined,fcl:{mode:'exclusive_verified',authorized:true,oldWritersStopped:true,assertExclusive:()=>undefined}});workflowInitial.close();documentInitial.close();
  const documentStore=new DocumentStore(documentPath,{fcl:{mode:'reopen'}});
  return {
    caseStore:new CaseStore(casePath,{fcl:{mode:'reopen'}}),
    nativeStore:new NativeAdminStore(nativePath,{fcl:{mode:'reopen'}}),
    documentStore,
    documentWorkflowStore:new DocumentWorkflowStore(documentStore,{fcl:{mode:'reopen'}}),
  };
}

it('composes FCL-only services inside a fresh authority context and exposes them only through the FCL dependency',async()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-production-compose-'));let stores:ReturnType<typeof finalStores>|undefined;
  try{
    stores=finalStores(root);
    let calls=0;
    const authority:FclReceiverAuthority={runVerified:async operation=>{calls++;return runWithVerifiedFclReceiver(proof,()=>operation(proof));}};
    const composed=await composeProductionFcl({portal,caseStore:stores.caseStore,nativeStore:stores.nativeStore,documentStore:stores.documentStore,documentWorkflowStore:stores.documentWorkflowStore,receiverSub:sub,authority,mailTransport:mail,caseCredentialSecret:'c'.repeat(32),publicSessionSecret:'p'.repeat(32)});
    expect(calls).toBe(1);
    expect(composed.fcl).toMatchObject({receiverAuthority:authority});
    await authority.runVerified(()=>expect(composed.nativeAdmin.get({organizationId:null,identity:{userId:sub,displayName:'receiver',email:'receiver@example.test',emailVerified:true,platformRole:null}},'fcl')).toMatchObject({version:0,active_release:null}));
  }finally{
    for(const store of Object.values(stores??{}))store.close();
    rmSync(root,{recursive:true,force:true});
  }
});

it('opens migrated v5 stores without authority or mail when FCL routes are disabled',()=>{
  const root=mkdtempSync(join(tmpdir(),'fcl-production-disabled-'));let stores:ReturnType<typeof finalStores>|undefined;
  try{
    stores=finalStores(root);
    const caseService=new CaseService(stores.caseStore,portal);
    const nativeAdmin=new NativeAdminService(stores.nativeStore,portal);
    const documentService=new DocumentService(stores.documentStore,portal);
    const documentWorkflow=new DocumentWorkflowService(stores.documentWorkflowStore,documentService,portal);
    expect(caseService).toBeDefined();
    expect(nativeAdmin).toBeDefined();
    expect(documentWorkflow).toBeDefined();
    expect(stores.documentStore.db.prepare('PRAGMA user_version').get()).toEqual({user_version:5});
  }finally{
    for(const store of Object.values(stores??{}))store.close();
    rmSync(root,{recursive:true,force:true});
  }
});

it('rechecks authority after a long render and never passes bytes back when the receiver changed',async()=>{
  const bytes=Buffer.from('%PDF-1.7\nsynthetic');
  let calls=0;
  const authority:FclReceiverAuthority={runVerified:()=>{calls++;return Promise.reject(new Error('fcl_receiver_authority_denied'));}};
  await expect(runWithVerifiedFclReceiver(proof,()=>renderFclPdfWithFreshAuthority(()=>Promise.resolve(bytes),authority,sub,'<html/>'))).rejects.toThrow('fcl_receiver_authority_denied');
  expect(calls).toBe(1);
  await expect(renderFclPdfWithFreshAuthority(()=>Promise.resolve(bytes),authority,sub,'<html/>')).resolves.toEqual(bytes);
  expect(calls).toBe(1);
});
