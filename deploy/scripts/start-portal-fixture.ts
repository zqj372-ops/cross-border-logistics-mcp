import {CustomsPackages} from '../../services/customs-native/packages';
import {DocumentStore,DocumentService} from '../../services/quote-documents/service';
import {DocumentWorkflowStore,DocumentWorkflowService} from '../../services/quote-documents/workflow';
import { NativeAdminStore, NativeAdminService } from '../../services/access-gateway/portal/native-admin';
import { NativeFreightcomService } from '../../services/access-gateway/portal/native-freightcom';
import { ChannelStore, ChannelService } from "../../services/access-gateway/portal/channels";
import { CaseStore, CaseService } from "../../services/access-gateway/portal/cases";
import { SqliteCallLogStore, PortalCallLogService, callRecorder } from "../../services/access-gateway/portal/call-log";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createPortalFixtureRuntime } from "../../services/access-gateway/portal/fixture";
import { createPortalMachineHttpHandler } from "../../services/access-gateway/portal/machine-http";
import { startPortalServer } from "../../services/access-gateway/portal/server";
import { createBusinessAccessFixture } from "../../services/access-gateway/portal/business-access/fixture";
import { createBusinessMachineHttpHandler } from "../../services/access-gateway/portal/business-access/http";
import { loadPortalBusinessService } from "../../services/access-gateway/portal/business/config";
import { createProductionT0HttpHandler } from "../../services/access-gateway/portal/t0-http";
import { FIXTURE_PORTAL_IDENTITIES } from "../../services/access-gateway/portal/identity";
import { FclQuoteService } from "../../services/quote-native/fcl";
import type {PortalContext} from "../../services/access-gateway/portal/contracts";
import {FclExecutionService} from '../../services/access-gateway/portal/fcl-execution';
import {FclExecutionMailService} from '../../services/access-gateway/portal/fcl-execution-mail';
import {FclExecutionHttpService} from '../../services/access-gateway/portal/fcl-execution-http';

function readOrCreatePrivateSecret(path:string):Buffer{
  if(!existsSync(path))writeFileSync(path,randomBytes(32),{mode:0o600,flag:"wx"});
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<32||stat.size>4096||(stat.mode&0o077)!==0)throw new Error("fcl_private_secret_invalid");
  return readFileSync(path);
}

