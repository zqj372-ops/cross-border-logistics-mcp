import { createHash, randomBytes } from 'node:crypto';
import { PortalError } from './contracts';
import type { PortalSessionManager, PortalSession } from './session';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
type Pending={code:string;expires:number;approved:PortalSession|null;address:string};
// Pending approvals are process-local and expire on restart. Issued sessions use
// the existing session store and never copy the browser's own session token.
export class CliAuthorization{
 private pending=new Map<string,Pending>();
 private starts=new Map<string,{n:number;expires:number}>();
 constructor(private sessions:PortalSessionManager,private now=Date.now){}
 private prune(){for(const[k,v]of this.pending)if(v.expires<=this.now())this.pending.delete(k);for(const[k,v]of this.starts)if(v.expires<=this.now())this.starts.delete(k);}
 start(address:string){this.prune();const count=this.starts.get(address)??{n:0,expires:this.now()+600000};if(count.n>=10||this.pending.size>=1000)throw new PortalError('cli_rate_limited');count.n++;this.starts.set(address,count);const secret=randomBytes(32).toString('base64url');let code:string;do{code=randomBytes(4).toString('hex').toUpperCase();}while([...this.pending.values()].some(p=>p.code===code));this.pending.set(digest(secret),{code,expires:this.now()+300000,approved:null,address});return {device_secret:secret,user_code:code,expires_in:300};}
 private lookup(code:string){this.prune();const p=[...this.pending.values()].find(v=>v.code===code);if(!p)throw new PortalError('cli_request_not_found');return p;}
 inspect(code:string){const p=this.lookup(code);return {user_code:p.code,state:p.approved?'approved':'pending',expires_in:Math.max(0,Math.floor((p.expires-this.now())/1000))};}
 approve(code:string,browser:PortalSession){if(!browser.identity?.emailVerified||!this.sessions.get(browser.sessionId))throw new PortalError('authentication_required');const p=this.lookup(code);if(p.approved)throw new PortalError('cli_request_conflict');p.approved=browser;return {state:'approved'};}
 poll(secret:string):{state:'pending'}|{state:'authorized';session_token:string;csrf_token:string;expires_at:number}{this.prune();const key=digest(secret),p=this.pending.get(key);if(!p)throw new PortalError('cli_request_not_found');if(!p.approved)return {state:'pending'};this.pending.delete(key);const browser=this.sessions.get(p.approved.sessionId);if(!browser?.identity||browser.csrfToken!==p.approved.csrfToken)throw new PortalError('cli_approval_expired');const fresh=this.sessions.authenticate(this.sessions.ensure(null).session.sessionId,browser.identity).session;const session={...fresh,organizationId:browser.organizationId};this.sessions.store.put(session);return {state:'authorized',session_token:session.sessionId,csrf_token:session.csrfToken,expires_at:session.expiresAt};}
}
