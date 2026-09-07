import { loginFixture } from './fixture-login.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const base = process.env.PORTAL_BASE_URL || 'http://127.0.0.1:8882';
const artifacts = resolve(process.env.PORTAL_ARTIFACTS || '/Users/autumn/.codex/visualizations/2026/09/05/01a0706e-46c2-7e43-837e-48cfd6d5a231');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('loopback_fixture_required');
await mkdir(artifacts, { recursive: true });

const source = (id, label) => ({ sourceId: id, authority: '界面验收样例', dataset: label, version: 'visual-sample@2026-09-05', locator: `fixture://${id}`, effectiveFrom: '2026-09-05', effectiveTo: null, officialUrl: null });
const quotePreview = {
  total_price: '286.40', currency: 'USD', origin: 'Toronto 仓', city: 'Kingston', province: 'NS', postal_code: 'B0P 1R0', billing_pallets: 2,
  base_price: '220.00', fuel: '44.00', accessorials: { appointment: '22.40' }, risk_tags: ['私人地址需人工核对', '来源为界面验收样例'],
  sales_note: '此金额仅用于验证费用层级、状态提示与保存交互，不代表真实承运商报价。', matched_rule: 'VISUAL-SAMPLE-ZONE', zone: '样例区域',
};
const quoteEnvelope = (data = quotePreview) => ({
  schema_version: 'portal-quote@2026-09-05.v1', source_schema_version: 'quote-preview-visual-sample.v2', status: 'manual_review', data,
  reason_codes: ['quote_source_evidence_missing'], request_id: 'req_visual_quote_0001', preview_only: true, saved: false, sendable: false,
  source_refs: [source('quote-rule-sample', '报价规则视觉样例')],
});
const record = (ref, city, total, createdAt) => ({
  record_ref: ref, record_status: 'manual_required', readback_verified: true, created_at: createdAt, currency: 'USD',
  request: { postal_code: 'B0P 1R0', city, cbm: '1.2', weight_kg: '300', piece_count: 2 },
  preview: { ...quotePreview, city, total_price: total }, source_refs: [source(`record-${ref}`, '原记录视觉样例')],
});
const records = [
  record('record_visual_0001', 'Kingston', '286.40', '2026-09-05T10:00:00Z'),
  record('record_visual_0002', 'Halifax', '318.20', '2026-09-04T09:00:00Z'),
  record('record_visual_0003', 'Moncton', '342.00', '2026-09-03T08:00:00Z'),
];

function customsEnvelope() {
  const country = (countryCode, code, total, rate) => ({
    country: countryCode, displayCode: code, status: 'confirmed', legalNames: [{ language: 'zh-CN', text: '不锈钢制餐桌、厨房或其他家用器具' }],
    chineseExplanation: { text: '界面验收样例：用于检查长文本、税率明细、措施与来源的排版。' }, confirmedTotalPercent: total,
    rates: [{ label: '一般关税样例', confirmed: true, treatment: '界面样例待遇', displayValue: `${rate}%`, rateExpressionRaw: `${rate}%`, conditionText: '仅为界面验收条件', interactionNote: '不得用于申报或报价' }],
    documents: [{ label: '材质说明样例', status: 'prepare_retain', reason: '用于验证资料准备状态', conditions: ['界面验收样例'] }],
    measures: [{ label: '贸易措施样例', legalScope: '仅验证展开内容和证据层级', rateExpressionRaw: '待权威来源确认', exceptions: ['不得作为真实适用结论'] }], warnings: ['所有编码与税率均为视觉样例'],
  });
  return { schema_version: 'portal-customs@2026-09-05.v1', status: 'success', reason_codes: [], data: {
    queryId: 'query_visual_sample_0001', ruleDate: '2026-09-05', serviceVersion: 'visual-sample@2026-09-05', snapshotHash: 'sha256:visual-sample-not-authoritative', nextQuestion: null,
    candidates: [{ country: 'CN', displayCode: '7323.93', hs6: '732393', legalNames: [{ language: 'zh-CN', text: '不锈钢制品候选样例' }], chineseExplanation: { text: '请依据真实材质、用途与权威税则确认。' }, classificationReason: '仅用于候选卡片交互验收' }],
    results: [country('CN', '7323.93', '7.0', '7.0'), country('US', '7323.93.0080', '3.4', '3.4'), country('CA', '7323.93.90', '6.5', '6.5')],
    sources: [source('customs-publication-sample', '关务发布视觉样例')],
  } };
}

