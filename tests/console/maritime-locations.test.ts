import {describe,expect,it} from 'vitest';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {exactPortName,portLookup,searchPortNames} from '../../services/maritime/schedule-collector/port-names';
import {resolveLocationCandidates} from '../../services/maritime/schedule-collector/locations';
import {createCollectorService} from '../../services/maritime/schedule-collector/service';
import {InMemoryEvidenceStore} from '../../services/maritime/schedule-collector/evidence';
import {createCoscoAdapter,parseCoscoLocationResponse} from '../../services/maritime/schedule-collector/carriers/cosco';
import type {CarrierAdapter} from '../../services/maritime/schedule-collector/carriers/types';
import type {CarrierParserContext} from '../../services/maritime/schedule-collector/carriers/types';

const {readLocationCache,locationLabel}=await import(pathToFileURL(resolve('apps/console/maritime-locations.js')).href) as {
  readLocationCache:(storage:{getItem:(key:string)=>string|null},key:string,now:number)=>unknown[];
  locationLabel:(candidate:Record<string,unknown>)=>{zh:string;en:string;country:string};
};
describe('bilingual schedule locations',()=>{
  it('normalizes both location discovery and the shared CLI/MCP query service',async()=>{
    const lookups:string[]=[];let queried:CarrierParserContext|null=null;
    const adapter:CarrierAdapter={metadata:{id:'COSCO',displayName:'COSCO',adapterVersion:'fixture@1',capabilityStatus:'live_verified',provenanceKind:'live',lastLiveVerifiedAt:null},
      resolveLocations:(input)=>{lookups.push(input.text);return Promise.resolve([{name:input.text,country_code:input.countryCode,type:'city',carrier_location_id:'official-'+input.text,mapping_source:'fixture',source_full_name:input.text,unlocode:null}]);},
      query:(ctx)=>{queried=ctx;return Promise.resolve({records:[],coverage:{requested_from:'2026-10-01',requested_until:'2026-10-10',covered_windows:[{from:'2026-10-01',until:'2026-10-10'}],uncovered_windows:[],pages_read:[1],complete:true,truncated:false,failure_reason:null},quality:{key_fields_complete:true,evaluation_status:'evaluated',conflicts:[],warnings:[],missing_field_count:0},evidenceRef:null});}};
    const service=createCollectorService({adapters:[adapter],ports:{clock:{now:()=>new Date('2026-09-18T00:00:00Z')},context:{requestId:'bilingual-test',auditId:'bilingual-audit',localFixture:true},audit:{record:async()=>{}},evidence:new InMemoryEvidenceStore(),http:{request:()=>Promise.reject(new Error('Network forbidden'))}}});
    const discovery=await service.resolveLocations({carrier:'COSCO',text:'青岛'});
    expect(discovery.envelope).toMatchObject({status:'success'});
    await service.query({carrier:'COSCO',origin:{text:'青岛',country_code:null,carrier_location_id:null},destination:{text:'多伦多',country_code:null,carrier_location_id:null},from:'2026-10-01',until:'2026-10-10',routing:'any'});
    expect(lookups).toEqual(['Qingdao','Qingdao','Toronto']);
    expect(queried).toMatchObject({origin:{input_text:'青岛',name:'Qingdao',country_code:'CN'},destination:{input_text:'多伦多',name:'Toronto',country_code:'CA'}});
  });
  it('supports COSCO prefix candidates and derives a country only from a valid official UN/LOCODE',async()=>{
    const response={data:{content:[{cityUuid:'official-auckland',cityLocName:'Auckland',country:'New Zealand',unloCode:'NZAKL',fullFormate:'Auckland, New Zealand'}]}};
    expect(parseCoscoLocationResponse(response)[0]?.country_code).toBe('NZ');
    expect(parseCoscoLocationResponse({data:{content:[{...response.data.content[0],unloCode:'invalid'}]}})[0]?.country_code).toBeNull();
    const candidates=await createCoscoAdapter().resolveLocations({text:'Auck',countryCode:'NZ'},{request:()=>Promise.resolve({status:200,url:'https://fixture.invalid/locations',headers:{},contentType:'application/json',body:new TextEncoder().encode(JSON.stringify(response))})});
    expect(candidates).toHaveLength(1);
  });
  it('maps a Chinese name to an English lookup while preserving country conflicts',()=>{
    expect(portLookup('青岛',null)).toEqual({text:'Qingdao',countryCode:'CN'});
    expect(portLookup('多伦多',null)).toEqual({text:'Toronto',countryCode:'CA'});
    expect(portLookup('上海','US')).toEqual({text:'上海',countryCode:'US'});
    expect(portLookup('Unknown Port',null)).toEqual({text:'Unknown Port',countryCode:null});
  });
  it('requires country disambiguation for Chinese names shared across countries',()=>{
    expect(exactPortName('奥克兰')).toBeNull();
    expect(searchPortNames('奥克兰').map(p=>p.country)).toEqual(['US','NZ']);
    expect(portLookup('温哥华',null)).toEqual({text:'温哥华',countryCode:null});
    expect(portLookup('温哥华','CA')).toEqual({text:'Vancouver',countryCode:'CA'});
    expect(portLookup('Vancouver',null)).toEqual({text:'Vancouver',countryCode:null});
  });
  it('retains caller Chinese text but accepts only a matching official country and carrier ID',()=>{
    const candidate={name:'Qingdao',country_code:'CN',type:'city' as const,carrier_location_id:'official-qingdao',mapping_source:'fixture',source_full_name:'Qingdao, China',unlocode:'CNTAO'};
    const resolved=resolveLocationCandidates({text:'青岛',country_code:null,carrier_location_id:null},[candidate]);
    expect(resolved.input_text).toBe('青岛');expect(resolved.carrier_location_id).toBe('official-qingdao');
    expect(()=>resolveLocationCandidates({text:'青岛',country_code:'US',carrier_location_id:null},[candidate])).toThrow();
    expect(()=>resolveLocationCandidates({text:'青岛',country_code:null,carrier_location_id:'invented'},[candidate])).toThrow();
    expect(locationLabel(candidate)).toMatchObject({zh:'青岛',en:'Qingdao',country:'CN'});
  });
  it('ignores corrupt, expired and future cache entries and reads only the requested scope',()=>{
    const now=100_000_000,entry={text:'Qingdao',zh:'青岛',en:'Qingdao',country:'CN',id:'official',at:now-1000};
    const store={getItem:(key:string)=>key==='org-a:ONE'?JSON.stringify([entry,{...entry,at:now-86_400_001},{...entry,at:now+1},{...entry,country:'<bad>'},{id:'bad'}]):null};
    expect(readLocationCache(store,'org-a:ONE',now)).toEqual([entry]);
    expect(readLocationCache(store,'org-b:ONE',now)).toEqual([]);
    expect(readLocationCache(store,'org-a:COSCO',now)).toEqual([]);
    expect(readLocationCache({getItem:()=>'{bad'},'org-a:ONE',now)).toEqual([]);
  });
});
