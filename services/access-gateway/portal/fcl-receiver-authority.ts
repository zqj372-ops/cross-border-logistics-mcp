import {AsyncLocalStorage} from 'node:async_hooks';
import {z} from 'zod';

const uuid=z.string().uuid();
const authorityResponseSchema=z.object({
  uuid,
  is_active:z.boolean(),
  attributes:z.object({email_verified:z.boolean()}).passthrough(),
}).passthrough();

export interface FclReceiverProof{
  readonly sub:string;
  readonly active:true;
  readonly emailVerified:true;
}

export interface FclReceiverAuthority{
  runVerified<T>(operation:(proof:FclReceiverProof)=>T|Promise<T>):Promise<T>;
}

export interface AuthentikFclReceiverAuthorityOptions{
  readonly expectedSub:string;
  readonly oidcIssuer:string|URL;
  readonly endpoint:string|URL;
  readonly token:string;
  readonly fetch?:typeof fetch;
  readonly timeoutMs?:number;
  readonly maxResponseBytes?:number;
}

const context=new AsyncLocalStorage<FclReceiverProof>();

export function currentFclReceiverAuthorized(userId:string,expectedSub:string):boolean{
  const proof=context.getStore();
  return proof?.active===true&&proof.emailVerified===true&&proof.sub===expectedSub&&userId===expectedSub;
}

export function runWithVerifiedFclReceiver<T>(proof:FclReceiverProof,operation:()=>T):T{
  return context.run(proof,operation);
}

function endpoint(value:string|URL,oidcIssuer:string|URL):URL{
  let url:URL;
  try{url=new URL(value);}catch{throw new Error('fcl_receiver_authority_configuration_invalid');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^\/api\/v3\/core\/users\/[0-9]+\/$/u.test(url.pathname))throw new Error('fcl_receiver_authority_configuration_invalid');
  let issuer:URL;
  try{issuer=new URL(oidcIssuer);}catch{throw new Error('fcl_receiver_authority_configuration_invalid');}
  if(issuer.protocol!=='https:'||issuer.origin!==url.origin)throw new Error('fcl_receiver_authority_configuration_invalid');
  return url;
}

function unavailable(causeCode:'authority_response_invalid'|'authority_transport_failed'):never{
  throw new Error('fcl_receiver_authority_unavailable',{cause:new Error(causeCode)});
}

async function boundedJson(response:Response,maximum:number):Promise<unknown>{
  const contentType=response.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase();
  if(contentType!=='application/json')throw new Error('fcl_receiver_authority_unavailable');
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/u.test(declared)||Number(declared)>maximum))throw new Error('fcl_receiver_authority_unavailable');
  if(!response.body)throw new Error('fcl_receiver_authority_unavailable');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{
    for(;;){
      const part=await reader.read();if(part.done)break;
      size+=part.value.byteLength;
      if(size>maximum){await reader.cancel();throw new Error('fcl_receiver_authority_unavailable');}
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)),size).toString('utf8')) as unknown;
  }catch(error){
    if(error instanceof Error&&error.message==='fcl_receiver_authority_unavailable')throw error;
    unavailable('authority_response_invalid');
  }finally{reader.releaseLock();}
}

export class AuthentikFclReceiverAuthority implements FclReceiverAuthority{
  readonly #expectedSub:string;
  readonly #url:URL;
  readonly #token:string;
  readonly #fetch:typeof fetch;
  readonly #timeoutMs:number;
  readonly #maxResponseBytes:number;

  constructor(options:AuthentikFclReceiverAuthorityOptions){
    if(!uuid.safeParse(options.expectedSub).success)throw new Error('fcl_receiver_authority_configuration_invalid');
    if(options.token.length<1||options.token.length>4096)throw new Error('fcl_receiver_authority_configuration_invalid');
    const timeout=options.timeoutMs??2_000,maximum=options.maxResponseBytes??64*1024;
    if(!Number.isInteger(timeout)||timeout<100||timeout>5_000)throw new Error('fcl_receiver_authority_configuration_invalid');
    if(!Number.isInteger(maximum)||maximum<1_024||maximum>1024*1024)throw new Error('fcl_receiver_authority_configuration_invalid');
    this.#expectedSub=options.expectedSub;
    this.#url=endpoint(options.endpoint,options.oidcIssuer);
    this.#token=options.token;
    this.#fetch=options.fetch??fetch;
    this.#timeoutMs=timeout;
    this.#maxResponseBytes=maximum;
  }

  private async verify():Promise<FclReceiverProof>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.#timeoutMs);
    try{
      const response=await this.#fetch(this.#url,{method:'GET',redirect:'error',credentials:'omit',signal:controller.signal,headers:{
        accept:'application/json',
        authorization:`Bearer ${this.#token}`,
        'cache-control':'no-store',
      }});
      if(!response.ok)throw new Error('fcl_receiver_authority_unavailable');
      const parsed=authorityResponseSchema.safeParse(await boundedJson(response,this.#maxResponseBytes));
      if(!parsed.success)throw new Error('fcl_receiver_authority_unavailable');
      if(parsed.data.uuid!==this.#expectedSub||parsed.data.is_active!==true||parsed.data.attributes.email_verified!==true)throw new Error('fcl_receiver_authority_denied');
      return Object.freeze({sub:parsed.data.uuid,active:true,emailVerified:true});
    }catch(error){
      if(error instanceof Error&&(error.message==='fcl_receiver_authority_unavailable'||error.message==='fcl_receiver_authority_denied'))throw error;
      unavailable('authority_transport_failed');
    }finally{clearTimeout(timer);}
  }

  async runVerified<T>(operation:(proof:FclReceiverProof)=>T|Promise<T>):Promise<T>{
    const proof=await this.verify();
    return context.run(proof,()=>operation(proof));
  }
}

export function createAuthentikFclReceiverAuthority(options:AuthentikFclReceiverAuthorityOptions):FclReceiverAuthority{
  return new AuthentikFclReceiverAuthority(options);
}