async function startPersonalFclFixture(input:{databaseDirectory:string;port:number;origin:string;runtime:Awaited<ReturnType<typeof createPortalFixtureRuntime>>}):Promise<void>{
  const receiverIdentity=FIXTURE_PORTAL_IDENTITIES.find(item=>item.userId==="fixture-fcl-receiver");
  if(!receiverIdentity?.emailVerified)throw new Error("fcl_fixture_receiver_missing");
  const receiver:PortalContext={identity:receiverIdentity,organizationId:null};
  const options=(path:string)=>({fcl:existsSync(path)?{mode:"reopen" as const}:{mode:"fresh_fixture" as const,authorized:true as const,oldWritersStopped:true as const}});
  const casePath=resolve(input.databaseDirectory,"business-cases.sqlite"),ratePath=resolve(input.databaseDirectory,"native-business.sqlite"),documentPath=resolve(input.databaseDirectory,"quote-documents.sqlite");
  const caseOptions=options(casePath),rateOptions=options(ratePath),documentOptions=options(documentPath);
  const executionEnabled=process.env.PORTAL_FIXTURE_FCL_EXECUTION==='true';
  const caseStore=new CaseStore(casePath,{...caseOptions,...(executionEnabled?{execution:caseOptions.fcl}:{})}),rateStore=new NativeAdminStore(ratePath,rateOptions),documentStore=new DocumentStore(documentPath,documentOptions),workflowStore=new DocumentWorkflowStore(documentStore,documentOptions);
  try{
    const active=(userId:string)=>FIXTURE_PORTAL_IDENTITIES.some(identity=>identity.userId===userId&&identity.emailVerified);
    const mailTransport={send:()=>undefined};
    const rateService=new NativeAdminService(rateStore,input.runtime.service,{receiverUserId:receiverIdentity.userId,receiverIsActive:active,now:()=>"2026-10-08T12:00:00.000Z",executionIsActive:active,mailTransport,mailConfigured:()=>true});
    const credentialSecret=readOrCreatePrivateSecret(resolve(input.databaseDirectory,"fcl-case-credential.secret"));
    const caseService=new CaseService(caseStore,input.runtime.service,{receiverUserId:receiverIdentity.userId,receiverIsActive:active,credentialSecret,credentialTtlDays:30,now:()=>"2026-10-08T12:00:00.000Z",mail:{enabled:false},notificationSettings:()=>{
      const view=rateService.getFclNotification(receiver);
      return view.input?{...view.input,transport:{send:()=>undefined},timeoutMs:5000}:null;
    }});
    let lifecycleMail:FclExecutionMailService|undefined;
    const quoteService=new FclQuoteService({caseReader:caseService,rateReader:rateService,now:()=>"2026-10-08T12:00:00.000Z"});
    const documentService=new DocumentService(documentStore,input.runtime.service);
    const documentWorkflow=new DocumentWorkflowService(workflowStore,documentService,input.runtime.service,undefined,{receiverUserId:receiverIdentity.userId,receiverIsActive:active,now:()=>"2026-10-08T12:00:00.000Z"},{quoteService,caseReader:caseService,caseLock:caseService,rateLock:rateService,rateReader:rateService,handoff:caseService,onDecision:(ctx,payload,eventId,kind)=>{lifecycleMail?.enqueueCaseEvent({event_id:eventId,case_ref:payload.case_binding.case_ref,owner_id:ctx.identity.userId,case_version:payload.case_binding.case_version,kind,status:payload.state});}});
    const publicSessionSecret=readOrCreatePrivateSecret(resolve(input.databaseDirectory,"fcl-public-session.secret"));
    let executionHttp:FclExecutionHttpService|undefined,stopWorker:(()=>Promise<void>)|undefined;
    if(executionEnabled){
      const startedAt=Date.now(),now=()=>new Date(Date.parse('2026-10-08T12:00:00Z')+Date.now()-startedAt).toISOString();

      const execution=new FclExecutionService(caseService,{isActive:active,now,configuration:ctx=>rateService.getFclNotificationV2(ctx),onEvent:(progress,event)=>mail.enqueue(progress,event)});
      const mail:FclExecutionMailService=new FclExecutionMailService(execution,{publicOrigin:input.origin,configuration:owner=>rateService.readFclNotificationForDispatch(owner),transport:mailTransport,verifyUsers:ids=>Promise.resolve(ids.every(active)?'active':'inactive'),now});
      lifecycleMail=mail;caseService.setFclEventObserver(event=>mail.enqueueCaseEvent(event));
      executionHttp=new FclExecutionHttpService(execution,documentWorkflow,rateService,mail);stopWorker=mail.startWorker();
    }
    const server=await startPortalServer({caseService,documentService,documentWorkflowService:documentWorkflow,nativeAdmin:rateService,fcl:{caseService,nativeAdmin:rateService,documentWorkflow,publicSessionSecret,businessDate:()=>"2026-10-08",secureCookie:false,...(executionHttp?{execution:executionHttp}:{})},mode:"fixtures",service:input.runtime.service,port:input.port,staticDirectory:"dist/console"});
    console.log(`FreightClaw personal FCL fixture: ${server.origin}/inquiry/`);
    console.log("Synthetic business date: 2026-10-08; isolated local storage; no production credentials.");
    let closing=false;
    const close=async()=>{if(closing)return;closing=true;await server.close();await stopWorker?.();workflowStore.close();documentStore.close();rateStore.close();caseStore.close();await input.runtime.close();process.exitCode=0;};
    process.once("SIGINT",()=>{void close();});process.once("SIGTERM",()=>{void close();});
  }catch(error){workflowStore.close();documentStore.close();rateStore.close();caseStore.close();await input.runtime.close();throw error;}
}

