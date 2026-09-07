import { loginFixture } from './fixture-login.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const runnerPath = resolve('tests/e2e/portal-browser/business-access-fixture-runner.ts');
let runner;
let runnerBuffer = '';

async function startFixture() {
  if (process.env.PORTAL_BASE_URL) return { baseUrl: process.env.PORTAL_BASE_URL, sourceOrigin: null };
  runner = spawn(process.execPath, ['--import', 'tsx/esm', runnerPath], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  runner.stderr.setEncoding('utf8');
  runner.stderr.on('data', (value) => { stderr += value; });
  runner.stdout.setEncoding('utf8');
  return new Promise((resolveStart, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture_runner_start_timeout')), 20_000);
    const onData = (value) => {
      runnerBuffer += value;
      const lines = runnerBuffer.split('\n');
      runnerBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.ready) {
          clearTimeout(timer);
          runner.stdout.off('data', onData);
          runner.stdout.on('data', (next) => { runnerBuffer += next; });
          resolveStart({ baseUrl: event.base_url, sourceOrigin: event.source_origin });
          return;
        }
      }
    };
    runner.stdout.on('data', onData);
    runner.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture_runner_exited_${code}:${stderr.slice(0, 500)}`));
    });
  });
}

async function stopFixture() {
  if (!runner) return null;
  const code = runner.exitCode === null
    ? await new Promise((resolveExit) => { runner.once('exit', (value) => resolveExit(value)); runner.kill('SIGTERM'); })
    : runner.exitCode;
  const events = runnerBuffer.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const closed = events.find((event) => event.closed);
  assert.equal(code, 0, JSON.stringify({ message: 'isolated fixture runner must close cleanly', closed, runner_buffer: runnerBuffer.slice(-500) }));
  assert.deepEqual(closed && { source_calls: closed.source_calls, source_contract_valid: closed.source_contract_valid }, { source_calls: 1, source_contract_valid: true });
  return closed;
}

const { baseUrl, sourceOrigin } = await startFixture();
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname), 'loopback fixture URL required');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
const requestedOrigins = new Set();
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('request', (request) => requestedOrigins.add(new URL(request.url()).origin));
const checks = [];
const customsInput = { query: '不锈钢水杯', ruleDate: '2026-09-05', attributes: { originCountry: 'CN' } };

async function login(label) { await loginFixture(page,baseUrl,label); }

async function go(hash) {
  await page.goto(`${baseUrl}/console/#${hash}`);
  await page.locator('main h1').waitFor();
}

async function browserApi(path, { method = 'GET', body } = {}) {
  return page.evaluate(async ({ path, method, body }) => {
    const session = await fetch('/console/api/v1/session', { credentials: 'same-origin', cache: 'no-store' }).then((response) => response.json());
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') Object.assign(headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': `browser-e2e-${crypto.randomUUID()}` });
    const response = await fetch(`/console/api/v1${path}`, { method, headers, credentials: 'same-origin', cache: 'no-store', ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }) });
    return { http: response.status, body: await response.json() };
  }, { path, method, body });
}

async function createBusinessKey(appId, label) {
  await go(`business-credential/${appId}`);
  await page.getByLabel('业务凭证名称').fill(label);
  const issuedResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/console/api/v1/business-access/applications/${appId}/credentials`));
  await page.getByRole('button', { name: '创建并显示业务 Key', exact: true }).click();
  const response = await issuedResponse;
  const result = await response.json();
  const safeResult = {
    http: response.status(),
    status: result.status,
    reason_codes: result.reason_codes,
    delivery: result.data?.delivery,
    credential_status: result.data?.credential?.status,
  };
  assert.equal(response.status(), 200, JSON.stringify(safeResult));
  assert.equal(result.status, 'success', JSON.stringify(safeResult));
  assert.equal(typeof result.data?.api_key, 'string', JSON.stringify(safeResult));
  await page.locator('#secret-dialog[open]').waitFor();
  const key = await page.locator('#secret-value').innerText();
  assert.match(key, /^flcbk_/);
  await page.getByRole('button', { name: '已保存，完成', exact: true }).click();
  await page.locator('#secret-dialog[open]').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#secret-value').innerText(), '');
  return key;
}

async function exchangeBusinessKey(key) {
  return page.evaluate(async ({ key }) => {
    const cookieDenied = await fetch('/access/v2/business/token/exchange', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema_version: 'business-exchange@2026-09-05.v1', requested_operations: ['customs.query'] }) });
    const cookieBody = await cookieDenied.json();
    const response = await fetch('/access/v2/business/token/exchange', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${key}` }, body: JSON.stringify({ schema_version: 'business-exchange@2026-09-05.v1', requested_operations: ['customs.query'] }) });
    const result = await response.json();
    return { cookieHttp: cookieDenied.status, cookieStatus: cookieBody.status, http: response.status, status: result.status, operations: result.data?.operations, token: result.data?.access_token };
  }, { key });
}

