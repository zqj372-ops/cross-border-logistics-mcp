import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {operationsFixture,estimateRequest,cosco} from '../../quote-native/fixtures/fcl-operations.ts';
import {createFclInquiryDraft} from '../../../apps/inquiry/fcl-model.ts';

const {chromium,request}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const base=process.env.PORTAL_BASE_URL||'http://127.0.0.1:8902';
assert.equal(new URL(base).hostname,'127.0.0.1');
const out=resolve(process.env.FCL_EVIDENCE_DIRECTORY||'.runtime/fcl-maintenance-evidence');
await mkdir(out,{recursive:true});
const checks=[],errors=[],version='fcl-document-workflow@2026-09-20.v1';
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
const contexts=[];
async function account(identity){
  const api=await request.newContext({baseURL:base});
  const anonymous=await(await api.get('/console/api/v1/session')).json();
  const login=await api.post('/console/api/v1/fixture-login',{headers:{origin:base,'x-csrf-token':anonymous.csrf_token,'idempotency-key':crypto.randomUUID()},data:{identity_id:identity}});
  assert.equal(login.status(),200);const session=await login.json();
  assert.equal(session.fcl_capability.fcl_personal,true);
  const context=await browser.newContext({storageState:await api.storageState(),viewport:{width:1440,height:1000},reducedMotion:'reduce'});contexts.push(context);await api.dispose();
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void dialog.accept('已核对原始费用，基础海运费从所选运价读取'));
  async function call(action,data,allowFailure=false){
    const headers={origin:base,'x-csrf-token':session.csrf_token,'idempotency-key':crypto.randomUUID()};
    const response=await context.request[data===undefined?'get':'post'](`${base}/console/api/v1/fcl/${action}`,{headers,...(data===undefined?{}:{data})});
    const body=await response.json();if(!allowFailure)assert.equal(response.status(),200,action+': '+JSON.stringify(body));
    return {...body,http:response.status()};
  }
  return {context,page,call};
}
async function publish(client,data){
  const current=await client.call('rate-get');
  const saved=await client.call('rate-save',{expected_version:current.data.version,input:data});
  const preview=await client.call('rate-preview');assert.equal(preview.data.can_publish,true);
  return (await client.call('rate-publish',{expected_version:saved.data.version,preview_hash:preview.data.preview_hash,confirmation:'reviewed_sources_and_conditions'})).data;
}
const fixture=()=>{
  const data=operationsFixture();data.label='本地验收演示价格';data.operations.delivery_rates=[];
  data.rates.forEach((rate,index)=>{rate.supplier_label='COSCO';rate.pol=['Yantian','Ningbo','Shanghai'][index];rate.items=['20GP','40GP','40HQ','45HQ'].map((container_type,i)=>({container_type,ocean_freight:String([2500,3100,3200,3900][i]+index*100),currency:'USD'}));});
  data.operations.rate_details=data.operations.rate_details.map((row,index)=>({...row,carrier:'COSCO',routing:`${data.rates[index].pol} → Vancouver`}));
  const reference=data.operations.charges[0];
  data.operations.charges=[['EMF','设备管理费','ocean','35','USD'],['ISPS','港口安保费','ocean','15','USD'],['DO','换单费','destination','65','USD'],['DOC','文件费','origin','450','CNY'],['CUSTOMS','加拿大清关费','customs','200','CAD']].map(([code,name_zh,category,amount,currency])=>({...reference,id:code,code,name_zh,name_en:code,category,amount,currency,container_types:['20GP','40GP','40HQ','45HQ'],source_ref:`synthetic:${code}`}));
  data.operations.templates[0]={...data.operations.templates[0],id:'canada',label:'加拿大整柜常用费用',destination:'Toronto',routing:'Vancouver → Toronto',service_mode:'container_drayage',charge_ids:data.operations.charges.map(c=>c.id),delivery_rate_id:null,container_types:['20GP','40GP','40HQ','45HQ'],exchange_rates:{USD:'7',CAD:'5.25'}};
  for(const row of [...data.rates,...data.operations.charges,...data.operations.templates]){delete row.valid_from;delete row.valid_until;}
  return data;
};
try{
  const alice=await account('fixture-fcl-receiver'),bob=await account('fixture-owner');
  const dataset=fixture();await publish(alice,dataset);
  assert.equal((await bob.call('rate-get')).data.active_release,null);checks.push('two verified accounts use personal FCL; rates isolated');
  const input={...createFclInquiryDraft(),origin_city:'Shenzhen',pol:'Yantian',pod:'Vancouver',final_destination:'Toronto',cargo_name:'本地验收机械配件',containers:[{type:'40HQ',quantity:1}],cargo_type:'general',estimated_weight:{value:'18000',unit:'kg'},cargo_ready_date:'2026-10-08',incoterm:'EXW',selected_services:['ocean_freight','pickup','delivery','canada_customs'],contact:{name:'本地演示客户',email:'synthetic@example.test',company:'演示公司',phone:null},consent:true};
  const ticket=(await alice.call('case-create',input)).data;
  const confirmed=(await alice.call('case-confirm',{case_id:ticket.case_id,expected_version:ticket.case_version,expected_customer_supplement_ref:null,confirmed_fields:{changes:[]},reason:'本地验收确认'})).data;
  assert.equal((await bob.call('case-get',{case_id:ticket.case_id},true)).http,403);
  const bobCase=(await bob.call('case-create',input)).data;assert.notEqual(bobCase.case_id,ticket.case_id);
  const req={...estimateRequest(),pol:'Yantian',case_ref:ticket.case_id,rate_ids:[cosco],template_ids:['canada']};
  const estimate=(await alice.call('estimate-run',req)).data.items[0];
  assert.deepEqual(estimate.calculation.blockers,[]);assert.equal(estimate.calculation.valid_until,null);
  assert.equal(estimate.calculation.totals.cost_total,'24705.00');assert.equal(estimate.calculation.lines.filter(row=>row.code==='ocean_freight').length,1);
  const quote=(await alice.call('estimate-select',{estimate_id:estimate.estimate_id,expected_version:estimate.version,case_ref:ticket.case_id,expected_case_version:confirmed.case_version,expected_customer_supplement_ref:null})).data;
  assert.equal(quote.completeness.complete,true);assert.equal(quote.cost_rows.filter(row=>row.source_kind==='ocean_freight').length,1);
  assert.equal((await bob.call('quote-get',{contract_version:version,quote_ref:quote.quote_ref,version:null},true)).http,403);
  const config=(await alice.call('issuer-config')).data;
  await alice.call('issuer-config-save',{contract_version:version,expected_version:config.version,confirmed:true,input:{issuer_name:'FreightClaw 本地验收',issuer_address:'演示地址',issuer_phone:'',issuer_email:'test@example.test',terms:'仅供本地界面验收，不构成商业报价。',standard_fee_template_v1:null}});
  const configNow=(await alice.call('issuer-config')).data;
  const doc=(await alice.call('document-save',{contract_version:version,operation:'create',quote_ref:quote.quote_ref,expected_quote_version:quote.version,expected_quote_digest:quote.content_digest,expected_case_version:confirmed.case_version,expected_customer_supplement_ref:null,expected_config_version:configNow.version,quote_no:'LOCAL-UI-001',quote_date:'2026-10-08',valid_until:'2027-01-31',remark:'本地验收，非真实报价'})).data;
  assert.equal(doc.customer_input.valid_until,'2027-01-31');checks.push('no maintenance dates; selected ocean once plus 5 ancillary lines; formal quotation validity retained');
  await alice.page.goto(base+'/console/#fcl/rates',{waitUntil:'networkidle'});
  await alice.page.locator('.ops-ocean-table').waitFor();
  assert.equal(await alice.page.locator('.ops-ocean-table input[type=date]').count(),0);
  const price=alice.page.locator('[data-ocean-index="0"][data-ocean-key="price:40HQ"]');await price.fill('3500');await price.press('Tab');
  await alice.page.getByRole('button',{name:'保存运价',exact:true}).click();
  await alice.page.locator('#ops-config-confirm').check();await alice.page.getByRole('button',{name:'确认生效',exact:true}).click();
  await alice.page.getByText('当前运价已生效',{exact:true}).waitFor();
  const current=(await alice.call('estimate-get',{estimate_id:estimate.estimate_id,version:null})).data;
  assert.equal(current.calculation.totals.cost_total,'26805.00');
  assert.equal((await alice.call('estimate-get',{estimate_id:estimate.estimate_id,version:1})).data.calculation.totals.cost_total,'24705.00');
  assert.equal((await alice.call('quote-get',{contract_version:version,quote_ref:quote.quote_ref,version:1})).data.content_digest,quote.content_digest);
  checks.push('inline ocean update reprices new estimate; old estimate and quote digest unchanged');
  await alice.page.evaluate(()=>window.scrollTo(0,0));await alice.page.screenshot({path:join(out,'ocean-rates-desktop.png'),fullPage:false});
  await alice.page.goto(base+'/console/#fcl/templates',{waitUntil:'networkidle'});await alice.page.locator('[data-fcl-form="ops-template"]').waitFor();
  assert.equal(await alice.page.locator('[name="template.valid_until"]').count(),0);
  await alice.page.getByRole('button',{name:'新增费用',exact:true}).click();
  await alice.page.locator('[name="charges.5.name_zh"]').fill('本地验收附费');await alice.page.locator('[name="charges.5.amount"]').fill('25');
  await alice.page.locator('[name="charges.5.currency"]').selectOption('CAD');
  await alice.page.getByRole('button',{name:'保存模板',exact:true}).click();
  await alice.page.locator('#ops-config-confirm').check();await alice.page.getByRole('button',{name:'确认生效',exact:true}).click();
  await alice.page.getByText('已发布，并重新计算受影响的预估报价。',{exact:true}).waitFor();
  await alice.page.reload({waitUntil:'networkidle'});await alice.page.locator('[data-fcl-form="ops-template"]').waitFor();
  const updated=(await alice.call('rate-get')).data.active_release.input;
  assert.equal(updated.operations.charges.find(row=>row.name_zh==='本地验收附费').amount,'25');
  checks.push('template inline add and edit saves without validity');
  await alice.page.evaluate(()=>window.scrollTo(0,0));await alice.page.screenshot({path:join(out,'fee-template-desktop.png'),fullPage:true});
  await alice.page.setViewportSize({width:390,height:844});await alice.page.screenshot({path:join(out,'fee-template-mobile.png'),fullPage:true});
  assert.equal(await alice.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await alice.page.setViewportSize({width:1440,height:1000});
  await alice.page.getByRole('button',{name:'新增模板',exact:true}).click();
  await alice.page.locator('[name="template.label"]').fill('蒙特利尔费用');await alice.page.locator('[name="template.pod"]').fill('Vancouver');await alice.page.locator('[name="template.destination"]').fill('Montreal');
  await alice.page.getByRole('button',{name:'新增费用',exact:true}).click();await alice.page.locator('[name="charges.0.name_zh"]').fill('本地操作费');await alice.page.locator('[name="charges.0.amount"]').fill('10');
  await alice.page.getByRole('button',{name:'保存模板',exact:true}).click();await alice.page.locator('#ops-config-confirm').check();await alice.page.getByRole('button',{name:'确认生效',exact:true}).click();
  await alice.page.getByText('已发布，并重新计算受影响的预估报价。',{exact:true}).waitFor();
  const afterNew=(await alice.call('rate-get')).data.active_release.input;assert.ok(afterNew.operations.templates.some(t=>t.label==='蒙特利尔费用'&&t.charge_ids.length===1));checks.push('new template and its first fee save directly on the same page');
  const legacy=globalThis.structuredClone(afterNew),old={...legacy.operations.charges[0],id:'legacy-base',code:'ocean_freight',name_zh:'基础海运费',name_en:'Ocean Freight',amount:'3200',currency:'USD'};
  legacy.operations.charges.push(old);legacy.operations.templates[0].charge_ids.push(old.id);await publish(alice,legacy);
  const blocked=(await alice.call('estimate-run',req)).data.items[0];assert.ok(blocked.calculation.blockers.includes('legacy_ocean_fee_review:legacy-base'));assert.equal(blocked.calculation.totals.cost_total,null);
  await alice.page.goto(base+'/console/#fcl/rates',{waitUntil:'networkidle'});await alice.page.reload({waitUntil:'networkidle'});await alice.page.locator('.ops-rate-pending summary').click();
  await alice.page.screenshot({path:join(out,'legacy-fee-review.png'),fullPage:false});
  await alice.page.locator('[data-id="charge:legacy-base"]').click();await alice.page.getByRole('button',{name:'保存运价',exact:true}).click();
  await alice.page.locator('#ops-config-confirm').check();await alice.page.getByRole('button',{name:'确认生效',exact:true}).click();await alice.page.getByText('当前运价已生效',{exact:true}).waitFor();
  const resolved=(await alice.call('estimate-run',req)).data.items[0];assert.deepEqual(resolved.calculation.blockers,[]);assert.equal(resolved.calculation.lines.filter(row=>row.code==='ocean_freight').length,1);
  assert.equal((await alice.call('rate-get')).data.active_release.input.operations.charges.find(c=>c.id==='legacy-base').amount,'3200');checks.push('legacy base amount retained; explicit UI exclusion removes duplicate calculation only');
  await bob.page.goto(base+'/console/#fcl',{waitUntil:'networkidle'});await bob.page.getByRole('button',{name:'新增询价',exact:true}).click();
  await bob.page.locator('#new-case-name').fill('第二个账号客户');await bob.page.locator('#new-case-email').fill('second@example.test');await bob.page.locator('[data-fcl-form="case-create"] [name="consent"]').check();
  await bob.page.getByRole('button',{name:'保存并完善需求',exact:true}).click();await bob.page.waitForURL(/#fcl\/case\//u);assert.doesNotMatch(await bob.page.locator('main').innerText(),/fcl_not_found|创建企业/);checks.push('second account creates inquiry through UI without enterprise');
  assert.deepEqual(errors,[]);
  await writeFile(join(out,'acceptance.json'),JSON.stringify({status:'pass',mode:'local-fixture',checks,pageErrors:errors,case_id:ticket.case_id,quote_ref:quote.quote_ref,document_id:doc.document_id},null,2));
  console.log(JSON.stringify({status:'pass',checks,screenshots:out},null,2));
}catch(error){
  for(const [index,context] of contexts.entries()){const page=context.pages()[0];if(page){await page.screenshot({path:join(out,`failure-${index}.png`),fullPage:true});await writeFile(join(out,`failure-${index}.txt`),await page.locator('body').innerText());}}
  throw error;
}finally{await browser.close();}