function taxEnvelope(items) {
  const results = items.map((item, index) => ({
    lineId: item.lineId, input: item, status: index === 19 ? 'manual_review' : 'success', customsPayable: index === 19 ? null : { amount: String(10 + index) + '.25', currency: 'CAD' },
    confirmedSubtotal: { amount: String(8 + index) + '.00', currency: 'CAD' }, valueForDuty: { amount: item.declaredValue, currency: 'CAD' },
    lines: [{ label: '关税样例', rateExpressionRaw: index === 19 ? '待权威来源确认' : '5.0%', amount: index === 19 ? null : '5.00', note: '界面验收样例' }],
    reasonCodes: index === 19 ? ['tariff_rate_requires_review'] : [], publication: { ruleDate: '2026-09-05', serviceVersion: 'visual-sample@2026-09-05', snapshotHash: 'sha256:visual-sample-not-authoritative' },
    exchangeRate: { fromCurrency: item.currency, toCurrency: 'CAD', rate: '1.0000', effectiveDate: '2026-09-05', sourceAuthorities: ['界面验收样例'] }, sources: [source(`tax-sample-${index}`, '税费视觉样例')],
  }));
  return { schema_version: 'portal-tax@2026-09-05.v1', status: 'manual_review', reason_codes: ['tariff_rate_requires_review'], request_id: 'req_visual_tax_0001', data: { partialFailure: true, counts: { total: 20, success: 19, needsInput: 0, manualReview: 1, unavailable: 0 }, results } };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
const saveKeys = [];
let saveAttempts = 0;
let listAttempts = 0;
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.route('**/console/api/v1/business/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace('/console/api/v1/business/', '');
  const input = request.method() === 'POST' ? request.postDataJSON()?.input : null;
  let response;
  if (path === 'services') response = { schema_version: 'portal-business@2026-09-05.v1', status: 'success', reason_codes: [], data: { organization_id: 'org_fixture', operations: ['customs.query', 'customs.tax.estimate', 'quote.zone_preview', 'quote.ai_extract_preview'].map((operation) => ({ operation, configured: true, reason_code: null })) } };
  else if (path === 'customs/query') response = customsEnvelope();
  else if (path === 'customs/tax-estimates/batch') response = taxEnvelope(input.items);
  else if (path === 'quote/preview') response = quoteEnvelope();
  else if (path === 'quote/records/prepare') response = { ...quoteEnvelope({ preview: quotePreview, preview_handle: 'opaque-visual-preview-handle-000000000001', expires_at: '2099-09-05T12:00:00Z' }), reason_codes: ['quote_source_evidence_missing'] };
  else if (path === 'quote/records/save') {
    saveAttempts += 1;
    saveKeys.push(request.headers()['idempotency-key']);
    response = saveAttempts === 1
      ? { schema_version: 'portal-quote-record@2026-09-05.v1', status: 'manual_review', reason_codes: ['write_readback_pending'], data: { operation_ref: 'operation_visual_0001', record_ref: 'record_visual_0001', saved: true, sendable: false, readback_verified: false } }
      : { schema_version: 'portal-quote-record@2026-09-05.v1', status: 'manual_review', reason_codes: ['quote_source_not_authoritative'], data: { operation_ref: 'operation_visual_0001', record_ref: 'record_visual_0001', record_status: 'manual_required', saved: true, sendable: false, readback_verified: true } };
  } else if (path === 'quote/records/list') {
    listAttempts += 1;
    response = { schema_version: 'portal-quote-record@2026-09-05.v1', status: 'success', reason_codes: [], data: listAttempts === 1 ? { records: records.slice(0, 2), next_cursor: 'cursor_visual_page_2' } : { records: records.slice(2), next_cursor: null } };
  } else if (path === 'quote/records/get') response = { schema_version: 'portal-quote-record@2026-09-05.v1', status: 'success', reason_codes: [], data: records.find((item) => item.record_ref === input.record_ref) };
  else if (path === 'quote/records/review') response = { schema_version: 'portal-quote-record@2026-09-05.v1', status: 'success', reason_codes: [], data: { tasks: [{ task_ref: 'review_visual_0001', status: 'pending', reason: '价格来源需要人工核对；这是界面验收样例。' }] } };
  else return route.continue();
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(response) });
});

