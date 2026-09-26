import { expect, it } from 'vitest';
import { dataset } from '../customs-native/publication-fixture';
import { renderCustomsReference } from '../../apps/console/customs-reference.js';
it('shows the manual review boundary and original text without introducing a duty total or interpreting HTML',()=>{
 const esc=(value:unknown)=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 const html=renderCustomsReference({esc,panel:(title:string,subtitle:string,body:string)=>title+subtitle+body,note:(s:string)=>s},{request_id:'req_ui',formal_ready:false,rule_date:'2026-09-27',snapshot_sha256:'a'.repeat(64),warnings:['待复核'],sources:[],candidates:[{item:{...dataset.nomenclature[0]!,country:'CN',code:'123456',display_code:'123456',description_original:'<script>unsafe</script>',is_declarable:0,language:'zh',source_locator:'official:row1'},hierarchy:[],rates:[]}]});
 expect(html).toContain('候选 · 待复核');expect(html).toContain('不代表免税或零税率');expect(html).toContain('&lt;script>');expect(html).not.toContain('<script>');expect(html).not.toContain('已确认的关税合计');
});
