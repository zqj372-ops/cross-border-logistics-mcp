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
}

export interface ProductionFclComposition{
  readonly caseService:CaseService;
  readonly nativeAdmin:NativeAdminService;
  readonly documentService:DocumentService;
  readonly documentWorkflow:DocumentWorkflowService;
  readonly fcl:FclHttpDependencies;
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
    const nativeAdmin=new NativeAdminService(options.nativeStore,options.portal,{receiverUserId:options.receiverSub,receiverIsActive,now});
    const caseService=new CaseService(options.caseStore,options.portal,{receiverUserId:options.receiverSub,receiverIsActive,credentialSecret:options.caseCredentialSecret,credentialTtlDays:30,now,mail:{enabled:false},notificationSettings:()=>{const view=nativeAdmin.getFclNotification(receiverContext);return view.input?{...view.input,transport:options.mailTransport,timeoutMs:FCL_SMTP_NOTIFICATION_TIMEOUT_MS}:null;}});
    const quoteService=new FclQuoteService({caseReader:caseService,rateReader:nativeAdmin,now});
    const documentService=new DocumentService(options.documentStore,options.portal,undefined,options.nativeBusiness,caseService);
    const renderer=(html:string)=>renderFclPdfWithFreshAuthority(renderPdf,options.authority,options.receiverSub,html);
    const documentWorkflow=new DocumentWorkflowService(options.documentWorkflowStore,documentService,options.portal,renderer,{receiverUserId:options.receiverSub,receiverIsActive,now},{quoteService,caseReader:caseService,caseLock:caseService,rateLock:nativeAdmin,rateReader:nativeAdmin,handoff:caseService});
    return Object.freeze({
      caseService,
      nativeAdmin,
      documentService,
      documentWorkflow,
      fcl:Object.freeze({caseService,nativeAdmin,documentWorkflow,publicSessionSecret:options.publicSessionSecret,businessDate:options.businessDate??(()=>new Date().toISOString().slice(0,10)),receiverAuthority:options.authority,receiverUserId:options.receiverSub}),
    });
  });
}
