import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const module = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const { chromium } = module.default || module;
const root = resolve(import.meta.dirname, '../../..');
const [html, styles, bundle] = await Promise.all([
  readFile(resolve(root, 'apps/console/index.html'), 'utf8'),
  readFile(resolve(root, 'apps/console/styles.css'), 'utf8'),
  build({ entryPoints: [resolve(root, 'apps/console/app.js')], bundle: true, format: 'esm', platform: 'browser', write: false }),
]);
const identity = { user_id: 'operator-real', display_name: '平台运维管理员', email: 'operator@example.test', email_verified: true, platform_role: 'operator' };
const ownerIdentity = { user_id: 'owner-real', display_name: '企业所有者', email: 'owner@example.test', email_verified: true, platform_role: null };
const envelope = (data) => ({ schema_version: 'portal@2026-09-05.v1', status: 'success', data, reason_codes: [], request_id: 'req_platform_ui' });
const state = { data_mode: 'production', identity, current_organization: null, organizations: [], users: [], memberships: [], invitations: [], applications: [], requests: [], grants: [], catalog: ['cargo.calculate', 'container.plan_summary', 'system.agent_context.get'].map((capability_id) => ({ capability_id, available: true })), operations: [] };
const ownerState = { ...state, identity: ownerIdentity, current_organization: { organization_id: 'org-owner', display_name: '示例企业', status: 'active' }, organizations: [{ organization_id: 'org-owner', display_name: '示例企业', status: 'active' }], users: [{ user_id: 'owner-real', display_name: '企业所有者' }], memberships: [{ organization_id: 'org-owner', user_id: 'owner-real', role: 'owner', status: 'active' }] };
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
let actor = 'operator';
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.route('http://portal.test/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/console/' || path === '/console/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  if (path === '/console/styles.css') return route.fulfill({ status: 200, contentType: 'text/css', body: styles });
  if (path === '/console/app.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle.outputFiles[0].text });
  if (path === '/console/api/v1/session') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema_version: 'portal@2026-09-05.v1', mode: 'production', authenticated: true, identity: actor === 'operator' ? identity : ownerIdentity, organization_id: actor === 'operator' ? null : 'org-owner', csrf_token: 'c'.repeat(43), fixture_identities: [] }) });
  if (path === '/console/api/v1/state') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope(actor === 'operator' ? state : ownerState)) });
  if (path === '/console/api/v1/platform-state') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope({ review: { requests: [], organizations: [], applications: [] }, provisioning: { grants: [], organizations: [], applications: [] }, grants: [] })) });
  if (path === '/console/api/v1/my-organizations') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope(actor === 'operator' ? { organizations: [], memberships: [], invitations: [] } : { organizations: ownerState.organizations, memberships: ownerState.memberships, invitations: [] })) });
  if (path === '/console/api/v1/business-access/review-queue' || path === '/console/api/v1/business-access/state') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope({ requests: [], grants: [], credentials: [], applications: [] })) });
  if (path === '/console/api/v1/business/services') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope({ organization_id: 'org-owner', operations: [] })) });
  if (path === '/console/api/v1/organizations') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope([])) });
  return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ status: 'blocked', reason_codes: ['route_not_found'] }) });
});

try {
  await page.goto('http://portal.test/console/#home');
  await page.getByRole('heading', { name: '审核与开通工作台', exact: true }).waitFor();
  await page.getByText('完善企业准入', { exact: true }).waitFor();
  await page.getByText('核对企业资料和负责人邀请，完成后由企业成员提交服务申请。', { exact: true }).waitFor();
  const admission = page.getByRole('button', { name: '进入企业准入', exact: true });
  await admission.waitFor();
  await page.getByText('邀请企业负责人', { exact: true }).waitFor();
  await page.getByRole('heading', { name: '平台开通的四个步骤', exact: true }).waitFor();
  assert.equal(await page.getByText('开通前核对企业连接', { exact: true }).count(), 5);
  await page.getByText('连接与授权按企业分别核对', { exact: true }).waitFor();
  assert.equal(await page.getByText('支持接入', { exact: true }).count(), 3);
  for (const wrong of ['从服务目录开始', '创建首家企业', '选择企业后检查连接', '创建应用后，选择需要的服务并提交用途说明。', '接入的四个步骤']) assert.equal(await page.getByText(wrong, { exact: true }).count(), 0, `${wrong} must not be shown to platform operators`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}`);
  }
  await admission.click();
  await page.getByRole('heading', { name: '企业准入', exact: true }).waitFor();
  actor = 'owner';
  await page.goto('http://portal.test/console/?actor=owner#home');
  await page.getByRole('heading', { name: '把物流能力，接入你的工作流。', exact: true }).waitFor();
  assert.equal(await page.locator('.cap-card').count(), 8);
  assert.equal(await page.getByText('先创建一个应用', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: '接入的四个步骤', exact: true }).count(), 0);
  assert.equal(await page.getByText('完善企业准入', { exact: true }).count(), 0);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ platform_task: '完善企业准入', business_service_status_count: 5, widths: [1440, 390], enterprise_member_flow_preserved: true, page_errors: pageErrors }));
} finally {
  await browser.close();
}
