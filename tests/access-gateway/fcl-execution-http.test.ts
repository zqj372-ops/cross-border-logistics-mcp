import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {FCL_EXECUTION_ACTIONS} from '../../services/access-gateway/portal/fcl-execution-http-contracts';
import {createFclCliFixture} from './fcl-cli-fixture';

it('routes every versioned execution action through the authenticated HTTP gate and fails closed when disabled',async()=>{
  const f=await createFclCliFixture(),root=mkdtempSync(join(tmpdir(),'fcl-execution-http-'));
  try{
    const path=join(root,'session.json');await f.staffSessionFile(path);
    const session=JSON.parse(readFileSync(path,'utf8')) as {session_token:string;csrf_token:string};
    for(const action of FCL_EXECUTION_ACTIONS){
      const response=await fetch(`${f.origin}/console/api/v1/fcl/${action}`,{method:'POST',headers:{cookie:`fc_portal_session=${session.session_token}`,origin:f.origin,'x-csrf-token':session.csrf_token,'idempotency-key':'execution-http-0001','content-type':'application/json'},body:'{}'});
      const body=await response.json() as {reason_codes:string[]};
      expect(response.status,action).not.toBe(404);expect(body.reason_codes,action).not.toContain('route_not_found');
    }
    const response=await fetch(`${f.origin}/console/api/v1/fcl/notification-v2-get`,{method:'POST',headers:{cookie:`fc_portal_session=${session.session_token}`,origin:f.origin,'x-csrf-token':session.csrf_token,'content-type':'application/json'},body:'{}'});
    expect(await response.json()).toMatchObject({data:null,reason_codes:['fcl_execution_not_configured']});
  }finally{await f.close();rmSync(root,{recursive:true,force:true});}
});
