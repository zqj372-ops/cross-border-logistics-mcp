import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loginFixture} from './fixture-login.mjs';

const base=process.env.PORTAL_BASE_URL,out=process.env.PORTAL_ARTIFACTS;
assert.equal(new URL(base).hostname,'127.0.0.1');assert.ok(out);mkdirSync(out,{recursive:true});
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],expectedUnavailable=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error'){const text=message.text()+' @ '+message.location().url;if(message.location().url.endsWith('/console/api/v1/public/customs/quota')&&message.text().includes('503'))expectedUnavailable.push(text);else errors.push(text);}});
const runtime=out,sessionFile=resolve(runtime,'quote-workflow-v3-native-session.json');let counter=0;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function cli(args,input){
  const extra=[];
  if(input){const path=resolve(runtime,`quote-workflow-v3-native-input-${counter++}.json`);writeFileSync(path,JSON.stringify(input),{mode:0o600});extra.push('--input',path);}
  extra.push('--idempotency-key',`native-${Date.now()}-${counter++}`);
  try{return {code:0,data:JSON.parse(execFileSync(process.execPath,[resolve('dist/cli/bin/freightclaw.mjs'),'workspace',...args,'--session-file',sessionFile,...extra],{encoding:'utf8'}))};}catch(error){return {code:error.status,data:JSON.parse(error.stdout||error.stderr)}};
}
try{
  await page.goto(base+'/console/#quote-documents');
  await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
  await loginFixture(page,base,'企业负责人 owner@example.test');
  const session=await page.evaluate(()=>fetch('/console/api/v1/session').then(response=>response.json()));
  const cookie=(await page.context().cookies()).find(value=>value.name==='fc_portal_session');
  assert.ok(cookie);
  writeFileSync(sessionFile,JSON.stringify({origin:base,session_token:cookie.value,csrf_token:session.csrf_token,expires_at:Date.now()+600000}),{mode:0o600});
  await page.goto(base+'/console/#configure/quote.documents');
  await page.getByRole('heading',{name:'填写企业报价模板',exact:true}).waitFor();
  for(const [name,value]of Object.entries({company_name:'Synthetic Native Logistics',company_address:'Loopback fixture only',company_email:'native@example.test',company_phone:'',terms:'Synthetic native acceptance terms.'}))await page.locator(`[name="${name}"]`).fill(value);
  const configWait=page.waitForResponse(response=>response.url().endsWith('/quote-documents/config-save'));
  await page.getByRole('button',{name:'保存企业模板',exact:true}).click();
  const configResponse=await configWait;assert.equal(configResponse.status(),200,JSON.stringify(await configResponse.json()));

  const rates=JSON.parse(execFileSync(process.execPath,['--import','tsx/esm','--input-type=module','-e',"import {config} from './tests/quote-native/fixture.ts';process.stdout.write(JSON.stringify(config));"],{encoding:'utf8'}));
  const current=cli(['residential-rates','get']);assert.equal(current.code,0,JSON.stringify(current));
  const savedRate=cli(['residential-rates','save'],{expected_version:current.data.data.version,input:rates});assert.equal(savedRate.code,0,JSON.stringify(savedRate));
  const preview=cli(['residential-rates','preview']);assert.equal(preview.code,0,JSON.stringify(preview));
  const published=cli(['residential-rates','publish'],{expected_version:savedRate.data.data.version,preview_hash:preview.data.data.preview_hash,confirmation:'reviewed_sources_and_conditions'});assert.equal(published.code,0,JSON.stringify(published));
  const probe=cli(['quote','self'],{postal_code:'M1B 5W9',address_line:null,city:null,province:'ON',cbm:'2.01',weight_kg:'200',piece_count:1,packaging_type:'pallet',longest_side_cm:'120',address_type:'private',requires_liftgate:true,requires_pallet_jack:false,requires_appointment:true,explicit_pallet_count:1,is_stackable:false,detention_minutes:31});
  assert.equal(probe.code,0,JSON.stringify(probe));assert.equal(probe.data.status,'success',JSON.stringify(probe));

  const caseDraft={mode:'shipping',services:['ocean'],transportMode:'fcl',origin:'Shanghai',destination:'Toronto M5X 1A9',product:'Synthetic native acceptance',readyDate:'',containerType:'40HQ',containerCount:'1',containerCountUnknown:false,volume:'',volumeUnknown:true,weight:'',weightUnknown:true,cargoType:'',palletCount:'',skuCount:'',deliverySite:'warehouse',unloading:'dock',businessRegion:'canada',notes:'native acceptance',contactName:'Native QA',email:'native-qa@example.test',company:'',phone:'',consent:true};
  const created=cli(['cases','create'],caseDraft);assert.equal(created.code,0,JSON.stringify(created));const caseId=created.data.data.case_id;
  assert.equal(cli(['cases','update','--id',caseId],{expected_version:1,status:'needs_input',public_note:'请补充包装信息。',internal_note:''}).code,0);
  assert.equal(cli(['cases','reply','--id',caseId],{expected_version:2,message:'纸箱包装，单件 18kg。'}).code,0);

  await page.goto(base+'/console/#case/'+caseId);
  await page.locator('[data-linked-ref]').waitFor();
  await page.locator('[data-linked-confirm]').check();
  await page.getByRole('button',{name:'用自有运价制作关联报价单',exact:true}).click();
  await page.getByRole('heading',{name:'私人地址报价 · 自有运价',exact:true}).waitFor();
  await page.getByLabel('加拿大邮编').fill('M1B 5W9');await page.getByLabel('总体积 · m³').fill('2.01');await page.getByLabel('总重量 · kg').fill('200');await page.getByLabel('件数',{exact:true}).fill('1');
  await page.locator('[name="address_type"]').selectOption('private');await page.locator('[name="packaging_type"]').selectOption('pallet');await page.locator('[name="longest_side_cm"]').fill('120');await page.locator('[name="address_line"]').fill('20 Synthetic Road');await page.locator('[name="city"]').fill('Toronto');await page.locator('[name="province"]').fill('ON');
  await page.getByRole('button',{name:'查询规则试算',exact:true}).click();
  await Promise.all([page.waitForURL(url=>url.hash==='#quote-documents'),page.getByRole('button',{name:'制作报价单',exact:true}).click()]);
  await page.waitForFunction(()=>Boolean(document.querySelector('[name="origin"]')?.value&&document.querySelector('[name="destination"]')?.value));
  await page.locator('[name="quote_no"]').fill('QA-NATIVE-V3-001');await page.locator('[name="customer_name"]').fill('Synthetic Native Customer');await page.locator('[name="quote_date"]').fill(new Date().toISOString().slice(0,10));
  const nativePrepareResponses=[];page.on('response',async response=>{if(response.url().endsWith('/quote-documents/native-prepare'))nativePrepareResponses.push({status:response.status(),request:response.request().postDataJSON(),body:await response.json().catch(()=>null)});});
  const firstSaveWait=page.waitForResponse(response=>response.url().endsWith('/quote-documents/save'));
  await page.getByRole('button',{name:'核对报价',exact:true}).click();
  let firstSaveResponse;try{firstSaveResponse=await firstSaveWait;}catch(error){throw new Error(JSON.stringify({error:String(error),page:await page.locator('#content').innerText(),nativePrepareResponses},null,2),{cause:error});}
  const firstSaveRequest=firstSaveResponse.request().postDataJSON(),firstSaveBody=await firstSaveResponse.json();assert.equal(firstSaveBody.status,'success',JSON.stringify(firstSaveBody));
  const first=firstSaveBody.data;assert.equal(first.document_kind,'linked',JSON.stringify({request:firstSaveRequest,response:firstSaveBody}));assert.equal(first.version,1);
  await page.getByRole('heading',{name:'核对报价',exact:true}).waitFor();

  await page.getByRole('button',{name:'返回修改',exact:true}).click();
  await page.getByRole('button',{name:'报价记录',exact:true}).click();
  const row=page.locator(`[data-action="qdoc-open"][data-id="${first.id}"]`);await row.waitFor();await row.click();
  await page.getByText('已读回服务器版本',{exact:false}).waitFor();
  const nativePrepareBefore=await page.evaluate(()=>globalThis.performance.getEntriesByType('resource').filter(entry=>entry.name.endsWith('/quote-documents/native-prepare')).length);
  await page.locator('[name="quote_no"]').fill('QA-NATIVE-V3-001-R2');
  const secondSaveWait=page.waitForResponse(response=>response.url().endsWith('/quote-documents/save'));
  await page.getByRole('button',{name:'继续编辑并重新核对',exact:true}).click();
  const secondSaveBody=await (await secondSaveWait).json();assert.equal(secondSaveBody.status,'success',JSON.stringify(secondSaveBody));
  assert.equal(secondSaveBody.data.id,first.id);assert.equal(secondSaveBody.data.version,2);
  await page.getByRole('heading',{name:'核对报价',exact:true}).waitFor();
  const nativePrepareAfter=await page.evaluate(()=>globalThis.performance.getEntriesByType('resource').filter(entry=>entry.name.endsWith('/quote-documents/native-prepare')).length);
  assert.equal(nativePrepareAfter,nativePrepareBefore);

  await page.locator('[name="evidence_ref"]').fill('manual:native-v3');await page.locator('[name="evidence_version"]').fill('1');await page.locator('[name="review_notes"]').fill('Synthetic native browser review.');await page.locator('[name="confirmed"]').check();
  const approveWait=page.waitForResponse(response=>response.url().endsWith('/quote-documents/approve'));
  await page.getByRole('button',{name:'确认人工核对',exact:true}).click();
  const approvedBody=await (await approveWait).json();assert.equal(approvedBody.status,'success',JSON.stringify(approvedBody));const approved=approvedBody.data;assert.equal(approved.id,first.id);assert.equal(approved.state,'approved');assert.equal(approved.version,3);
  const screenshotPath=resolve(out,'quote-workflow-v3-native-approved.png');await page.screenshot({path:screenshotPath,fullPage:true});assert.ok(statSync(screenshotPath).size>100);

  const exportWait=page.waitForResponse(response=>response.url().endsWith('/quote-documents/export'));
  const downloadWait=page.waitForEvent('download');
  await page.getByRole('button',{name:'导出正式 PDF',exact:true}).click();
  const exportBody=await (await exportWait).json();assert.equal(exportBody.status,'success',JSON.stringify(exportBody));
  const download=await downloadWait,path=await download.path();assert.ok(path);
  const bytes=readFileSync(path),pdfPath=resolve(out,'quote-workflow-v3-native-formal.pdf');await download.saveAs(pdfPath);assert.ok(statSync(pdfPath).size>100);
  const text=execFileSync('pdftotext',[pdfPath,'-'],{encoding:'utf8'});
  assert.match(text,/QA-NATIVE-V3-001-R2/u);assert.match(text,/Synthetic Native Customer/u);assert.match(text,/USD/u);assert.doesNotMatch(text,/DRAFT - NOT A FORMAL QUOTE/u);
  const readback=cli(['documents','get'],{contract_version:'quote-documents-workflow@2026-09-15.v1',id:first.id});assert.equal(readback.code,0,JSON.stringify(readback));assert.equal(readback.data.data.id,first.id);assert.equal(readback.data.data.version,3);assert.equal(readback.data.data.state,'approved');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({document_id:first.id,versions:[first.version,secondSaveBody.data.version,approved.version],screenshot:screenshotPath,pdf:pdfPath,pdf_sha256:sha256(bytes),web:{id:first.id,version:approved.version,state:approved.state},cli:{id:readback.data.data.id,version:readback.data.data.version,state:readback.data.data.state},errors,expected_unavailable:expectedUnavailable}));
}finally{
  await browser.close();
}
