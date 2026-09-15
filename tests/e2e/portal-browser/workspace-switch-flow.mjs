import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const module = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const { chromium } = module.default || module;
const root = resolve(import.meta.dirname, '../../..');
const output = resolve(process.env.QA_OUTPUT_DIR || '/tmp/freightclaw-workspace-switch-qa');
mkdirSync(output, { recursive: true });
const [html, styles, bundle] = await Promise.all([
  readFile(resolve(root, 'apps/console/index.html'), 'utf8'),
  readFile(resolve(root, 'apps/console/styles.css'), 'utf8'),
  build({ entryPoints: [resolve(root, 'apps/console/app.js')], bundle: true, format: 'esm', platform: 'browser', write: false }),
]);

const identity = { user_id: 'dual-role-operator', display_name: '平台运维管理员', email: 'operator@example.test', email_verified: true, platform_role: 'operator' };
const organization = { organization_id: 'org-acme', tenant_id: 'tenant-acme', display_name: '聚仓科技', status: 'active' };
const membership = { organization_id: organization.organization_id, user_id: identity.user_id, role: 'admin', status: 'active', created_at: '2026-09-15T00:00:00.000Z' };
const application = { application_id: 'app-one', organization_id: organization.organization_id, client_id: 'client-one', name: '报价业务应用', purpose: '企业报价协作', environment: 'production', owner_user_id: identity.user_id, status: 'active', version: 1, created_at: '2026-09-15T00:00:00.000Z' };
const catalog = ['cargo.calculate', 'container.plan_summary', 'system.agent_context.get'].map((capability_id) => ({ capability_id, available: true, reason_code: null }));
const platformState = { data_mode: 'production', identity, current_organization: null, organizations: [organization], users: [], memberships: [membership], invitations: [], applications: [], requests: [], grants: [], catalog, operations: [] };
const organizationState = { ...platformState, current_organization: organization, users: [{ user_id: identity.user_id, display_name: identity.display_name }], applications: [application] };
const envelope = (data) => ({ schema_version: 'portal@2026-09-05.v1', status: 'success', data, reason_codes: [], request_id: 'req_workspace_switch' });
const linkedEnvelope = (data) => ({ schema_version: 'quote-documents@2026-09-13.v2', status: 'success', data, reason_codes: [] });
let selectedOrganization = null;
const selections = [];
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(5_000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('https://portal.test/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/console/' || path === '/console/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  if (path === '/console/styles.css') return route.fulfill({ status: 200, contentType: 'text/css', body: styles });
  if (path === '/console/app.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle.outputFiles[0].text });
  if (path === '/console/api/v1/session') return json({ schema_version: 'portal@2026-09-05.v1', mode: 'production', authenticated: true, identity, organization_id: selectedOrganization, csrf_token: 'c'.repeat(43), fixture_identities: [] });
  if (path === '/console/api/v1/session/organization' && request.method() === 'POST') {
    selectedOrganization = request.postDataJSON().organization_id;
    selections.push(selectedOrganization);
    return json({ schema_version: 'portal@2026-09-05.v1', mode: 'production', authenticated: true, identity, organization_id: selectedOrganization, csrf_token: 'd'.repeat(43), fixture_identities: [] });
  }
  if (path === '/console/api/v1/state') return json(envelope(selectedOrganization ? organizationState : platformState));
  if (path === '/console/api/v1/platform-state') return json(envelope({ review: { requests: [], organizations: [], applications: [] }, provisioning: { grants: [], organizations: [], applications: [] }, grants: [] }));
  if (path === '/console/api/v1/my-organizations') return json(envelope({ organizations: [organization], memberships: [membership], invitations: [] }));
  if (path === '/console/api/v1/business-access/review-queue' || path === '/console/api/v1/business-access/state') return json(envelope({ requests: [], grants: [], credentials: [], applications: [] }));
  if (path === '/console/api/v1/business/services') return json({ schema_version: 'portal-business@2026-09-05.v1', status: 'success', data: { organization_id: organization.organization_id, operations: [] }, reason_codes: [] });
  if (path === '/console/api/v1/quote-documents/config') return json(envelope({ version: 0, input: null }));
  if (path === '/console/api/v1/quote-documents/list') return json(linkedEnvelope({ items: [], next_cursor: null }));
  if (path === '/console/api/v1/cases') return json({ schema_version: 'portal-cases@2026-09-07.v1', status: 'success', data: { items: [], next_cursor: null, can_manage: true }, reason_codes: [] });
  if (path === '/console/api/v1/public/customs/quota') return json(envelope({ limit: 20, remaining: 20, resets_at: '2026-09-16T00:00:00+08:00' }));
  return json({ status: 'blocked', data: null, reason_codes: ['route_not_found'] }, 404);
});

try {
  await page.goto('https://portal.test/console/#applications');
  await page.getByRole('heading', { name: '请在平台工作区处理任务', exact: true }).waitFor();
  const selector = page.locator('#organization');
  await selector.waitFor();
  assert.deepEqual(await selector.locator('option').allTextContents(), ['平台工作区', '聚仓科技']);

  await selector.selectOption('org-acme');
  await page.getByRole('heading', { name: '工作台', exact: true }).waitFor();
  await page.evaluate(() => { location.hash = 'applications'; });
  await page.getByRole('heading', { name: '我的应用', exact: true }).waitFor();
  await page.getByText('报价业务应用', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'enterprise-applications.png'), fullPage: true });

  await page.evaluate(() => { location.hash = 'members'; });
  await page.getByRole('heading', { name: '成员与邀请', exact: true }).waitFor();
  await page.getByText('当前登录账号', { exact: true }).waitFor();

  await page.evaluate(() => { location.hash = 'quote-documents'; });
  await page.getByRole('heading', { name: '制作报价单', exact: true }).waitFor();
  await page.getByRole('heading', { name: '填写你的公司资料', exact: true }).waitFor();

  await page.evaluate(() => { location.hash = 'app/app-one'; });
  await page.getByText('完整凭证仅由应用负责人管理。需要转交时，请由企业管理员更新负责人。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '创建凭证', exact: true }).count(), 0);

  await page.locator('#organization').selectOption('');
  await page.getByRole('heading', { name: '审核与开通工作台', exact: true }).waitFor();
  await page.evaluate(() => { location.hash = 'applications'; });
  await page.getByRole('heading', { name: '请在平台工作区处理任务', exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'platform-guard-restored.png'), fullPage: true });
  assert.deepEqual(selections, ['org-acme', null]);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ flow: 'platform -> enterprise -> platform', selections, enterprise_pages: ['applications', 'members', 'quote-documents'], credential_secret_access: false, page_errors: errors, screenshots: output }));
} finally {
  await browser.close();
}
