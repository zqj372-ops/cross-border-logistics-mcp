import {describe,expect,it,vi} from 'vitest';
// @ts-expect-error Browser ESM.
import {createFclWorkspaceEntryController,enterPersonalFclWorkspace,fclWorkspaceEntryGateRequired,requiresPersonalFclWorkspace,type FclWorkspaceSession} from '../../apps/console/fcl-workspace-entry.ts';

const enterpriseSession={authenticated:true,organization_id:'org_fixture',fcl_capability:{fcl_personal:true},identity:{user_id:'receiver'}};

describe('personal FCL workspace entry',()=>{
 it('requires the personal workspace for every FCL route while an enterprise is selected',()=>{
  expect(requiresPersonalFclWorkspace('fcl',enterpriseSession)).toBe(true);
  expect(requiresPersonalFclWorkspace('fcl',{...enterpriseSession,organization_id:null})).toBe(false);
  expect(requiresPersonalFclWorkspace('fcl',{...enterpriseSession,fcl_capability:{fcl_personal:false}})).toBe(false);
  expect(requiresPersonalFclWorkspace('workbench',enterpriseSession)).toBe(false);
 });

 it('does not load FCL until the session switch and refresh have completed',async()=>{
  let release!: (value:{organization_id:null})=>void;
  const switchToPersonal=vi.fn(()=>new Promise<{organization_id:null}>(resolve=>{release=resolve;}));
  const loadWorkspace=vi.fn();
  const entered=enterPersonalFclWorkspace({
   page:'fcl',
   session:enterpriseSession,
   isCurrent:()=>true,
   switchToPersonal,
   loadWorkspace,
  });
  await Promise.resolve();
  expect(switchToPersonal).toHaveBeenCalledTimes(1);
  expect(loadWorkspace).not.toHaveBeenCalled();
  release({organization_id:null});
  await expect(entered).resolves.toBe('loaded');
  expect(loadWorkspace).toHaveBeenCalledTimes(1);
 });

 it('keeps the FCL route blocked while the switch is in flight and after it fails',()=>{
  const personal={...enterpriseSession,organization_id:null};
  expect(fclWorkspaceEntryGateRequired('fcl',personal,{switching:true})).toBe(true);
  expect(fclWorkspaceEntryGateRequired('fcl',personal,{failed:true})).toBe(true);
  expect(fclWorkspaceEntryGateRequired('fcl',enterpriseSession)).toBe(true);
  expect(fclWorkspaceEntryGateRequired('fcl',personal)).toBe(false);
  expect(fclWorkspaceEntryGateRequired('workbench',enterpriseSession)).toBe(false);
 });

 it('finishes a pending refresh before retrying an intermediate personal session',async()=>{
  const order:string[]=[];
  const loadWorkspace=vi.fn(()=>{order.push('fcl');});
  await expect(enterPersonalFclWorkspace({
   page:'fcl',
   session:{...enterpriseSession,organization_id:null},
   prepareRequired:true,
   isCurrent:()=>true,
   switchToPersonal:vi.fn(()=>{order.push('state');return Promise.resolve({organization_id:null});}),
   loadWorkspace,
  })).resolves.toBe('loaded');
  expect(order).toEqual(['state','fcl']);
 });

 it('retries the pending refresh after the organization POST succeeded and keeps FCL blocked until then',async()=>{
  let session:FclWorkspaceSession={...enterpriseSession};
  const controllerRef:{current:ReturnType<typeof createFclWorkspaceEntryController>|null}={current:null};
  const order:string[]=[];
  const completePreparation=vi.fn(()=>{order.push('state');return Promise.resolve({organization_id:null});});
  const loadWorkspace=vi.fn(()=>{order.push('fcl');});
  const render=vi.fn(()=>{const current=controllerRef.current;if(current?.gateRequired())current.begin();});
  const controller=createFclWorkspaceEntryController({
   getPage:()=>'fcl',
   getSession:()=>session,
   getUserId:()=>session.identity?.user_id,
   switchToPersonal:vi.fn(({onSessionSelected}:{onSessionSelected:()=>void})=>{session={...session,organization_id:null};onSessionSelected();return Promise.reject(Object.assign(new Error('state_unavailable'),{code:'state_unavailable'}));}),
   completePreparation,
   loadWorkspace,
   render,
  });
  controllerRef.current=controller;
  controller.begin();
  await vi.waitFor(()=>expect(render).toHaveBeenCalled());
  expect(controller.gateRequired()).toBe(true);
  expect(loadWorkspace).not.toHaveBeenCalled();
  await controller.retry();
  await vi.waitFor(()=>expect(loadWorkspace).toHaveBeenCalledTimes(1));
  expect(completePreparation).toHaveBeenCalledTimes(1);
  expect(order).toEqual(['state','fcl']);
  expect(controller.gateRequired()).toBe(false);
 });

 it('stops automatic retries when the account changes during preparation',async()=>{
  const controllerRef:{current:ReturnType<typeof createFclWorkspaceEntryController>|null}={current:null};
  const render=vi.fn(()=>{const current=controllerRef.current;if(current?.gateRequired())current.begin();});
  const switchToPersonal=vi.fn(()=>Promise.reject(Object.assign(new Error('account_changed'),{code:'account_changed'})));
  const controller=createFclWorkspaceEntryController({
   getPage:()=>'fcl',
   getSession:()=>enterpriseSession,
   getUserId:()=>enterpriseSession.identity.user_id,
   switchToPersonal,
   completePreparation:vi.fn(()=>Promise.resolve({organization_id:null})),
   loadWorkspace:vi.fn(),
   render,
  });
  controllerRef.current=controller;
  controller.begin();
  await vi.waitFor(()=>expect(render).toHaveBeenCalled());
  expect(switchToPersonal).toHaveBeenCalledTimes(1);
  expect(controller.gateRequired()).toBe(true);
 });

 it('drops a stale switch result after leaving the FCL route',async()=>{
  let current=true;
  let release!: (value:{organization_id:null})=>void;
  const switchToPersonal=vi.fn(()=>new Promise<{organization_id:null}>(resolve=>{release=resolve;}));
  const loadWorkspace=vi.fn();
  const entered=enterPersonalFclWorkspace({
   page:'fcl',
   session:enterpriseSession,
   isCurrent:()=>current,
   switchToPersonal,
   loadWorkspace,
  });
  await Promise.resolve();
  current=false;
  release({organization_id:null});
  await expect(entered).resolves.toBe('stale');
  expect(loadWorkspace).not.toHaveBeenCalled();
 });

 it('loads once when the user leaves and returns before the switch completes',async()=>{
  let page='fcl';
  let release!: (value:{organization_id:null})=>void;
  const loadWorkspace=vi.fn();
  const entered=enterPersonalFclWorkspace({
   page:'fcl',
   session:enterpriseSession,
   isCurrent:()=>page==='fcl',
   switchToPersonal:()=>new Promise<{organization_id:null}>(resolve=>{release=resolve;}),
   loadWorkspace,
  });
  await Promise.resolve();
  page='workbench';
  page='fcl';
  release({organization_id:null});
  await expect(entered).resolves.toBe('loaded');
  expect(loadWorkspace).toHaveBeenCalledTimes(1);
 });

 it('does not load after the signed-in account changes',async()=>{
  let currentUser='receiver';
  let release!: (value:{organization_id:null})=>void;
  const loadWorkspace=vi.fn();
  const entered=enterPersonalFclWorkspace({
   page:'fcl',
   session:enterpriseSession,
   isCurrent:()=>currentUser==='receiver',
   switchToPersonal:()=>new Promise<{organization_id:null}>(resolve=>{release=resolve;}),
   loadWorkspace,
  });
  await Promise.resolve();
  currentUser='other';
  release({organization_id:null});
  await expect(entered).resolves.toBe('stale');
  expect(loadWorkspace).not.toHaveBeenCalled();
 });

 it('fails closed when the switched session still carries an enterprise context',async()=>{
  const loadWorkspace=vi.fn();
  await expect(enterPersonalFclWorkspace({
   page:'fcl',
   session:enterpriseSession,
   isCurrent:()=>true,
   switchToPersonal:vi.fn(()=>Promise.resolve({organization_id:'org_fixture'})),
   loadWorkspace,
  })).rejects.toThrow('fcl_personal_workspace_switch_failed');
  expect(loadWorkspace).not.toHaveBeenCalled();
 });

 it('propagates a switch failure without loading FCL',async()=>{
  const loadWorkspace=vi.fn();
  await expect(enterPersonalFclWorkspace({
   page:'fcl',
   session:enterpriseSession,
   isCurrent:()=>true,
   switchToPersonal:vi.fn(()=>Promise.reject(Object.assign(new Error('network'),{code:'network'}))),
   loadWorkspace,
  })).rejects.toMatchObject({code:'network'});
  expect(loadWorkspace).not.toHaveBeenCalled();
 });

 it('does not switch when the account is already in the personal workspace',async()=>{
  const switchToPersonal=vi.fn();
  const loadWorkspace=vi.fn();
  await expect(enterPersonalFclWorkspace({
   page:'fcl',
   session:{...enterpriseSession,organization_id:null},
   isCurrent:()=>true,
   switchToPersonal,
   loadWorkspace,
  })).resolves.toBe('loaded');
  expect(switchToPersonal).not.toHaveBeenCalled();
  expect(loadWorkspace).toHaveBeenCalledTimes(1);
 });
});
