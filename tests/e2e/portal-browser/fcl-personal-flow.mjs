import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const imported = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const {chromium} = imported.default || imported;
const base = (process.env.PORTAL_BASE_URL || 'http://127.0.0.1:8891').replace(/\/$/u, '');
const stopAfterApproval = process.env.FCL_BROWSER_STOP_AFTER_APPROVAL === 'true';
assert.equal(new URL(base).hostname, '127.0.0.1');

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {}),
});
const context = await browser.newContext({
  viewport: {width: 1440, height: 1000},
  reducedMotion: 'reduce',
  acceptDownloads: true,
});
const page = await context.newPage();
const checks = [];
const pageErrors = [];
const fclRequests = [];
const fclResponses = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('dialog', dialog => void dialog.accept('本地验收确认'));
page.on('request', request => { if (request.url().includes('/console/api/v1/fcl/')) fclRequests.push({method: request.method(), path: new URL(request.url()).pathname}); });
page.on('response', response => {
  if (!response.url().includes('/console/api/v1/fcl/')) return;
  void response.json().then(body => {
    fclResponses.push({
      method: response.request().method(),
      path: new URL(response.url()).pathname,
      status: response.status(),
      reason_codes: Array.isArray(body?.reason_codes) ? body.reason_codes : [],
    });
  }).catch(() => undefined);
});

async function responseJson(response) {
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  return body;
}
async function openCaseOperations() {
  const details = page.locator('details.fcl-operations');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
}

