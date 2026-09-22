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
let dialogMode = 'accept';
page.on('pageerror', error => pageErrors.push(error.message));
page.on('dialog', dialog => { void (dialogMode === 'dismiss' ? dialog.dismiss() : dialog.accept('本地验收确认')); });
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
async function openWorkspaceStep(step) {
  const button = page.locator(`.fcl-workflow [data-step="${step}"]`);
  if (await button.getAttribute('aria-current') !== 'step') await button.click();
  await page.locator(`#fcl-step-${step}`).waitFor({state: 'visible'});
}
async function openCaseOperations(caseId) {
  if (!(await page.locator('.fcl-workflow').count())) {
    if (!caseId) throw new Error('case_id_required_to_reopen_operations');
    await page.evaluate(id => { location.hash = `fcl/case/${id}`; }, caseId);
    await page.getByRole('heading', {name: '整柜报价', exact: true}).waitFor();
  }
  const requirements = page.locator('#fcl-step-requirements');
  if (!(await requirements.isVisible())) {
    await openWorkspaceStep('quote');
    const moreSettings = page.locator('details.ops-ticket-details').filter({hasText: '更多设置'});
    if (await moreSettings.count()) await openDetails(moreSettings);
    await page.locator('[data-action="fcl-workspace-step"][data-step="requirements"]').first().click();
    await requirements.waitFor({state: 'visible'});
  }
  const details = page.locator('details.fcl-operations');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
}
async function openQuoteEditor() {
  const form = page.locator('[data-fcl-form="quote-save"]');
  if (!(await form.count())) {
    const edit = page.locator('[data-action="fcl-edit-quote"]');
    await edit.waitFor();
    await edit.click();
  }
  await form.waitFor({state: 'visible'});
}
async function openDetails(details) {
  await details.evaluate(node => { if (!node.open) node.open = true; });
}

