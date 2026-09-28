/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Exercises the browser ESM controller. */
import {afterEach,describe,expect,it,vi} from 'vitest';
// @ts-expect-error Browser ESM boundary.
import {createFclOperations} from '../../apps/console/fcl-operations.js';
import {operationsFixture} from '../quote-native/fixtures/fcl-operations';
import {fclCaseListQuerySchema} from '../../services/access-gateway/portal/case-contracts';

afterEach(()=>vi.unstubAllGlobals());
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const ok=(data:unknown)=>({status:'success',data});
const ticket=(id:string)=>({case_id:id,inquiry_no:`INQ-${id}`,case_status:'in_review',case_version:1,current_input:{pol:`Port ${id}`,pod:'Vancouver',final_destination:'Calgary',containers:[{type:'40HQ',quantity:2}],cargo_ready_date:'2026-10-15',estimated_weight:{value:'12000'}},review_context:{review_required:false}});
function fixture(){
  const draft=operationsFixture(),rateView={version:1,draft,active_release:{input:draft},history:[]};
  const call=vi.fn((action:string,body?:Record<string,unknown>|null,_method?:string,_query?:string):Promise<ReturnType<typeof ok>>=>{
    void _method;void _query;
    if(action==='rate-get')return Promise.resolve(ok(rateView));
    if(action==='case-get')return Promise.resolve(ok(ticket(String(body?.case_id))));
    return Promise.resolve(ok({items:[],next_cursor:null}));
  });
  const ops=createFclOperations({call,write:vi.fn(),api:vi.fn(),esc:(value:string|number|null)=>String(value??''),rerender:vi.fn(),notify:vi.fn(),model:()=>({session:{fcl_capability:{business_date:'2026-10-08'}}})});
  return {ops,call,rateView};
}

describe('FCL page-specific reads',()=>{
  it.each(['rates','templates','compare'])('loads only rate configuration for %s until history or case selection is opened',async section=>{
    const {ops,call}=fixture();ops.render('',section);await tick();ops.render('',section);
    expect(call.mock.calls.map(([action])=>action)).toEqual(['rate-get']);
    if(section==='compare')expect(ops.render('',section)).toContain('data-action="ops-cases-open"');
  });

  it('loads history only when opened and scopes a ticket history on the server',async()=>{
    const {ops,call}=fixture();ops.render('a');await tick();
    expect(call.mock.calls.map(([action])=>action)).toEqual(['rate-get','case-get']);
    await ops.action({dataset:{action:'ops-tab',tab:'history'}});ops.render('a');await tick();
    expect(call).toHaveBeenLastCalledWith('estimate-list',{case_ref:'a',destination:null,shipping_date:null});
    ops.render('a');await tick();expect(call.mock.calls.filter(([action])=>action==='estimate-list')).toHaveLength(1);
    const general=fixture();general.ops.render();await tick();
    await general.ops.action({dataset:{action:'ops-tab',tab:'history'}});general.ops.render();await tick();
    expect(general.call).toHaveBeenLastCalledWith('estimate-list',{case_ref:null,destination:null,shipping_date:null});
  });

  it('loads candidates on demand, encodes supported GET pagination, and keeps earlier pages on retry',async()=>{
    const {ops,call}=fixture();ops.render();await tick();call.mockClear();
    const cursor='opaque+/= cursor';
    call.mockResolvedValueOnce(ok({items:[ticket('a')],next_cursor:cursor}));
    await ops.action({dataset:{action:'ops-cases-open'}});
    expect(call).toHaveBeenCalledTimes(1);
    const [action,body,method,search]=call.mock.calls[0]!;
    expect([action,body,method]).toEqual(['case-list',null,'GET']);
    const query=new URLSearchParams(search);
    expect(fclCaseListQuerySchema.parse({limit:Number(query.get('limit')),status:query.get('status'),cursor:query.get('cursor')})).toEqual({limit:50,status:null,cursor:null});
    expect(ops.render()).toContain('INQ-a');expect(ops.render()).toContain('ops-cases-more');
    call.mockRejectedValueOnce(new Error('offline'));
    await ops.action({dataset:{action:'ops-cases-more'}});
    expect(ops.render()).toContain('INQ-a');expect(ops.render()).toContain('ops-cases-more');
    call.mockResolvedValueOnce(ok({items:[ticket('a'),ticket('b')],next_cursor:null}));
    await ops.action({dataset:{action:'ops-cases-more'}});
    expect(call).toHaveBeenLastCalledWith('case-list',null,'GET',`?${new URLSearchParams({limit:'50',cursor})}`);
    const html=ops.render();expect(html.match(/INQ-a/gu)).toHaveLength(1);expect(html).toContain('INQ-b');expect(html).not.toContain('ops-cases-more');
  });

  it('allows a new ticket to load while an old request is pending, and drops the old response',async()=>{
    const {ops,call,rateView}=fixture();let finish!:(value:ReturnType<typeof ok>)=>void;
    call.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    ops.render('old');ops.render('new');await tick();
    expect(ops.render('new')).toContain('INQ-new');
    finish(ok(rateView));await tick();
    expect(ops.render('new')).toContain('INQ-new');expect(ops.render('new')).not.toContain('INQ-old');
  });

  it('clears query drafts and pending candidate responses on account reset',async()=>{
    const {ops,call}=fixture();ops.render('old');await tick();
    expect(ops.render('old')).toContain('value="Port old"');
    ops.reset();ops.render();await tick();
    expect(ops.render()).not.toContain('Port old');expect(ops.render()).not.toContain('12000');
    let finish!:(value:ReturnType<typeof ok>)=>void;
    call.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=ops.action({dataset:{action:'ops-cases-open'}});
    await tick();
    ops.reset();ops.render();await tick();finish(ok({items:[ticket('old')],next_cursor:null}));await pending;
    expect(ops.render()).not.toContain('INQ-old');expect(ops.render()).toContain('ops-cases-open');
  });

  it('does not dispatch a queued action into a new account after an async handler yields',async()=>{
    const {ops,call}=fixture();ops.render();await tick();call.mockClear();
    const pending=ops.action({dataset:{action:'ops-cases-open'}});
    ops.reset();ops.render();await pending;await tick();
    expect(call.mock.calls.map(([action])=>action)).toEqual(['rate-get']);
    expect(ops.render()).toContain('ops-cases-open');
  });

  it('keeps rate editing usable when history fails and retries history explicitly',async()=>{
    const {ops,call}=fixture();ops.render();await tick();
    call.mockRejectedValueOnce(new Error('offline'));
    await ops.action({dataset:{action:'ops-tab',tab:'history'}});ops.render();await tick();
    expect(ops.render()).toContain('ops-history-retry');
    const failedCount=call.mock.calls.length;ops.render();await tick();expect(call).toHaveBeenCalledTimes(failedCount);
    await ops.action({dataset:{action:'ops-history-retry'}});expect(ops.render()).not.toContain('ops-history-retry');
    await ops.action({dataset:{action:'ops-tab',tab:'rates'}});
    expect(ops.render()).toContain('ops-ocean-table');expect(call.mock.calls.filter(([action])=>action==='rate-get')).toHaveLength(1);
  });
});
