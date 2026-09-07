import { loginFixture } from './fixture-login.mjs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const base=process.env.PORTAL_BASE_URL || 'http://127.0.0.1:8882';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname))throw new Error('Loopback fixture URL required');
const artifacts=resolve(process.env.PORTAL_ARTIFACTS || '.runtime/portal-browser');await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const checks=[];
async function login(label){ await loginFixture(page,base,label); }
async function go(route){await page.goto(`${base}/console/#${route}`);await page.locator('main h1').waitFor();}
try {
 await page.goto(`${base}/console/#login`);await page.locator('[data-form=password-login]').waitFor();await page.getByLabel('账号',{exact:true}).waitFor();await page.screenshot({path:resolve(artifacts,'portal-final-login.png'),fullPage:true});
 await login('平台运维管理员 operator@example.test');
 assert.equal(await page.locator('#sidebar').getByRole('button',{name:'我的应用',exact:true}).count(),0);
 await go('organization-new');const orgName=`验收企业 ${Date.now()}`;await page.getByLabel('企业名称').fill(orgName);await page.getByLabel('首位所有者邮箱').fill('owner@example.test');await page.getByRole('button',{name:'创建企业与邀请',exact:true}).click();await page.getByText(orgName,{exact:true}).first().waitFor();
 await page.getByText('等待所有者确认',{exact:true}).last().waitFor();checks.push('organization-created-owner-pending');
 const row=page.getByRole('row').filter({hasText:orgName});await row.getByRole('button',{name:'管理企业'}).click();await page.getByLabel('变更原因').waitFor();const orgId=decodeURIComponent(new URL(page.url()).hash.split('/')[1]);
 await login('企业所有者 owner@example.test');await go('members');const invite=page.getByRole('button',{name:'接受邀请'});if(await invite.count()){const response=page.waitForResponse(value=>value.request().method()==='POST'&&value.url().includes('/console/api/v1/invitations/')&&value.url().endsWith('/accept'));await invite.last().click();await response;await page.getByText('操作已完成，已读取最新状态。',{exact:true}).waitFor();}
 // Existing members must be able to see their pending invitations across organizations.
 await go('workbench');await page.getByLabel('当前企业').selectOption(orgId);await page.waitForURL('**/#home');await go('workbench');await page.getByRole('heading',{name:'业务工作台',exact:true}).waitFor();checks.push('owner-claim-and-enter-second-organization');
 await go('customs');await page.getByLabel('商品名称或 HS 编码').fill('不锈钢水杯');await page.getByRole('button',{name:'查询关税与归类',exact:true}).click();await page.getByText(/当前企业尚未配置该业务服务的 API 连接/).waitFor();assert.equal(await page.getByLabel('商品名称或 HS 编码').inputValue(),'不锈钢水杯');checks.push('customs-unconfigured-keeps-input');
 await page.screenshot({path:resolve(artifacts,'portal-final-customs-desktop.png'),fullPage:true});
 await go('quote');await page.getByLabel('加拿大邮编').fill('M1B 5W9');await page.getByLabel('总体积 · m³').fill('1.2');await page.getByLabel('总重量 · kg').fill('300');await page.getByLabel('件数',{exact:true}).fill('2');await page.getByRole('button',{name:'查询规则试算',exact:true}).click();await page.getByText(/当前企业尚未配置该业务服务的 API 连接/).waitFor();checks.push('quote-unconfigured-keeps-input');
 await page.screenshot({path:resolve(artifacts,'portal-final-quote-desktop.png'),fullPage:true});
 for(const width of [390,320,768]){await page.setViewportSize({width,height:950});await go('quote');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow ${width}`);if(width<=760){await page.getByRole('button',{name:'打开导航',exact:true}).click();assert.equal(await page.getByRole('button',{name:'打开导航',exact:true}).getAttribute('aria-expanded'),'true');await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'打开导航',exact:true}).getAttribute('aria-expanded'),'false');assert.equal(await page.locator('#content').evaluate(el=>el.inert),false);}await page.evaluate(()=>{window.scrollTo(0,0);document.activeElement?.blur();});await page.screenshot({path:resolve(artifacts,`portal-final-quote-${width}.png`),fullPage:true});}checks.push('mobile-overflow-menu-keyboard');
 await page.setViewportSize({width:1440,height:1000});await login('平台运维管理员 operator@example.test');await go(`organization/${orgId}`);await page.getByLabel('变更原因').waitFor();await page.getByLabel('企业状态',{exact:true}).selectOption('suspended');await page.getByLabel('变更原因').selectOption('operational_pause');await page.getByRole('button',{name:'保存企业状态',exact:true}).click();await page.getByRole('row').filter({hasText:orgName}).getByText('接入系统已暂停').waitFor();checks.push('tenant-and-organization-suspend-readback');
 await go(`organization/${orgId}`);await page.getByLabel('变更原因').waitFor();await page.getByLabel('企业状态',{exact:true}).selectOption('active');await page.getByLabel('变更原因').selectOption('resume_verified');await page.getByRole('button',{name:'保存企业状态',exact:true}).click();await page.getByRole('row').filter({hasText:orgName}).getByText('接入系统已启用').waitFor();checks.push('organization-resume-readback');
 await page.screenshot({path:resolve(artifacts,'portal-final-organizations.png'),fullPage:true});assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,consoleErrors:errors}));
}finally{await browser.close();}
