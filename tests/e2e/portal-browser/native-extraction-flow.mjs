import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loginFixture } from './fixture-login.mjs';
import { config } from '../../quote-native/fixture.ts';
const base=process.env.PORTAL_BASE_URL, runtime=process.env.PORTAL_QA_RUNTIME, out=process.env.PORTAL_ARTIFACTS;
assert.equal(new URL(base).hostname,'127.0.0.1');assert.ok(runtime&&out);mkdirSync(runtime,{recursive:true});mkdirSync(out,{recursive:true});
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[],expectedUnavailable=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'){if(m.location().url?.endsWith('/public/customs/quota')&&m.text().includes('503'))expectedUnavailable.push('fixture public customs quota is not configured');else errors.push(m.text());}});
let counter=0;const session=resolve(runtime,'parser-session.json');
function cli(args,input){const extras=[];if(input){const file=resolve(runtime,`input-${counter++}.json`);writeFileSync(file,JSON.stringify(input),{mode:0o600});extras.push('--input',file);}try{return {code:0,data:JSON.parse(execFileSync(process.execPath,[resolve('dist/cli/bin/freightclaw.mjs'),'workspace',...args,'--session-file',session,...extras],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))};}catch(e){return {code:e.status,data:JSON.parse(e.stdout||e.stderr)};}}
async function extract(text){await page.locator('[name="customer_message"]').fill(text);await Promise.all([page.waitForResponse(r=>r.url().endsWith('/business/quote/extract')),page.getByRole('button',{name:'提取资料',exact:true}).click()]);await page.waitForFunction(()=>!document.querySelector('[data-form="business-extract"] button[type="submit"]')?.disabled);await page.getByRole('heading',{name:'核对解析结果',exact:true}).waitFor();}
async function shot(name,width){await page.setViewportSize({width,height:1000});await page.evaluate(async()=>{await document.fonts.ready;window.scrollTo(0,0);});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:resolve(out,name+'.png'),fullPage:true});}
try{
  await page.goto(base+'/console/#quote/private');await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();
  await loginFixture(page,base,'企业负责人 owner@example.test');
  const start=cli(['login','start','--endpoint',base]);assert.equal(start.code,3);await page.goto(start.data.verification_url);await page.getByRole('button',{name:'确认连接',exact:true}).click();await page.getByRole('heading',{name:'CLI 已获准连接'}).waitFor();assert.equal(cli(['login','finish']).code,0);
  assert.equal(cli(['residential-rates','get']).data.data.draft,null,'requires fresh blank fixture');
  await page.goto(base+'/console/#quote/private');await page.getByRole('heading',{name:'私人地址询价',exact:true}).waitFor();
  const text='2纸箱 每件10kg 100x100x100cm\n收货地址: 20 Synthetic Road, Toronto ON M1B 5W9\n私人地址';
  const parsed=cli(['quote','extract'],{customer_message:text});assert.equal(parsed.code,3,JSON.stringify(parsed));assert.equal(parsed.data.data.extraction.weight_kg,'20');
  await extract(text);assert.equal(await page.locator('[name="weight_kg"]').inputValue(),'20');assert.equal(await page.locator('[name="cbm"]').inputValue(),'2');for(const name of ['delivery_unload','pallet_jack_choice','appointment_choice'])assert.equal(await page.locator(`[name="${name}"]`).inputValue(),'');
  assert.equal(await page.locator('[name="extraction_confirmed"]').isChecked(),false);
  await shot('parser-desktop',1440);await page.locator('.quote-extraction').screenshot({path:resolve(out,'parser-review-desktop.png')});await shot('parser-mobile',390);await page.locator('.quote-extraction').screenshot({path:resolve(out,'parser-review-mobile.png')});
  assert.equal(await page.locator('[data-form="business-quote"]').evaluate(form=>form.checkValidity()),false);
  const saved=cli(['residential-rates','save','--idempotency-key','parser-qa-save-0001'],{expected_version:0,input:config});assert.equal(saved.code,0,JSON.stringify(saved));
  const preview=cli(['residential-rates','preview']);assert.equal(preview.code,0);assert.equal(cli(['residential-rates','publish','--idempotency-key','parser-qa-publish-0001'],{expected_version:preview.data.data.version,preview_hash:preview.data.data.preview_hash,confirmation:'reviewed_sources_and_conditions'}).code,0);
  for(const [name,value]of [['delivery_unload','self'],['pallet_jack_choice','no'],['appointment_choice','yes']])await page.locator(`[name="${name}"]`).selectOption(value);
  await page.locator('[name="extraction_confirmed"]').check();await page.getByRole('button',{name:'查询规则试算',exact:true}).click();await page.getByText('135.00 USD',{exact:true}).waitFor();
  await shot('parser-confirmed-quote',1440);
  await extract('3件，12.2kg，43*22*38cm\n住宅 M1B5W9');assert.equal(await page.locator('[name="piece_count"]').inputValue(),'3');assert.equal(await page.locator('[name="cbm"]').inputValue(),'0.107844');assert.equal(await page.locator('[name="weight_kg"]').inputValue(),'');assert.equal(await page.getByText('135.00 USD',{exact:true}).count(),0);assert.equal(await page.locator('[name="extraction_confirmed"]').isChecked(),false);
  await extract('2纸箱 每件10kg 100x100x100cm\n总重30kg\n住宅 M1B5W9');assert.equal(await page.locator('[name="weight_kg"]').inputValue(),'');await page.getByText('资料中存在冲突，请核对标记项后再试算。',{exact:true}).waitFor();
  await shot('parser-conflict',1440);
  await page.locator('[name="customer_message"]').fill('9'.repeat(100)+'纸箱');await Promise.all([page.waitForResponse(r=>r.url().endsWith('/business/quote/extract')),page.getByRole('button',{name:'提取资料',exact:true}).click()]);await page.waitForFunction(()=>!document.querySelector('[data-form="business-extract"] button[type="submit"]')?.disabled);assert.equal(await page.locator('[name="piece_count"]').inputValue(),'');assert.equal(await page.locator('[name="cbm"]').inputValue(),'');
  assert.equal(errors.length,0,JSON.stringify(errors));assert.equal(cli(['logout']).code,0);
  console.log(JSON.stringify({passed:['private login guard','native extraction with blank business configuration','CLI and webpage agree','unknown delivery conditions remain empty','confirmation required','published deterministic quote 135.00 USD','re-extract clears stale price and confirmation','weight ambiguity and explicit conflict remain unresolved'],viewports:[1440,390],errors,expectedUnavailable,artifacts:out}));
}finally{await browser.close();}
