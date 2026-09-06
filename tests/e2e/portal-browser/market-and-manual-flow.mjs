import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = resolve(import.meta.dirname, '../../..');
const artifacts = resolve(process.env.PORTAL_ARTIFACTS || '.runtime/market-review');
await mkdir(artifacts, { recursive: true });
const [html, styles, bundle] = await Promise.all([readFile(resolve(root, 'apps/console/index.html'), 'utf8'), readFile(resolve(root, 'apps/console/styles.css'), 'utf8'), build({entryPoints:[resolve(root,'apps/console/app.js')],bundle:true,platform:'browser',format:'esm',write:false})]);
let signedIn = false; let credentials = [];
const user = { user_id:'ui_owner',display_name:'测试负责人',email:'owner@example.test',email_verified:true,platform_role:null };
const organization = {organization_id:'org_ui',display_name:'界面验收企业',status:'active'};
const application = { application_id:'app_ui',organization_id:'org_ui',name:'物流服务接入',status:'active',owner_user_id:user.user_id,environment:'production' };
const membership = {organization_id:'org_ui',user_id:user.user_id,status:'active',role:'owner'};
const t0 = ['cargo.calculate','container.plan_summary','system.agent_context.get'];
const operations = ['quote.zone_preview','quote.ai_extract_preview','customs.query','customs.tax.estimate'];
const grant = {grant_id:'grant_ui',application_id:'app_ui',state:'active',capabilities:t0,expires_at:null,version:1};
const businessGrant = {grant_id:'bgrant_ui',application_id:'app_ui',state:'active',operations,expires_at:null,version:1};
const envelope = data => ({status:'success',data,reason_codes:[],request_id:'req_ui'});
const calls = []; const errors = []; const key = 'flcbk_browser_fixture_only';
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1000}});
const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror',error=>errors.push(error.message));
await page.route('https://portal.test/**', async route => {
  const request = route.request(); const pathname = new URL(request.url()).pathname;
  const json = data => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  if(pathname==='/console/')return route.fulfill({status:200,contentType:'text/html',body:html});
  if(pathname==='/console/app.js')return route.fulfill({status:200,contentType:'text/javascript',body:bundle.outputFiles[0].text});
  if(pathname==='/console/styles.css')return route.fulfill({status:200,contentType:'text/css',body:styles});
  if(pathname==='/console/api/v1/session')return json({mode:'production',authenticated:signedIn,identity:signedIn?user:null,organization_id:signedIn?'org_ui':null,csrf_token:signedIn?'x'.repeat(43):null,fixture_identities:[]});
  if(pathname==='/console/api/v1/state')return json(envelope({identity:user,current_organization:organization,organizations:[organization],users:[user],memberships:[membership],invitations:[],applications:[application],requests:[],grants:[grant],catalog:t0.map(capability_id=>({capability_id,available:true})),operations:[]}));
  if(pathname==='/console/api/v1/my-organizations')return json(envelope({organizations:[organization],memberships:[membership],invitations:[]}));
  if(pathname==='/console/api/v1/business-access/state')return json(envelope({applications:[application],requests:[],grants:[businessGrant],credentials}));
  if(pathname==='/console/api/v1/business/services')return json(envelope({operations:operations.map(operation=>({operation,configured:true}))}));
  if(pathname==='/console/api/v1/business-access/applications/app_ui/credentials' && request.method()==='POST'){
    const body=request.postDataJSON(); assert.equal(body.t0_mode,'current_grant'); assert.deepEqual(new Set(body.operations),new Set(operations));
    credentials=[{credential_id:'bkey_ui',application_id:'app_ui',label:body.label,operations,t0_mode:'current_grant',version:1,status:'active',delivery_status:'pending',secret_last_four:'TEST',created_at:new Date().toISOString(),expires_at:Math.floor(Date.now()/1000)+2592000,last_used_at:null}];
    return json(envelope({credential:credentials[0],api_key:key}));
  }
  if(pathname==='/console/api/v1/business-access/credentials/bkey_ui/acknowledge'){
    assert.equal(request.postDataJSON().expected_version,1); credentials[0].delivery_status='acknowledged';credentials[0].version=2;return json(envelope({credential:credentials[0]}));
  }
  if(pathname.startsWith('/api/v2/')){
    calls.push({path:pathname,one_key:request.headers().authorization===`ApiKey ${key}`});
    return json({status:'success',request_id:`req_check_${calls.length}`,data:{},reason_codes:[]});
  }
  return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({status:'blocked',reason_codes:['route_not_found']})});
});
async function go(hash){await page.goto(`https://portal.test/console/#${hash}`);await page.locator('main[aria-busy=false] h1').waitFor();}
try {
  await go('home'); await page.getByRole('heading',{name:'把物流能力，接入你的工作流。'}).waitFor();
  assert.equal(await page.locator('.cap-card').count(),8);
  await page.screenshot({path:resolve(artifacts,'home-desktop.png'),fullPage:true});
  await page.locator('.customer-navigation [data-go=market]').click();
  await page.locator('[data-action=market-protocol][data-id=mcp]').click(); assert.equal(await page.locator('.cap-card').count(),3);
  await page.getByLabel('搜索能力').fill('not-found'); await page.getByRole('heading',{name:'没有找到相关能力'}).waitFor();
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();
  await page.locator('[data-action=market-category][data-id=customs]').click(); assert.equal(await page.locator('.cap-card').count(),2);
  await page.locator('[data-go="service/customs.query"]').click(); await page.getByRole('heading',{name:'关税与商品归类',level:1,exact:true}).waitFor();
  assert.equal(await page.getByText('当前通过 REST API 提供，Agent 可按接口文档调用。',{exact:true}).count(),1);
  await page.screenshot({path:resolve(artifacts,'service-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'在线使用',exact:true}).click(); await page.getByRole('heading',{name:'登录工作台',exact:true}).waitFor();
  await go('guide'); await page.getByRole('heading',{name:'快速上手',exact:true}).waitFor();
  await page.screenshot({path:resolve(artifacts,'manual-desktop.png'),fullPage:true});
  for(const chapter of ['keys','rest','mcp','results','services','account']) { await page.locator(`.manual-sidebar [data-go="guide/${chapter}"]`).click(); await page.locator('article h1').waitFor(); }
  assert.equal(calls.length,0,'browsing must not call private business APIs');
  signedIn=true; await page.goto('https://portal.test/console/?actor=owner#api-keys'); await page.locator('main[aria-busy=false] h1').waitFor(); await page.getByRole('button',{name:'创建 API Key',exact:true}).click();
  await page.getByLabel('名称',{exact:true}).fill('统一验收 Key');
  assert.equal(await page.getByRole('checkbox').count(),0,'one-key form must not ask for scopes again');
  await page.getByRole('button',{name:'创建并显示 API Key',exact:true}).click(); await page.locator('#secret-dialog[open]').waitFor();
  await page.getByRole('button',{name:'已保存，完成',exact:true}).click(); await page.locator('#secret-dialog[open]').waitFor({state:'hidden'});
  await page.getByRole('heading',{name:'本次连接验证',exact:true}).waitFor();
  assert.equal(await page.locator('#secret-value').innerText(),''); assert.equal(calls.length,2); assert.ok(calls.every(call=>call.one_key));
  assert.deepEqual(calls.map(call=>call.path).sort(),['/api/v2/business/quote/zone-preview','/api/v2/tools/cargo.calculate']);
  assert.equal(await page.evaluate(()=>globalThis.localStorage.length+globalThis.sessionStorage.length),0);
  await page.screenshot({path:resolve(artifacts,'keys-desktop.png'),fullPage:true});
  await go('apply'); await page.getByRole('heading',{name:'服务申请',exact:true}).waitFor(); assert.equal(await page.getByText('已开通',{exact:true}).count(),7);
  await go('workbench'); await page.getByRole('heading',{name:'业务工作台',exact:true}).waitFor();
  await page.screenshot({path:resolve(artifacts,'workbench-desktop.png'),fullPage:true});
  const widths=[768,390,320];
  for(const width of widths){
    await page.setViewportSize({width,height:900});
    for(const view of ['home','market','service/customs.query','guide','api-keys','apply/new','workbench']){
      await go(view); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow ${view} at ${width}`);
      if(width===390)await page.screenshot({path:resolve(artifacts,`${view.replaceAll('/','-')}-mobile.png`),fullPage:true});
    }
    if(width<760){await page.getByRole('button',{name:'打开导航',exact:true}).click();await page.locator('#sidebar.open').waitFor();await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'打开导航',exact:true}).getAttribute('aria-expanded'),'false');}
  }
  membership.role='viewer';
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('https://portal.test/console/?actor=viewer#home');
  await page.locator('main[aria-busy=false] h1').waitFor();
  await page.locator('.customer-navigation').getByRole('button',{name:'个人中心',exact:true}).click();
  await page.getByRole('heading',{name:'业务工作台',exact:true}).waitFor();
  for(const view of ['api-keys','api-keys/new','apply','apply/new','apply/customs.query']){
    await go(view);
    assert.equal(await page.locator('form[data-form="api-key-create"],form[data-form="service-access"]').count(),0);
    await page.getByText(/联系企业管理员/).first().waitFor();
  }
  assert.equal(calls.length,2,'viewer navigation must not trigger API key creation or business calls');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({public_market:true,protocols:{mcp:3,api:5},manual_chapters:7,one_key_direct_checks:calls,secret_cleared:true,storage_empty:true,viewer_routes_guarded:true,widths:[1440,...widths],page_errors:errors,artifacts}));
} catch (error) { console.error(JSON.stringify({page_errors:errors, alerts:await page.locator('.form-error:visible,#notification:not([hidden])').allTextContents()})); throw error; } finally {await browser.close();}
