import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { PortalError } from './contracts';
// Local acceptance credentials only. This class is never mounted in production.
const accounts:Readonly<Record<string,string>>={user:'fixture-sales',admin:'fixture-operator','sales@example.test':'fixture-sales','operator@example.test':'fixture-operator'};
const digest=(value:string)=>createHash('sha256').update(value).digest();
const glyphs:Record<string,string[]>={
 '2':['11110','00001','00001','01110','10000','10000','11111'],
 '3':['11110','00001','00001','01110','00001','00001','11110'],
 '4':['10010','10010','10010','11111','00010','00010','00010'],
 '5':['11111','10000','10000','11110','00001','00001','11110'],
 '6':['01110','10000','10000','11110','10001','10001','01110'],
 '7':['11111','00001','00010','00100','01000','01000','01000'],
 '8':['01110','10001','10001','01110','10001','10001','01110'],
 '9':['01110','10001','10001','01111','00001','00001','01110'],
};
function captchaImage(code:string){
 const noise=Array.from({length:12},()=>`<path d="M${randomInt(190)} ${randomInt(56)}L${randomInt(190)} ${randomInt(56)}" stroke="#c5cede" stroke-width="1"/>`).join('');
 const shapes=[...code].map((letter,index)=>`<g transform="translate(${12+index*34} ${12+randomInt(5)}) rotate(${randomInt(-9,10)} 10 14)" fill="#34405a">${glyphs[letter]!.flatMap((row,y)=>[...row].flatMap((pixel,x)=>pixel==='1'?[`<rect x="${x*4}" y="${y*4}" width="4.2" height="4.2"/>`]:[])).join('')}</g>`).join('');
 return 'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="190" height="56" viewBox="0 0 190 56"><rect width="190" height="56" fill="#f5f7fb"/>${noise}${shapes}</svg>`).toString('base64');
}
export class FixtureFormLogin {
 private challenges=new Map<string,{session:string;address:string;hash:Buffer;expires:number}>();
 private attempts=new Map<string,{count:number;expires:number}>();
 private now:()=>number;private code:()=>string;
 constructor(options:{now?:()=>number;code?:()=>string}={}){this.now=options.now??Date.now;this.code=options.code??(()=>Array.from({length:5},()=>String(randomInt(2,10))).join(''));}
 private prune(){for(const [id,c] of this.challenges)if(c.expires<=this.now())this.challenges.delete(id);for(const [id,c] of this.attempts)if(c.expires<=this.now())this.attempts.delete(id);}
 private allowed(address:string){this.prune();if((this.attempts.get(address)?.count??0)>=10||this.attempts.size>=1024)throw new PortalError('login_rate_limited');}
 challenge(session:string,address:string){
  this.allowed(address);for(const [id,c] of this.challenges)if(c.session===session)this.challenges.delete(id);
  if(this.challenges.size>=1024)throw new PortalError('login_rate_limited');
  const code=this.code(),id=randomUUID();this.challenges.set(id,{session,address,hash:digest(code),expires:this.now()+120000});
  return {captcha_id:id,image:captchaImage(code),expires_in:120};
 }
 verify(session:string,address:string,input:{account:string;password:string;captcha_id:string;captcha:string}){
  this.allowed(address);const challenge=this.challenges.get(input.captcha_id);this.challenges.delete(input.captcha_id);
  const attempt=this.attempts.get(address)??{count:0,expires:this.now()+600000};attempt.count++;this.attempts.set(address,attempt);
  const account=accounts[input.account.trim().toLowerCase()];
  const passwordValid=timingSafeEqual(digest(input.password),digest('FreightClaw2026!'));
  if(!challenge||challenge.session!==session||challenge.address!==address||challenge.expires<=this.now()||!timingSafeEqual(challenge.hash,digest(input.captcha.trim()))||!account||!passwordValid)throw new PortalError('login_invalid');
  this.attempts.delete(address);return account;
 }
}