try {
  await page.goto(`${base}/inquiry/`, {waitUntil: 'networkidle'});
  await page.getByRole('heading', {name: '中国 → 加拿大 · FCL整柜询价', exact: true}).waitFor();
  await page.locator('#origin_city').fill('Shenzhen');
  await page.locator('#pol').fill('Yantian');
  await page.locator('#pod').fill('Vancouver');
  await page.locator('#final_destination').fill('Toronto');
  await page.locator('#container-40HQ').fill('1');
  await page.locator('#cargo_ready_date').fill('2026-10-15');
  await page.locator('#incoterm').selectOption('EXW');
  await page.locator('form button[type="submit"]').click();
  await page.locator('#cargo_name').fill('Synthetic furniture');
  await page.locator('#cargo_type').selectOption('general');
  await page.locator('#estimated_weight').fill('18000');
  await page.locator('input[name="service"][value="ocean_freight"]').check();
  await page.locator('form button[type="submit"]').click();
  await page.locator('#contact\\.name').fill('Synthetic Shipper');
  await page.locator('#contact\\.email').fill('shipper@example.test');
  await page.locator('input[name="consent"]').check();
  const submittedResponse = page.waitForResponse(response => response.url().endsWith('/inquiry/api/v1/fcl/submit'));
  await page.locator('form button[type="submit"]').click();
  const submitted = await responseJson(await submittedResponse);
  assert.equal(submitted.status, 'success');
  const firstCaseId = submitted.data.case_id;
  const firstInquiryNo = submitted.data.inquiry_no;
  await page.getByRole('heading', {name: '询价已保存', exact: true}).waitFor();
  assert.equal(new URL(page.url()).hash, '');
  checks.push('public three-step submit and credential exchange');
  await page.evaluate(() => { location.hash = '#business'; });
  await page.getByRole('heading', {name: '企业与合规服务', exact: true}).waitFor();
  await page.evaluate(() => { location.hash = '#fcl'; });
  await page.getByRole('heading', {name: '中国 → 加拿大 · FCL整柜询价', exact: true}).waitFor();
  await page.getByText(firstInquiryNo, {exact: false}).waitFor();
  checks.push('public FCL to legacy and back to FCL remounts without losing the ticket');

  const sessionResponse = await context.request.get(`${base}/console/api/v1/session`);
  const sessionBody = await responseJson(sessionResponse);
  const loginResponse = await context.request.post(`${base}/console/api/v1/fixture-login`, {
    headers: {
      origin: base,
      'x-csrf-token': sessionBody.csrf_token,
      'idempotency-key': 'fcl-browser-login-0001',
    },
    data: {identity_id: 'fixture-fcl-receiver'},
  });
  const loginBody = await responseJson(loginResponse);
  assert.equal(loginBody.fcl_capability?.fcl_personal, true);
  let responsePromise;

  await page.goto(`${base}/console/#fcl`, {waitUntil: 'networkidle'});
  await page.locator('.case-card').first().waitFor();
  await page.locator('.case-card').first().click();
  await page.getByRole('heading', {name: 'FCL 报价工作区', exact: true}).waitFor();
  await openCaseOperations();
  const staffSupplementCountBefore = fclRequests.filter(request => request.path.endsWith('/case-staff-supplement')).length;
  await page.locator('[data-fcl-form="staff-supplement"] button[type="submit"]').click();
  await page.getByText('没有检测到需要记录的变化。', {exact: true}).waitFor();
  assert.equal(fclRequests.filter(request => request.path.endsWith('/case-staff-supplement')).length, staffSupplementCountBefore);
  await openCaseOperations();
  await page.locator('[data-fcl-form="case-status"] textarea[name="public_note"]').fill('Please confirm the final destination.');
  await page.locator('[data-fcl-form="case-status"] select[name="status"]').selectOption('needs_input');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/case-status'));
  await page.locator('[data-fcl-form="case-status"] button[type="submit"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');

  await page.goto(`${base}/inquiry/`, {waitUntil: 'networkidle'});
  await page.locator('[data-fcl-supplement]').waitFor();
  await page.locator('#supply-origin_city').fill('Shekou');
  await page.locator('#supply-pod').fill('Vancouver');
  await page.locator('#supply-final_destination').fill('Montreal');
  await page.locator('#supply-container-40HQ').fill('2');
  await page.locator('#supply-cargo_name').fill('Synthetic furniture updated');
  await page.locator('#supply-cargo_type').selectOption('wood');
  await page.locator('#supply-estimated_weight').fill('17500');
  await page.locator('#supply-cargo_ready_date').fill('2026-10-20');
  await page.locator('#supply-incoterm').selectOption('FOB');
  await page.locator('#supply-incoterm_other').fill('FOB Shenzhen terms');
  await page.locator('#supply-contact-name').fill('Synthetic Shipper Updated');
  await page.locator('#supply-contact-email').fill('updated-shipper@example.test');
  await page.locator('#supply-contact-company').fill('Synthetic Company');
  await page.locator('#supply-contact-phone').fill('+1 555 0100');
  await page.locator('#supply-notes').fill('Customer supplied all available structured fields.');
  const diff = page.locator('[data-fcl-supplement-diff]');
  await diff.getByText('final_destination', {exact: true}).waitFor();
  await diff.getByText('Montreal', {exact: true}).waitFor();
  await diff.getByText('containers', {exact: true}).waitFor();
  await diff.getByText('contact.email', {exact: true}).waitFor();
  const supplementRequest = page.waitForRequest(request => request.url().endsWith('/inquiry/api/v1/fcl/supplement'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/inquiry/api/v1/fcl/supplement'));
  await page.locator('[data-fcl-supplement] button[type="submit"]').click();
  const supplementPayload = (await supplementRequest).postDataJSON();
  assert.ok(supplementPayload.fields.changes.length >= 10);
  const supplemented = await responseJson(await responsePromise);
  assert.equal(supplemented.status, 'success');
  assert.equal(supplemented.data.case_version, 3);
  checks.push('public supplement before/after and persisted customer event');

  await page.goto(`${base}/console/#fcl`, {waitUntil: 'networkidle'});
  await page.locator('.case-card').first().click();
  await page.getByRole('heading', {name: 'FCL 报价工作区', exact: true}).waitFor();
  await openCaseOperations();
  await page.locator('[data-fcl-form="staff-supplement"] [name="contact.company"]').fill('Staff verified company');
  await page.locator('[data-fcl-form="staff-supplement"] [name="message"]').fill('Staff recorded the offline company confirmation.');
  const staffSupplementRequest = page.waitForRequest(request => request.url().endsWith('/case-staff-supplement'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/case-staff-supplement'));
  await page.locator('[data-fcl-form="staff-supplement"] button[type="submit"]').click();
  const staffSupplementPayload = (await staffSupplementRequest).postDataJSON();
  assert.equal(staffSupplementPayload.fields.changes.some(change => change.field === 'contact.company'), true);
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  await page.locator('[data-fcl-form="case-confirm"] textarea[name="reason"]').fill('Synthetic requirements reviewed from the public inquiry.');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/case-confirm'));
  await page.locator('[data-fcl-form="case-confirm"] button[type="submit"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  checks.push('staff confirmation');

  await page.goto(`${base}/console/#fcl/rates`, {waitUntil: 'networkidle'});
  await page.getByRole('button', {name: '添加来源', exact: true}).click();
  await page.locator('[name="fcl-rate-label"]').fill('FCL browser fixture rates');
  const rate = page.locator('[data-fcl-rate-index="0"]');
  await rate.locator('[name="fcl-rate-0-supplier"]').fill('Synthetic carrier');
  await rate.locator('[name="fcl-rate-0-pol"]').fill('Yantian');
  await rate.locator('[name="fcl-rate-0-pod"]').fill('Vancouver');
  await rate.locator('[name="fcl-rate-0-from"]').fill('2026-10-01');
  await rate.locator('[name="fcl-rate-0-until"]').fill('2026-10-31');
  await rate.locator('[name="fcl-rate-0-source"]').fill('synthetic:browser-rate');
  await rate.locator('[name="fcl-rate-0-source-version"]').fill('v1');
  await rate.locator('[name="fcl-rate-0-40HQ-price"]').fill('3200');
  await page.evaluate(() => { location.hash = 'fcl'; });
  await page.locator('.case-card').first().waitFor();
  await page.evaluate(() => { location.hash = 'fcl/rates'; });
  await page.locator('[name="fcl-rate-label"]').waitFor();
  assert.equal(await page.locator('[name="fcl-rate-label"]').inputValue(), 'FCL browser fixture rates');
  assert.equal(await page.locator('[name="fcl-rate-0-40HQ-price"]').inputValue(), '3200');
  await page.locator('[data-action="fcl-rate-preview"]').click();
  await page.getByText('请先保存运价草稿，再预览服务器版本。', {exact: true}).waitFor();
  assert.equal(await page.locator('[name="fcl-rate-0-40HQ-price"]').inputValue(), '3200');
  await page.getByRole('button', {name: '添加来源', exact: true}).click();
  await page.locator('[data-action="fcl-rate-remove"][data-index="1"]').click();
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-save'));
  await page.locator('[data-action="fcl-rate-save"]').click();
  const firstRateSave = await responseJson(await responsePromise);
  assert.equal(firstRateSave.status, 'success');
  assert.equal(firstRateSave.data.draft.rates.length, 1);
  assert.equal(firstRateSave.data.draft.rates[0].items[0].ocean_freight, '3200');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-preview'));
  await page.locator('[data-action="fcl-rate-preview"]').click();
  const preview = await responseJson(await responsePromise);
  assert.equal(preview.data.can_publish, true);
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-publish'));
  await page.locator('[data-action="fcl-rate-publish"]').click();
  const firstPublication = await responseJson(await responsePromise);
  assert.equal(firstPublication.status, 'success');
  const firstReleaseId = firstPublication.data.active_release.release_id;
  await rate.locator('[name="fcl-rate-0-40HQ-price"]').fill('3300');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-save'));
  await page.locator('[data-action="fcl-rate-save"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-preview'));
  await page.locator('[data-action="fcl-rate-preview"]').click();
  assert.equal((await responseJson(await responsePromise)).data.can_publish, true);
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-publish'));
  await page.locator('[data-action="fcl-rate-publish"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  await page.locator('details.panel', {hasText: '历史发布'}).locator('summary').click();
  const rollbackPreview = page.waitForResponse(response => response.url().includes('/rate-preview?release_id=') && response.url().includes(firstReleaseId));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-rollback'));
  await page.locator(`[data-action="fcl-rate-rollback"][data-release="${firstReleaseId}"]`).click();
  assert.equal((await responseJson(await rollbackPreview)).data.can_publish, true);
  const rollback = await responseJson(await responsePromise);
  assert.equal(rollback.status, 'success');
  assert.equal(rollback.data.active_release.input.rates[0].items[0].ocean_freight, '3200');
  checks.push('rate draft preview, publication and selected historical rollback');

  await page.goto(`${base}/console/#fcl/config`, {waitUntil: 'networkidle'});
  await page.locator('[name="fcl-issuer-name"]').fill('   ');
  await page.locator('[name="fcl-issuer-terms"]').fill('Synthetic fixture terms.');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/issuer-config-save'));
  await page.locator('[data-fcl-form="issuer-config-save"] button[type="submit"]').click();
  const invalidIssuerResponse = await responsePromise;
  const invalidIssuer = await invalidIssuerResponse.json();
  assert.equal(invalidIssuerResponse.status(), 400);
  assert.equal(invalidIssuer.status, 'needs_input');
  assert.equal(await page.locator('[name="fcl-issuer-name"]').inputValue(), '   ');
  await page.locator('[name="fcl-issuer-name"]').fill('FreightClaw Synthetic Issuer');
  await page.locator('details.qdoc-template-picker summary').click();
  await page.locator('[data-fcl-template-ref]').first().check();
  const issuerSaveRequest = page.waitForRequest(request => request.url().endsWith('/issuer-config-save'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/issuer-config-save'));
  await page.locator('[data-fcl-form="issuer-config-save"] button[type="submit"]').click();
  assert.equal((await issuerSaveRequest).postDataJSON().input.standard_fee_template_v1.items.length > 0, true);
  assert.equal((await responseJson(await responsePromise)).status, 'success');

  await page.goto(`${base}/console/#fcl`, {waitUntil: 'networkidle'});
  await page.locator('.case-card').first().click();
  await page.getByRole('heading', {name: 'FCL 报价工作区', exact: true}).waitFor();
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-match'));
  await page.locator('[data-action="fcl-match"]').click();
  const matched = await responseJson(await responsePromise);
  assert.equal(matched.status, 'success', JSON.stringify(matched));
  await page.locator('[name="fcl-source-sell-0"]').waitFor();
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-save'));
  await page.locator('[data-fcl-form="quote-save"] button[type="submit"]').click();
  const partial = await responseJson(await responsePromise);
  assert.equal(partial.status, 'needs_input');
  assert.equal(partial.data.version, 1);
  assert.equal(partial.data.current_version, 1);
  await page.reload({waitUntil: 'networkidle'});
  await page.locator('[data-action="fcl-edit-quote"]').waitFor();
  await page.locator('[data-action="fcl-edit-quote"]').click();
  await page.locator('[name="fcl-source-sell-0"]').fill('3500');
  await page.locator('[name="USD"]').fill('7.2');
  const updateRequest = page.waitForRequest(request => request.url().endsWith('/quote-save'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-save'));
  await page.locator('[data-fcl-form="quote-save"] button[type="submit"]').click();
  const updatePayload = (await updateRequest).postDataJSON();
  const completed = await responseJson(await responsePromise);
  assert.equal(updatePayload.operation, 'update');
  assert.equal(updatePayload.quote_ref, partial.data.quote_ref);
  assert.equal(completed.status, 'success');
  assert.equal(completed.data.quote_ref, partial.data.quote_ref);
  assert.equal(completed.data.version, 2);
  checks.push('needs_input quote retained and updated on the same quote_ref');
  const quoteHistoryDetails = page.locator('details.panel', {hasText: '报价历史'});
  await quoteHistoryDetails.locator('summary').waitFor();
  await quoteHistoryDetails.locator('summary').click();
  await page.locator('[data-action="fcl-quote-open-history"]').first().waitFor();
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-get'));
  await page.locator('[data-action="fcl-quote-open-history"]').first().click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  await page.getByText('历史报价 v2', {exact: true}).waitFor();

  await page.locator('#fcl-doc-quote-no').fill('FCL-BROWSER-001');
  await page.locator('#fcl-doc-remark').fill('Document display edited before approval.');
  const documentSaveRequest = page.waitForRequest(request => request.url().endsWith('/document-save'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-save'));
  await page.locator('[data-action="fcl-doc-save"]').click();
  const documentSavePayload = (await documentSaveRequest).postDataJSON();
  assert.equal(documentSavePayload.quote_no, 'FCL-BROWSER-001');
  assert.equal(documentSavePayload.remark, 'Document display edited before approval.');
  const documentSaved = await responseJson(await responsePromise);
  assert.equal(documentSaved.status, 'success');
  const relatedAfterReject = page.waitForResponse(response => response.url().endsWith('/document-list'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-reject'));
  await page.locator('[data-action="fcl-doc-reject"]').click();
  const rejected = await responseJson(await responsePromise);
  assert.equal(rejected.status, 'success');
  assert.equal(rejected.data.state, 'rejected');

  await relatedAfterReject;
  await openCaseOperations();
  await page.locator('[data-fcl-form="case-status"] textarea[name="public_note"]').fill('Please confirm the revised cargo date.');
  await page.locator('[data-fcl-form="case-status"] select[name="status"]').selectOption('needs_input');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/case-status'));
  await page.locator('[data-fcl-form="case-status"] button[type="submit"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  await page.goto(`${base}/inquiry/`, {waitUntil: 'networkidle'});
  await page.locator('[data-fcl-supplement]').waitFor();
  await page.locator('#supply-cargo_ready_date').fill('2026-10-28');
  await page.locator('#supply-notes').fill('Customer confirmed the revised cargo date after document rejection.');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/inquiry/api/v1/fcl/supplement'));
  await page.locator('[data-fcl-supplement] button[type="submit"]').click();
  const secondSupplement = await responseJson(await responsePromise);
  assert.equal(secondSupplement.status, 'success');
  assert.equal(secondSupplement.data.input.containers.find(container => container.type === '40HQ').quantity, 2);
  assert.equal(secondSupplement.data.input.final_destination, 'Montreal');
  assert.equal(secondSupplement.data.input.contact.email, 'updated-shipper@example.test');
  await page.goto(`${base}/console/#fcl`, {waitUntil: 'networkidle'});
  await page.locator('.case-card').first().click();
  await page.getByRole('heading', {name: 'FCL 报价工作区', exact: true}).waitFor();
  await page.locator('[data-fcl-form="case-confirm"] textarea[name="reason"]').fill('Confirmed revised cargo date after rejection.');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/case-confirm'));
  await page.locator('[data-fcl-form="case-confirm"] button[type="submit"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');

  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-match'));
  await page.locator('[data-action="fcl-match"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  await page.locator('[name="fcl-source-sell-0"]').fill('3600');
  await page.locator('[name="USD"]').fill('7.2');
  const resubmitQuoteRequest = page.waitForRequest(request => request.url().endsWith('/quote-save'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-save'));
  await page.locator('[data-fcl-form="quote-save"] button[type="submit"]').click();
  const resubmitQuotePayload = (await resubmitQuoteRequest).postDataJSON();
  assert.equal(resubmitQuotePayload.operation, 'update');
  assert.equal(resubmitQuotePayload.source_binding.mode, 'replace');
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  checks.push('document rejection, customer supplement, case reconfirmation and quote replacement');

  const resubmitRequest = page.waitForRequest(request => request.url().endsWith('/document-save'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-save'));
  await page.locator('[data-action="fcl-doc-save"]').click();
  assert.equal((await resubmitRequest).postDataJSON().operation, 'resubmit');
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-review'));
  await page.locator('[data-action="fcl-doc-review"]').click();
  const review = await responseJson(await responsePromise);
  assert.equal(review.status, 'success');
  await page.locator('[data-action="fcl-edit-quote"]').click();
  await page.locator('#fcl-quote-remark').fill('Quote edited after document review.');
  assert.equal(await page.locator('[data-action="fcl-doc-approve"]').isDisabled(), true);
  const reviewInvalidationQuote = page.waitForRequest(request => request.url().endsWith('/quote-save'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-save'));
  await page.locator('[data-fcl-form="quote-save"] button[type="submit"]').click();
  assert.equal((await reviewInvalidationQuote).postDataJSON().operation, 'update');
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-save'));
  await page.locator('[data-action="fcl-doc-save"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-review'));
  await page.locator('[data-action="fcl-doc-review"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-approve'));
  await page.locator('[data-action="fcl-doc-approve"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  checks.push('document save/review, edit invalidation, refresh review and approval');

  if (!stopAfterApproval) {
    const downloadPromise = page.waitForEvent('download');
    responsePromise = page.waitForResponse(response => response.url().endsWith('/document-export'));
    await page.locator('[data-action="fcl-doc-export"]').click();
    const [exportedResponse, download] = await Promise.all([responsePromise, downloadPromise]);
    const exported = await responseJson(exportedResponse);
    const downloadPath = join(tmpdir(), `fcl-browser-${Date.now()}.pdf`);
    await download.saveAs(downloadPath);
    const pdf = await readFile(downloadPath);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.equal(pdf.byteLength, exported.data.byte_length);
    assert.equal(createHash('sha256').update(pdf).digest('hex'), exported.data.sha256);
    await rm(downloadPath, {force: true});
    checks.push('formal PDF schema, hash, bytes, safe filename and browser download');

    await page.locator('[name="fcl-handoff-note"]').fill('Synthetic browser handoff.');
    responsePromise = page.waitForResponse(response => response.url().endsWith('/handoff-save'));
    await page.locator('[data-action="fcl-handoff"]').click();
    const handoff = await responseJson(await responsePromise);
    assert.equal(handoff.status, 'success');
    assert.equal(handoff.data.status, 'handed_off');
    checks.push('handoff recorded without Booking or SO');
  } else {
    responsePromise = page.waitForResponse(response => response.url().endsWith('/document-export'));
    await page.locator('[data-action="fcl-doc-export"]').click();
    const unavailableResponse = await responsePromise;
    const unavailable = await unavailableResponse.json();
    assert.equal(unavailableResponse.status(), 503);
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.reason_codes[0], 'document_renderer_unavailable');
    await page.waitForFunction(() => document.querySelector('#notification')?.textContent?.includes('document_renderer_unavailable'));
    checks.push('formal PDF and handoff NOT_RUN: host browser sandbox unavailable; unavailable reason surfaced in UI');
  }

  const publicSessionResponse = await context.request.get(`${base}/inquiry/api/v1/session`);
  const publicSession = await responseJson(publicSessionResponse);
  const secondSubmissionResponse = await context.request.post(`${base}/inquiry/api/v1/fcl/submit`, {
    headers: {origin: base, 'x-csrf-token': publicSession.data.session.csrf_token, 'idempotency-key': 'fcl-browser-second-submit-01'},
    data: {
      contract_version: 'fcl-inquiry@2026-09-20.v1',
      transport_mode: 'FCL',
      origin_city: 'Ningbo',
      pol: 'Ningbo',
      pod: 'Vancouver',
      final_destination: 'Calgary',
      containers: [{type: '20GP', quantity: 1}],
      cargo_name: 'Second synthetic cargo',
      cargo_type: 'general',
      estimated_weight: {value: '9000', unit: 'kg'},
      cargo_ready_date: '2026-10-25',
      incoterm: 'FOB',
      incoterm_other: null,
      selected_services: ['ocean_freight'],
      contact: {name: 'Second shipper', company: null, email: 'second-shipper@example.test', phone: null},
      notes: null,
      consent: true,
    },
  });
  const secondSubmission = await responseJson(secondSubmissionResponse);
  assert.equal(secondSubmission.status, 'success');
  const secondCaseId = secondSubmission.data.case_id;
  const secondInquiryNo = secondSubmission.data.inquiry_no;
  await page.route(url => /\/fcl\/(quote-list|document-list|handoff-get|issuer-config|notification-get)$/u.test(url.pathname), async route => {
    let caseRef;
    try { caseRef = route.request().postDataJSON()?.case_ref; } catch { caseRef = undefined; }
    if (caseRef === undefined || caseRef === secondCaseId) await new Promise(resolve => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.goto(`${base}/console/#fcl/case/${secondCaseId}`, {waitUntil: 'domcontentloaded'});
  await page.locator('[data-fcl-form="case-confirm"] textarea[name="reason"]').fill('Reason typed before delayed related responses finish.');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await page.locator('[data-fcl-form="case-confirm"] textarea[name="reason"]').inputValue(), 'Reason typed before delayed related responses finish.');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/case-confirm'));
  await page.locator('[data-fcl-form="case-confirm"] button[type="submit"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  await page.unroute(url => /\/fcl\/(quote-list|document-list|handoff-get|issuer-config|notification-get)$/u.test(url.pathname));
  checks.push('confirmation reason survives delayed related/config reload');

  await page.route('**/console/api/v1/fcl/case-get', async route => {
    const caseId = route.request().postDataJSON()?.case_id;
    await new Promise(resolve => setTimeout(resolve, caseId === firstCaseId ? 900 : 50));
    await route.continue();
  });
  await page.goto(`${base}/console/#fcl/case/${firstCaseId}`, {waitUntil: 'domcontentloaded'});
  await new Promise(resolve => setTimeout(resolve, 50));
  await page.evaluate(id => { location.hash = `fcl/case/${id}`; }, secondCaseId);
  await page.getByText(secondInquiryNo, {exact: false}).first().waitFor();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(new URL(page.url()).hash.endsWith(secondCaseId), true);
  assert.equal((await page.locator('.case-workspace').innerText()).includes(firstInquiryNo), false);
  await page.unroute('**/console/api/v1/fcl/case-get');
  checks.push('case switch ignores delayed stale case response');

  const otherContext = await browser.newContext({viewport: {width: 1280, height: 900}});
  const otherPage = await otherContext.newPage();
  const otherSessionResponse = await otherContext.request.get(`${base}/console/api/v1/session`);
  const otherSession = await responseJson(otherSessionResponse);
  await responseJson(await otherContext.request.post(`${base}/console/api/v1/fixture-login`, {
    headers: {origin: base, 'x-csrf-token': otherSession.csrf_token, 'idempotency-key': 'fcl-browser-other-login-01'},
    data: {identity_id: 'fixture-sales'},
  }));
  const organizationAttempt = await otherContext.request.post(`${base}/console/api/v1/session/organization`, {
    headers: {origin: base, 'x-csrf-token': otherSession.csrf_token, 'idempotency-key': 'fcl-browser-other-org-01'},
    data: {organization_id: 'org_fixture'},
  });
  assert.equal(organizationAttempt.status(), 403);
  await otherPage.goto(`${base}/console/#fcl`, {waitUntil: 'networkidle'});
  assert.equal(await otherPage.locator('.case-card').count(), 0);
  await otherContext.close();
  checks.push('non-receiver and organization switch do not expose writable FCL state');

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({status: stopAfterApproval ? 'partial' : 'pass', checks, page_errors: pageErrors}, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'failed',
    url: page.url(),
    checks,
    page_errors: pageErrors,
    fcl_requests: fclRequests.slice(-20),
    fcl_responses: fclResponses.slice(-20),
    notifications: await page.locator('#notification').allTextContents().catch(() => []),
    form_errors: await page.locator('[data-fcl-form] .form-error:not([hidden])').allTextContents().catch(() => []),
  }, null, 2));
  throw error;
} finally {
  await browser.close();
}
