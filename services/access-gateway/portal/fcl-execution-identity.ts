import {AsyncLocalStorage} from 'node:async_hooks';
import {z} from 'zod';
import {createAuthentikFclReceiverAuthority,type FclReceiverAuthority} from './fcl-receiver-authority';

export interface FclExecutionDirectory{
  run<T>(ids:readonly string[],operation:()=>T|Promise<T>):Promise<T>;
  isActive(id:string):boolean;
  verify(ids:readonly string[]):Promise<'active'|'inactive'|'unavailable'>;
}
export const fclExecutionDirectorySchema=z.object({people:z.array(z.object({user_id:z.uuid(),authority_url:z.url()}).strict()).min(1).max(200)}).strict();

/** Server-configured references to existing IdP users; this does not create accounts or grant Case access. */
export class VerifiedFclExecutionDirectory implements FclExecutionDirectory{
  private readonly context=new AsyncLocalStorage<ReadonlySet<string>>();
  constructor(private readonly authorities:ReadonlyMap<string,FclReceiverAuthority>){}
  isActive(id:string){return this.context.getStore()?.has(id)===true;}
  private async lookup(ids:readonly string[]){
    const unique=[...new Set(ids)];if(unique.length>128)throw new Error('fcl_execution_directory_limit');
    const active=new Set<string>();let unavailable=false;
    for(let i=0;i<unique.length;i+=8)await Promise.all(unique.slice(i,i+8).map(async id=>{
      const authority=this.authorities.get(id);if(!authority)return;
      try{await authority.runVerified(proof=>{if(proof.sub===id&&proof.active&&proof.emailVerified)active.add(id);});}
      catch(error){if(!(error instanceof Error)||error.message!=='fcl_receiver_authority_denied')unavailable=true;}
    }));
    return {active,unavailable,total:unique.length};
  }
  async run<T>(ids:readonly string[],operation:()=>T|Promise<T>):Promise<T>{
    const result=await this.lookup(ids);if(result.unavailable)throw new Error('fcl_execution_authority_unavailable');
    return this.context.run(result.active,operation);
  }
  async verify(ids:readonly string[]){const result=await this.lookup(ids);return result.unavailable?'unavailable':result.active.size===result.total?'active':'inactive';}
}
export function createAuthentikExecutionDirectory(input:unknown,issuer:string,token:string){
  const config=fclExecutionDirectorySchema.parse(input);
  if(new Set(config.people.map(person=>person.user_id)).size!==config.people.length)throw new Error('fcl_execution_directory_invalid');
  return new VerifiedFclExecutionDirectory(new Map(config.people.map(person=>[person.user_id,createAuthentikFclReceiverAuthority({expectedSub:person.user_id,oidcIssuer:issuer,endpoint:person.authority_url,token})])));
}
