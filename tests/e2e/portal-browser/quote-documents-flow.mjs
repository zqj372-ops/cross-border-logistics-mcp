import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loginFixture} from './fixture-login.mjs';
const base=process.env.PORTAL_BASE_URL,runtime=process.env.PORTAL_QA_RUNTIME,out=process.env.PORTAL_ARTIFACTS;
assert.equal(new URL(base).hostname,'127.0.0.1');assert.ok(runtime&&out);mkdirSync(runtime,{recursive:true});mkdirSync(out,{recursive:true});
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href),browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],expectedUnavailable=[],observedFailures=[];let unsavedInputDialogObserved=false;page.on('pageerror',e=>errors.push(e.message));page.on('response',response=>{if(response.status()>=400){observedFailures.push((async()=>{let body;try{body=await response.json();}catch{body=null;}let payload;try{payload=response.request().postDataJSON();}catch{payload=null;}return {method:response.request().method(),path:new URL(response.url()).pathname,status:response.status(),schema:String(body?.schema_version??''),reasons:Array.isArray(body?.reason_codes)?[...body.reason_codes]:[],id:payload?.id??null,mode:payload?.mode??null,version:payload?.contract_version??null};})());}});page.on('console',m=>{if(m.type()==='error'){if(m.location().url?.endsWith('/public/customs/quota')&&m.text().includes('503'))expectedUnavailable.push('fixture public customs quota unavailable');else errors.push(m.text());}});
const session=resolve(runtime,'document-session.json');let counter=0;
function cli(args,input){const extra=[];if(input){const path=resolve(runtime,`doc-input-${counter++}.json`);writeFileSync(path,JSON.stringify(input),{mode:0o600});extra.push('--input',path);}extra.push('--idempotency-key',`e2e-${Date.now()}-${counter++}`);try{return {code:0,data:JSON.parse(execFileSync(process.execPath,[resolve('dist/cli/bin/freightclaw.mjs'),'workspace',...args,'--session-file',session,...extra],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))};}catch(e){return {code:e.status,data:JSON.parse(e.stdout||e.stderr)};}}
async function shot(name,width){await page.setViewportSize({width,height:1000});await page.evaluate(async()=>{await document.fonts.ready;window.scrollTo(0,0);});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:resolve(out,name+'.png'),fullPage:true});}
try{
 const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(base+'/console/api/v1/quote-documents/config')).status(),401);await anonymous.close();
 await page.goto(base+'/console/#quote-documents');await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
 await loginFixture(page,base,'企业负责人 owner@example.test');const start=cli(['login','start','--endpoint',base]);assert.equal(start.code,3);await page.goto(start.data.verification_url);await page.getByRole('button',{name:'确认连接',exact:true}).click();await page.getByRole('heading',{name:'CLI 已获准连接'}).waitFor();assert.equal(cli(['login','finish']).code,0);
 assert.equal((await page.context().request.post(base+'/console/api/v1/quote-documents/preview',{data:{input:{}}})).status(),403);
 assert.equal(cli(['documents','config']).data.data.input,null);
 await page.goto(base+'/console/#quote-documents');await page.getByRole('heading',{name:'填写你的公司资料',exact:true}).waitFor();await page.getByRole('link',{name:'填写公司与报价模板',exact:true}).click();
 for(const [name,value]of Object.entries({company_name:'FreightClaw 测试物流',company_address:'仅用于本地验收',company_email:'qa@example.test',company_phone:'',terms:'测试报价条款：所列费用以已确认的货物、地址和服务条件为准。此单用于功能验收。'}))await page.locator(`[name="${name}"]`).fill(value);
 await page.getByRole('button',{name:'确认保存企业模板'}).click();await page.getByText('企业模板已保存并读回。',{exact:true}).waitFor();await shot('quote-template-desktop',1440);
 await page.getByRole('link',{name:'制作与记录',exact:true}).click();await page.locator('[name="quote_no"]').fill('QA-DOCUMENT-001');await page.locator('[name="customer_name"]').fill('测试客户 · 加拿大住宅派送');await page.locator('[name="valid_until"]').fill('2099-12-31');await page.locator('[name="origin"]').fill('多伦多');await page.locator('[name="destination"]').fill('渥太华');await page.getByText('运输单号、汇率与备注',{exact:true}).click();await page.locator('[name="USD"]').fill('7.2');await page.locator('[name="CAD"]').fill('5.3');await page.locator('[data-fee="0"] [name="name"]').fill('住宅派送费');await page.locator('[data-fee="0"] [name="quantity"]').fill('2');await page.locator('[data-fee="0"] [name="unit_price"]').fill('125.15');
 await page.getByText('运输单号、汇率与备注',{exact:true}).click();await page.getByRole('button',{name:'核对费用与合计',exact:true}).click();await page.getByRole('button',{name:'确认保存草稿',exact:true}).waitFor();await shot('quote-editor-desktop',1440);await shot('quote-editor-mobile',390);
 const saveResponse=page.waitForResponse(r=>r.url().endsWith('/quote-documents/save'));await page.getByRole('button',{name:'确认保存草稿',exact:true}).click();const saved=(await (await saveResponse).json()).data;await page.getByRole('heading',{name:'报价单已保存',exact:true}).waitFor();assert.equal(saved.state,'draft');assert.equal(cli(['documents','get'],{id:saved.id}).data.data.id,saved.id);
 // ---- published synthetic residential release for the linked loop (fixture config is read-only) ----
 const rateConfig=JSON.parse(execFileSync(process.execPath,['--import','tsx/esm','--input-type=module','-e',"import {config} from './tests/quote-native/fixture.ts';process.stdout.write(JSON.stringify(config));"],{encoding:'utf8'}));
 const rateCurrent=cli(['residential-rates','get']);assert.equal(rateCurrent.code,0,JSON.stringify(rateCurrent));
 const rateSaved=cli(['residential-rates','save'],{expected_version:rateCurrent.data.data.version,input:rateConfig});assert.equal(rateSaved.code,0,JSON.stringify(rateSaved));
 const ratePreview=cli(['residential-rates','preview']);assert.equal(ratePreview.code,0,JSON.stringify(ratePreview));
 const ratePublished=cli(['residential-rates','publish'],{expected_version:rateSaved.data.data.version,preview_hash:ratePreview.data.data.preview_hash,confirmation:'reviewed_sources_and_conditions'});assert.equal(ratePublished.code,0,JSON.stringify(ratePublished));
 const rateProbe=cli(['quote','self'],{postal_code:'M1B 5W9',address_line:null,city:null,province:'ON',cbm:'2.01',weight_kg:'200',piece_count:1,packaging_type:'pallet',longest_side_cm:'120',address_type:'private',requires_liftgate:true,requires_pallet_jack:false,requires_appointment:true,explicit_pallet_count:1,is_stackable:false,detention_minutes:31});
 assert.equal(rateProbe.code,0,JSON.stringify(rateProbe));assert.equal(rateProbe.data.status,'success',JSON.stringify(rateProbe));
 // ---- C6 linked loop: case review context -> native quote -> linked prepare/save/approve + supplement gate ----
 const caseDraft={mode:'shipping',services:['ocean'],transportMode:'fcl',origin:'Shanghai',destination:'Toronto M5X 1A9',product:'Synthetic linked acceptance',readyDate:'',containerType:'40HQ',containerCount:'1',containerCountUnknown:false,volume:'',volumeUnknown:true,weight:'',weightUnknown:true,cargoType:'',palletCount:'',skuCount:'',deliverySite:'warehouse',unloading:'dock',businessRegion:'canada',notes:'link acceptance',contactName:'Linked QA',email:'linked-qa@example.test',company:'',phone:'',consent:true};
 const created=cli(['cases','create'],caseDraft);assert.equal(created.code,0,JSON.stringify(created));const caseId=created.data.data.case_id;
 assert.equal(cli(['cases','update','--id',caseId],{expected_version:1,status:'needs_input',public_note:'请补充包装信息。',internal_note:''}).code,0);
 assert.equal(cli(['cases','reply','--id',caseId],{expected_version:2,message:'纸箱包装，单件 18kg。'}).code,0);
 await page.goto(base+'/console/#case/'+caseId);
 try{await page.getByText('服务端已核对的最新客户补充：').waitFor({timeout:20000});}catch(error){const diagnostic={url:page.url().replace(/[?#].*$/u,''),content:(await page.locator('#content').innerHTML().catch(()=>'')).slice(0,1500)};await page.screenshot({path:resolve(out,'first-case-context-failure.png'),fullPage:true}).catch(()=>{});console.error('CASE-CONTEXT-FAILURE',JSON.stringify(diagnostic));throw error;}
 const derivedRef=await page.locator('[data-linked-ref]').getAttribute('data-ref');assert.ok(derivedRef,'derived customer supplement ref must be displayed by the server snapshot');assert.equal(await page.locator('[data-linked-confirm]').isChecked(),false,'confirmation must start unchecked');assert.equal(await page.getByRole('button',{name:'用自有运价制作关联报价单',exact:true}).isDisabled(),true);
 await page.locator('[data-linked-confirm]').check();await page.getByRole('button',{name:'用自有运价制作关联报价单',exact:true}).click();
 await page.getByRole('heading',{name:'私人地址报价 · 自有运价',exact:true}).waitFor();await page.getByText('关联询价 '+caseId,{exact:false}).waitFor();
 await page.getByLabel('加拿大邮编').fill('M1B 5W9');await page.getByLabel('总体积 · m³').fill('2.01');await page.getByLabel('总重量 · kg').fill('200');await page.getByLabel('件数',{exact:true}).fill('1');await page.locator('[name="address_type"]').selectOption('residential');await page.locator('[name="packaging_type"]').selectOption('pallet');
 await page.locator('[name="longest_side_cm"]').fill('120');await page.locator('[name="address_line"]').fill('20 Synthetic Road');await page.locator('[name="city"]').fill('Toronto');await page.locator('[name="province"]').fill('ON');
 await page.getByRole('button',{name:'查询规则试算',exact:true}).click();await page.getByRole('button',{name:'制作报价单',exact:true}).click();
 await page.getByRole('heading',{name:'制作报价单',exact:true}).waitFor();await page.getByText('关联询价 '+caseId,{exact:false}).waitFor();await page.locator('[name="quote_no"]').fill('QA-LINKED-001');await page.locator('[name="customer_name"]').fill('Linked QA customer');
 await page.getByRole('button',{name:'核对费用与合计',exact:true}).click();await page.getByRole('button',{name:'确认保存草稿',exact:true}).waitFor();
 const linkedSaveResponse=page.waitForResponse(r=>r.url().endsWith('/quote-documents/save'));
 await page.getByRole('button',{name:'确认保存草稿',exact:true}).click();const linkedSaved=(await (await linkedSaveResponse).json()).data;
 await page.getByText('关联报价单已保存并读回。',{exact:false}).waitFor();
 assert.equal(linkedSaved.inquiry_case_link_v1.case_ref,caseId);assert.equal(linkedSaved.inquiry_case_link_v1.reviewed_customer_event_ref,derivedRef);
 const cliLinked=cli(['documents','get'],{contract_version:'inquiry-quote-link@2026-09-13.v1',id:linkedSaved.id});assert.equal(cliLinked.code,0,JSON.stringify(cliLinked));assert.equal(cliLinked.data.data.id,linkedSaved.id);assert.equal(cliLinked.data.data.inquiry_case_link_v1.case_ref,caseId);
 await page.getByText('人工核对并确认报价',{exact:true}).click();for(const [name,value]of Object.entries({evidence_ref:'manual:linked-qa-only',evidence_version:'qa-v1',review_notes:'仅功能验收；核对已发布运价来源与客户补充。'}))await page.locator(`[name="${name}"]`).fill(value);await page.locator('[name="confirmed"]').check();
 const linkedApproveResponse=page.waitForResponse(r=>r.url().endsWith('/quote-documents/approve'));
 await page.getByRole('button',{name:'确认人工核对',exact:true}).click();const linkedApproved=(await (await linkedApproveResponse).json()).data;
 await page.getByText('人工核对已保存并读回。',{exact:true}).waitFor();assert.equal(linkedApproved.state,'approved');
 assert.equal(cli(['cases','update','--id',caseId],{expected_version:3,status:'needs_input',public_note:'请再次确认包装。',internal_note:''}).code,0);
 assert.equal(cli(['cases','reply','--id',caseId],{expected_version:4,message:'追加轻抛货说明。'}).code,0);
 await page.getByRole('button',{name:'复制为新报价单',exact:true}).click();await page.getByText('未重新确认前不能核对费用或保存',{exact:false}).waitFor();
 await page.getByRole('button',{name:'核对费用与合计',exact:true}).click();await page.getByText('复制后的关联报价单必须重新核对客户资料',{exact:false}).waitFor();
 await page.getByRole('button',{name:'重新核对客户资料',exact:true}).click();await page.getByText('服务端最新客户补充：',{exact:false}).waitFor();
 await page.locator('[data-linked-reverify]').check();await page.getByRole('button',{name:'核对费用与合计',exact:true}).click();
 await page.getByText('客户资料已更新，请返回询价详情重新确认后再制作关联报价单。',{exact:false}).waitFor();
 await page.goto(base+'/console/#quote-documents');await page.locator(`[data-action="qdoc-open"][data-id="${saved.id}"]`).first().click();await page.getByText('报价单已保存',{exact:false}).waitFor();
 // ---- C6r8 staged linked checks: exact requests, per-step id/state, prepopulated failures ----
 const LINK='inquiry-quote-link@2026-09-13.v1',V2='quote-documents@2026-09-13.v2',V1='portal@2026-09-05.v1';
 const expectedFailures=[
  {key:'linked-old-supplement-formal',method:'POST',path:'/console/api/v1/quote-documents/export',status:200,schema:V2,reasons:['inquiry_quote_case_review_required'],count:1,seen:0,id:null,mode:'formal',version:LINK},
  {key:'history-missing',method:'POST',path:'/console/api/v1/quote-documents/export',status:503,schema:V2,reasons:['inquiry_quote_history_bytes_missing'],count:1,seen:0,id:null,mode:'history',version:LINK},
  {key:'newly-approved-formal',method:'POST',path:'/console/api/v1/quote-documents/export',status:503,schema:V2,reasons:['document_renderer_unavailable'],count:1,seen:0,id:null,mode:'formal',version:LINK},
  {key:'injected-list-failure',method:'POST',path:'/console/api/v1/quote-documents/list',status:503,schema:V2,reasons:['document_service_unavailable'],count:2,seen:0,id:null,mode:null,version:LINK},
  {key:'unlinked-draft-formal',method:'POST',path:'/console/api/v1/quote-documents/export',status:503,schema:V1,reasons:['document_renderer_unavailable'],count:1,seen:0,id:null,mode:null,version:null},
 ];

 const recordFailure=async(response,key)=>{const entry=expectedFailures.find(value=>value.key===key);assert.ok(entry,'unknown expected failure '+key);assert.equal(response.status(),entry.status,`${key} status`);const body=await response.json();assert.equal(body.schema_version,entry.schema,`${key} schema`);assert.deepEqual(body.reason_codes,entry.reasons,`${key} reasons ${JSON.stringify(body)}`);entry.seen+=1;return body;};
 const postTarget=request=>{try{return request.postDataJSON()}catch{return null;}};
 const exportWaiter=(id,mode='formal')=>page.waitForResponse(r=>{const body=postTarget(r.request());return r.request().method()==='POST'&&r.url().endsWith('/quote-documents/export')&&body!==null&&body.id===id&&body.mode===mode;});
 const linkedCurrent=async(id)=>{const read=cli(['documents','get'],{contract_version:'inquiry-quote-link@2026-09-13.v1',id});assert.equal(read.code,0,JSON.stringify(read));return read.data.data;};
 let linkedDraftSeen=false;
 const createLinkedDraft=async(quoteNo,expectDialog=false)=>{
  await page.goto(base+'/console/#case/'+caseId);
  if(!linkedDraftSeen){linkedDraftSeen=true;await page.reload();}
  await page.locator('[data-linked-ref]').waitFor();
  let dirtyMarker='';
  if(expectDialog){
   await page.evaluate(()=>{location.hash='quote-documents';});
   await page.getByRole('button',{name:'新建报价单',exact:true}).click();
   const quoteNo=page.locator('[name="quote_no"]');
   await quoteNo.waitFor();assert.equal(await quoteNo.isEditable(),true,'the new draft editor must be editable before dirty input is written');
   dirtyMarker='DIRTY-GUARD-'+Date.now();await quoteNo.fill(dirtyMarker);
   await page.evaluate(target=>{location.hash=target;},'case/'+caseId);
   await page.locator('[data-linked-ref]').waitFor();
  }
  await page.locator('[data-linked-ref]').waitFor();
  try{await page.getByText('服务端已核对的最新客户补充：').waitFor({timeout:20000});}catch(error){const diagnostic={url:page.url().replace(/[?#].*$/u,''),content:(await page.locator('#content').innerHTML().catch(()=>'')).slice(0,1500)};await page.screenshot({path:resolve(out,'helper-case-context-failure.png'),fullPage:true}).catch(()=>{});console.error('CASE-CONTEXT-FAILURE',JSON.stringify(diagnostic));throw error;}
  await page.locator('[data-linked-confirm]').check();
  const dialogMessage='当前还有未保存的修改（报价单或运价试算），继续将放弃这些修改。是否继续？';
  const clickLinkedEntry=()=>page.getByRole('button',{name:'用自有运价制作关联报价单',exact:true}).click();
  let settleCancel,rejectCancel;const cancelSettled=new Promise((resolve,reject)=>{settleCancel=resolve;rejectCancel=reject;});
  const cancelHandler=dialog=>{(async()=>{try{assert.equal(dialog.type(),'confirm');assert.equal(dialog.message(),dialogMessage);unsavedInputDialogObserved=true;await dialog.dismiss();settleCancel('cancelled');}catch(error){rejectCancel(error);}})();};
  page.on('dialog',cancelHandler);
  let cancelOutcome;
  try{await clickLinkedEntry();cancelOutcome=await Promise.race([cancelSettled,new Promise(resolve=>setTimeout(()=>resolve('no-dialog'),2000))]);}finally{page.off('dialog',cancelHandler);}
  console.log('STAGE linked-entry-click outcome='+cancelOutcome+(expectDialog?' expected-dirty':''));
  if(cancelOutcome==='cancelled'){
   assert.ok(page.url().includes('#case/'),'cancelling must not navigate away from the case');
   assert.equal(await page.locator('[data-linked-confirm]').isChecked(),true,'cancelling must keep the reviewed confirmation');
   await page.evaluate(()=>{location.hash='quote-documents';});
   const preserved=page.locator('[name="quote_no"]');await preserved.waitFor();
   assert.equal(await preserved.inputValue(),dirtyMarker,'cancelling must keep the unsaved draft input');
   await page.goto(base+'/console/#case/'+caseId);await page.locator('[data-linked-confirm]').waitFor();
   let settleAccept,rejectAccept;const acceptSettled=new Promise((resolve,reject)=>{settleAccept=resolve;rejectAccept=reject;});
   const acceptHandler=dialog=>{(async()=>{try{assert.equal(dialog.type(),'confirm');assert.equal(dialog.message(),dialogMessage);await dialog.accept();settleAccept();}catch(error){rejectAccept(error);}})();};
   page.on('dialog',acceptHandler);
   try{await clickLinkedEntry();await acceptSettled;}finally{page.off('dialog',acceptHandler);}
  } else if(expectDialog){ assert.fail('the unsaved-input confirm was expected for this dirty hand-off but did not fire'); }
  await page.getByRole('heading',{name:'私人地址报价 · 自有运价',exact:true}).waitFor();await page.getByLabel('加拿大邮编').fill('M1B 5W9');await page.getByLabel('总体积 · m³').fill('2.01');await page.getByLabel('总重量 · kg').fill('200');await page.getByLabel('件数',{exact:true}).fill('1');
  await page.locator('[name="address_type"]').selectOption('residential');await page.locator('[name="packaging_type"]').selectOption('pallet');await page.locator('[name="longest_side_cm"]').fill('120');await page.locator('[name="address_line"]').fill('20 Synthetic Road');await page.locator('[name="city"]').fill('Toronto');await page.locator('[name="province"]').fill('ON');
  await page.getByRole('button',{name:'查询规则试算',exact:true}).click();await page.getByRole('button',{name:'制作报价单',exact:true}).click();
  await page.getByRole('heading',{name:'制作报价单',exact:true}).waitFor();await page.locator('[name="quote_no"]').fill(quoteNo);await page.locator('[name="customer_name"]').fill('Linked QA customer');await page.getByRole('button',{name:'核对费用与合计',exact:true}).click();await page.getByRole('button',{name:'确认保存草稿',exact:true}).waitFor();
  const saveWait=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/quote-documents/save'));
  await page.getByRole('button',{name:'确认保存草稿',exact:true}).click();const saved=(await (await saveWait).json()).data;
  await page.getByText('关联报价单已保存并读回。',{exact:false}).waitFor();assert.equal(saved.state,'draft');assert.equal((await linkedCurrent(saved.id)).state,'draft');return saved;
 };
 assert.equal((await linkedCurrent(linkedSaved.id)).state,'approved');
 // old supplement: formal export must be exactly the approved 200 manual_review outcome
 await page.goto(base+'/console/#quote-documents');await page.locator(`[data-action="qdoc-open"][data-id="${linkedSaved.id}"]`).first().click();await page.getByText('报价单已保存',{exact:false}).waitFor();
 expectedFailures.find(entry=>entry.key==='linked-old-supplement-formal').id=linkedSaved.id;
 const oldExportWait=exportWaiter(linkedSaved.id);await page.getByRole('button',{name:'导出 PDF',exact:true}).click();
 const oldExportBody=await recordFailure(await oldExportWait,'linked-old-supplement-formal');
 assert.equal(oldExportBody.status,'manual_review');assert.equal(oldExportBody.data,null);void oldExportBody;
 // reconfirm the new supplement: new document with a new ref, CLI readback
 console.log('STAGE linked-export-old-supplement done');const secondSaved=await createLinkedDraft('QA-LINKED-002',true);console.log('STAGE reconfirmed-new-draft done');
 assert.notEqual(secondSaved.id,linkedSaved.id);assert.notEqual(secondSaved.inquiry_case_link_v1.reviewed_customer_event_ref,derivedRef);
 assert.equal((await linkedCurrent(secondSaved.id)).inquiry_case_link_v1.reviewed_customer_event_ref,secondSaved.inquiry_case_link_v1.reviewed_customer_event_ref);
 // history without cached bytes: exact 503 reason and no fabricated receipt
 expectedFailures.find(entry=>entry.key==='history-missing').id=secondSaved.id;
 const historyWait=exportWaiter(secondSaved.id,'history');await page.getByRole('button',{name:'历史回执（仅已有缓存）',exact:true}).click();
 await recordFailure(await historyWait,'history-missing');await page.getByText('该报价没有可用的历史回执，不能补生成。',{exact:false}).waitFor();
 // approve this draft while the follow-up list call fails: the confirmed result must survive
 await page.route('**/quote-documents/list',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({schema_version:'quote-documents@2026-09-13.v2',status:'unavailable',data:null,reason_codes:['document_service_unavailable']})}));
 await page.getByText('人工核对并确认报价',{exact:true}).click();for(const [name,value]of Object.entries({evidence_ref:'manual:linked-list-failure',evidence_version:'qa-v1',review_notes:'列表故障时仍应保留已确认结果。'}))await page.locator(`[name="${name}"]`).fill(value);await page.locator('[name="confirmed"]').check();
 const approveWait=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/quote-documents/approve'));await page.getByRole('button',{name:'确认人工核对',exact:true}).click();
 assert.equal((await approveWait).status(),200);await page.getByText('人工核对已保存并读回。',{exact:false}).waitFor();await page.getByText('报价记录暂不可用',{exact:false}).waitFor();assert.equal(await page.getByText('暂无报价记录',{exact:false}).count(),0,'list failure must not read as an empty history');
 assert.equal((await linkedCurrent(secondSaved.id)).state,'approved');await page.unroute('**/quote-documents/list');
 // newly approved document: the real renderer is unavailable on this host
 expectedFailures.find(entry=>entry.key==='newly-approved-formal').id=secondSaved.id;
 const rendererWait=exportWaiter(secondSaved.id);await page.getByRole('button',{name:'导出 PDF',exact:true}).click();
 const rendererBody=await recordFailure(await rendererWait,'newly-approved-formal');assert.equal(rendererBody.status,'unavailable');assert.equal(rendererBody.data,null);void rendererBody;
 // another real draft: open the approval details, fill a reason, then reject
 const thirdSaved=await createLinkedDraft('QA-LINKED-003',true);console.log('STAGE third-draft done');
 await page.getByText('人工核对并确认报价',{exact:true}).click();await page.locator('[name="reason"]').fill('linked reject acceptance');
 const rejectWait=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/quote-documents/reject'));await page.getByRole('button',{name:'退回修改',exact:true}).click();
 assert.equal((await rejectWait).status(),200);await page.getByText('已退回，原因已保存。',{exact:false}).waitFor();assert.equal((await linkedCurrent(thirdSaved.id)).state,'rejected');
 // sales: accept the existing viewer invitation, then verify a non-manager cannot see the owner case or linked record
 const salesContext=await browser.newContext(),salesPage=await salesContext.newPage();
 await salesPage.goto(base+'/console/#cases');await loginFixture(salesPage,base,'业务员 sales@example.test');
 await salesPage.goto(base+'/console/#members');const inviteButton=salesPage.getByRole('button',{name:'接受邀请'});await inviteButton.waitFor();
 const acceptWait=salesPage.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/console/api/v1/invitations/'));await inviteButton.click();assert.ok([200,201].includes((await acceptWait).status()),'invitation acceptance must succeed');
 const orgSelect=salesPage.locator('#organization');if(await orgSelect.count())await orgSelect.selectOption('org_fixture');await salesPage.waitForTimeout(800);
 const salesSession=await salesPage.evaluate(()=>fetch('/console/api/v1/session').then(r=>r.json()));assert.equal(salesSession.organization_id,'org_fixture','sales must have the fixture organization selected');
 const salesState=await salesPage.evaluate(()=>fetch('/console/api/v1/state').then(r=>r.json()));assert.ok((salesState.data?.memberships||[]).some(m=>m.organization_id==='org_fixture'&&m.user_id===salesSession.identity.user_id&&m.status==='active'&&m.role==='viewer'),'sales must be an active viewer of the fixture organization');
 await salesPage.goto(base+'/console/#case/'+caseId);await salesPage.waitForFunction(()=>{const content=document.querySelector('#content');return content!==null&&!content.textContent.includes('需求编号')&&!content.textContent.includes('载入');},null,{timeout:20000});
 assert.equal(await salesPage.getByText('需求编号').count(),0,'an active non-manager must not read the case detail');
 assert.equal(await salesPage.getByRole('button',{name:'用自有运价制作关联报价单',exact:true}).count(),0,'non-manager must not see the linked entry');
 await salesPage.goto(base+'/console/#quote-documents');await salesPage.waitForTimeout(1500);
 assert.equal(await salesPage.locator(`[data-action="qdoc-open"][data-id="${secondSaved.id}"]`).count(),0,'linked record must stay invisible to a non-manager');
 await salesContext.close();
 // late response: withhold a real committed success, switch to a different identity, then release
 const lateDraft=await createLinkedDraft('QA-LINKED-004',true);console.log('STAGE late-draft done');
 await page.getByText('人工核对并确认报价',{exact:true}).click();for(const [name,value]of Object.entries({evidence_ref:'manual:linked-late',evidence_version:'qa-v1',review_notes:'晚到响应不得改写已切换身份。'}))await page.locator(`[name="${name}"]`).fill(value);await page.locator('[name="confirmed"]').check();
 let releaseLate,lateFetched;const fetchedPromise=new Promise(resolve=>{lateFetched=resolve;}),lateGate=new Promise(resolve=>{releaseLate=resolve;});
 await page.route('**/quote-documents/approve',async route=>{const response=await route.fetch();const body=await response.json();lateFetched(body);await lateGate;await route.fulfill({response,body:JSON.stringify(body)});});
 await page.getByRole('button',{name:'确认人工核对',exact:true}).click();
 const lateBody=await fetchedPromise;assert.equal(lateBody.status,'success','the real response must be committed before it is withheld');
 await page.locator('[data-action="account-menu"]').click();await page.locator('[data-action="logout"]').click();
 const anonymousState=await page.waitForFunction(async()=>{const state=await fetch('/console/api/v1/session').then(r=>r.json());return state.authenticated===false&&state.organization_id===null?state:false;});
 const anonymousValue=await anonymousState.jsonValue();await anonymousState.dispose();assert.equal(anonymousValue.authenticated,false,'logout must complete before releasing the withheld response');
 const lateDelivered=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/quote-documents/approve'));releaseLate();
 const deliveredResponse=await lateDelivered;await deliveredResponse.finished();await page.unroute('**/quote-documents/approve');
 assert.equal(await page.getByText('人工核对已保存并读回。',{exact:false}).count(),0,'a stale response must not repaint after an identity switch');
 assert.equal((await linkedCurrent(lateDraft.id)).state,'approved','the withheld response was already committed server-side');
 await loginFixture(page,base,'企业负责人 owner@example.test');
 // initial list failure must surface as unavailable, never as an empty history
 await page.route('**/quote-documents/list',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({schema_version:'quote-documents@2026-09-13.v2',status:'unavailable',data:null,reason_codes:['document_service_unavailable']})}));
 await page.goto(base+'/console/#quote-documents');await page.getByText('报价记录暂不可用',{exact:false}).waitFor();
 assert.equal(await page.getByText('暂无报价记录',{exact:false}).count(),0,'initial list failure must not be presented as an empty history');await page.unroute('**/quote-documents/list');
 await page.goto(base+'/console/#quote-documents');await page.reload();await page.getByText('新建报价单',{exact:false}).waitFor();await page.locator(`[data-action="qdoc-open"][data-id="${saved.id}"]`).first().click();await page.getByText('报价单已保存',{exact:false}).waitFor();assert.equal((await linkedCurrent(saved.id)).state,'draft');
 let rendererUnavailable=null,downloadEvent=page.waitForEvent('download').catch(()=>null);
 expectedFailures.find(entry=>entry.key==='unlinked-draft-formal').id=saved.id;
 const draftExport=page.waitForResponse(r=>r.url().endsWith('/quote-documents/export'));
 await page.getByRole('button',{name:'导出 PDF',exact:true}).click();
 const draftReply=await draftExport,draftBody=await draftReply.json();
 if(draftReply.status()===503){await recordFailure(draftReply,'unlinked-draft-formal');rendererUnavailable='draft export returned '+draftReply.status()+' '+draftBody.reason_codes.join(',');}
 else{const download=await downloadEvent;assert.ok(download,JSON.stringify(draftBody));await download.saveAs(resolve(out,'draft-quotation.pdf'));assert.ok(readFileSync(resolve(out,'draft-quotation.pdf')).subarray(0,5).toString()==='%PDF-');}
 await page.getByText('人工核对并确认报价',{exact:true}).click();for(const [name,value]of Object.entries({evidence_ref:'manual:local-qa-only',evidence_version:'qa-v1',review_notes:'仅功能验收；核对两票每票 125.15 USD，合计 250.30 USD。'}))await page.locator(`[name="${name}"]`).fill(value);await page.locator('[name="confirmed"]').check();await page.getByRole('button',{name:'确认人工核对',exact:true}).click();await page.getByText('人工核对已保存并读回。',{exact:true}).waitFor();
 if(rendererUnavailable){const failed=cli(['documents','export','--file',resolve(out,'approved-quotation.pdf')],{id:saved.id});assert.notEqual(failed.code,0,'renderer unavailable must not report success');assert.equal(existsSync(resolve(out,'approved-quotation.pdf')),false,'failed export must not create a file');rendererUnavailable+='; CLI formal export fail-closed verified';}
 else{const exported=cli(['documents','export','--file',resolve(out,'approved-quotation.pdf')],{id:saved.id});assert.equal(exported.code,0,JSON.stringify(exported));assert.equal(exported.data.data.draft,false);assert.equal(cli(['documents','export','--file',resolve(out,'approved-quotation.pdf')],{id:saved.id}).code,1,'must not overwrite existing file');}
 // --- C6r13-a: real revocation of a promoted admin member ---
 const changeMembership=async(targetPage,userId,change)=>{const key='e2e-membership-'+Date.now()+'-'+Math.random().toString(36).slice(2,10);const result=await targetPage.evaluate(async([id,payload,idempotencyKey])=>{const session=await fetch('/console/api/v1/session').then(r=>r.json());const response=await fetch('/console/api/v1/memberships/'+encodeURIComponent(id)+'/status',{method:'PATCH',headers:{'content-type':'application/json','x-csrf-token':session.csrf_token,'idempotency-key':idempotencyKey},body:JSON.stringify(payload)});return {status:response.status,body:await response.json()};},[userId,change,key]);assert.equal(result.status,200,'membership change must answer 200 '+JSON.stringify(result));assert.equal(result.body.status,'success','membership change must be a success envelope '+JSON.stringify(result.body));return result.body.data;};
 const blockedDraft=await createLinkedDraft('QA-LINKED-006',true);
 await page.route('**/quote-documents/list',route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({schema_version:'quote-documents@2026-09-13.v2',status:'blocked',data:null,reason_codes:['document_not_found']})}));
 await page.getByText('人工核对并确认报价',{exact:true}).click();for(const [name,value]of Object.entries({evidence_ref:'manual:blocked-list',evidence_version:'qa-v1',review_notes:'列表返回精确权限拒绝时必须清理已确认视图。'}))await page.locator(`[name="${name}"]`).fill(value);await page.locator('[name="confirmed"]').check();
 const blockedApprove=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/quote-documents/approve'));await page.getByRole('button',{name:'确认人工核对',exact:true}).click();assert.equal((await blockedApprove).status(),200);
 await page.getByText('没有访问权限或记录不存在。',{exact:false}).waitFor();
 assert.equal(await page.getByText('人工核对已保存并读回。',{exact:false}).count(),0,'a blocked permission denial must clear the confirmed view');
 assert.equal(await page.getByText('报价单已保存',{exact:false}).count(),0,'the saved document view must be cleared');
 await page.unroute('**/quote-documents/list');
 assert.equal((await linkedCurrent(blockedDraft.id)).state,'approved','the server side approval still succeeded');
 await page.reload(); // fresh fixture page state for the next independent scenario (after the A assertions)
 const revokeDraft=await createLinkedDraft('QA-LINKED-005',false);
 assert.equal((await linkedCurrent(revokeDraft.id)).state,'draft');
 {
  const developerContext=await browser.newContext(),developerPage=await developerContext.newPage();
  await developerPage.goto(base+'/console/#cases');await loginFixture(developerPage,base,'企业开发者 developer@example.test');
  const devSession=await developerPage.evaluate(()=>fetch('/console/api/v1/session').then(r=>r.json()));
  const devState=await developerPage.evaluate(()=>fetch('/console/api/v1/state').then(r=>r.json()));
  assert.ok((devState.data?.memberships||[]).some(m=>m.organization_id==='org_fixture'&&m.user_id===devSession.identity.user_id&&m.status==='active'),'the fixture developer must already be an active member');
  const devOrg=developerPage.locator('#organization');if(await devOrg.count())await devOrg.selectOption('org_fixture');
  await developerPage.waitForFunction(()=>{const select=document.querySelector('#organization');return !select||select.value!=='';},null,{timeout:15000});
  try{
  const promoted=await changeMembership(page,'fixture-developer',{role:'admin',status:'active'});
  assert.deepEqual([promoted.role,promoted.status],['admin','active'],'developer must be promoted to the existing admin role');
  await developerPage.goto(base+'/console/#quote-documents');await developerPage.waitForTimeout(1200);
  await developerPage.waitForFunction(id=>document.querySelector(`[data-action="qdoc-open"][data-id="${id}"]`)!==null,revokeDraft.id,{timeout:15000});
  await developerPage.locator(`[data-action="qdoc-open"][data-id="${revokeDraft.id}"]`).first().click();await developerPage.getByText('报价单已保存',{exact:false}).waitFor();
  await developerPage.getByText('人工核对并确认报价',{exact:true}).click();
  for(const [name,value]of Object.entries({evidence_ref:'review:revoked-prep',evidence_version:'qa-v1',review_notes:'撤权前已在页面准备的操作。'}))await developerPage.locator(`[name="${name}"]`).fill(value);await developerPage.locator('[name="confirmed"]').check();
  const before=await linkedCurrent(revokeDraft.id);
  const suspended=await changeMembership(page,'fixture-developer',{role:'admin',status:'suspended'});
  assert.equal(suspended.status,'suspended','the member must be suspended before the next linked write');
  const revokedWait=developerPage.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/quote-documents/approve'));
  await developerPage.getByRole('button',{name:'确认人工核对',exact:true}).click();
  const revokedResponse=await revokedWait;const revoked={status:revokedResponse.status(),body:await revokedResponse.json()};
  assert.equal(revoked.status,404,JSON.stringify(revoked));
  assert.equal(revoked.body.schema_version,'quote-documents@2026-09-13.v2',JSON.stringify(revoked.body));assert.equal(revoked.body.status,'blocked',JSON.stringify(revoked.body));assert.equal(revoked.body.data,null,JSON.stringify(revoked.body));assert.deepEqual(revoked.body.reason_codes,['document_not_found'],JSON.stringify(revoked.body));assert.equal(await developerPage.getByText('人工核对已保存并读回。',{exact:false}).count(),0,'a revoked member must not see a success prompt');
  try{await developerPage.getByText('没有访问权限或记录不存在。',{exact:false}).waitFor({timeout:15000});}catch(error){console.error('REVOKE-UI-DIAG',JSON.stringify({url:developerPage.url().replace(/[?#].*$/u,''),content:(await developerPage.locator('#content').innerText().catch(()=>'')).slice(0,700)}));throw error;}
  assert.equal(await developerPage.locator(`[data-action="qdoc-open"][data-id="${revokeDraft.id}"]`).count(),0,'the revoked page must drop the unauthorized record without a reload');
  const revokedRead=await developerPage.evaluate(async id=>{const session=await fetch('/console/api/v1/session').then(r=>r.json());const response=await fetch('/console/api/v1/quote-documents/get',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':session.csrf_token},body:JSON.stringify({contract_version:'inquiry-quote-link@2026-09-13.v1',id})});return {status:response.status,body:await response.json()};},revokeDraft.id);
  assert.equal(revokedRead.status,404,'the revoked member must get 404 when reading the old id');
  assert.equal(revokedRead.body.schema_version,'quote-documents@2026-09-13.v2',JSON.stringify(revokedRead.body));assert.equal(revokedRead.body.status,'blocked',JSON.stringify(revokedRead.body));assert.equal(revokedRead.body.data,null,JSON.stringify(revokedRead.body));assert.deepEqual(revokedRead.body.reason_codes,['document_not_found'],JSON.stringify(revokedRead.body));
  const revokedList=await developerPage.evaluate(async()=>{const session=await fetch('/console/api/v1/session').then(r=>r.json());const response=await fetch('/console/api/v1/quote-documents/list',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':session.csrf_token},body:JSON.stringify({contract_version:'inquiry-quote-link@2026-09-13.v1',limit:20})});return {status:response.status,body:await response.json()};});
  assert.equal(revokedList.status,404,JSON.stringify(revokedList));assert.equal(revokedList.body.status,'blocked',JSON.stringify(revokedList.body));assert.equal(revokedList.body.data,null,JSON.stringify(revokedList.body));assert.deepEqual(revokedList.body.reason_codes,['document_not_found'],JSON.stringify(revokedList.body));
  const after=await linkedCurrent(revokeDraft.id);assert.deepEqual([after.version,after.state],[before.version,before.state],'revoked approval must not change the document');
  }finally{const restored=await changeMembership(page,'fixture-developer',{role:'developer',status:'active'});assert.deepEqual([restored.role,restored.status],['developer','active'],'the synthetic membership change must be reverted');await developerContext.close();}
 }
 // --- C6r13-b: real second organization switch ---
 {
  const operatorContext=await browser.newContext(),operatorPage=await operatorContext.newPage();
  await operatorPage.goto(base+'/console/#members');await loginFixture(operatorPage,base,'平台运维管理员 operator@example.test');
  await operatorPage.goto(base+'/console/#organization-new');const secondOrgName='验收企业 '+Date.now();const createWait=operatorPage.waitForResponse(r=>r.request().method()==='POST'&&/\/console\/api\/v1\/organizations$/u.test(new URL(r.url()).pathname));await operatorPage.getByLabel('企业名称').fill(secondOrgName);await operatorPage.getByLabel('首位所有者邮箱').fill('owner@example.test');await operatorPage.getByRole('button',{name:'创建企业与邀请',exact:true}).click();const createResponse=await createWait;assert.equal(createResponse.status(),200,'organization creation must succeed');await operatorPage.getByText(secondOrgName,{exact:false}).first().waitFor();
  await operatorContext.close();
  await page.goto(base+'/console/#members');await page.reload();const acceptSecond=page.getByRole('button',{name:'接受邀请'});await acceptSecond.waitFor();
  const acceptWait=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/console/api/v1/invitations/'));await acceptSecond.click();assert.ok([200,201].includes((await acceptWait).status()),'the owner must accept the pending invitation');
  const organizations=await page.evaluate(()=>fetch('/console/api/v1/my-organizations').then(r=>r.json()));const activeOrgs=(organizations.data?.organizations||[]).filter(org=>org.status==='active');assert.ok(activeOrgs.length>=2,'the owner must have two active organizations');
  const secondOrg=activeOrgs.find(org=>org.organization_id!=='org_fixture');assert.ok(secondOrg,'the synthetic second organization must be active');
  // prepare old-organization state in this document before switching (no reload afterwards)
  await page.goto(base+'/console/#case/'+caseId);await page.locator('[data-linked-ref]').waitFor();await page.locator('[data-linked-confirm]').check();
  const carryMarker='CARRY-OVER-'+Date.now();
  await page.goto(base+'/console/#quote-documents');await page.getByRole('button',{name:'新建报价单',exact:true}).click();
  const carryInput=page.locator('[name="quote_no"]');await carryInput.waitFor();await carryInput.fill(carryMarker);assert.equal(await carryInput.inputValue(),carryMarker);
  await page.goto(base+'/console/#members');await page.locator('#organization').waitFor();
  const switchOut=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/session/organization')&&r.status()===200);
  await page.locator('#organization').selectOption(secondOrg.organization_id);await switchOut;
  await page.waitForFunction(()=>location.hash.replace(/^#/u,'')==='home',null,{timeout:20000});
  await page.waitForFunction(()=>{const c=document.querySelector('#content');return c!==null&&c.textContent.length>40;},null,{timeout:20000});
  const switched=await page.evaluate(()=>fetch('/console/api/v1/session').then(r=>r.json()));assert.equal(switched.organization_id,secondOrg.organization_id,'the session must really switch organization');
  const crossOrg=await page.evaluate(async id=>{const session=await fetch('/console/api/v1/session').then(r=>r.json());const response=await fetch('/console/api/v1/quote-documents/get',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':session.csrf_token},body:JSON.stringify({contract_version:'inquiry-quote-link@2026-09-13.v1',id})});return {status:response.status,body:await response.json()};},secondSaved.id);
  assert.equal(crossOrg.status,404,'the other organization must not see the previous linked record');assert.deepEqual(crossOrg.body.reason_codes,['document_not_found'],JSON.stringify(crossOrg.body));
  const switchedCase=page.waitForResponse(r=>r.request().method()==='GET'&&/\/console\/api\/v1\/cases\//u.test(new URL(r.url()).pathname));
  await page.goto(base+'/console/#case/'+caseId);const switchedCaseResponse=await switchedCase;assert.equal(switchedCaseResponse.status(),404,'the other organization must answer 404 for the previous case');assert.equal(await page.getByText('需求编号').count(),0,'the other organization must not see the previous case');
  await page.goto(base+'/console/#quote-documents');await page.getByText('填写你的公司资料',{exact:false}).waitFor();
  assert.equal(await page.locator('[data-linked-confirm]').count(),0,'the other organization must not inherit the previous confirmation');
  const carryNow=page.locator('[name="quote_no"]');if(await carryNow.count())assert.notEqual(await carryNow.inputValue(),carryMarker,'the other organization must not inherit the previous draft input');
  await page.goto(base+'/console/#members');await page.locator('#organization').waitFor();
  const switchBack=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/session/organization')&&r.status()===200);
  await page.locator('#organization').selectOption('org_fixture');await switchBack;
  await page.waitForFunction(()=>location.hash.replace(/^#/u,'')==='home',null,{timeout:20000});
  await page.waitForFunction(()=>{const c=document.querySelector('#content');return c!==null&&c.textContent.length>40;},null,{timeout:20000});
  const back=await page.evaluate(()=>fetch('/console/api/v1/session').then(r=>r.json()));assert.equal(back.organization_id,'org_fixture','the session must return to the fixture organization');
  await page.goto(base+'/console/#case/'+caseId);await page.locator('[data-linked-ref]').waitFor();await page.locator('[data-linked-confirm]').waitFor();assert.equal(await page.locator('[data-linked-confirm]').isChecked(),false,'the previous confirmation must not be restored after switching back');
  await page.goto(base+'/console/#quote-documents');await page.locator('[name="quote_no"]').waitFor();const backInput=page.locator('[name="quote_no"]');assert.notEqual(await backInput.inputValue(),carryMarker,'the previous dirty marker must not be restored after switching back');
 }
 await shot('quote-saved-desktop',1440);await page.goto(base+'/console/#market/configure');await page.getByRole('heading',{name:'报价单制作',exact:true}).waitFor();await shot('quote-market-desktop',1440);
 assert.equal(cli(['logout']).code,0);
 const resolvedFailures=await Promise.all(observedFailures);const quotaResolved=resolvedFailures.filter(observed=>observed.path==='/console/api/v1/public/customs/quota'&&observed.status===503);assert.ok(quotaResolved.length>0,'the fixture public customs quota is expected to answer 503');
 const deniedReads=resolvedFailures.filter(observed=>observed.status>=400&&observed.status<500);
 const expectedDenials=[{method:'POST',path:'/console/api/v1/quote-documents/approve',status:404,reasons:['document_not_found']},{method:'POST',path:'/console/api/v1/quote-documents/get',status:404,reasons:['document_not_found']},{method:'POST',path:'/console/api/v1/quote-documents/list',status:404,reasons:['document_not_found'],min:1},{method:'GET',prefix:'/console/api/v1/cases/',status:404,reasons:['case_not_found'],min:1},];
 for(const observed of deniedReads){const match=expectedDenials.find(entry=>entry.method===observed.method&&entry.status===observed.status&&(entry.path===observed.path||(entry.prefix!==undefined&&observed.path.startsWith(entry.prefix)))&&(entry.allowEmptyReasons===true||(entry.reasons.length===observed.reasons.length&&entry.reasons.every((r,i)=>r===observed.reasons[i]))));assert.ok(match,'unregistered 4xx denial '+JSON.stringify(observed));match.seen=(match.seen||0)+1;}
 for(const entry of expectedDenials){if(entry.min!==undefined)assert.ok((entry.seen||0)>=entry.min,`${entry.method} ${entry.path??entry.prefix} expected at least ${entry.min} denial`);}
 for(const observed of resolvedFailures.filter(observed=>observed.status>=500&&!quotaResolved.includes(observed))){const match=expectedFailures.find(entry=>entry.status>=500&&entry.method===observed.method&&entry.path===observed.path&&entry.status===observed.status&&entry.schema===observed.schema&&entry.reasons.length===observed.reasons.length&&entry.reasons.every((reason,index)=>reason===observed.reasons[index])&&entry.id===observed.id&&entry.mode===observed.mode&&entry.version===observed.version);assert.ok(match,'unexpected 5xx '+JSON.stringify(observed));match.observed=(match.observed||0)+1;}
 for(const entry of expectedFailures){if(entry.status>=500)assert.equal(entry.observed,entry.count,`${entry.key} expected ${entry.count} x ${entry.status} ${entry.path}`);else assert.equal(entry.seen,entry.count,`${entry.key} expected ${entry.count} business outcome`);}
 const rendererNetworkErrors=errors.filter(message=>message.includes('503'));
 assert.ok(errors.every(message=>message.includes('503')||message.includes('404')),'only expected 4xx/5xx may surface as console errors: '+JSON.stringify(errors));
 assert.ok(rendererNetworkErrors.length<=resolvedFailures.filter(o=>o.status>=500).length,`console 503s (${rendererNetworkErrors.length}) must be explained by observed 5xx responses (${resolvedFailures.filter(o=>o.status>=500).length})`);
 const consoleDenials=errors.filter(message=>message.includes('404'));assert.ok(consoleDenials.length<=deniedReads.length,`console 404s (${consoleDenials.length}) must be explained by observed denial responses (${deniedReads.length})`);
 const passed=['login guard','blank template','web template save and readback','web decimal preview 250.30 USD','draft save and CLI readback','published synthetic residential release and quote probe','linked case review context, confirmation gate and hand-off','linked prepare/save with CLI same-id readback','linked approve','supplement change blocks the copied linked draft until re-confirmation','manual approval with evidence','market configuration entry','desktop/mobile no horizontal overflow',...(rendererUnavailable?['renderer unavailable → draft/formal export fail-closed without files','linked old-supplement formal = 200 manual_review case_review_required','history missing = 503 inquiry_quote_history_bytes_missing','newly approved formal = 503 document_renderer_unavailable','approve + list failure keeps the confirmed result','linked reject + CLI readback','non-manager cannot see owner case or linked record','late committed response withheld across an identity switch','initial list failure is not an empty history','revoked member approve/get/list deny with exact v2 blocked envelopes','second organization session switch with old case/quote/confirmation isolation','switch back does not restore the previous confirmation or draft marker']:['web draft PDF download','CLI formal PDF download and SHA-256','refuse existing output overwrite'])];
 console.log(JSON.stringify({rendererUnavailable,unsavedInputDialogObserved,observedFailures:resolvedFailures,expectedFailures,rendererNetworkErrors,passed,notVerified:rendererUnavailable?['web draft PDF download','CLI formal PDF download and SHA-256','refuse existing output overwrite']:[],errors,expectedUnavailable,artifacts:out}));
}finally{await browser.close();}