if (!process.argv.includes("--fixtures")) throw new Error("explicit_fixtures_argument_required");
const port = Number(process.env.PORTAL_FIXTURE_PORT ?? "8882");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("fixture_port_invalid");
const origin = `http://127.0.0.1:${port}`;
const databaseDirectory = resolve(process.env.PORTAL_FIXTURE_DIRECTORY ?? ".runtime/console-fixture");
const personalFcl = process.env.PORTAL_FIXTURE_FCL_PERSONAL === "true";
const runtime = await createPortalFixtureRuntime({ databaseDirectory, ...(personalFcl?{mode:"fcl-personal" as const}:{}) });
const boundaries = { allowedHosts: [`127.0.0.1:${port}`], allowedOrigins: [origin] };
if(personalFcl){
  await startPersonalFclFixture({databaseDirectory,port,origin,runtime});
} else {
const callStore = new SqliteCallLogStore(resolve(databaseDirectory, "calls.sqlite"));
const channelStore = new ChannelStore(resolve(databaseDirectory, "business-channels.sqlite"));
const documentStore=new DocumentStore(resolve(databaseDirectory,"quote-documents.sqlite"));
const documentWorkflowStore=new DocumentWorkflowStore(documentStore,{oldWritersStopped:true,ownershipMode:'fresh-fixture'});
const nativeStore=new NativeAdminStore(resolve(databaseDirectory,"native-business.sqlite"));
nativeStore.packages=new CustomsPackages(nativeStore,runtime.service,resolve(databaseDirectory,'customs-inbox'));
const nativeFreightcom=new NativeFreightcomService(nativeStore,runtime.service);
const nativeConfig=resolve(databaseDirectory,"native-business-config.json");
if(!process.env.PORTAL_BUSINESS_CONFIG_FILE)writeFileSync(nativeConfig,JSON.stringify({connections:[{organizationId:"org_fixture",tenantId:"tenant_fixture",enabledOperations:["customs.query","customs.tax.estimate","quote.zone_preview","quote.ai_extract_preview","quote.freightcom_ltl.preview"],nativeCustoms:true,nativeQuote:true,nativeFreightcom:true}]}),{mode:0o600});
const caseStore = new CaseStore(resolve(databaseDirectory, "business-cases.sqlite"));
try {
  const businessService = await loadPortalBusinessService({ nativeStore,nativeFreightcom,nativeQuoteScript:resolve("dist/services/quote-native/run.py"),configPath:process.env.PORTAL_BUSINESS_CONFIG_FILE??nativeConfig, callRecorder: callRecorder(callStore), portalService: runtime.service, ...(process.env.PORTAL_BUSINESS_CONFIG_FILE ? { configPath: process.env.PORTAL_BUSINESS_CONFIG_FILE } : {}), allowLoopbackFixtures: true });
  const pepperPath = resolve(databaseDirectory, "business-fixture.pepper");
  if (!existsSync(pepperPath)) writeFileSync(pepperPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  const pepperStat = lstatSync(pepperPath);
  if (!pepperStat.isFile() || pepperStat.isSymbolicLink() || pepperStat.size !== 32 || (pepperStat.mode & 0o077) !== 0) throw new Error("business_fixture_pepper_invalid");
  const credentialPepper = readFileSync(pepperPath);
  const businessAccess = await createBusinessAccessFixture({ databasePath: resolve(databaseDirectory, "business-access.sqlite"), portalService: runtime.service, credentialPepper, operationAuthority: { isAvailable: (tenantId, operation) => businessService.isAvailable(tenantId, operation as never) }, tenantClientAuthority: { requireActive: (tenantId, clientId) => runtime.requireActiveTenantClient(tenantId, clientId) } });
  credentialPepper.fill(0);
  const unifiedBridge = runtime.createUnifiedBridge(businessAccess.service);
  const machine = createPortalMachineHttpHandler({ mode: "fixtures", bridge: unifiedBridge, ...boundaries });
  const t0Machine = createProductionT0HttpHandler({ mode: "fixtures", bridge: unifiedBridge, ...boundaries, trustedProxyAddresses: [] });
  const businessMachine = createBusinessMachineHttpHandler({ mode: "fixtures", service: businessAccess.service, executor: { execute: async (request) => businessService.executeMachine(request as never) }, ...boundaries, trustedProxyAddresses: [] });
  const caseService=new CaseService(caseStore, runtime.service);
  const documentService=new DocumentService(documentStore,runtime.service,undefined,{business:businessService,current:org=>nativeStore.current(org,'residential')},caseService);
  const documentWorkflowService=new DocumentWorkflowService(documentWorkflowStore,documentService,runtime.service);
  const server = await startPortalServer({customsPackages:nativeStore.packages, documentService, documentWorkflowService, nativeAdmin:new NativeAdminService(nativeStore,runtime.service),nativeFreightcom, channelService: new ChannelService(channelStore, runtime.service), caseService, mode: "fixtures", service: runtime.service, bridge: unifiedBridge, organizationBridge: runtime.organizationBridge, callLogService: new PortalCallLogService(callStore, runtime.service), businessService, businessAccessService: businessAccess.service, businessMachineHandler: { handle: (request,response) => t0Machine.handle(request,response)||businessMachine.handle(request,response) }, port, staticDirectory: "dist/console", machineHandler: machine });
  console.log(`FreightClaw local acceptance workspace: ${server.origin}/console/`);
  console.log("Isolated fixture identities and local storage. Business availability is verified per request.");
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await server.close(); await callStore.close(); documentStore.close(); caseStore.close(); channelStore.close(); nativeFreightcom.close(); nativeStore.close(); businessAccess.repository.close(); await runtime.close(); process.exitCode = 0; };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
} catch (error) { await callStore.close(); documentStore.close(); caseStore.close(); channelStore.close(); nativeFreightcom.close(); nativeStore.close(); await runtime.close(); throw error; }
}
