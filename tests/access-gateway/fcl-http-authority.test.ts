import {expect,it} from 'vitest';
import type {PortalContext,PortalIdentity} from '../../services/access-gateway/portal/contracts';
import {FclHttpService} from '../../services/access-gateway/portal/fcl-http';
import {currentFclReceiverAuthorized,runWithVerifiedFclReceiver,type FclReceiverAuthority,type FclReceiverProof} from '../../services/access-gateway/portal/fcl-receiver-authority';

const sub='00000000-0000-4000-8000-000000000004';
const identity:PortalIdentity={userId:sub,displayName:'FCL receiver',email:'receiver@example.test',emailVerified:true,platformRole:null};
const ctx:PortalContext={identity,organizationId:null};
const proof:FclReceiverProof={sub,active:true,emailVerified:true};

function service(authority:FclReceiverAuthority){
  return new FclHttpService({
    caseService:{listFclCases:()=>({items:[],next_cursor:null}),getFclCustomerView:()=>({}),submitFclInquiry:()=>Promise.resolve({})} as never,
    nativeAdmin:{} as never,
    documentWorkflow:{} as never,
    publicSessionSecret:'synthetic-public-session-secret-32-bytes',
    businessDate:()=> '2026-10-08',
    receiverAuthority:authority,
  });
}

it('revalidates authority for every FCL request and capability call',async()=>{
  let calls=0;
  const authority:FclReceiverAuthority={runVerified:async operation=>{calls++;return await operation(proof);}};
  const fcl=service(authority);
  await expect(fcl.executeStaff(ctx,'case-list',{limit:25,status:null,cursor:null},()=> 'fcl-authority-case-list-01')).resolves.toMatchObject({status:'success',data:{items:[],next_cursor:null}});
  expect(calls).toBe(1);
  await expect(fcl.capability(identity)).resolves.toMatchObject({fcl_personal:true,receiver_user_id:sub});
  expect(calls).toBe(2);
});

it('fails closed without leaking capability when the authority is unavailable or the identity differs',async()=>{
  const unavailable:FclReceiverAuthority={runVerified:()=>Promise.reject(new Error('fcl_receiver_authority_unavailable'))};
  const fcl=service(unavailable);
  await expect(fcl.executeStaff(ctx,'case-list',{limit:25,status:null,cursor:null},()=> 'fcl-authority-case-list-02')).rejects.toThrow('fcl_receiver_authority_unavailable');
  await expect(fcl.capability(identity)).resolves.toMatchObject({fcl_personal:false,receiver_user_id:null});

  const mismatch:FclReceiverAuthority={runVerified:operation=>Promise.resolve(operation(proof))};
  const mismatchService=service(mismatch);
  await expect(mismatchService.executeStaff({...ctx,identity:{...identity,userId:'00000000-0000-4000-8000-000000000099'}},'case-list',{limit:25,status:null,cursor:null},()=> 'fcl-authority-case-list-03')).rejects.toThrow('fcl_not_found');
  await expect(mismatchService.capability({...identity,userId:'00000000-0000-4000-8000-000000000099'})).resolves.toMatchObject({fcl_personal:false,receiver_user_id:null});
});

it('checks the authority for public FCL actions but not for logout',async()=>{
  let calls=0;
  const authority:FclReceiverAuthority={runVerified:async operation=>{calls++;return await operation(proof);}};
  const fcl=service(authority);
  await expect(fcl.executePublicAction({} as PortalContext,'logout',{},()=> 'fcl-logout-authority-0001',null)).resolves.toMatchObject({status:'success',data:null});
  expect(calls).toBe(0);
});

it('runs personal organization selection inside a fresh receiver proof',async()=>{
  let calls=0;
  const authority:FclReceiverAuthority={runVerified:operation=>{calls++;return Promise.resolve(runWithVerifiedFclReceiver(proof,()=>operation(proof)));}};
  const fcl=service(authority);
  await expect(fcl.runWithPersonalAuthority(identity,()=>currentFclReceiverAuthorized(sub,sub))).resolves.toBe(true);
  expect(calls).toBe(1);
  await expect(fcl.runWithPersonalAuthority({...identity,userId:'00000000-0000-4000-8000-000000000099'},()=>undefined)).rejects.toThrow('fcl_not_found');
  expect(calls).toBe(2);
});
