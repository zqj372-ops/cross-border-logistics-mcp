import { expect, it } from 'vitest';
import { FixtureFormLogin } from '../../services/access-gateway/portal/form-login';
it('validates credentials and one-use session-bound captcha, expires challenges and limits failures',()=>{
 let now=0;const login=new FixtureFormLogin({now:()=>now,code:()=> '23456'});
 const challenge=login.challenge('session-a','127.0.0.1');
 expect(JSON.stringify(challenge)).not.toContain('23456');
 expect(()=>login.verify('session-b','127.0.0.1',{account:'admin',password:'FreightClaw2026!',captcha_id:challenge.captcha_id,captcha:'23456'})).toThrow('login_invalid');
 const next=login.challenge('session-a','127.0.0.1');
 expect(login.verify('session-a','127.0.0.1',{account:'admin',password:'FreightClaw2026!',captcha_id:next.captcha_id,captcha:'23456'})).toBe('fixture-operator');
 expect(()=>login.verify('session-a','127.0.0.1',{account:'admin',password:'FreightClaw2026!',captcha_id:next.captcha_id,captcha:'23456'})).toThrow('login_invalid');
 const expired=login.challenge('session-a','127.0.0.1');now+=121000;
 expect(()=>login.verify('session-a','127.0.0.1',{account:'user',password:'FreightClaw2026!',captcha_id:expired.captcha_id,captcha:'23456'})).toThrow('login_invalid');
 for(let i=0;i<10;i++){const c=login.challenge('session-a','127.0.0.2');expect(()=>login.verify('session-a','127.0.0.2',{account:'admin',password:'wrong',captcha_id:c.captcha_id,captcha:'23456'})).toThrow('login_invalid');}
 expect(()=>login.challenge('new-session','127.0.0.2')).toThrow('login_rate_limited');
 now+=601000;const c=login.challenge('session-a','127.0.0.2');expect(login.verify('session-a','127.0.0.2',{account:'user',password:'FreightClaw2026!',captcha_id:c.captcha_id,captcha:'23456'})).toBe('fixture-sales');
});
