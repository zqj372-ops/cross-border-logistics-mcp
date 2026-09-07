import { it, expect } from 'vitest';
import { CliAuthorization } from '../../services/access-gateway/portal/cli-auth';
import { PortalSessionManager, InMemoryPortalSessionStore } from '../../services/access-gateway/portal/session';
it('requires browser confirmation, never returns its cookie, consumes once and expires pending requests',()=>{
 let now=1000;const sessions=new PortalSessionManager({store:new InMemoryPortalSessionStore(),now:()=>now,secureCookie:false});const auth=new CliAuthorization(sessions,()=>now);
 const browser=sessions.authenticate(sessions.ensure(null).session.sessionId,{userId:'user',displayName:'User',email:'user@example.test',emailVerified:true,platformRole:null}).session;
 const start=auth.start('127.0.0.1');expect(auth.poll(start.device_secret).state).toBe('pending');
 expect(()=>auth.approve(start.user_code,sessions.ensure(null).session)).toThrow('authentication_required');
 auth.approve(start.user_code,browser);const result=auth.poll(start.device_secret);expect(result.state).toBe('authorized');if(result.state==='authorized'){expect(result.session_token).not.toBe(browser.sessionId);expect(sessions.get(result.session_token)?.identity?.userId).toBe('user');sessions.logout(result.session_token);expect(sessions.get(result.session_token)).toBeNull();expect(sessions.get(browser.sessionId)?.identity?.userId).toBe('user');}
 expect(()=>auth.poll(start.device_secret)).toThrow('cli_request_not_found');
 const next=auth.start('127.0.0.1');now+=301000;expect(()=>auth.approve(next.user_code,browser)).toThrow('cli_request_not_found');
});
it('revoked browser approval cannot mint a session and bounded start requests recover after expiry',()=>{
 let now=1000;const sessions=new PortalSessionManager({store:new InMemoryPortalSessionStore(),now:()=>now,secureCookie:false});const auth=new CliAuthorization(sessions,()=>now);
 const browser=sessions.authenticate(sessions.ensure(null).session.sessionId,{userId:'user',displayName:'User',email:'user@example.test',emailVerified:true,platformRole:null}).session;
 const start=auth.start('local');auth.approve(start.user_code,browser);expect(()=>auth.approve(start.user_code,browser)).toThrow('cli_request_conflict');sessions.logout(browser.sessionId);expect(()=>auth.poll(start.device_secret)).toThrow('cli_approval_expired');
 for(let n=0;n<9;n++)auth.start('local');expect(()=>auth.start('local')).toThrow('cli_rate_limited');now+=600001;expect(auth.start('local').user_code).toMatch(/^[A-F0-9]{8}$/u);
});

it('caps CLI credentials at thirty minutes even when browser sessions last longer',()=>{let now=1000;const sessions=new PortalSessionManager({store:new InMemoryPortalSessionStore(),now:()=>now,ttlMs:86400000});const auth=new CliAuthorization(sessions,()=>now);const browser=sessions.authenticate(sessions.ensure(null).session.sessionId,{userId:'user',displayName:'User',email:'user@example.test',emailVerified:true,platformRole:null}).session;const start=auth.start('local');auth.approve(start.user_code,browser);const result=auth.poll(start.device_secret);expect(result.state).toBe('authorized');if(result.state==='authorized'){expect(result.expires_at).toBe(now+1800000);now+=1800001;expect(sessions.get(result.session_token)).toBeNull();expect(sessions.get(browser.sessionId)).not.toBeNull();}});
