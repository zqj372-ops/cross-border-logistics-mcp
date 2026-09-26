import { expect, it } from 'vitest';
import { dataset } from '../customs-native/publication-fixture';
import { renderCustomsImportBrief, renderCustomsReference } from '../../apps/console/customs-reference.js';
const ui = {
 esc:(value:unknown)=>(typeof value==='string'||typeof value==='number'?String(value):'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
 panel:(title:string,subtitle:string,body:string)=>title+subtitle+body,
 note:(message:string)=>message,
};
type ReferenceData = Parameters<typeof renderCustomsReference>[1];
function item(country:'CN'|'US'|'CA',code:string,language:string,description:string):ReferenceData['candidates'][number] {
 return {item:{...dataset.nomenclature[0]!,country,code,display_code:code,language,description_original:description,is_declarable:1},hierarchy:[],rates:[],name_translation:null};
}
function reference(candidates:ReferenceData['candidates']):ReferenceData {
 return {request_id:'req_ui',formal_ready:false,rule_date:'2026-09-27',snapshot_sha256:'a'.repeat(64),warnings:['待复核','其他待复核'],sources:[],candidates};
}
it('shows the selected country as an import brief, groups bilingual codes and never equates missing measures with no duties',()=>{
 const data=reference([item('CN','1234560000','zh-CN','合成商品'),item('CA','1234561000','en','Synthetic article'),item('CA','1234561000','fr','Article fictif'),item('CA','1234562000','en','Other article')]);
 const html=renderCustomsReference(ui,data,{input:{query:'123456',codeCountry:'CA'},country:'CA'});
 expect(html).toContain('商品进口建议与要求');
 for(const label of ['建议申报品名','建议归类','税率','反倾销','反补贴','进口限制','认证与标签','清关资料']) expect(html).toContain(label);
 expect(html.match(/<option /gu)).toHaveLength(2);
 expect(html).toContain('value="1234561000" selected');
 expect(html).toContain('待核验');expect(html).not.toContain('无反倾销');expect(html).not.toContain('归类已确认');
 expect(html).toContain('本次返回');expect(html).toContain('不能直接作为申报品名');
 expect(html).toContain('Article fictif');
});
it('does not substitute another country when the requested country has no match',()=>{
 const html=renderCustomsReference(ui,reference([item('CN','1234560000','zh-CN','合成商品')]),{input:{query:'missing',codeCountry:'US'}});
 expect(html).toContain('美国暂无匹配候选');expect(html).not.toContain('data-customs-brief');
});
it('displays corresponding Chinese and English names with translation provenance, separate from a customer draft',()=>{
 const candidate=item('US','1234567890','en','Other');
 candidate.hierarchy=[{...candidate.item,code:'123456',description_original:'Synthetic articles'}];
 candidate.name_translation={language:'zh',text:'合成器具 — 其他',status:'machine',model:'fixture-model'};
 const html=renderCustomsReference(ui,reference([candidate]),{input:{query:'客户填写的器具',codeCountry:'US'}});
 expect(html).toContain('中文（参考译文）：合成器具 — 其他');expect(html).toContain('英文（官方原文）：Synthetic articles — Other');
 expect(html).toContain('建议申报品名');expect(html).toContain('客户填写的器具');expect(html).not.toContain('待补充商品中文名称');
 expect(html).toContain('机器翻译，仅供理解原文');
 const cn=item('CN','1234567890','zh-CN','合成器具');
 cn.name_translation={language:'en',text:'Synthetic articles',status:'machine',model:'fixture-model'};
 const cnHtml=renderCustomsReference(ui,reference([cn]),{country:'CN'});
 expect(cnHtml).toContain('中文（官方原文）：合成器具');expect(cnHtml).toContain('英文（参考译文）：Synthetic articles');
});
it('puts the source MFN rate before optional preferential schedules and avoids duplicated parent names',()=>{
 const candidate=item('CA','1234561000','en','Synthetic article');
 candidate.hierarchy=[{...candidate.item,code:'123456',description_original:'Synthetic article'}];
 candidate.rates=['CCCT','CEUT','CIAT','MFN'].map(treatment=>({...dataset.tariffs[0]!,country:'CA',code:'12345610',treatment,measure_type:'customs_duty',rate_expression_raw:treatment==='MFN'?'7.5%':'Free'}));
 const html=renderCustomsReference(ui,reference([candidate]),{input:{query:'1234561000',codeCountry:'CA'}});
 const brief=html.split('<section data-customs-brief>')[1]!.split('</section>')[0]!;
 expect(brief).toContain('7.5%');expect(brief).toContain('最惠国税率');expect(brief).toContain('另有 3 条');
 expect(brief).not.toContain('Free');expect(brief).not.toContain('customs_duty');expect(brief).not.toContain('Synthetic article — Synthetic article');
});
it('keeps rate conditions and source scope with the rate rather than promoting a parent or preferential rate to a total',()=>{
 const candidate=item('US','1234567890','en','Other');
 candidate.hierarchy=[{...candidate.item,code:'123456',display_code:'123456',description_original:'Synthetic articles',is_declarable:0}];
 candidate.rates=[{...dataset.tariffs[0]!,country:'US',code:'123456',rate_expression_raw:'7.2%',treatment:'general',condition_text_raw:'Only if the condition applies',measure_type:'base_duty'}];
 const html=renderCustomsReference(ui,reference([candidate]),{input:{query:'1234567890',codeCountry:'US'}});
 expect(html).toContain('Synthetic articles');expect(html).toContain('7.2%');expect(html).toContain('Only if the condition applies');
 expect(html).toContain('所属税目 123456');expect(html).toContain('完整税费待核验');expect(html).not.toContain('税费合计');
});
it('preserves published measure conclusions, producer conditions and unknown measure types in the brief',()=>{
 const result:Parameters<typeof renderCustomsImportBrief>[1]={
  displayCode:'1234561000',status:'candidate',classificationReason:'Synthetic candidate only',legalNames:[{language:'en',text:'Synthetic article',sourceId:'synthetic'}],
  measures:[{id:'synthetic-ad',label:'Synthetic antidumping case',measureType:'anti_dumping',originCountry:'CN',codeHint:null,matchStatus:'possible',legalScope:'Only the source-defined product scope',exceptions:[],caseNumber:'fixture-case',exporterOrProducer:'Synthetic producer',rateExpressionRaw:'12%',effectiveFrom:'2026-01-01',effectiveTo:null,sourceId:'synthetic'},
   {id:'synthetic-other',label:'Unknown source measure',measureType:'unmapped_measure',originCountry:'CN',codeHint:null,matchStatus:'manual_review',legalScope:'Source review required',exceptions:[],caseNumber:null,exporterOrProducer:null,rateExpressionRaw:null,effectiveFrom:'2026-01-01',effectiveTo:null,sourceId:'synthetic'}],
  documents:[{id:'synthetic-document',label:'Synthetic certificate',side:'ca_import',status:'conditional',conditions:['When the stated condition applies'],reason:'Source condition',effectiveFrom:'2026-01-01',effectiveTo:null,sourceId:'synthetic'}],
 };
 const html=renderCustomsImportBrief(ui,result,{query:'合成器具',attributes:{material:'合成材料'}});
 expect(html).toContain('合成器具，合成材料');expect(html).toContain('可能涉及');expect(html).toContain('Synthetic producer');expect(html).toContain('12%');
 expect(html).toContain('Unknown source measure');expect(html).toContain('条件适用');expect(html).toContain('When the stated condition applies');
 expect(html).not.toContain('来源已确认归类');expect(html).not.toContain('无反补贴');
});
it('shows the manual review boundary and original text without introducing a duty total or interpreting HTML',()=>{
 const esc=(value:unknown)=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 const html=renderCustomsReference({esc,panel:(title:string,subtitle:string,body:string)=>title+subtitle+body,note:esc},{request_id:'req_ui',formal_ready:false,rule_date:'2026-09-27',snapshot_sha256:'a'.repeat(64),warnings:['待复核','其他待复核'],sources:[],candidates:[{item:{...dataset.nomenclature[0]!,country:'CN',code:'123456',display_code:'123456',description_original:'<script>unsafe</script>',is_declarable:0,language:'zh',source_locator:'official:row1'},hierarchy:[],rates:[],name_translation:null}]});
 expect(html).not.toContain('&lt;br>');expect(html).toContain('待复核 其他待复核');expect(html).toContain('中国税号');expect(html).toContain('进口税率不能作为出口税率');expect(html).not.toContain('中国出口');expect(html).toContain('候选 · 待复核');expect(html).toContain('不代表免税或零税率');expect(html).toContain('&lt;script>');expect(html).not.toContain('<script>');expect(html).not.toContain('已确认的关税合计');
});