async function callBusiness(token, route, input) {
  return page.evaluate(async ({ token, route, input }) => {
    const response = await fetch(route, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ schema_version: 'business-call@2026-09-05.v1', input }) });
    const result = await response.json();
    return { http: response.status, status: result.status, reason: result.reason_codes?.[0], schema: result.schema_version };
  }, { token, route, input });
}

try {
  await login('企业开发者 developer@example.test');
  await go('app-new');
  await page.getByLabel('应用名称').fill('业务 API 浏览器闭环验收');
  await page.getByLabel('应用用途').fill('隔离本地环境验证关务业务 API 的申请、授权、凭证和撤销边界。');
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  await page.getByRole('heading', { name: '业务 API 浏览器闭环验收', exact: true }).waitFor();
  const appId = decodeURIComponent(new URL(page.url()).hash.split('/')[1]);
  assert.ok(appId);
  checks.push('developer-created-application');

  await go(`business-request-new/${appId}`);
  await page.getByRole('checkbox', { name: /关税与归类/ }).check();
  await page.getByRole('checkbox', { name: /加拿大尾程规则试算/ }).check();
  await page.getByLabel('业务用途与调用情况').fill('仅用于本地闭环验收；关务结果保持源服务不可用状态，报价权限本次不批准。');
  await page.getByRole('button', { name: '保存业务申请草稿', exact: true }).click();
  await page.getByRole('button', { name: '提交业务审核', exact: true }).waitFor();
  const requestId = decodeURIComponent(new URL(page.url()).hash.split('/')[1]);
  await page.getByRole('button', { name: '提交业务审核', exact: true }).click();
  const developerState = await browserApi('/business-access/state');
  const submitted = developerState.body.data.requests.find((item) => item.request_id === requestId);
  assert.equal(submitted.state, 'submitted');
  const developerReview = await browserApi(`/business-access/requests/${requestId}/decision`, { method: 'POST', body: { expected_version: submitted.version, decision: 'approve', reason: '越权调用必须失败', approved_operations: ['customs.query'] } });
  assert.equal(developerReview.body.status, 'blocked');
  checks.push('request-submitted-and-developer-review-denied');

  await login('平台审核员 reviewer@example.test');
  await go(`business-request/${requestId}`);
  await page.getByRole('checkbox', { name: /加拿大尾程规则试算/ }).uncheck();
  await page.getByLabel('业务审核说明').fill('仅批准关税查询用于隔离 Source 不可用路径验收。');
  await page.getByRole('button', { name: '提交业务审核结论', exact: true }).click();
  await page.getByText('审核意见：仅批准关税查询用于隔离 Source 不可用路径验收。').waitFor();
  checks.push('reviewer-partially-approved-customs-only');

  await login('平台运维管理员 operator@example.test');
  await go('grants');
  const activate = page.getByRole('button', { name: '开通业务授权', exact: true }).last();
  const grantId = await activate.getAttribute('data-id');
  assert.ok(grantId);
  const operatorQueue = await browserApi('/business-access/review-queue');
  const pendingGrant = operatorQueue.body.data.grants.find((item) => item.grant_id === grantId);
  assert.deepEqual(pendingGrant.operations, ['customs.query']);

  await login('平台审核员 reviewer@example.test');
  const reviewerActivate = await browserApi(`/business-access/grants/${grantId}/activate`, { method: 'POST', body: { expected_version: pendingGrant.version } });
  assert.equal(reviewerActivate.body.status, 'blocked');
  checks.push('reviewer-provisioning-denied');

  await login('平台运维管理员 operator@example.test');
  await go('grants');
  await page.getByRole('button', { name: '开通业务授权', exact: true }).last().click();
  await page.getByRole('button', { name: '管理业务授权', exact: true }).last().waitFor();
  checks.push('operator-activated-customs-grant');

  await login('企业开发者 developer@example.test');
  await go(`business-grant/${grantId}`);
  await page.getByRole('heading', { name: '业务授权详情', exact: true }).waitFor();
  await page.getByText('当前身份可查看授权范围，不能暂停、撤销或调整授权。', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-action="business-access-suspend"], [data-action="business-access-revoke-grant"], [data-form="business-access-scope"]').count(), 0);
  checks.push('developer-grant-deep-link-is-read-only');

  await login('企业所有者 owner@example.test');
  await go(`app/${appId}`);
  const ownerSelect = page.locator('form[data-form="application-status"] select[name="application_owner"]');
  await ownerSelect.selectOption('fixture-owner');
  await page.locator('form[data-form="application-status"]').getByRole('button', { name: '保存状态', exact: true }).click();
  await page.locator('form[data-form="application-status"] select[name="application_owner"]').waitFor();
  assert.equal(await page.locator('form[data-form="application-status"] select[name="application_owner"]').inputValue(), 'fixture-owner');

  await login('企业开发者 developer@example.test');
  await go(`business-credential/${appId}`);
  await page.getByRole('heading', { name: '业务凭证', exact: true }).waitFor();
  await page.getByText('当前身份无凭证管理权限', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '创建并显示业务 Key', exact: true }).count(), 0);
  checks.push('non-owner-business-credential-deep-link-is-read-only');

  await login('企业所有者 owner@example.test');
  await go(`app/${appId}`);
  await page.locator('form[data-form="application-status"] select[name="application_owner"]').selectOption('fixture-developer');
  await page.locator('form[data-form="application-status"]').getByRole('button', { name: '保存状态', exact: true }).click();
  await page.locator('form[data-form="application-status"] select[name="application_owner"]').waitFor();
  assert.equal(await page.locator('form[data-form="application-status"] select[name="application_owner"]').inputValue(), 'fixture-developer');

  await login('企业开发者 developer@example.test');
  const keyA = await createBusinessKey(appId, '关务验收 Key A');
  const exchangeA = await exchangeBusinessKey(keyA);
  assert.equal(exchangeA.cookieStatus, 'blocked');
  assert.equal(exchangeA.http, 200);
  assert.equal(exchangeA.status, 'success');
  assert.deepEqual(exchangeA.operations, ['customs.query']);
  assert.ok(exchangeA.token);
  const tokenA = exchangeA.token;
  checks.push('business-key-exchanged-with-cookie-channel-blocked');

  const customs = await callBusiness(tokenA, '/api/v2/business/customs/query', customsInput);
  assert.deepEqual(customs, { http: 200, status: 'unavailable', reason: 'fixture_source_503', schema: 'portal-customs@2026-09-05.v1' });
  const quoteDenied = await callBusiness(tokenA, '/api/v2/business/quote/zone-preview', { postal_code: 'M5V 3A8', cbm: '1', weight_kg: '100', piece_count: 1, packaging_type: 'pallet', address_type: 'commercial', requires_liftgate: false, requires_pallet_jack: false, requires_appointment: false, explicit_pallet_count: 1, is_stackable: true, detention_minutes: 0 });
  assert.equal(quoteDenied.status, 'blocked');
  assert.ok([401, 403].includes(quoteDenied.http));
  const v1Denied = await page.evaluate(async ({ key }) => {
    const response = await fetch('/access/v1/token/exchange', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${key}` }, body: JSON.stringify({ schema_version: '2026-08-27.v1', requested_tool_names: ['cargo.calculate'] }) });
    const result = await response.json();
    return { http: response.status, status: result.status };
  }, { key: keyA });
  assert.equal(v1Denied.status, 'blocked');
  assert.ok([401, 403].includes(v1Denied.http));
  checks.push('customs-reached-local-source-as-unavailable-and-other-channels-denied');

  await go(`app/${appId}`);
  const keyARow = page.getByText('关务验收 Key A', { exact: true }).locator('xpath=ancestor::tr');
  page.once('dialog', (dialog) => dialog.accept());
  const revokeKeyResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes(`/console/api/v1/business-access/credentials/`) && response.url().endsWith('/revoke'));
  await keyARow.getByRole('button', { name: '撤销业务 Key', exact: true }).click();
  const revoked = await revokeKeyResponse;
  const revokedResult = await revoked.json();
  assert.equal(revoked.status(), 200, JSON.stringify({ http: revoked.status(), status: revokedResult.status, reason_codes: revokedResult.reason_codes }));
  assert.equal(revokedResult.status, 'success');
  const tokenAAfterKeyRevoke = await callBusiness(tokenA, '/api/v2/business/customs/query', customsInput);
  assert.equal(tokenAAfterKeyRevoke.status, 'blocked');
  checks.push('revoked-key-invalidated-existing-token');

  const keyB = await createBusinessKey(appId, '关务验收 Key B');
  const exchangeB = await exchangeBusinessKey(keyB);
  assert.equal(exchangeB.http, 200);
  assert.equal(exchangeB.status, 'success');
  assert.ok(exchangeB.token);
  const tokenB = exchangeB.token;

  await login('企业所有者 owner@example.test');
  await go(`business-grant/${grantId}`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '撤销业务授权', exact: true }).click();
  const tokenBAfterGrantRevoke = await callBusiness(tokenB, '/api/v2/business/customs/query', customsInput);
  assert.equal(tokenBAfterGrantRevoke.status, 'blocked');
  checks.push('revoked-grant-invalidated-existing-token');

  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  if (sourceOrigin) assert.equal(requestedOrigins.has(sourceOrigin), false, 'browser must not call the source service directly');
  checks.push('source-call-remained-server-side');

  await browser.close();
  const sourceEvidence = await stopFixture();
  console.log(JSON.stringify({ checks, customs_status: customs.status, source_calls: sourceEvidence?.source_calls ?? null, browser_errors: pageErrors }));
} catch (error) {
  await browser.close().catch(() => {});
  await stopFixture().catch(() => {});
  throw error;
}