async function login() { await loginFixture(page,base,'企业开发者 developer@example.test'); }
async function go(hash) { await page.goto(`${base}/console/#${hash}`); await page.locator('main h1').waitFor(); }
async function banner() {
  await page.evaluate(() => {
    if (document.querySelector('#visual-sample-banner')) return;
    const element = document.createElement('div'); element.id = 'visual-sample-banner'; element.textContent = '界面验收样例 · 非真实税率或报价';
    element.style.cssText = 'position:absolute;inset:0 0 auto 0;z-index:999999;background:#7c2d12;color:#fff;text-align:center;font:700 15px/40px system-ui;letter-spacing:.04em;box-shadow:0 2px 8px #0003';
    document.body.append(element); document.body.style.paddingTop = '40px';
  });
}
async function shot(name, width) {
  await page.setViewportSize({ width, height: width <= 390 ? 900 : 1000 });
  await banner();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}`);
  await page.screenshot({ path: resolve(artifacts, name), fullPage: true });
}

try {
  await login();
  await go('customs');
  await page.getByLabel('商品名称或 HS 编码').fill('不锈钢水杯（界面验收样例）');
  await page.getByLabel('主要材质').fill('不锈钢');
  await page.getByLabel('用途').fill('日常饮水');
  await page.getByRole('button', { name: '查询关税与归类', exact: true }).click();
  await page.getByText('查询完成', { exact: true }).waitFor();
  await page.getByText('中国出口', { exact: true }).last().waitFor();
  await page.getByText('加拿大进口', { exact: true }).last().waitFor();
  assert.equal(await page.getByText('所有编码与税率均为视觉样例', { exact: true }).count(), 3);
  assert.equal(await page.getByLabel('商品名称或 HS 编码').inputValue(), '不锈钢水杯（界面验收样例）');
  await shot('portal-business-results-customs-1440.png', 1440);
  await shot('portal-business-results-customs-390.png', 390);

  await go('tax');
  for (let index = 1; index < 20; index += 1) await page.getByRole('button', { name: '添加商品', exact: true }).click();
  assert.equal(await page.locator('[data-tax-input]').count(), 20);
  assert.equal(await page.locator('[data-tax-input][open]').getAttribute('data-tax-input'), '19');
  await page.evaluate(() => {
    for (let index = 0; index < 20; index += 1) {
      document.querySelector(`#description_${index}`).value = `商品视觉样例 ${index + 1}`;
      document.querySelector(`#hsCode_${index}`).value = `73239${index % 10}`;
      document.querySelector(`#declaredValue_${index}`).value = String(100 + index);
      document.querySelector(`#currency_${index}`).value = 'CAD';
    }
    document.querySelector('[data-tax-input="19"]').open = false;
    document.querySelector('[data-tax-input="0"]').open = true;
  });
  assert.equal(await page.locator('#description_19').inputValue(), '商品视觉样例 20');
  assert.equal(await page.locator('#declaredValue_19').inputValue(), '119');
  await page.getByRole('button', { name: '估算 20 项商品', exact: true }).click();
  await page.getByText('共 20 项', { exact: true }).waitFor();
  await page.getByText('完成 19 项', { exact: true }).waitFor();
  await page.getByText('待处理 1 项', { exact: true }).waitFor();
  assert.equal(await page.locator('.tax-result-row').count(), 20);
  assert.equal(await page.locator('.estimate-item').count(), 20);
  assert.equal(await page.locator('[data-tax-input="19"]').evaluate((element) => element.open), true);
  assert.equal(await page.locator('.tax-result-row[open]').count(), 2);
  assert.equal(await page.locator('.tax-result-row').last().evaluate((element) => element.open), true);
  assert.equal(await page.locator('#description_19').inputValue(), '商品视觉样例 20');
  await page.locator('.tax-result-row').last().getByRole('button', { name: '修改此项资料', exact: true }).click();
  assert.equal(await page.locator('[data-tax-input="19"]').evaluate((element) => element.open), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'description_19');
  await shot('portal-business-results-tax-1440.png', 1440);
  await shot('portal-business-results-tax-320.png', 320);

  await go('quote');
  await page.getByLabel('详细地址').fill('123 Visual Sample Road');
  await page.getByLabel('加拿大邮编').fill('B0P 1R0');
  await page.getByLabel('城市').fill('Kingston');
  await page.getByLabel('省份').fill('NS');
  await page.getByLabel('总体积 · m³').fill('1.2');
  await page.getByLabel('总重量 · kg').fill('300');
  await page.getByLabel('件数').fill('2');
  await page.getByRole('button', { name: '查询规则试算', exact: true }).click();
  await page.getByText('286.40 USD', { exact: true }).waitFor();
  await page.getByText('尚未保存或发出正式报价', { exact: false }).waitFor();
  await page.getByRole('button', { name: '核对并准备保存', exact: true }).click();
  await page.getByRole('button', { name: '保存待复核记录', exact: true }).waitFor();

  await page.getByLabel('加拿大邮编').fill('B0P 2R0');
  const staleSave = page.locator('[data-action="business-quote-save"]');
  assert.equal(await staleSave.isDisabled(), true, 'editing quote input must disable saving the prepared preview');
  await page.getByText('资料已修改，请重新查询后使用结果。', { exact: true }).first().waitFor();
  await page.getByLabel('加拿大邮编').fill('B0P 1R0');
  await page.getByRole('button', { name: '查询规则试算', exact: true }).click();
  await page.getByRole('button', { name: '核对并准备保存', exact: true }).click();
  await page.locator('[data-action="business-quote-save"]').click();
  await page.getByText('原记录可能已保存，但尚未完成读回', { exact: false }).waitFor();
  await page.locator('[data-action="business-quote-save"]').click();
  await page.getByText('已保存到原系统，并已读回确认', { exact: false }).waitFor();
  assert.equal(saveAttempts, 2);
  assert.equal(saveKeys.length, 2);
  assert.ok(saveKeys[0]);
  assert.equal(saveKeys[0], saveKeys[1], 'readback retry must reuse the same idempotency key');
  await shot('portal-business-results-quote-1440.png', 1440);
  await shot('portal-business-results-quote-390.png', 390);

  await page.getByRole('button', { name: '查看我的报价记录', exact: true }).click();
  await page.getByText(/Kingston · B0P 1R0/u).waitFor();
  await page.locator('[data-action="business-record-more"]').click();
  await page.getByText(/Moncton · B0P 1R0/u).waitFor();
  assert.equal(listAttempts, 2);
  await page.getByText(/Kingston · B0P 1R0/u).locator('xpath=ancestor::tr').getByRole('button', { name: '查看原记录', exact: true }).click();
  await page.getByText('人工复核任务', { exact: true }).waitFor();
  await page.getByText('当前 API 不会发送报价', { exact: true }).waitFor();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  console.log(JSON.stringify({ verdict: 'pass', customs: 'complete-visual-sample', tax: { total: 20, partial_failure: true }, quote: { status: 'manual_review', save_attempts: saveAttempts, same_idempotency_key: true, history_pages: listAttempts }, screenshots: 6, browser_errors: [] }));
} finally {
  await browser.close();
}
