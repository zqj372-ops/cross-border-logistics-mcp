import {expect,it} from 'vitest';
import {
  AuthentikFclReceiverAuthority,
  currentFclReceiverAuthorized,
  type FclReceiverProof,
} from '../../services/access-gateway/portal/fcl-receiver-authority';

const sub='00000000-0000-4000-8000-000000000004';
const token='synthetic-authority-token';
const options={expectedSub:sub,oidcIssuer:'https://www.freightclaw.net/application/o/freightclaw-portal/',endpoint:`https://www.freightclaw.net/api/v3/core/users/4/`,token,timeoutMs:500,maxResponseBytes:4096};
const response=(body:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});

it('verifies the exact Authentik uuid, active flag and verified email only within the current async request',async()=>{
  const authority=new AuthentikFclReceiverAuthority({...options,fetch:()=>Promise.resolve(response({pk:4,uid:'different-hash',uuid:sub,is_active:true,attributes:{email_verified:true},extra:true}))});
  expect(currentFclReceiverAuthorized(sub,sub)).toBe(false);
  await expect(authority.runVerified(async(proof:FclReceiverProof)=>{
    expect(proof).toEqual({sub,active:true,emailVerified:true});
    expect(currentFclReceiverAuthorized(sub,sub)).toBe(true);
    await new Promise(resolve=>setTimeout(resolve,5));
    expect(currentFclReceiverAuthorized(sub,sub)).toBe(true);
  })).resolves.toBeUndefined();
  expect(currentFclReceiverAuthorized(sub,sub)).toBe(false);
});

it('isolates concurrent proofs and never trusts a shared boolean',async()=>{
  const other='00000000-0000-4000-8000-000000000005';
  const first=new AuthentikFclReceiverAuthority({...options,fetch:()=>Promise.resolve(response({uuid:sub,is_active:true,attributes:{email_verified:true}}))});
  const second=new AuthentikFclReceiverAuthority({...options,expectedSub:other,endpoint:'https://www.freightclaw.net/api/v3/core/users/5/',fetch:()=>Promise.resolve(response({uuid:other,is_active:true,attributes:{email_verified:true}}))});
  await Promise.all([
    first.runVerified(async()=>{await new Promise(resolve=>setTimeout(resolve,10));expect(currentFclReceiverAuthorized(sub,sub)).toBe(true);expect(currentFclReceiverAuthorized(other,sub)).toBe(false);}),
    second.runVerified(async()=>{expect(currentFclReceiverAuthorized(other,other)).toBe(true);expect(currentFclReceiverAuthorized(sub,other)).toBe(false);await new Promise(resolve=>setTimeout(resolve,10));expect(currentFclReceiverAuthorized(other,other)).toBe(true);}),
  ]);
});

it.each([
  ['inactive',{uuid:sub,is_active:false,attributes:{email_verified:true}}],
  ['unverified',{uuid:sub,is_active:true,attributes:{email_verified:false}}],
  ['wrong uuid',{uuid:'00000000-0000-4000-8000-000000000099',is_active:true,attributes:{email_verified:true}}],
])('rejects %s receiver state',async(_label,body)=>{
  const authority=new AuthentikFclReceiverAuthority({...options,fetch:()=>Promise.resolve(response(body))});
  await expect(authority.runVerified(()=>undefined)).rejects.toThrow('fcl_receiver_authority_denied');
});

it.each([
  ['non-2xx',()=>Promise.resolve(response({},503))],
  ['redirect rejected',(_url:URL|RequestInfo,init?:RequestInit)=>{expect(init?.redirect).toBe('error');return Promise.resolve(response({},302,{location:'https://evil.example/'}));}],
  ['timeout',(_url:URL|RequestInfo,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))],
  ['non-json',()=>Promise.resolve(new Response('not json',{status:200,headers:{'content-type':'text/plain'}}))],
  ['malformed',()=>Promise.resolve(response({uuid:'not-a-uuid',is_active:true,attributes:{email_verified:true}}))],
  ['oversized',()=>Promise.resolve(response({uuid:sub,is_active:true,attributes:{email_verified:true}},200,{'content-length':'8192'}))],
])('fails closed on %s authority responses',async(_label,fetcher)=>{
  const authority=new AuthentikFclReceiverAuthority({...options,fetch:fetcher});
  await expect(authority.runVerified(()=>undefined)).rejects.toThrow('fcl_receiver_authority_unavailable');
});

it('rejects unsafe configuration and does not reflect the authority token',()=>{
  expect(()=>new AuthentikFclReceiverAuthority({...options,endpoint:'http://www.freightclaw.net/api/v3/core/users/4/',fetch:()=>Promise.resolve(response({}))})).toThrow('fcl_receiver_authority_configuration_invalid');
  expect(()=>new AuthentikFclReceiverAuthority({...options,endpoint:'https://www.freightclaw.net/api/v3/core/users/4/?x=1',fetch:()=>Promise.resolve(response({}))})).toThrow('fcl_receiver_authority_configuration_invalid');
  expect(()=>new AuthentikFclReceiverAuthority({...options,endpoint:'https://identity.example.test/api/v3/core/users/4/',fetch:()=>Promise.resolve(response({}))})).toThrow('fcl_receiver_authority_configuration_invalid');
  const authority=new AuthentikFclReceiverAuthority({...options,fetch:()=>Promise.reject(new Error(token))});
  return expect(authority.runVerified(()=>undefined)).rejects.toSatisfy(error=>!(error instanceof Error)||!error.message.includes(token));
});
