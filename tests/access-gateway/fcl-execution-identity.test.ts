import {expect,it} from 'vitest';
import {VerifiedFclExecutionDirectory,createAuthentikExecutionDirectory} from '../../services/access-gateway/portal/fcl-execution-identity';
import type {FclReceiverAuthority} from '../../services/access-gateway/portal/fcl-receiver-authority';

it('uses current identity authority, isolates verification contexts and fails closed on revocation',async()=>{
  let active=true,available=true;
  const authority:FclReceiverAuthority={runVerified:operation=>{if(!available)return Promise.reject(new Error('fcl_receiver_authority_unavailable'));if(!active)return Promise.reject(new Error('fcl_receiver_authority_denied'));return Promise.resolve(operation({sub:'real-existing-user',active:true,emailVerified:true}));}};
  const directory=new VerifiedFclExecutionDirectory(new Map([['real-existing-user',authority]]));
  expect(directory.isActive('real-existing-user')).toBe(false);
  await directory.run(['real-existing-user'],()=>{expect(directory.isActive('real-existing-user')).toBe(true);expect(directory.isActive('invented')).toBe(false);});
  expect(directory.isActive('real-existing-user')).toBe(false);
  active=false;expect(await directory.verify(['real-existing-user'])).toBe('inactive');
  available=false;expect(await directory.verify(['real-existing-user'])).toBe('unavailable');
  expect(()=>createAuthentikExecutionDirectory({people:[{user_id:'00000000-0000-4000-8000-000000000001',authority_url:'https://evil.invalid/api/v3/core/users/1/'}]},'https://identity.example.test/','synthetic')).toThrow();
});
