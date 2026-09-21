import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFclInquiryDraft} from '../../apps/inquiry/fcl-model';
import {createPortalHttpHandler} from '../../services/access-gateway/portal/http';
import {FixturePortalIdentityProvider} from '../../services/access-gateway/portal/identity';
import {InMemoryPortalSessionStore,PortalSessionManager} from '../../services/access-gateway/portal/session';
import {CaseService,CaseStore} from '../../services/access-gateway/portal/cases';
import {NativeAdminService,NativeAdminStore} from '../../services/access-gateway/portal/native-admin';
import {DocumentService,DocumentStore} from '../../services/quote-documents/service';
import {DocumentWorkflowService,DocumentWorkflowStore} from '../../services/quote-documents/workflow';
import {FclQuoteService} from '../../services/quote-native/fcl';
import {FCL_RATE_DATASET_VERSION,type FclRateDataset} from '../../services/quote-native/fcl-contracts';
import type {PortalContext} from '../../services/access-gateway/portal/contracts';

export const fclCliReceiverId='fixture-fcl-receiver';
const fresh={fcl:{mode:'fresh_fixture',authorized:true,oldWritersStopped:true}} as const;
const publicSecret='synthetic-public-session-secret-32-bytes';
const receiver:PortalContext={organizationId:null,identity:{userId:fclCliReceiverId,displayName:'FCL receiver',email:'fcl-receiver@example.test',emailVerified:true,platformRole:null}};
const portal={getState:()=>({data:{current_organization:null,memberships:[]}})};

export function fclCliInquiry(){
  return {...createFclInquiryDraft(),origin_city:'Shenzhen',pol:'Yantian',pod:'Vancouver',final_destination:'Toronto',cargo_name:'Synthetic cargo',containers:[{type:'40HQ' as const,quantity:1}],cargo_type:'general' as const,estimated_weight:{value:'18000',unit:'kg' as const},cargo_ready_date:'2026-10-08',incoterm:'EXW' as const,selected_services:['ocean_freight'] as const,contact:{name:'Synthetic',company:null,email:'shipper@example.test',phone:null},notes:null,consent:true};
}

export function fclCliRates():FclRateDataset{
  return {contract_version:FCL_RATE_DATASET_VERSION,label:'CLI rates',rates:[{rate_id:'00000000-0000-4000-8000-000000000201',supplier_label:'Carrier',pol:'Yantian',pod:'Vancouver',valid_from:'2026-10-01',valid_until:'2026-10-15',source_ref:'synthetic:cli-rate',source_version:'v1',note:null,items:[{container_type:'40HQ',ocean_freight:'3200',currency:'USD'}],additional_fees:[]}]};
}

export async function createFclCliFixture(){
  const root=mkdtempSync(join(tmpdir(),'fcl-cli-red-')),caseStore=new CaseStore(join(root,'cases.sqlite'),fresh),rateStore=new NativeAdminStore(join(root,'rates.sqlite'),fresh),documentStore=new DocumentStore(join(root,'documents.sqlite'),fresh),workflowStore=new DocumentWorkflowStore(documentStore,fresh);
  const caseService=new CaseService(caseStore,portal as never,{receiverUserId:fclCliReceiverId,receiverIsActive:()=>true,credentialSecret:'synthetic-fcl-credential-secret-32-bytes',credentialTtlDays:30,now:()=> '2026-10-08T12:00:00.000Z',mail:{enabled:false}});
  const rateService=new NativeAdminService(rateStore,portal as never,{receiverUserId:fclCliReceiverId,receiverIsActive:()=>true,now:()=> '2026-10-08T12:00:00.000Z'});
  const quoteService=new FclQuoteService({caseReader:caseService,rateReader:rateService,now:()=> '2026-10-08T12:00:00.000Z'});
  const documentWorkflow=new DocumentWorkflowService(workflowStore,new DocumentService(documentStore,portal as never),portal as never,()=>Promise.resolve(Buffer.from('%PDF-1.7\n'+'.'.repeat(120))),{receiverUserId:fclCliReceiverId,receiverIsActive:()=>true,now:()=> '2026-10-08T12:00:00.000Z'},{quoteService,caseReader:caseService,caseLock:caseService,rateLock:rateService,rateReader:rateService,handoff:caseService});
  const sessions=new PortalSessionManager({store:new InMemoryPortalSessionStore(),secureCookie:false,canSelectPersonal:identity=>{try{caseService.listFclCases({identity,organizationId:null},{limit:1,status:null,cursor:null});return true;}catch{return false;}}});
  const state:{handler?:ReturnType<typeof createPortalHttpHandler>}={};
  const server=createServer((request,response)=>{void state.handler?.handle(request,response);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  state.handler=createPortalHttpHandler({mode:'fixtures',service:portal as never,caseService,nativeAdmin:rateService,documentWorkflowService:documentWorkflow,identityProvider:new FixturePortalIdentityProvider({mode:'fixtures',loopback:true}),sessions,allowedHosts:[new URL(origin).host],allowedOrigins:[origin],allowLoopbackHttp:true,fcl:{caseService,nativeAdmin:rateService,documentWorkflow,publicSessionSecret:publicSecret,businessDate:()=> '2026-10-08',secureCookie:false}});
  const staffSessionFile=async(filename:string,identityId=fclCliReceiverId)=>{
    const boot=await fetch(origin+'/console/api/v1/session'),bootBody=await boot.json() as {csrf_token:string};
    const logged=await fetch(origin+'/console/api/v1/fixture-login',{method:'POST',headers:{cookie:boot.headers.get('set-cookie')!.split(';')[0]!,origin,'x-csrf-token':bootBody.csrf_token,'idempotency-key':`fcl-cli-login-${identityId}`,'content-type':'application/json'},body:JSON.stringify({identity_id:identityId})});
    if(logged.status!==200)throw new Error(`fcl_cli_staff_login_${logged.status}`);
    const loggedBody=await logged.json() as {csrf_token:string};
    writeFileSync(filename,JSON.stringify({origin,session_token:logged.headers.get('set-cookie')!.split('=')[1]!.split(';')[0]!,csrf_token:loggedBody.csrf_token,expires_at:Date.now()+1_800_000}),{mode:0o600});
  };
  return {root,origin,receiver,caseService,rateService,staffSessionFile,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));workflowStore.close();documentStore.close();rateStore.close();caseStore.close();rmSync(root,{recursive:true,force:true});}};
}
