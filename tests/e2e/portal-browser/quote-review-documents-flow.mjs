import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const playwrightModule = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const { chromium } = playwrightModule.default || playwrightModule;
const base = process.env.PORTAL_BASE_URL || 'http://127.0.0.1:8882';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('loopback_fixture_required');

const pdf = Buffer.from('%PDF-1.7\nverified portal review fixture\n%%EOF');
const pdfHash = `sha256:${createHash('sha256').update(pdf).digest('hex')}`;
const source = { source_id: 'zone-price:review-fixture', source_type: 'fixture', system: 'quote-review-browser-fixture', locator: 'fixture://quote-review', version: 'visual-review@2026-09-05', retrieved_at: '2026-09-05T00:00:00Z', authority: 'supporting', content_hash: `sha256:${'a'.repeat(64)}` };
const preview = { currency: 'USD', source_type: 'manual_required', confidence: 50, postal_code: 'L4K 2N2', postal_prefix: 'L4K', preferred_city: 'Concord', city: 'Concord', province: 'ON', origin: 'toronto', zone: null, billing_pallets: 3, pallet_breakdown: { volume: 2, weight: 3 }, base_price: null, fuel: null, accessorials: {}, total_price: null, risk_tags: ['source_not_authoritative'], manual_review_required: true, matched_rule: 'manual', matched_by: null, candidate_count: 0, match_trace: {}, sales_note: null };
const request = { address_line: '8888 Keele St', postal_code: 'L4K 2N2', city: 'Concord', province: 'ON', cbm: '4.2', weight_kg: '850', piece_count: 10, packaging_type: 'carton', longest_side_cm: '100', address_type: 'commercial', requires_liftgate: false, requires_pallet_jack: false, requires_appointment: true, explicit_pallet_count: null, is_stackable: null, detention_minutes: 0 };
const evidence = { evidence_ref: 'supplier_rate_ref_1', evidence_version: 'supplier-release-2026-09-05', effective_at: '2026-09-05T08:00:00Z', valid_until: '2026-09-12T08:00:00Z' };
const charges = [{ code: 'base', label: '基础运费', amount_usd: '200.00' }, { code: 'fuel', label: '燃油附加费', amount_usd: '45.50' }];
const terms = '收货方负责现场卸货；超出所列条件须重新报价。';
let resolved = false;
let resolveBody;
let generated = false;

const record = () => ({ record_ref: 'record_abcdefghijklmnop', record_version: resolved ? 2 : 1, record_status: resolved ? 'quoted' : 'manual_required', review_task_ref: 'task_abcdefghijklmnop', currency: 'USD', saved: true, sendable: false, quote_ready: resolved, pdf_available: generated, bookable: false, total_price_usd: resolved ? '245.50' : null, review_evidence: resolved ? evidence : null, charge_lines: resolved ? charges : null, customer_terms: resolved ? terms : null, service_conditions: resolved ? request : null, source_snapshot_hash: resolved ? source.content_hash : null, readback_verified: true, created_at: '2026-09-05T00:00:00Z', request, preview, resolution: resolved ? { decision: 'approve_manual_price', total_price_usd: '245.50', currency: 'USD', review_evidence: evidence, charge_lines: charges, customer_terms: terms, service_conditions: request, source_snapshot_hash: source.content_hash, note: '已核对供应商费率版本。', reviewer_actor_id: 'fixture-owner', resolved_at: '2026-09-05T09:00:00Z', recalculation: { schema_version: 'quote-preview@2026-09-05.v2', preview, source_refs: [source] } } : null, source_refs: [source] });
const envelope = (status, data, reason_codes = []) => ({ schema_version: 'portal-quote-record@2026-09-05.v1', source_schema_version: 'quote-review-resolution@2026-09-05.v2', status, data, reason_codes, source_refs: [source], request_id: 'req_browser_review_0001' });

