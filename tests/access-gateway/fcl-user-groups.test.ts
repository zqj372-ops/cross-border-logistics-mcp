import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {NativeAdminStore} from '../../services/access-gateway/portal/native-admin';
import {FclUserGroups} from '../../services/access-gateway/portal/fcl-user-groups';
import type {PortalIdentity} from '../../services/access-gateway/portal/contracts';
const person=(userId:string):PortalIdentity=>({userId,displayName:userId,email:`${userId}@example.test`,emailVerified:true,platformRole:null});
it('defaults to customer, preserves explicit revocation, audits and rejects privilege escalation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fcl-groups-')),store=new NativeAdminStore(join(dir,'native.sqlite'));try{
 const groups=new FclUserGroups(store,'admin'),admin=person('admin'),customer=person('customer');
 groups.observe(admin,false);groups.observe(customer,false);
 expect(groups.self(customer,false).group).toBe('customer');
 const input={user_id:'customer',group:'operations',expected_version:0,confirmed:true};
 expect(()=>groups.save(customer,input,'groups-write-0001')).toThrow('fcl_not_found');
 expect(groups.save(admin,input,'groups-write-0001').group).toBe('operations');
 expect(groups.save(admin,input,'groups-write-0001').version).toBe(1);
 expect(()=>groups.save(admin,{...input,expected_version:0},'groups-write-0002')).toThrow('version_conflict');
 groups.save(admin,{...input,group:'customer',expected_version:1},'groups-write-0003');
 expect(groups.save(admin,input,'groups-write-0001')).toMatchObject({group:'customer',version:2});
 expect(new FclUserGroups(store,'admin').self(customer,true).group).toBe('customer');
 expect(()=>groups.save(admin,{...input,user_id:'admin'},'groups-write-0004')).toThrow('fcl_group_administrator_protected');
 expect(()=>groups.save(admin,{...input,user_id:'missing'},'groups-write-0005')).toThrow('fcl_group_user_not_found');
 expect(groups.list(admin,{}).items).toHaveLength(2);
 expect(()=>groups.list(customer,{})).toThrow('fcl_not_found');
 expect(store.db.prepare("SELECT count(*) AS total FROM native_audit WHERE kind='user-group'").get()?.total).toBe(2);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

it('rechecks group grants on the shared API path without changing the login session',async()=>{
 const {FclHttpService}=await import('../../services/access-gateway/portal/fcl-http');
 const dir=mkdtempSync(join(tmpdir(),'fcl-groups-api-')),store=new NativeAdminStore(join(dir,'native.sqlite'));
 try{
 const groups=new FclUserGroups(store,'admin'),admin=person('admin'),user=person('staff'),ctx={identity:user,organizationId:null};groups.observe(user,false);
 const api=new FclHttpService({userGroups:groups,receiverUserId:'admin',publicSessionSecret:'synthetic-group-test-secret-32-bytes',businessDate:()=> '2026-09-29',caseService:{listFclCases:()=>({items:[],next_cursor:null})} as never,nativeAdmin:{} as never,documentWorkflow:{} as never});
 await expect(api.executeStaff(ctx,'case-list',{limit:25,status:null,cursor:null},()=> 'group-api-request-01')).rejects.toThrow('fcl_not_found');
 groups.save(admin,{user_id:user.userId,group:'sales',expected_version:0,confirmed:true},'group-api-grant-001');
 await expect(api.executeStaff(ctx,'case-list',{limit:25,status:null,cursor:null},()=> 'group-api-request-02')).resolves.toMatchObject({status:'success'});
 groups.save(admin,{user_id:user.userId,group:'operations',expected_version:1,confirmed:true},'group-api-grant-002');
 await expect(api.executeStaff(ctx,'case-list',{limit:25,status:null,cursor:null},()=> 'group-api-request-03')).rejects.toThrow('fcl_not_found');
 expect((await api.userGroup(user))?.group).toBe('operations');
 groups.save(admin,{user_id:user.userId,group:'customer',expected_version:2,confirmed:true},'group-api-grant-003');
 await expect(api.executeStaff(ctx,'workspace-list',{},()=> 'group-api-request-04')).rejects.toThrow('fcl_not_found');
 await expect(api.executeStaff(ctx,'group-list',{},()=> 'group-api-request-05')).rejects.toThrow('fcl_not_found');
 expect(await api.isParticipant(user)).toBe(false);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
