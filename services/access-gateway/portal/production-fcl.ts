import {FclExecutionService} from './fcl-execution';
import {FclExecutionMailService} from './fcl-execution-mail';
import {FclExecutionHttpService} from './fcl-execution-http';
import type {FclExecutionDirectory} from './fcl-execution-identity';
import type {CaseStore} from './cases';
import {CaseService,type FclMailTransport} from './cases';
import type {NativeAdminStore} from './native-admin';
import {NativeAdminService} from './native-admin';
import type {DocumentStore} from '../../quote-documents/service';
import {DocumentService} from '../../quote-documents/service';
import type {DocumentWorkflowStore} from '../../quote-documents/workflow';
import {DocumentWorkflowService} from '../../quote-documents/workflow';
import {renderPdf} from '../../quote-documents/renderer';
import {FclQuoteService} from '../../quote-native/fcl';
import type {PortalService} from './service';
import type {PortalContext} from './contracts';
import type {FclHttpDependencies} from './fcl-http';
import type {PortalBusinessService} from './business/service';
import type {QuoteRelease} from '../../quote-native/client';
import {currentFclReceiverAuthorized,type FclReceiverAuthority} from './fcl-receiver-authority';
import {FCL_SMTP_NOTIFICATION_TIMEOUT_MS} from './fcl-smtp-transport';

export interface ProductionFclCompositionOptions{
  readonly portal:Pick<PortalService,'getState'>;
  readonly caseStore:CaseStore;
  readonly nativeStore:NativeAdminStore;
  readonly documentStore:DocumentStore;
  readonly documentWorkflowStore:DocumentWorkflowStore;
  readonly receiverSub:string;
  readonly authority:FclReceiverAuthority;
  readonly mailTransport:FclMailTransport;
  readonly caseCredentialSecret:string;
  readonly publicSessionSecret:string;
  readonly nativeBusiness?:{business:Pick<PortalBusinessService,'execute'>;current:(org:string)=>QuoteRelease|null};
  readonly now?:()=>string;
  readonly businessDate?:()=>string;
  readonly executionDirectory?:FclExecutionDirectory;
  readonly publicOrigin?:string;
}

export interface ProductionFclComposition{
  readonly caseService:CaseService;
  readonly nativeAdmin:NativeAdminService;
  readonly documentService:DocumentService;
  readonly documentWorkflow:DocumentWorkflowService;
  readonly fcl:FclHttpDependencies;
  readonly close:()=>Promise<void>;
}

export async function renderFclPdfWithFreshAuthority(renderer:(html:string)=>Promise<Buffer>,authority:FclReceiverAuthority,receiverSub:string,html:string):Promise<Buffer>{
  const bytes=await renderer(html);
  if(currentFclReceiverAuthorized(receiverSub,receiverSub))await authority.runVerified(()=>undefined);
  return bytes;
}

export async function composeProductionFcl(options:ProductionFclCompositionOptions):Promise<ProductionFclComposition>{
  const now=options.now??(()=>new Date().toISOString());
  const receiverContext:PortalContext={organizationId:null,identity:{userId:options.receiverSub,displayName:'FCL receiver',email:'fcl-receiver@internal.invalid',emailVerified:true,platformRole:null}};
  // Non-receiver accounts enter via the normal authenticated Portal session.
  // The anonymous intake receiver retains its separate live authority check.
  const receiverIsActive=(userId:string)=>userId!==options.receiverSub||currentFclReceiverAuthorized(userId,options.receiverSub);
  return options.authority.runVerified(()=>{
    const nativeAdmin=new NativeAdminService(options.nativeStore,options.portal,{receiverUserId:options.receiverSub,receiverIsActive,now,executionIsActive:id=>options.executionDirectory?.isActive(id)===true,mailConfigured:()=>Boolean(options.mailTransport),mailTransport:options.mailTransport});
    const caseService=new CaseService(options.caseStore,options.portal,{receiverUserId:options.receiverSub,receiverIsActive,credentialSecret:options.caseCredentialSecret,credentialTtlDays:30,now,mail:{enabled:false},notificationSettings:()=>{const view=nativeAdmin.getFclNotification(receiverContext);return view.input?{...view.input,transport:options.mailTransport,timeoutMs:FCL_SMTP_NOTIFICATION_TIMEOUT_MS}:null;}});
    let lifecycleMail:FclExecutionMailService|undefined;
    const quoteService=new FclQuoteService({caseReader:caseService,rateReader:nativeAdmin,now});
    const documentService=new DocumentService(options.documentStore,options.portal,undefined,options.nativeBusiness,caseService);
    const renderer=(html:string)=>renderFclPdfWithFreshAuthority(renderPdf,options.authority,options.receiverSub,html);
    const documentWorkflow=new DocumentWorkflowService(options.documentWorkflowStore,documentService,options.portal,renderer,{receiverUserId:options.receiverSub,receiverIsActive,now},{quoteService,caseReader:caseService,caseLock:caseService,rateLock:nativeAdmin,rateReader:nativeAdmin,handoff:caseService,onDecision:(ctx,payload,eventId,kind)=>{lifecycleMail?.enqueueCaseEvent({event_id:eventId,case_ref:payload.case_binding.case_ref,owner_id:ctx.identity.userId,case_version:payload.case_binding.case_version,kind,status:payload.state});}});
    let executionHttp:FclExecutionHttpService|undefined,stopWorker:(()=>Promise<void>)|undefined;
    if(options.caseStore.executionEnabled){
      if(!options.executionDirectory)throw new Error('fcl_execution_directory_not_configured');
      if(!options.publicOrigin)throw new Error('fcl_execution_public_origin_not_configured');
      const directory=options.executionDirectory;
      const execution=new FclExecutionService(caseService,{now,isActive:id=>directory.isActive(id),configuration:ctx=>nativeAdmin.getFclNotificationV2(ctx),onEvent:(value,event)=>mail.enqueue(value,event)});
      const mail:FclExecutionMailService=new FclExecutionMailService(execution,{publicOrigin:options.publicOrigin,configuration:owner=>nativeAdmin.readFclNotificationForDispatch(owner),now,transport:options.mailTransport,verifyUsers:ids=>directory.verify(ids)});
      lifecycleMail=mail;caseService.setFclEventObserver(event=>mail.enqueueCaseEvent(event));
      executionHttp=new FclExecutionHttpService(execution,documentWorkflow,nativeAdmin,mail,directory);
      stopWorker=mail.startWorker();
    }
    return Object.freeze({
      close:async()=>{await stopWorker?.();},
      caseService,
      nativeAdmin,
      documentService,
      documentWorkflow,
      fcl:Object.freeze({...(executionHttp?{execution:executionHttp}:{}),caseService,nativeAdmin,documentWorkflow,publicSessionSecret:options.publicSessionSecret,businessDate:options.businessDate??(()=>new Date().toISOString().slice(0,10)),receiverAuthority:options.authority,receiverUserId:options.receiverSub}),
    });
  });
}
