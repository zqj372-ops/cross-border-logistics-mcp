import {expect,it} from 'vitest';
import {checkPackagePublication} from '../../services/customs-native/package-publication';
import {customsRelease} from '../../services/customs-native/publication';
import {publicationStatus} from '../../services/customs-native/upstream/worker/query/query-service';
import {dataset} from './publication-fixture';
import type {PublicationSnapshotRow} from '../../services/customs-native/upstream/worker/repositories/customs';
it('keeps package activation and query publication identity checks in agreement',async()=>{
 const r=customsRelease(dataset,'isolated-release','2026-09-07T12:00:00.000Z');
 const cases:Partial<PublicationSnapshotRow>[]=[{}, {ready:0},{test_data:1},{gate_report_sha256:'c'.repeat(64)},{release_ids_json:'[]'},{release_ids_json:JSON.stringify([r.sources[0]!.id,r.sources[0]!.id])},{approval_ids_json:'["one"]'},{approval_ids_json:'[""]'},{approval_ids_json:'{}'},{reasons_json:'["pending"]'},{reasons_json:'null'},{evaluated_at:'2026-02-30T12:00:00Z'},{evaluated_at:'2026-09-07T01:00:00+08:00'},{last_source_check_at:'invalid'}];
 for(const change of cases){const s={...r.snapshot,...change},query=await publicationStatus(s,r.sources.map(s=>s.id),r.sources);expect(checkPackagePublication(s,r.sources).length===0,JSON.stringify(change)).toBe(query.dataStatus.ready);}
});
