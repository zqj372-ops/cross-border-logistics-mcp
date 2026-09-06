import { Worker } from "node:worker_threads";
import type { PostgresGatewayConfiguration } from "../postgres-store";
import type { PortalData, PortalRepository } from "./store";
import type { BusinessAccessRepository } from "./business-access/store";
import { BusinessAccessStoreError } from "./business-access/store";
import type { BusinessAccessData } from "./business-access/contracts";
import type { PortalSession, PortalSessionStore } from "./session";
import type { PortalOidcTransaction } from "./identity";

const MAX_BYTES=8*1024*1024;
class SharedStoreConnection {
  worker: Worker;
  failed=false;retryAfter=0;
  readonly configuration:PostgresGatewayConfiguration;readonly workerUrl:URL;
  readonly timeout: number;
  closed=false;
  transaction=false;
  constructor(configuration:PostgresGatewayConfiguration,workerUrl:URL,initialize=false){
    this.configuration=configuration;this.workerUrl=workerUrl;
    this.timeout=Math.min(60_000,configuration.connectionTimeoutMillis+configuration.statementTimeoutMillis+5000);
    this.worker=this.startWorker();
    try{this.call({op:"init",initialize});}catch(error){this.close();throw error;}
  }
  startWorker(){const worker=new Worker(this.workerUrl,{workerData:this.configuration,execArgv:[]});worker.unref();worker.on("error",()=>{if(this.worker===worker){this.failed=true;this.retryAfter=Date.now()+1000;}});return worker;}
  call<T>(command:Record<string,unknown>):T {
    if(this.closed)throw new Error("portal_shared_store_unavailable");
    if(this.failed){if(Date.now()<this.retryAfter)throw new Error("portal_shared_store_unavailable");void this.worker.terminate();this.worker=this.startWorker();this.failed=false;try{this.call({op:"init"});}catch(error){this.failed=true;this.retryAfter=Date.now()+1000;throw error;}}
    if(Buffer.byteLength(JSON.stringify(command))>MAX_BYTES)throw new Error("portal_shared_payload_limit");
    const buffer=new SharedArrayBuffer(MAX_BYTES+8),control=new Int32Array(buffer,0,2);
    this.worker.postMessage({command,buffer});
    if(Atomics.wait(control,0,0,this.timeout)==="timed-out"){void this.worker.terminate();this.failed=true;this.retryAfter=Date.now()+1000;throw new Error("portal_shared_store_unavailable");}
    const response=JSON.parse(Buffer.from(new Uint8Array(buffer,8,Atomics.load(control,1))).toString("utf8")) as {ok:boolean;value:T;code?:string};
    if(!response.ok)throw new Error(response.code??"portal_shared_store_unavailable");
    return response.value;
  }
  mutate<D,T>(kind:"portal"|"business",mutate:(data:D)=>T,idempotency?:{action:string;key:string;hash:string}):{value:T;replayed:boolean}{
    if(this.transaction)throw new Error("portal_shared_transaction_reentrant");
    if(idempotency&&!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(idempotency.key))throw new Error("idempotency_key_invalid");
    this.transaction=true;
    try {
      const begun=this.call<{replayed:boolean;result:T;data:D}>({op:"begin",kind,...idempotency});
      if(begun.replayed)return {value:begun.result,replayed:true};
      const result=mutate(begun.data);
      if(result instanceof Promise)throw new Error("portal_shared_async_mutation_invalid");
      this.call({op:"commit",kind,data:begun.data,result,...idempotency});
      return {value:result,replayed:false};
    }catch(error){try{this.call({op:"rollback"});}catch{/* Connection failures roll back in PostgreSQL. */}throw error;}
    finally{this.transaction=false;}
  }
  close(){if(this.closed)return;this.closed=true;void this.worker.terminate();}
}

/** Shared PostgreSQL authority with no process-local authorization cache. */
export class PostgresPortalStores {
  readonly portal:PortalRepository;
  readonly business:BusinessAccessRepository;
  readonly sessions:PortalSessionStore & {close():void};
  readonly #connection:SharedStoreConnection;
  constructor(options:{configuration:PostgresGatewayConfiguration;workerUrl?:URL;initialize?:boolean}){
    const db=new SharedStoreConnection(options.configuration,options.workerUrl??new URL("./postgres-worker.mjs",import.meta.url),options.initialize);this.#connection=db;
    this.portal={kind:"production",read:()=>db.call<PortalData>({op:"read",kind:"portal"}),transact:<T>(action:string,key:string,hash:string,mutate:(data:PortalData)=>T)=>db.mutate("portal",mutate,{action,key,hash}).value,close:()=>{}};
    this.business={kind:"production",read:()=>db.call<BusinessAccessData>({op:"read",kind:"business"}),transact:<T>(action:string,key:string,hash:string,mutate:(data:BusinessAccessData)=>T)=>db.mutate("business",mutate,{action,key,hash}),close:()=>{},recordUse:(id,now)=>{
      db.mutate<BusinessAccessData,boolean>("business",data=>{const credential=data.credentials.find(x=>x.credentialId===id);if(!credential||credential.status!=="active"||credential.deliveryStatus!=="acknowledged"||credential.expiresAt<=now)throw new BusinessAccessStoreError("business_authorization_denied");const usedAt=new Date(now*1000).toISOString();if(!credential.lastUsedAt||credential.lastUsedAt<usedAt)credential.lastUsedAt=usedAt;return true;});
    }};
    this.sessions={kind:"persistent",get:id=>db.call<PortalSession|null>({op:"session-get",id}),put:s=>{db.call({op:"session-put",id:s.sessionId,data:s,expires:s.expiresAt});},delete:id=>{db.call({op:"session-delete",id});},replace:(id,csrf,next)=>db.call<boolean>({op:"session-replace",id,csrf,data:next,expires:next.expiresAt}),consumeOidc:(id,state,now)=>db.call<PortalOidcTransaction|null>({op:"session-consume",id,state,now}),close:()=>{}};
  }
  close(){this.#connection.close();}
}