try {
  await page.goto(`${base}/inquiry/`, {waitUntil: 'networkidle'});
  await page.getByRole('heading', {name: '整柜海运询价', exact: true}).waitFor();
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
  await page.getByRole('heading', {name: '整柜海运询价', exact: true}).waitFor();
  await page.getByText(firstInquiryNo, {exact: false}).waitFor();
  checks.push('public FCL to legacy and back to FCL remounts without losing the ticket');
  await page.goto(`${base}/inquiry/details/`, {waitUntil: 'domcontentloaded'});
  await page.goBack({waitUntil: 'domcontentloaded'});
  await page.getByRole('heading', {name: '整柜海运询价', exact: true}).waitFor();
  await page.getByText(firstInquiryNo, {exact: false}).waitFor();
  checks.push('public FCL page remains operable after browser back');

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
  const caseCard = page.locator('.case-card').filter({hasText: firstInquiryNo});
  await caseCard.waitFor();
  await caseCard.click();
  await page.getByRole('heading', {name: '整柜报价', exact: true}).waitFor();
  await page.locator('[data-fcl-form="case-confirm"] textarea[name="reason"]').fill('Unsaved reason must survive cancelled navigation.');
  dialogMode = 'dismiss';
  await page.evaluate(() => { location.hash = 'fcl/rates'; });
  await page.waitForFunction(() => location.hash.startsWith('#fcl/case/'));
  assert.equal(new URL(page.url()).hash, `#fcl/case/${firstCaseId}`);
  assert.equal(await page.locator('[data-fcl-form="case-confirm"] textarea[name="reason"]').inputValue(), 'Unsaved reason must survive cancelled navigation.');
  dialogMode = 'accept';
  await page.locator('[data-fcl-form="case-confirm"] textarea[name="reason"]').fill('');
  checks.push('dirty internal navigation cancellation keeps the current draft');
  await openCaseOperations(firstCaseId);
  const staffSupplementCountBefore = fclRequests.filter(request => request.path.endsWith('/case-staff-supplement')).length;
  await page.locator('[data-fcl-form="staff-supplement"] button[type="submit"]').click();
  await page.getByText('没有检测到需要记录的变化。', {exact: true}).waitFor();
  assert.equal(fclRequests.filter(request => request.path.endsWith('/case-staff-supplement')).length, staffSupplementCountBefore);
  await openCaseOperations(firstCaseId);
  await page.locator('[data-fcl-form="case-status"] textarea[name="public_note"]').fill('Please confirm the final destination.');
  await page.locator('[data-fcl-form="case-status"] select[name="status"]').selectOption('needs_input');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/case-status'));
  await page.locator('[data-fcl-form="case-status"] button[type="submit"]').click();
  const statusUpdated = await responseJson(await responsePromise);
  assert.equal(statusUpdated.status, 'success');
  const supplementExpectedVersion = statusUpdated.data.case_version;

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
  await diff.getByText('最终目的地', {exact: true}).waitFor();
  await diff.getByText('Montreal', {exact: true}).waitFor();
  await diff.getByText('柜型与柜数', {exact: true}).waitFor();
  await diff.getByText('电子邮箱', {exact: true}).waitFor();
  const supplementRequest = page.waitForRequest(request => request.url().endsWith('/inquiry/api/v1/fcl/supplement'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/inquiry/api/v1/fcl/supplement'));
  await page.locator('[data-fcl-supplement] button[type="submit"]').click();
  const supplementPayload = (await supplementRequest).postDataJSON();
  assert.ok(supplementPayload.fields.changes.length >= 10);
  assert.equal(supplementPayload.expected_version, supplementExpectedVersion);
  const supplemented = await responseJson(await responsePromise);
  assert.equal(supplemented.status, 'success');
  assert.equal(supplemented.data.case_version, supplementExpectedVersion + 1);
  checks.push('public supplement before/after and persisted customer event');

  await page.goto(`${base}/console/#fcl`, {waitUntil: 'networkidle'});
  await page.locator('.case-card').filter({hasText: firstInquiryNo}).click();
  await page.getByRole('heading', {name: '整柜报价', exact: true}).waitFor();
  await openCaseOperations(firstCaseId);
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
  await page.getByRole('button', {name: '新增一行', exact: true}).click();
  await page.locator('[data-ocean-index="0"][data-ocean-key="supplier_label"]').fill('Synthetic carrier');
  await page.locator('[data-ocean-index="0"][data-ocean-key="pol"]').fill('Yantian');
  await page.locator('[data-ocean-index="0"][data-ocean-key="pod"]').fill('Vancouver');
  await page.locator('[data-ocean-index="0"][data-ocean-key="valid_from"]').fill('2026-10-01');
  await page.locator('[data-ocean-index="0"][data-ocean-key="valid_until"]').fill('2026-10-31');
  await page.locator('[data-ocean-index="0"][data-ocean-key="price:40HQ"]').fill('3200');
  await page.locator('[data-action="ops-ocean-more"][data-index="0"]').click();
  await page.locator('[data-fcl-form="ops-ocean-advanced"] [name="source_ref"]').fill('synthetic:browser-rate');
  await page.locator('[data-fcl-form="ops-ocean-advanced"] [name="source_version"]').fill('v1');
  await page.locator('[data-fcl-form="ops-ocean-advanced"] button[type="submit"]').click();
  dialogMode = 'dismiss';
  await page.evaluate(() => { location.hash = 'fcl'; });
  await page.waitForFunction(() => location.hash === '#fcl/rates');
  assert.equal(await page.locator('[data-ocean-index="0"][data-ocean-key="price:40HQ"]').inputValue(), '3200');
  dialogMode = 'accept';
  await page.locator('[data-action="ops-preview-config"]').click();
  await page.getByText('请先保存或取消当前编辑。', {exact: true}).waitFor();
  assert.equal(await page.locator('[data-ocean-index="0"][data-ocean-key="price:40HQ"]').inputValue(), '3200');
  await page.getByRole('button', {name: '新增一行', exact: true}).click();
  await page.locator('[data-action="ops-ocean-disable"][data-index="1"]').click();
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-save'));
  await page.locator('[data-action="ops-save-config"]').click();
  const firstRateSave = await responseJson(await responsePromise);
  assert.equal(firstRateSave.status, 'success');
  assert.equal(firstRateSave.data.draft.rates.length, 1);
  assert.equal(firstRateSave.data.draft.rates[0].items[0].ocean_freight, '3200');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-preview'));
  await page.locator('[data-action="ops-preview-config"]').click();
  const preview = await responseJson(await responsePromise);
  assert.equal(preview.data.can_publish, true);
  await page.locator('#ops-config-confirm').check();
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-publish'));
  await page.locator('[data-action="ops-publish-config"]').click();
  const firstPublication = await responseJson(await responsePromise);
  assert.equal(firstPublication.status, 'success');
  await page.locator('[data-ocean-index="0"][data-ocean-key="price:40HQ"]').fill('3300');
  await openDetails(page.locator('details.ops-publication'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-save'));
  await page.locator('[data-action="ops-save-config"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  await openDetails(page.locator('details.ops-publication'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-preview'));
  await page.locator('[data-action="ops-preview-config"]').click();
  assert.equal((await responseJson(await responsePromise)).data.can_publish, true);
  await page.locator('#ops-config-confirm').check();
  responsePromise = page.waitForResponse(response => response.url().endsWith('/rate-publish'));
  await page.locator('[data-action="ops-publish-config"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  checks.push('rate draft save and publication');

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
  await page.locator('.case-card').filter({hasText: firstInquiryNo}).click();
  await page.getByRole('heading', {name: '整柜报价', exact: true}).waitFor();
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-match'));
  await openWorkspaceStep('quote');
  await page.locator('[data-action="fcl-match"]').click();
  const matched = await responseJson(await responsePromise);
  assert.equal(matched.status, 'success', JSON.stringify(matched));
  const sourceSellPrice = page.locator('[data-fcl-fee-row][data-source-kind="ocean_freight"] [name="sell_price"]').first();
  await sourceSellPrice.waitFor();
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-save'));
  await page.locator('[data-fcl-form="quote-save"] button[type="submit"]').click();
  const partial = await responseJson(await responsePromise);
  assert.equal(partial.status, 'needs_input');
  assert.equal(partial.data.version, 1);
  assert.equal(partial.data.current_version, 1);
  await page.reload({waitUntil: 'networkidle'});
  await openWorkspaceStep('quote');
  await page.locator('[data-fcl-fee-row][data-source-kind="ocean_freight"] [name="sell_price"]').first().fill('3500');
  await page.locator('[name="USD"]').fill('7.2');
  await page.locator('[data-fcl-form="quote-save"] [name="adjustment_reason"]').fill('Customer sell price confirmed.');
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
  await page.locator(`[data-fcl-quote-version="${partial.data.quote_ref}"]`).selectOption('1');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-get'));
  await page.locator('[data-action="fcl-quote-open-history"]').first().click();
  const oldQuote = await responseJson(await responsePromise);
  assert.ok(['success', 'manual_review'].includes(oldQuote.status));
  assert.equal(oldQuote.data.version, 1);
  await page.getByText('历史报价 v1', {exact: true}).waitFor();
  await openWorkspaceStep('quote');
  await page.getByRole('button', {name: '添加人工费用', exact: true}).click();
  assert.equal(await page.getByText('未分类', {exact: true}).count() > 0, true);
  const manualRow = page.locator('[data-fcl-fee-row][data-source-kind="manual"]').first();
  await manualRow.waitFor();
  assert.equal(await manualRow.locator('[name="cost_price"]').inputValue(), '');
  assert.equal(await manualRow.locator('[name="sell_price"]').inputValue(), '');
  const manualKey = await manualRow.getAttribute('data-key');
  assert.ok(manualKey);
  const manualDetails = page.locator(`[data-fcl-fee-detail][data-key="${manualKey}"]`);
  await manualDetails.locator('[name="group"]').selectOption('B');
  await manualDetails.locator('[name="service"]').selectOption('ocean_freight');
  await manualRow.locator('[name="fee_name"]').fill('Synthetic documentation fee');
  await manualRow.locator('[name="unit"]').selectOption('SHIPMENT');
  await manualRow.locator('[name="cost_price"]').fill('15');
  await manualRow.locator('[name="sell_price"]').fill('25');
  await manualRow.locator('[name="currency"]').selectOption('CAD');
  await manualDetails.locator('[name="evidence"]').fill('fixture:manual-documentation');
  await manualDetails.locator('[name="evidence_version"]').fill('v1');
  await manualDetails.locator('[name="quantity_conditions"]').fill('One confirmation cycle per shipment.');
  await manualDetails.locator('[name="customer_note"]').fill('Customer-visible documentation note.');
  await manualDetails.locator('[name="internal_note"]').fill('Internal documentation note.');
  await page.locator('[name="CAD"]').fill('5.2');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-save'));
  await page.locator('[data-fcl-form="quote-save"] button[type="submit"]').click();
  const addedQuote = await responseJson(await responsePromise);
  assert.equal(addedQuote.status, 'success');
  const addedRow = addedQuote.data.cost_rows.find(row => row.row_key === manualKey);
  assert.equal(addedRow.template_ref, null);
  assert.equal(addedRow.quantity_conditions, 'One confirmation cycle per shipment.');
  assert.equal(addedRow.customer_note, 'Customer-visible documentation note.');
  assert.equal(addedRow.internal_note, 'Internal documentation note.');
  assert.equal(addedRow.fully_priced, true);

  const persistedManual = page.locator(`[data-fcl-fee-row][data-key="${manualKey}"]`);
  await persistedManual.locator('[name="cost_price"]').fill('18');
  await persistedManual.locator('[name="sell_price"]').fill('30');
  await page.locator('[data-fcl-form="quote-save"] [name="adjustment_reason"]').fill('Correct the documentation fee.');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-save'));
  await page.locator('[data-fcl-form="quote-save"] button[type="submit"]').click();
  const editedQuote = await responseJson(await responsePromise);
  const editedRow = editedQuote.data.cost_rows.find(row => row.row_key === manualKey);
  assert.equal(editedQuote.status, 'success');
  assert.equal(editedRow.cost_price, '18');
  assert.equal(editedRow.sell_price, '30');
  assert.equal(editedRow.evidence_ref, 'fixture:manual-documentation');
  assert.equal(editedRow.evidence_version, 'v1');
  assert.equal(editedRow.quantity_conditions, 'One confirmation cycle per shipment.');
  assert.equal(editedRow.customer_note, 'Customer-visible documentation note.');
  assert.equal(editedRow.internal_note, 'Internal documentation note.');
  assert.equal(editedRow.cost_amount, '18.00');
  assert.equal(editedRow.fully_priced, true);

  await page.getByRole('button', {name: '添加人工费用', exact: true}).click();
  const unsavedManual = page.locator('[data-fcl-fee-row][data-source-kind="manual"]').last();
  const unsavedKey = await unsavedManual.getAttribute('data-key');
  await unsavedManual.locator('[data-action="fcl-fee-remove"]').click();
  assert.equal(await page.locator(`[data-fcl-fee-row][data-key="${unsavedKey}"]`).count(), 0);

  await page.setViewportSize({width: 390, height: 800});
  const mobileOverflow = await page.evaluate(() => {
    const table = document.querySelector('.ops-ticket-table-wrap');
    return {
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      tableClientWidth: table?.clientWidth ?? 0,
      tableScrollWidth: table?.scrollWidth ?? 0,
      tableOverflowX: table ? window.getComputedStyle(table).overflowX : '',
      rootOverflowX: window.getComputedStyle(document.documentElement).overflowX,
    };
  });
  assert.ok(mobileOverflow.pageWidth <= mobileOverflow.viewportWidth, JSON.stringify(mobileOverflow));
  assert.equal(mobileOverflow.tableOverflowX, 'auto');
  assert.ok(mobileOverflow.tableScrollWidth >= mobileOverflow.tableClientWidth, JSON.stringify(mobileOverflow));
  assert.notEqual(mobileOverflow.rootOverflowX, 'hidden');
  await page.setViewportSize({width: 1440, height: 1000});

  const persistedDelete = page.locator(`[data-fcl-fee-row][data-key="${manualKey}"] [data-action="fcl-fee-remove"]`);
  await persistedDelete.click();
  await page.locator('[data-fcl-form="quote-save"] [name="adjustment_reason"]').fill('Remove the documentation fee from this ticket.');
  const removalRequest = page.waitForRequest(request => request.url().endsWith('/quote-save'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-save'));
  await page.locator('[data-fcl-form="quote-save"] button[type="submit"]').click();
  const removalPayload = (await removalRequest).postDataJSON();
  const removalChange = removalPayload.input.extensions?.fcl_row_adjustments_v1?.changes?.find(change => change.row_key === manualKey);
  assert.deepEqual(removalChange, {row_key: manualKey, operation: 'remove', reason: 'Remove the documentation fee from this ticket.'});
  const removedQuote = await responseJson(await responsePromise);
  assert.equal(removedQuote.status, 'success');
  assert.equal(removedQuote.data.cost_rows.some(row => row.row_key === manualKey), false);
  checks.push('Web fee edit preserves evidence and notes; audited delete and local add/remove');

  await page.locator('[data-fcl-form="quote-save"] [name="adjustment_reason"]').fill('This draft is discarded on confirmed navigation.');
  dialogMode = 'accept';
  await page.evaluate(() => { location.hash = 'fcl/rates'; });
  await page.locator('.ops-ocean-table').waitFor();
  const reloadedQuoteAfterDiscard = page.waitForResponse(response => response.url().endsWith('/quote-get'));
  await page.evaluate(id => { location.hash = `fcl/case/${id}`; }, firstCaseId);
  await page.getByRole('heading', {name: '整柜报价', exact: true}).waitFor();
  await reloadedQuoteAfterDiscard;
  await openWorkspaceStep('quote');
  await openQuoteEditor();
  assert.equal(await page.locator('[data-fcl-form="quote-save"] [name="adjustment_reason"]').inputValue(), '');
  checks.push('confirmed dirty navigation discards FCL drafts');

  await openWorkspaceStep('documents');
  await page.locator('#fcl-doc-quote-no').fill('FCL-BROWSER-001');
  await page.locator('#fcl-doc-remark').fill('Document display edited before approval.');
  const documentSaveRequest = page.waitForRequest(request => request.url().endsWith('/document-save'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-save'));
  await openWorkspaceStep('documents');
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

  const resubmitRequest = page.waitForRequest(request => request.url().endsWith('/document-save'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-save'));
  await openWorkspaceStep('documents');
  await page.locator('[data-action="fcl-doc-save"]').click();
  assert.equal((await resubmitRequest).postDataJSON().operation, 'resubmit');
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-review'));
  await page.locator('[data-action="fcl-doc-review"]').click();
  const review = await responseJson(await responsePromise);
  assert.equal(review.status, 'success');
  await openWorkspaceStep('quote');
  await openQuoteEditor();
  await page.locator('[data-fcl-form="quote-save"] [name="adjustment_reason"]').fill('Quote edited after document review.');
  assert.equal(await page.locator('.fcl-workflow [data-step="documents"]').isDisabled(), true);
  await openWorkspaceStep('quote');
  const reviewInvalidationQuote = page.waitForRequest(request => request.url().endsWith('/quote-save'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/quote-save'));
  await page.locator('[data-fcl-form="quote-save"] button[type="submit"]').click();
  assert.equal((await reviewInvalidationQuote).postDataJSON().operation, 'update');
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-save'));
  await openWorkspaceStep('documents');
  await page.locator('[data-action="fcl-doc-save"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-review'));
  await page.locator('[data-action="fcl-doc-review"]').click();
  assert.equal((await responseJson(await responsePromise)).status, 'success');
  const relatedAfterApproval = page.waitForResponse(response => response.url().endsWith('/document-get'));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-approve'));
  await page.locator('[data-action="fcl-doc-approve"]').click();
  const approvedDocument = await responseJson(await responsePromise);
  assert.equal(approvedDocument.status, 'success');
  const approvedDocumentVersion = approvedDocument.data.version;
  await relatedAfterApproval;
  checks.push('document save/review, edit invalidation, refresh review and approval');
  const documentHistoryDetails = page.locator('details.panel', {hasText: '报价单历史'});
  await documentHistoryDetails.locator('summary').waitFor();
  await openDetails(documentHistoryDetails);
  const documentVersionSelect = page.locator(`[data-fcl-doc-version="${approvedDocument.data.document_id}"]`);
  await documentVersionSelect.selectOption('1');
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-get'));
  await page.locator('[data-action="fcl-doc-open-history"]').first().click();
  const oldDocument = await responseJson(await responsePromise);
  assert.equal(oldDocument.data.version, 1);
  assert.equal(oldDocument.data.historical, true);
  assert.equal(await page.locator('[data-action="fcl-doc-export-history"]').count() > 0, true);
  await openDetails(documentHistoryDetails);
  await documentVersionSelect.selectOption(String(approvedDocumentVersion));
  responsePromise = page.waitForResponse(response => response.url().endsWith('/document-get'));
  await page.locator('[data-action="fcl-doc-open-history"]').first().click();
  const currentDocument = await responseJson(await responsePromise);
  assert.equal(currentDocument.data.version, approvedDocumentVersion);
  assert.equal(currentDocument.data.state, 'approved');
  assert.equal(await page.locator('[data-action="fcl-handoff"]').isDisabled(), true);
  await page.getByText('请先导出并校验当前正式 PDF。', {exact: true}).waitFor();
  checks.push('quote and document version selectors read bounded old revisions');

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
    assert.equal(await page.locator('[data-action="fcl-handoff"]').isDisabled(), false);
    checks.push('formal PDF schema, hash, bytes, safe filename and browser download');

    await page.locator('[name="fcl-handoff-note"]').fill('Synthetic browser handoff.');
    let unknownHandoffRequest;
    let unknownHandoffData;
    let abortHandoffOnce = true;
    await page.route('**/console/api/v1/fcl/handoff-save', async route => {
      if (abortHandoffOnce) {
        abortHandoffOnce = false;
        unknownHandoffRequest = {body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key']};
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        unknownHandoffData = await response.json();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    const failedHandoffRequest = page.waitForEvent('requestfailed', {predicate: request => request.url().endsWith('/handoff-save')});
    await page.locator('[data-action="fcl-handoff"]').click();
    await failedHandoffRequest;
    await page.waitForFunction(() => document.querySelector('[data-action="fcl-handoff"]')?.disabled === false);
    await page.waitForFunction(() => document.querySelector('#notification')?.textContent?.trim().length > 0);
    assert.equal(await page.locator('[name="fcl-handoff-note"]').inputValue(), 'Synthetic browser handoff.');
    await page.unroute('**/console/api/v1/fcl/handoff-save');
    const retryHandoffRequest = page.waitForRequest(request => request.url().endsWith('/handoff-save'));
    responsePromise = page.waitForResponse(response => response.url().endsWith('/handoff-save'));
    await page.locator('[data-action="fcl-handoff"]').click();
    const retriedHandoffRequest = await retryHandoffRequest;
    assert.deepEqual(retriedHandoffRequest.postDataJSON(), unknownHandoffRequest.body);
    assert.equal(retriedHandoffRequest.headers()['idempotency-key'], unknownHandoffRequest.key);
    const handoff = await responseJson(await responsePromise);
    assert.equal(handoff.data.current?.request_digest, unknownHandoffData.data.current?.request_digest);
    assert.equal(handoff.status, 'success');
    assert.equal(handoff.data.status, 'handed_off');
    assert.equal(handoff.data.replay.replayed, true);
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
  assert.equal((await page.locator('.fcl-workbench').innerText()).includes(firstInquiryNo), false);
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
    body: (await page.locator('body').innerText().catch(() => '')).slice(0, 1200),
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
