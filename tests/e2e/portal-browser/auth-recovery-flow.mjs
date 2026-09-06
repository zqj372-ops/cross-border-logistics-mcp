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
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.route('http://portal.test/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/console/' || path === '/console/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  if (path === '/console/styles.css') return route.fulfill({ status: 200, contentType: 'text/css', body: styles });
  if (path === '/console/app.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle.outputFiles[0].text });
  if (path === '/console/api/v1/session') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema_version: 'portal@2026-09-05.v1', mode: 'production', authenticated: false, identity: null, organization_id: null, csrf_token: 'c'.repeat(43), fixture_identities: [] }) });
  return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
});

try {
  const message = '登录链接已失效，请重新登录；若刚完成邮箱验证或找回，直接重新登录即可。';
  await page.goto('http://portal.test/console/?auth_error=login_expired#login');
  await page.getByRole('alert').getByText(message, { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: '邮箱账号登录', exact: true }).getAttribute('href'), '/console/auth/login');
  for (const category of ['__proto__', 'constructor', 'toString']) {
    await page.goto(`http://portal.test/console/?auth_error=${encodeURIComponent(category)}#login`);
    assert.equal(await page.locator('#login-error').innerText(), '', `${category} must not resolve through Object.prototype`);
  }
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ allowed_category_rendered: true, prototype_categories_hidden: ['__proto__', 'constructor', 'toString'], page_errors: pageErrors }));
} finally {
  await browser.close();
}
