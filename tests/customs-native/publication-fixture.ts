import { DEMO_SOURCES, DEMO_NOMENCLATURE, DEMO_TARIFF_RULES, DEMO_REQUIREMENTS } from './demo-data';
import type { CustomsDataset } from '../../services/customs-native/contracts';
// Synthetic rows deliberately emulate an approved publication in isolated unit
// tests. No fixture is loaded by any runtime, importer or production entrypoint.
export const dataset:CustomsDataset={label:'Isolated synthetic approval test',rule_date:'2026-09-07',test_data:false,sources:DEMO_SOURCES.map(s=>({...s,official_url:'https://www.cbsa-asfc.gc.ca/',manifest_sha256:'a'.repeat(64)})),nomenclature:DEMO_NOMENCLATURE.map(r=>({...r,parent_code:null,raw_row_hash:'a'.repeat(64),release_manifest_sha256:'a'.repeat(64)})),tariffs:DEMO_TARIFF_RULES.map(r=>({...r,raw_row_hash:'a'.repeat(64),release_manifest_sha256:'a'.repeat(64)})),requirements:DEMO_REQUIREMENTS.map(r=>({...r,raw_row_hash:'a'.repeat(64),release_manifest_sha256:'a'.repeat(64)})),measures:[]};