const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.route('**/console/api/v1/business/**', async (route) => {
  const call = route.request(); const path = new URL(call.url()).pathname.replace('/console/api/v1/business/', '');
  let body;
  if (path === 'services') body = { schema_version: 'portal-business@2026-09-05.v1', status: 'success', data: { organization_id: 'org_fixture', operations: [] }, reason_codes: [] };
  else if (path === 'quote/review-queue') body = envelope('success', { tasks: resolved ? [] : [{ task_ref: 'task_abcdefghijklmnop', task_version: 1, record_ref: 'record_abcdefghijklmnop', record_version: 1, status: 'pending', reason: 'quote_source_requires_review', risk_tags: ['source_not_authoritative'], created_by_actor_id: 'fixture-developer', created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z' }] }, []);
  else if (path === 'quote/records/list') body = envelope('success', { records: [record()], next_cursor: null }, []);
  else if (path === 'quote/records/get') body = envelope(resolved ? 'success' : 'manual_review', record(), resolved ? [] : ['quote_source_not_authoritative']);
  else if (path === 'quote/records/review') body = envelope('success', { tasks: [{ task_ref: 'task_abcdefghijklmnop', record_ref: 'record_abcdefghijklmnop', status: resolved ? 'resolved' : 'pending', task_version: resolved ? 2 : 1, reason: 'quote_source_requires_review', risk_tags: ['source_not_authoritative'], resolved_price_usd: resolved ? '245.50' : null, created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z' }] }, []);
  else if (path === 'quote/review-tasks/task_abcdefghijklmnop/resolution-preview') body = envelope('manual_review', { record_ref: 'record_abcdefghijklmnop', record_version: 1, task_ref: 'task_abcdefghijklmnop', task_version: 1, preview, resolution_handle: 'opaque-resolution-handle-that-is-long-enough', expires_at: '2099-09-05T00:10:00Z' }, ['quote_source_not_authoritative']);
  else if (path === 'quote/review-tasks/task_abcdefghijklmnop/resolve') { resolveBody = call.postDataJSON(); resolved = true; body = envelope('success', { operation_ref: 'op_abcdefghijklmnop', record_ref: 'record_abcdefghijklmnop', record_version: 2, record_status: 'quoted', task_ref: 'task_abcdefghijklmnop', task_version: 2, task_status: 'resolved', total_price_usd: '245.50', currency: 'USD', review_evidence: evidence, charge_lines: charges, customer_terms: terms, service_conditions: request, source_snapshot_hash: source.content_hash, source_refs: [source], quote_ready: true, saved: true, sendable: false, pdf_available: false, bookable: false, readback_verified: true }, []); }
  else if (path === 'quote/records/record_abcdefghijklmnop/documents') { generated = true; body = { ...envelope('success', { document_ref: 'document_abcdefghijklmnop', record_ref: 'record_abcdefghijklmnop', record_version: 3, document_kind: 'formal_quote_pdf', formal: true, valid_now: true, historical_snapshot: true, watermark: null, media_type: 'application/pdf', content_sha256: pdfHash, content_length: pdf.length, schema_version: 'quote-document@2026-09-05.v2', download_path: '/api/v1/m2m/quote/documents/document_abcdefghijklmnop/content', issued_at: '2026-09-05T10:00:00Z', valid_until: evidence.valid_until, source_snapshot_hash: source.content_hash, terms_hash: source.content_hash, created_at: '2026-09-05T10:00:00Z', readback_verified: true }, []), source_schema_version: 'quote-document-create@2026-09-05.v2', source_refs: [{ source_type: 'source_system_quote_record', authority: 'record_snapshot', record_ref: 'record_abcdefghijklmnop', record_version: 3, formal: true, valid_until: evidence.valid_until, source_snapshot_hash: source.content_hash, content_hash: pdfHash }] }; }
  else if (path === 'quote/documents/document_abcdefghijklmnop/content') return route.fulfill({ status: 200, contentType: 'application/pdf', headers: { 'content-disposition': 'attachment; filename="document_abcdefghijklmnop.pdf"', 'cache-control': 'no-store' }, body: pdf });
  else return route.continue();
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
});

async function login() {
  await page.goto(`${base}/console/#login`); await page.locator('[data-action=logout], .identity-list button').first().waitFor();
  const logout = page.getByRole('button', { name: '退出', exact: true }); if (await logout.isVisible()) { const response = page.waitForResponse((value) => value.request().method() === 'POST' && value.url().endsWith('/console/api/v1/logout')); await logout.click(); await response; await page.goto(`${base}/console/#login`); await page.reload(); await page.locator('.identity-list button').first().waitFor(); }
  const identity = page.getByRole('button', { name: /企业所有者/ }); await identity.waitFor(); const response = page.waitForResponse((value) => value.request().method() === 'POST' && value.url().endsWith('/console/api/v1/fixture-login')); await identity.click(); await response; await page.locator('[data-action=logout]').first().waitFor();
}

try {
  await login(); await page.goto(`${base}/console/#quote-history`); await page.getByRole('heading', { name: '我的报价记录' }).waitFor();
  await page.getByRole('button', { name: '重新计算并复核' }).click(); await page.getByRole('heading', { name: '人工证据确认' }).waitFor();
  await page.getByLabel('人工确认总价 · USD').fill('245.50'); await page.getByLabel('证据引用').fill('supplier_rate_ref_1');
  await page.getByLabel('证据版本').fill('supplier-release-2026-09-05'); await page.getByLabel('证据生效时间').fill('2026-09-05T08:00');
  await page.getByLabel('报价有效期至').fill('2026-09-12T08:00'); await page.getByLabel(/逐项费用/).fill('base | 基础运费 | 200.00\nfuel | 燃油附加费 | 45.50');
  await page.getByLabel('客户可见条款与卸货条件').fill(terms); await page.getByLabel('复核说明').fill('已核对供应商费率版本。'); await page.getByText('我已人工核对逐项金额、币种、服务条件、费率来源与有效期').click();
  await page.getByRole('button', { name: '提交复核结果' }).click(); await page.getByText('已人工确认', { exact: true }).waitFor();
  assert.equal(resolveBody.confirmed, 'human_verified_price_and_source'); assert.equal(resolveBody.total_price_usd, '245.50'); assert.deepEqual(resolveBody.charge_lines, charges); assert.equal(resolveBody.customer_terms, terms); assert.equal('currency' in resolveBody, false);
  await page.getByRole('button', { name: '查看原记录' }).click(); await page.getByText('245.50 USD', { exact: true }).waitFor();
  await page.getByText('supplier_rate_ref_1', { exact: true }).waitFor(); await page.getByRole('button', { name: '生成正式 PDF' }).click();
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('link', { name: '下载并校验文件' }).click(); const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'document_abcdefghijklmnop.pdf'); const path = await download.path(); assert.ok(path); assert.deepEqual(await readFile(path), pdf); await rm(path, { force: true });
  assert.equal(pageErrors.length, 0, pageErrors.join('\n')); console.log('quote review/PDF browser flow: 13 checks passed');
} finally { await browser.close(); }
