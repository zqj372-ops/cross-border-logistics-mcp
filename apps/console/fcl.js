import { fclLabel, fclValue, fclEventMessage, displayMargin, fclIssue } from '../inquiry/fcl-presentation.ts';
import { fclHttpResponseSchemas } from '../../services/access-gateway/portal/fcl-http-contracts.ts';

const DOCUMENT_VERSION = 'fcl-document-workflow@2026-09-20.v1';
const QUOTE_VERSION = 'fcl-quote-workflow@2026-09-20.v1';
const HANDOFF_VERSION = 'fcl-handoff@2026-09-21.v1';
const NOTIFICATION_VERSION = 'fcl-notification@2026-09-21.v1';
const containerTypes = ['20GP', '40GP', '40HQ', '45HQ'];
const serviceLabels = {
  pickup: '中国提货',
  export_customs: '中国出口报关',
  ocean_freight: '海运干线',
  canada_customs: '加拿大清关',
  devanning_storage: '拆柜与仓储',
  delivery: '加拿大派送',
};

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export function nextQuoteOperation(quote) {
  return quote ? 'update' : 'create';
}

export function nextDocumentOperation(document) {
  if (!document) return 'create';
  if (document.state === 'draft') return 'refresh';
  if (document.state === 'rejected') return 'resubmit';
  return 're_quote';
}

export function quoteDraftFromView(view) {
  return {
    source_sell_prices: view.cost_rows.filter(row => row.source_kind !== 'manual').map(row => ({
      row_key: row.row_key,
      sell_price: row.sell_price,
      customer_note: row.customer_note,
    })),
    manual_fees: view.cost_rows.filter(row => row.source_kind === 'manual').map(row => ({
      id: row.row_key.startsWith('manual:') ? row.row_key.slice(7) : row.row_key,
      template_ref: row.template_ref,
      name: row.name,
      group: row.group,
      service: row.service,
      quantity: row.quantity,
      unit: row.unit,
      container_type: row.container_type,
      cost_price: row.cost_price,
      sell_price: row.sell_price,
      currency: row.currency,
      internal_note: row.internal_note,
      customer_note: row.customer_note,
      evidence_ref: row.evidence_ref,
      evidence_version: row.evidence_version,
      quantity_conditions: row.quantity_conditions,
    })),
    service_scopes: view.service_coverage
      .filter(row => ['included', 'free', 'out_of_scope'].includes(row.disposition))
      .map(row => ({ service: row.service, disposition: row.disposition, note: row.note, included_row_refs: row.included_row_refs })),
    exchange_rates: { ...view.exchange_rates },
    remark: view.remark,
  };
}

export function decodePdfBytes(value) {
  const binary = globalThis.atob(value.content_base64);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function verifyPdfOutput(value, cryptoApi = globalThis.crypto) {
  const bytes = decodePdfBytes(value);
  if (!value.filename.startsWith('fcl-') || !value.filename.endsWith('.pdf') || value.filename.includes('/') || value.filename.includes('\\')) {
    throw Object.assign(new Error('fcl_pdf_filename_invalid'), { code: 'fcl_pdf_filename_invalid' });
  }
  if (bytes.byteLength !== value.byte_length || bytes.byteLength < 100 || bytes.byteLength > 8 * 1024 * 1024 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    throw Object.assign(new Error('fcl_pdf_bytes_invalid'), { code: 'fcl_pdf_bytes_invalid' });
  }
  const digest = [...new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== value.sha256) throw Object.assign(new Error('fcl_pdf_hash_mismatch'), { code: 'fcl_pdf_hash_mismatch' });
  return bytes;
}

export function createFclWorkspace({api, mutate, model, esc, head, panel, empty, note, field, actions, formError, icon, rerender, notify}) {
  let epoch = 0, scope = '', activeRouteKey = '', cases = null, casesNextCursor = null, casesError = '', activeCaseId = '', detail = null, detailError = '', rateView = null, rateDraft = null, rateError = '', ratePreview = null, rateDirty = false, configView = null, notificationView = null, configError = '', issuerDraft = null, notificationDraft = null, issuerDirty = false, notificationDirty = false, message = '', matchResult = null, quoteView = null, quoteList = null, quoteHistoryView = null, quoteDraft = null, quoteDirty = false, editingQuoteRef = null, documentView = null, documentList = null, documentDisplayDraft = null, documentDisplayDirty = false, reviewView = null, handoffView = null, exportView = null, handoffDraft = '', handoffDirty = false, selectedRateId = null, relatedCaseId = '', caseStatusDraft = null, staffSupplementDraft = null, staffSupplementMessage = '', confirmReasonDraft = '', caseStatusDirty = false, staffSupplementDirty = false, confirmDirty = false, operationsOpen = false, loadingRelated = false;
  let workspaceStep = 'requirements';
  const isDirty = () => rateDirty || issuerDirty || notificationDirty || quoteDirty || documentDisplayDirty || caseStatusDirty || staffSupplementDirty || confirmDirty || handoffDirty;
  const discardDrafts = () => {
    rateDraft = clone(rateView?.draft) || rateDraft; rateDirty = false;
    issuerDraft = null; notificationDraft = null; issuerDirty = false; notificationDirty = false;
    matchResult = null; editingQuoteRef = null; quoteDraft = null; quoteDirty = false; reviewView = null; exportView = null;
    documentDisplayDraft = null; documentDisplayDirty = false;
    caseStatusDraft = null; staffSupplementDraft = null; staffSupplementMessage = ''; confirmReasonDraft = ''; caseStatusDirty = false; staffSupplementDirty = false; confirmDirty = false;
    handoffDraft = ''; handoffDirty = false;
  };
  const sync = () => {
    const current = JSON.stringify([model().sessionGeneration, model().session?.identity?.user_id, model().session?.organization_id, model().session?.fcl_capability?.fcl_personal]);
    if (current !== scope) { scope = current; reset(); }
  };
  const reset = () => {
    epoch += 1; activeRouteKey = ''; cases = null; casesNextCursor = null; casesError = ''; activeCaseId = ''; detail = null; detailError = ''; rateView = null; rateDraft = null; rateError = ''; ratePreview = null; rateDirty = false;
    configView = null; notificationView = null; configError = ''; issuerDraft = null; notificationDraft = null; issuerDirty = false; notificationDirty = false; message = ''; matchResult = null; quoteView = null; quoteList = null; quoteHistoryView = null; quoteDraft = null; quoteDirty = false; editingQuoteRef = null; documentView = null; documentList = null; documentDisplayDraft = null; documentDisplayDirty = false; reviewView = null; handoffView = null; exportView = null; handoffDraft = ''; handoffDirty = false; selectedRateId = null; relatedCaseId = ''; caseStatusDraft = null; staffSupplementDraft = null; staffSupplementMessage = ''; confirmReasonDraft = ''; caseStatusDirty = false; staffSupplementDirty = false; confirmDirty = false; operationsOpen = false; loadingRelated = false;
  };
  const clearCaseDependents = () => {
    matchResult = null; quoteView = null; quoteList = null; quoteHistoryView = null; quoteDraft = null; quoteDirty = false; editingQuoteRef = null; documentView = null; documentList = null; documentDisplayDraft = null; documentDisplayDirty = false; reviewView = null; handoffView = null; exportView = null; handoffDraft = ''; handoffDirty = false; selectedRateId = null; relatedCaseId = ''; caseStatusDraft = null; staffSupplementDraft = null; staffSupplementMessage = ''; confirmReasonDraft = ''; caseStatusDirty = false; staffSupplementDirty = false; confirmDirty = false; operationsOpen = false; loadingRelated = false;
  };
  const resetCaseWorkspace = () => {
    detail = null; detailError = ''; clearCaseDependents(); message = '';
  };
  const selectCase = (id) => {
    if (activeCaseId === id) return;
    epoch += 1; activeCaseId = id; workspaceStep = 'requirements'; resetCaseWorkspace();
  };
  const requestRelatedRefresh = () => { relatedCaseId = ''; loadingRelated = false; };
  const hasCapability = () => model().session?.fcl_capability?.fcl_personal === true;
  const route = () => {
    const parts = location.hash.slice(1).split('/');
    return { page: parts[0] || 'fcl', action: parts[1] || '', id: parts[2] || '' };
  };
  const syncRoute = () => {
    const current = route(), key = `${current.page}/${current.action}/${current.id}`;
    if (key === activeRouteKey) return current;
    const leftCase = activeRouteKey.startsWith('fcl/case/');
    activeRouteKey = key;
    message = '';
    if (leftCase || current.action !== 'case') {
      epoch += 1;
      relatedCaseId = '';
      loadingRelated = false;
      if (current.action !== 'case') { detail = null; detailError = ''; }
    }
    return current;
  };
  const validateResponse = (action, value) => {
    const parsed = fclHttpResponseSchemas[action].safeParse(value);
    if (!parsed.success) throw Object.assign(new Error('fcl_response_invalid'), { code: 'fcl_response_invalid' });
    return parsed.data;
  };
  const call = async (action, body, method = 'POST', query = '') => {
    const result = await api(`/fcl/${action}${query}`, { method, ...(method === 'GET' ? {} : { body }), acceptBusiness: true });
    return validateResponse(action, result);
  };
  const write = async (action, body) => {
    const result = await mutate(`/fcl/${action}`, 'POST', body, { acceptBusiness: true });
    return validateResponse(action, result);
  };
  const valueField = (title, id, value = '', attributes = '') => {
    const match = /\bname="([^"]+)"/u.exec(attributes);
    const name = match?.[1] || id;
    const cleaned = attributes.replace(/\s*name="[^"]*"/gu, '');
    return field(title, id, `<input id="${id}" name="${esc(name)}" value="${esc(value ?? '')}" ${cleaned}>`);
  };
  const fclError = (error) => error?.code ? `${fclIssue(error.code) === error.code ? '操作暂未完成，请核对资料或稍后重试' : fclIssue(error.code)}（${error.code}）` : error?.message || '个人 FCL 服务暂时不可用。';
  const downloadPdf = (bytes, filename) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const blankQuoteDraft = (selected) => {
    const containers = new Set((detail?.current_input.containers || []).flatMap(container => container.quantity === null ? [] : [container.type]));
    const services = new Set(detail?.current_input.selected_services || []);
    return {
      source_sell_prices: [
        ...selected.rate.items.filter(item => containers.has(item.container_type)).map(item => ({ row_key: `ocean_freight:${item.container_type}`, sell_price: null, customer_note: null })),
        ...(selected.rate.additional_fees || []).flatMap((fee, index) => {
          if (!services.has(fee.service)) return [];
          if (fee.unit === 'CNTR' && (!fee.container_type || !containers.has(fee.container_type))) return [];
          return [{ row_key: `rate_fee:${index}:${fee.service}:${fee.unit}:${fee.container_type ?? 'shipment'}`, sell_price: null, customer_note: null }];
        }),
      ],
      manual_fees: [],
      service_scopes: [],
      exchange_rates: { USD: null, CAD: null },
      remark: null,
    };
  };
  const blankManualFee = () => ({ id: crypto.randomUUID(), template_ref: null, name: '', group: 'C', service: detail?.current_input?.selected_services?.[0] || 'delivery', quantity: '1', unit: 'SHIPMENT', container_type: null, cost_price: null, sell_price: null, currency: 'CAD', internal_note: null, customer_note: null, evidence_ref: null, evidence_version: null, quantity_conditions: null });

  const loadCases = async (cursor = null, append = false) => {
    if (!append && (cases || casesError)) return;
    const e = epoch;
    try {
      const query = `?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await call('case-list', null, 'GET', query);
      if (e !== epoch) return;
      if (response.data) {
        cases = append && cases ? { items: [...cases.items, ...response.data.items], next_cursor: response.data.next_cursor } : response.data;
        casesNextCursor = response.data.next_cursor;
        casesError = '';
      } else if (!append || !cases) casesError = response.reason_codes?.[0] || 'fcl_unavailable';
      else message = responseMessage(response, '', '');
    } catch (error) { if (e === epoch) { if (append && cases) message = fclError(error); else casesError = error.code || 'network'; } }
    if (e === epoch) rerender();
  };
  const loadDetail = async (id) => {
    if (detail?.case_id === id) return;
    const e = epoch;
    detailError = '';
    try {
      const response = await call('case-get', { case_id: id });
      if (e !== epoch || activeCaseId !== id) return;
      if (response.data) detail = response.data; else detailError = response.reason_codes?.[0] || 'fcl_not_found';
    } catch (error) { if (e === epoch && activeCaseId === id) detailError = error.code || 'network'; }
    if (e === epoch && activeCaseId === id) rerender();
  };
  const loadRelated = async (id) => {
    if ((relatedCaseId === id && !loadingRelated) || loadingRelated) return;
    relatedCaseId = id; loadingRelated = true;
    const e = epoch;
    try {
      const [quotes, documents, handoff] = await Promise.all([
        call('quote-list', { contract_version: DOCUMENT_VERSION, case_ref: id, limit: 100, cursor: null }),
        call('document-list', { contract_version: DOCUMENT_VERSION, case_ref: id, limit: 100, cursor: null }),
        call('handoff-get', { contract_version: HANDOFF_VERSION, case_ref: id }),
      ]);
      if (e !== epoch || activeCaseId !== id) return;
      if (quotes.data) {
        quoteList = quotes.data;
        const latest = quotes.data.items?.[0];
        if (latest) {
          const value = await call('quote-get', { contract_version: DOCUMENT_VERSION, quote_ref: latest.quote_ref, version: null });
          if (e !== epoch || activeCaseId !== id) return;
          if (value.data && !quoteDraft) quoteView = value.data;
        }
      }
      if (documents.data) {
        documentList = documents.data;
        const latest = documents.data.items?.[0];
        if (latest) {
          const value = await call('document-get', { contract_version: DOCUMENT_VERSION, document_id: latest.document_id, version: null });
          if (e !== epoch || activeCaseId !== id) return;
          if (value.data) documentView = value.data;
        }
      }
      if (handoff.data) handoffView = handoff.data;
      if ([quotes.status, documents.status, handoff.status].some(status => status !== 'success')) message = '部分 FCL 业务数据需要人工复核，已保留可读版本。';
      await loadConfig();
    } catch (error) {
      if (e === epoch && activeCaseId === id) { message = fclError(error); relatedCaseId = ''; }
    } finally { if (e === epoch && activeCaseId === id) { loadingRelated = false; rerender(); } }
  };
  const loadRate = async () => {
    if (rateView && !rateError) return;
    const e = epoch;
    rateError = '';
    try {
      const response = await call('rate-get', null, 'GET');
      if (e !== epoch) return;
      if (response.status === 'success') { rateView = response.data; rateDraft = clone(response.data.draft) || { contract_version: 'fcl-rate-dataset@2026-09-20.v1', label: '个人 FCL 运价', rates: [] }; }
      else rateError = response.reason_codes?.[0] || 'fcl_unavailable';
    } catch (error) { if (e === epoch) rateError = error.code || 'network'; }
    if (e === epoch) rerender();
  };
  const loadConfig = async () => {
    if (configView && notificationView) return;
    const e = epoch;
    configError = '';
    try {
      const [config, notification] = await Promise.all([call('issuer-config', null, 'GET'), call('notification-get', null, 'GET')]);
      if (e !== epoch) return;
      if (config.data) configView = config.data;
      if (notification.data) notificationView = notification.data;
      if (!config.data || !notification.data) configError = config.reason_codes?.[0] || notification.reason_codes?.[0] || 'fcl_unavailable';
    } catch (error) { if (e === epoch) configError = error.code || 'network'; }
    if (e === epoch) rerender();
  };

  const statusLabel = fclLabel;
  const caseCard = (item) => `<a class="case-card" href="#fcl/case/${encodeURIComponent(item.case_id)}"><span class="case-card-icon">${icon('container')}</span><div class="case-card-body"><div class="case-card-top"><h2>${esc(item.inquiry_no || 'FCL 询价')}</h2><span class="badge ${item.case_status === 'needs_input' ? 'warning' : ''}">${esc(statusLabel(item.case_status))}</span></div><p>${esc([item.current_input.pol, item.current_input.pod].filter(Boolean).join(' → ') || '线路待确认')}</p><div class="case-meta"><span>需求第 ${item.case_version} 版</span><span>${item.review_context?.review_required ? '待重新核对' : '已确认需求'}</span></div></div><span class="case-arrow" aria-hidden="true">${icon('arrow')}</span></a>`;
  const listPage = () => {
    void loadCases();
    const heading = head('整柜询价', '从客户需求到正式报价，在这里完成每一票的处理。', '<a class="button primary" href="/inquiry/">客户询价入口</a>');
    if (!cases && !casesError) return heading + '<p role="status">正在读取受理列表…</p>';
    if (casesError) return heading + note(fclError({code: casesError}), 'error');
    return heading + (cases.items.length ? `<div class="case-list">${cases.items.map(caseCard).join('')}</div>${casesNextCursor ? '<div class="head-actions"><button type="button" class="button" data-action="fcl-cases-more">加载更多询价</button></div>' : ''}` : empty('还没有 FCL 询价', '公开询价保存后会出现在这里。'));
  };

  const staffSupplementFields = (inputValue) => `<div class="field-grid">${valueField('中国起运城市', 'fcl-origin-city', inputValue.origin_city || '', 'name="origin_city"')}${valueField('起运港（POL）', 'fcl-pol', inputValue.pol || '', 'name="pol"')}</div><div class="field-grid">${valueField('目的港（POD）', 'fcl-pod', inputValue.pod || '', 'name="pod"')}${valueField('最终目的地', 'fcl-final', inputValue.final_destination || '', 'name="final_destination"')}</div><fieldset class="fcl-container-grid"><legend>柜型与柜数</legend>${containerTypes.map(type => { const row = inputValue.containers.find(item => item.type === type); return `<div class="fcl-container-row"><label for="fcl-container-${type}">${type}</label><label class="check-row"><input type="checkbox" name="container-pending-${type}"${row?.quantity === null ? ' checked' : ''}>柜数待确认</label><input id="fcl-container-${type}" name="container-${type}" type="number" min="1" max="9999" step="1" value="${row?.quantity ?? ''}" aria-label="${type}柜数"></div>`; }).join('')}</fieldset><div class="field-grid">${valueField('货物品名', 'fcl-cargo-name', inputValue.cargo_name || '', 'name="cargo_name"')}${field('货物属性', 'fcl-cargo-type', `<select id="fcl-cargo-type" name="cargo_type"><option value="">待确认</option>${['general','battery','liquid_powder','wood','regulated','other'].map(value => `<option value="${value}"${inputValue.cargo_type === value ? ' selected' : ''}>${fclLabel(value)}</option>`).join('')}</select>`)}</div><div class="field-grid">${valueField('预计毛重 kg', 'fcl-weight', inputValue.estimated_weight?.value || '', 'name="estimated_weight" inputmode="decimal"')}${valueField('备货日期', 'fcl-ready', inputValue.cargo_ready_date || '', 'name="cargo_ready_date" type="date"')}</div><div class="field-grid">${field('贸易条款', 'fcl-incoterm', `<select id="fcl-incoterm" name="incoterm"><option value="">待确认</option>${['EXW','FOB','CIF','DDU','DDP','Other'].map(value => `<option value="${value}"${inputValue.incoterm === value ? ' selected' : ''}>${value}</option>`).join('')}</select>`)}${valueField('其他条款说明', 'fcl-incoterm-other', inputValue.incoterm_other || '', 'name="incoterm_other"')}</div><fieldset class="fcl-service-grid"><legend>服务范围</legend>${Object.entries(serviceLabels).map(([id, label]) => `<label class="check-row"><input type="checkbox" name="service" value="${id}"${inputValue.selected_services?.includes(id) ? ' checked' : ''}>${label}</label>`).join('')}</fieldset><div class="field-grid">${valueField('联系人', 'fcl-contact-name', inputValue.contact?.name || '', 'name="contact.name"')}${valueField('邮箱', 'fcl-contact-email', inputValue.contact?.email || '', 'name="contact.email" type="email"')}</div><div class="field-grid">${valueField('公司', 'fcl-contact-company', inputValue.contact?.company || '', 'name="contact.company"')}${valueField('电话', 'fcl-contact-phone', inputValue.contact?.phone || '', 'name="contact.phone"')}</div><div class="field"><label for="fcl-notes">补充说明</label><textarea id="fcl-notes" name="notes" rows="3" maxlength="4000">${esc(inputValue.notes || '')}</textarea></div>`;

  const captureStaffSupplement = (form) => {
    const data = new FormData(form);
    const value = (name) => String(data.get(name) ?? '').trim() || null;
    const weight = value('estimated_weight');
    return {
      origin_city: value('origin_city'),
      pol: value('pol'),
      pod: value('pod'),
      final_destination: value('final_destination'),
      containers: containerTypes.flatMap(type => {
        const raw = String(data.get(`container-${type}`) ?? '').trim();
        const pending = data.get(`container-pending-${type}`) === 'on';
        if (!pending && raw === '') return [];
        const parsed = Number(raw);
        return [{ type, quantity: pending ? null : Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 9999 ? parsed : 0 }];
      }),
      cargo_name: value('cargo_name'),
      cargo_type: value('cargo_type'),
      estimated_weight: weight ? { value: weight, unit: 'kg' } : null,
      cargo_ready_date: value('cargo_ready_date'),
      incoterm: value('incoterm'),
      incoterm_other: value('incoterm_other'),
      selected_services: [...form.querySelectorAll('input[name="service"]:checked')].map(element => element.value),
      contact: {
        name: value('contact.name'),
        email: value('contact.email'),
        company: value('contact.company'),
        phone: value('contact.phone'),
      },
      notes: value('notes'),
    };
  };

  const eventDiff = (event) => {
    if (!['fcl_customer_supplement','fcl_staff_supplement'].includes(event.kind)) return '';
    const changes = event.payload?.field_changes || [];
    if (!changes.length) return '';
    return `<details class="case-diff"><summary>查看 ${changes.length} 项资料变更</summary><dl>${changes.map(change => `<div><dt>${esc(fclLabel(change.field))}</dt><dd><span>变更前：${esc(fclValue(change.field, change.before))}</span><span>变更后：${esc(fclValue(change.field, change.after))}</span></dd></div>`).join('')}</dl></details>`;
  };
  const inquiryReadonlySummary = (value) => `<dl class="case-details"><div><dt>起运城市</dt><dd>${esc(value.origin_city || '待确认')}</dd></div><div><dt>起运港（POL）</dt><dd>${esc(value.pol || '待确认')}</dd></div><div><dt>目的港（POD）</dt><dd>${esc(value.pod || '待确认')}</dd></div><div><dt>最终目的地</dt><dd>${esc(value.final_destination || '待确认')}</dd></div><div><dt>柜型</dt><dd>${esc(value.containers.map(item=>`${item.type} × ${item.quantity ?? '待确认'}`).join('、') || '待确认')}</dd></div><div><dt>货物</dt><dd>${esc(value.cargo_name || '待确认')} · ${esc(value.cargo_type ? fclLabel(value.cargo_type) : '属性待确认')} · ${esc(value.estimated_weight ? `${value.estimated_weight.value} ${value.estimated_weight.unit}` : '重量待确认')}</dd></div><div><dt>备货日期 / 贸易条款</dt><dd>${esc(value.cargo_ready_date || '待确认')} · ${esc(value.incoterm || '待确认')}${value.incoterm_other ? ` · ${esc(value.incoterm_other)}` : ''}</dd></div><div><dt>服务</dt><dd>${esc(value.selected_services.map(id=>serviceLabels[id]||id).join('、') || '待确认')}</dd></div><div><dt>联系人</dt><dd>${esc(value.contact.name || '待确认')} · ${esc(value.contact.company || '公司待确认')}</dd></div><div><dt>邮箱</dt><dd>${esc(value.contact.email || '待确认')}</dd></div><div><dt>电话</dt><dd>${esc(value.contact.phone || '待确认')}</dd></div><div><dt>说明</dt><dd>${esc(value.notes || '无')}</dd></div></dl>`;

  const detailPage = (id) => {
    selectCase(id);
    void loadDetail(id);
    void loadRate();
    if (detail?.case_id === id && activeCaseId === id) void loadRelated(id);
    let heading = head('整柜报价', detail ? `${detail.inquiry_no} · 需求第 ${detail.case_version} 版` : '正在读取询价需求', `<a class="button" href="#fcl">返回询价列表</a>`);
    if (detailError) return heading + note(fclError({code: detailError}), 'error');
    if (!detail) return heading + '<p role="status">正在读取询价…</p>';
    const inputValue = detail.current_input, originalValue = detail.original_input;
    const ended = ['closed', 'cancelled'].includes(detail.case_status);
    const events = detail.events || [];
    const eventRows = events.map(event => `<li><div class="case-event-head"><strong>${esc(fclLabel(event.kind))}</strong><time>${esc(new Date(event.created_at).toLocaleString('zh-CN'))}</time></div><p>${esc(fclEventMessage(event.message))}</p><small>${esc(fclLabel(event.actor_kind))} · ${event.visibility === 'customer' ? '客户可见' : '仅内部可见'}</small>${eventDiff(event)}</li>`).join('');
    const statusDraft = caseStatusDraft || { status: 'in_review', public_note: '', internal_note: '' };
    const statusForm = `<form data-fcl-form="case-status" data-case="${esc(id)}" data-version="${detail.case_version}">${formError}<h3>需求状态</h3><div class="field-grid">${field('状态', 'fcl-status', `<select id="fcl-status" name="status">${[['in_review','处理中'],['needs_input','要求客户补充'],['closed','关闭'],['cancelled','取消']].map(([value, label]) => `<option value="${value}"${statusDraft.status === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`)}${field('客户可见说明', 'fcl-public-note', `<textarea id="fcl-public-note" name="public_note" rows="3" required maxlength="2000">${esc(statusDraft.public_note || '')}</textarea>`)}</div>${field('内部备注', 'fcl-internal-note', `<textarea id="fcl-internal-note" name="internal_note" rows="2" maxlength="2000">${esc(statusDraft.internal_note || '')}</textarea>`)}${actions('保存处理状态')}</form>`;
    const supplementValue = staffSupplementDraft ? { ...inputValue, ...staffSupplementDraft, contact: { ...inputValue.contact, ...staffSupplementDraft.contact } } : inputValue;
    const supplementForm = `<form data-fcl-form="staff-supplement" data-case="${esc(id)}" data-version="${detail.case_version}">${formError}<h3>补充或修改资料</h3><p>填写与客户确认后的资料，修改前后的内容都会保留。</p>${staffSupplementFields(supplementValue)}<div class="field"><label for="fcl-supplement-message">说明</label><textarea id="fcl-supplement-message" name="message" rows="3" maxlength="2000" placeholder="说明线下确认来源">${esc(staffSupplementMessage)}</textarea></div>${actions('保存补充资料')}</form>`;
    const confirmForm = `<form class="panel" data-fcl-form="case-confirm" data-case="${esc(id)}" data-version="${detail.case_version}" data-ref="${esc(detail.review_context.latest_customer_supplement_ref || '')}"><div class="panel-body">${formError}<h2>核对确认</h2><p>请核对客户的线路、柜量、货物和服务。确认后即可开始报价。</p><div class="field"><label for="fcl-confirm-reason">核对说明</label><textarea id="fcl-confirm-reason" name="reason" rows="3" required maxlength="2000">${esc(confirmReasonDraft)}</textarea></div>${actions('确认当前需求')}</div></form>`;
    const showOperations = operationsOpen || Boolean(caseStatusDraft || staffSupplementDraft || caseStatusDirty || staffSupplementDirty || staffSupplementMessage);
    const steps = [
      ['requirements', '确认需求', ended ? fclLabel(detail.case_status) : detail.review_context.review_required ? '待核对' : '已确认'],
      ['quote', '填写报价', quoteDirty ? '有未保存修改' : quoteView ? (quoteView.completeness.complete ? '已保存' : '待补费用') : '待报价'],
      ['documents', '审核与导出', quoteDirty || documentDisplayDirty ? '有未保存修改' : documentView ? (documentView.currentness.valid_now ? fclLabel(documentView.state) : '待重新核对') : '待生成'],
    ];
    const brief = `<section class="fcl-route-brief" aria-label="本票概况"><div><span class="fcl-eyebrow">中国 → 加拿大 · 整柜海运</span><h2>${esc(inputValue.pol || '起运港待确认')} <span aria-hidden="true">→</span> ${esc(inputValue.pod || '目的港待确认')}</h2></div><div><span>柜型与柜数</span><strong>${esc(inputValue.containers.map(row => `${row.type} × ${row.quantity ?? '待确认'}`).join('、') || '待确认')}</strong></div><div><span>备货日期</span><strong>${esc(inputValue.cargo_ready_date || '待确认')}</strong></div><span class="badge ${detail.case_status === 'needs_input' ? 'warning' : ''}">${esc(fclLabel(detail.case_status))}</span></section>`;
    const navigation = `<nav class="fcl-workflow" aria-label="报价处理步骤">${steps.map(([key, label, state], index) => `<button type="button" data-action="fcl-workspace-step" data-step="${key}" aria-controls="fcl-step-${key}"${workspaceStep === key ? ' aria-current="step"' : ''}><span class="fcl-step-index">${index + 1}</span><span><strong>${label}</strong><small>${state}</small></span></button>`).join('')}</nav>`;
    const requirements = `<section id="fcl-step-requirements"${workspaceStep !== 'requirements' ? ' hidden' : ''}><div class="fcl-review-layout"><div>${panel('客户需求', '核对这份资料后，再选择运价并填写客户售价。', `<div class="panel-body">${inquiryReadonlySummary(inputValue)}</div>`)}${ended ? '' : `<details class="panel fcl-operations"${showOperations ? ' open' : ''}><summary>补充资料与处理状态</summary><div class="panel-body">${statusForm}${supplementForm}</div></details>`}</div><aside>${ended ? '<section class="panel"><div class="panel-body"><h2>本票已结束</h2><p>历史需求、报价与文件均已保留。本票不能继续修改，如有新的运输需求，请重新提交询价。</p></div></section>' : detail.review_context.review_required ? confirmForm : `<section class="panel fcl-next-action"><div class="panel-body"><span class="fcl-eyebrow">需求已确认</span><h2>可以开始报价了</h2><p>选择本票适用的运价，填写客户售价与其他费用。</p><button class="button primary" data-action="fcl-workspace-step" data-step="quote">前往填写报价 ${icon('arrow')}</button></div></section>`}<details class="panel"><summary>客户首次提交的资料</summary><div class="panel-body">${inquiryReadonlySummary(originalValue)}</div></details><details class="panel"><summary>处理记录 · ${events.length}</summary><ol class="case-timeline">${eventRows}</ol></details></aside></div></section>`;
    const quote = `<section id="fcl-step-quote"${workspaceStep !== 'quote' ? ' hidden' : ''}><div class="fcl-quote-layout"><div>${quoteInputPanel(id)}</div><aside>${quoteResultPanel()}<section class="panel fcl-next-action"><div class="panel-body"><h3>${ended ? '历史报价单' : '下一步：生成报价单'}</h3><p>${ended ? '已出具的报价单与审核记录仍可查看。' : '保存报价后，核对客户金额并审核，再导出正式文件。'}</p><button class="button" data-action="fcl-workspace-step" data-step="documents">前往审核与导出 ${icon('arrow')}</button></div></section></aside></div>${quoteHistorySnapshot()}${quoteHistoryPanel()}</section>`;
    const documents = `<section id="fcl-step-documents"${workspaceStep !== 'documents' ? ' hidden' : ''}><div class="fcl-review-layout"><div>${panel('报价单与审核', '先核对客户看到的金额、条款与有效期，再确认审核。', `<div class="panel-body">${quoteView ? `<div class="fcl-document-status"><strong>${documentView ? (documentView.currentness.valid_now ? fclLabel(documentView.state) : '需要重新生成或核对') : '待生成报价单'}</strong><span>报价第 ${quoteView.version} 版${documentView ? ` · 报价单第 ${documentView.version} 版` : ''}</span></div>${ended ? '<p>本票已结束。可以在下方查看报价单快照，或从历史记录下载已经生成的文件。</p>' : `${documentDisplayForm()}${reviewPanel()}${documentActions()}`}` : '<div class="fcl-empty"><h3>请先保存一份报价</h3><p>填写成本与售价并保存后，就可以在这里生成和审核报价单。</p><button class="button primary" data-action="fcl-workspace-step" data-step="quote">前往填写报价</button></div>'}</div>`)}${documentSnapshotPanel()}${documentHistoryPanel()}</div><aside>${handoffPanel()}</aside></div></section>`;
    return heading + messageNote() + brief + navigation + requirements + quote + documents;

  };

  const messageNote = () => message ? note(message) : '';
  const matchedSelected = () => {
    const matched = matchResult?.data?.selected;
    if (matched) return matched;
    return editingQuoteRef && quoteView?.quote_ref === editingQuoteRef ? quoteView.source_snapshot : null;
  };
  const beginQuoteEdit = () => {
    if (!quoteView) return;
    editingQuoteRef = quoteView.quote_ref;
    quoteDraft = quoteDraftFromView(quoteView);
    matchResult = {
      status: 'success',
      data: {
        candidates: [quoteView.source_snapshot],
        selected: quoteView.source_snapshot,
      },
      reason_codes: [],
    };
  };
  const quoteInputPanel = (id) => {
    if (!detail) return '';
    if (quoteView && !quoteDraft && !matchResult) {
      const source = quoteView.source_snapshot;
      return panel('已保存的报价', '核对费用明细，或继续编辑售价与服务范围。', `<div class="panel-body"><div class="fcl-source-selected">运价来源：${esc(source.rate.supplier_label)} · ${esc(source.valid_from)} 至 ${esc(source.valid_until)}</div><div class="fcl-saved-fees">${quoteView.cost_rows.map(row => `<article><div><strong>${esc(row.source_kind === 'ocean_freight' ? `${row.container_type || ''} 海运费` : row.name)}</strong><small>${esc(row.quantity)} ${esc(fclLabel(row.unit))} · ${esc(row.currency)}</small></div><dl><div><dt>成本单价</dt><dd>${esc(row.cost_price ?? '待补')}</dd></div><div><dt>客户单价</dt><dd>${esc(row.sell_price ?? '待补')}</dd></div><div><dt>客户合计</dt><dd>${esc(row.sell_amount ?? '待补')}</dd></div></dl>${row.customer_note ? `<p>${esc(row.customer_note)}</p>` : ''}</article>`).join('')}</div><div class="head-actions">${quoteView.currentness.valid_now ? '<button class="button primary" data-action="fcl-edit-quote">继续编辑此报价</button>' : ''}<button class="button" data-action="fcl-match" data-id="${esc(id)}"${detail.review_context.review_required ? ' disabled' : ''}>重新选择运价</button><a class="button" href="#fcl/rates">管理运价</a></div></div>`);
    }
    const matchButton = `<button class="button primary" data-action="fcl-match" data-id="${esc(id)}" ${detail.review_context.review_required ? 'disabled' : ''}>查找适用运价</button>`;
    let body = `<p>按本票线路、柜型和备货日期查找可用运价。多个来源时，请选择实际采用的一项。</p><div class="head-actions">${matchButton}<a class="button" href="#fcl/rates">管理运价</a></div>`;
    if (matchResult) {
      if (matchResult.status === 'manual_review') body += note(`匹配需要人工选择：${matchResult.reason_codes.map(fclIssue).join('、')}`, 'warning');
      if (matchResult.status === 'success') body += `<p class="fcl-source-selected">已选择：${esc(matchResult.data.selected?.rate.supplier_label || '运价来源')} · 有效期至 ${esc(matchResult.data.selected?.valid_until || '')}</p>`;
      if (matchResult.data?.candidates?.length) body += `<div class="table-wrap"><table><thead><tr><th>选择</th><th>来源</th><th>运输线路</th><th>柜型价</th></tr></thead><tbody>${matchResult.data.candidates.map(candidate => `<tr><td><input type="radio" aria-label="选择 ${esc(candidate.rate.supplier_label)}" name="fcl-rate-candidate" value="${esc(candidate.rate_id)}"${selectedRateId === candidate.rate_id ? ' checked' : ''}></td><td>${esc(candidate.rate.supplier_label)}<small>${esc(candidate.source_ref)}</small></td><td>${esc(candidate.rate.pol)} → ${esc(candidate.rate.pod)}</td><td>${esc(candidate.rate.items.map(item => `${item.container_type} · ${item.ocean_freight} ${item.currency}/柜`).join(' / '))}</td></tr>`).join('')}</tbody></table></div><button class="button" data-action="fcl-select-candidate">使用所选来源</button>`;
    }
    const selected = matchedSelected();
    if (selected && (quoteDraft || matchResult?.status === 'success')) body += quoteEditor(selected);
    else body += '<p class="muted">请先选择适用运价。保存报价后，可查看成本、销售额和毛利。</p>';
    return panel('成本与客户售价', '选择已核验的运价，再填写售价、其他费用与服务说明。', `<div class="panel-body">${body}</div>`);
  };
  const manualTemplateRefs = () => {
    const selection = configView?.input?.standard_fee_template_v1;
    const configured = (selection?.items || []).map(item => ({ template_id: selection.template_id, template_version: selection.template_version, item_key: item.item_key, name: item.name }));
    const catalog = configView?.catalog?.groups?.flatMap(group => group.items.map(item => ({ template_id: configView.catalog.template_id, template_version: configView.catalog.template_version, item_key: item.item_key, name: item.name }))) || [];
    const values = configured.length ? configured : catalog;
    return values.filter((item, index) => values.findIndex(candidate => candidate.item_key === item.item_key && candidate.template_id === item.template_id && candidate.template_version === item.template_version) === index);
  };
  const manualTemplateSelect = (fee, index) => {
    const refs = manualTemplateRefs();
    const current = fee.template_ref ? JSON.stringify(fee.template_ref) : '';
    const saved = fee.template_ref && !refs.some(ref => JSON.stringify({ template_id: ref.template_id, template_version: ref.template_version, item_key: ref.item_key }) === current)
      ? `<option value="${esc(current)}" selected>${esc(fee.template_ref.item_key)}</option>` : '';
    return field('标准费用项目', `fcl-manual-template-${index}`, `<select id="fcl-manual-template-${index}" name="template_ref"><option value="">不引用</option>${saved}${refs.map(ref => { const value = JSON.stringify({ template_id: ref.template_id, template_version: ref.template_version, item_key: ref.item_key }); return `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(ref.name || ref.item_key)}</option>`; }).join('')}</select>`);
  };
  const quoteHistoryPanel = () => {
    if (!quoteList?.items?.length) return '';
    return `<details class="panel"><summary>报价历史（${quoteList.items.length}）</summary><div class="panel-body">${quoteList.items.map(item => { const versions = Array.from({length:Math.min(item.current_version,1000)},(_,index)=>index+1); return `<div class="field-grid"><div><strong>v${item.version}</strong><small>${item.complete ? '完整' : '待补'} · ${item.currentness.valid_now ? '当前有效' : '需要重新核对'} · ${esc(item.created_at)}</small></div><div class="field"><label for="fcl-quote-version-${esc(item.quote_ref)}">查看版本</label><select id="fcl-quote-version-${esc(item.quote_ref)}" data-fcl-quote-version="${esc(item.quote_ref)}">${versions.map(version=>`<option value="${version}"${version===item.version?' selected':''}>v${version}</option>`).join('')}</select></div><button class="button" data-action="fcl-quote-open-history" data-quote="${esc(item.quote_ref)}" data-version="${item.version}">读取</button></div>`; }).join('')}</div></details>`;
  };
  const quoteHistorySnapshot = () => {
    if (!quoteHistoryView) return '';
    const scope = quoteHistoryView.service_coverage.map(row => `${serviceLabels[row.service] || row.service}:${row.disposition === 'pending' ? '待补费用' : fclLabel(row.disposition)}`).join('、');
    return `<section class="panel"><div class="panel-body"><h3>历史报价 v${quoteHistoryView.version}</h3><dl class="case-details"><div><dt>Case</dt><dd>${esc(quoteHistoryView.case_binding.case_ref)} v${quoteHistoryView.case_binding.case_version}</dd></div><div><dt>客户范围</dt><dd>${esc(scope || '待确认')}</dd></div><div><dt>服务覆盖</dt><dd>${esc(quoteHistoryView.service_coverage.length ? '已读取只读快照' : '无')}</dd></div><div><dt>参考汇率</dt><dd>USD ${esc(quoteHistoryView.exchange_rates.USD ?? '未填')} · CAD ${esc(quoteHistoryView.exchange_rates.CAD ?? '未填')}</dd></div></dl>${calculationPanel(quoteHistoryView)}<p class="muted">来源：${esc(quoteHistoryView.source_snapshot.rate_id)} · release v${quoteHistoryView.source_snapshot.release_version} · ${esc(quoteHistoryView.source_snapshot.valid_from)} → ${esc(quoteHistoryView.source_snapshot.valid_until)}</p>${quoteHistoryView.remark ? `<p>${esc(quoteHistoryView.remark)}</p>` : ''}</div></section>`;
  };
  const quoteResultPanel = () => {
    let body = '';
    if (quoteView) {
      body += `<div data-fcl-quote-dirty class="inline-note warning"${quoteDirty ? '' : ' hidden'}>售价或费用已修改。下方仍是上次保存的金额，请重新保存。</div><div class="inline-note">已保存 · 第 ${quoteView.version} 版 · ${quoteView.currentness.valid_now ? '当前有效' : `需重新处理：${esc(quoteView.currentness.reason_codes.map(fclIssue).join('、'))}`} · ${quoteView.completeness.complete ? '费用完整' : `待补：${esc(quoteView.completeness.missing_fields.map(fclIssue).join('、'))}`}</div>${calculationPanel(quoteView)}`;
    } else body += '<p class="muted">尚无已保存报价。</p>';
    return panel('报价汇总', '金额来自最近一次保存的报价。', `<div class="panel-body">${body}</div>`);
  };

  const quoteEditor = (selected) => {
    if (!quoteDraft) quoteDraft = blankQuoteDraft(selected);
    const sourcePriceRows = quoteDraft.source_sell_prices.map((row, index) => {
      const rateRow = selected.rate.items.find(item => `ocean_freight:${item.container_type}` === row.row_key);
      const fee = !rateRow && selected.rate.additional_fees?.[Number(row.row_key.split(':')[1])];
      const label = rateRow ? `${rateRow.container_type} 海运费` : fee ? `${fee.name} · ${fee.unit === 'CNTR' ? fee.container_type : 'SHIPMENT'}` : row.row_key;
      const cost = rateRow ? rateRow.ocean_freight : fee?.cost_price;
      const currency = rateRow ? rateRow.currency : fee?.currency;
      return `<div class="field-grid" data-fcl-source-price data-key="${esc(row.row_key)}"><div><strong>${esc(label)}</strong><small>成本 ${esc(cost ?? '缺价')} ${esc(currency ?? '')} / ${rateRow || fee?.unit === 'CNTR' ? '柜' : '票'}</small><input type="hidden" name="source_key" value="${esc(row.row_key)}"></div>${valueField('客户售价', `fcl-source-sell-${index}`, row.sell_price || '', `name="fcl-source-sell-${index}" inputmode="decimal"`)}${valueField('客户备注', `fcl-source-note-${index}`, row.customer_note || '', `name="fcl-source-note-${index}"`)}</div>`;
    }).join('');
    const manualRows = quoteDraft.manual_fees.map((fee, index) => `<div class="panel" data-fcl-manual-row data-id="${esc(fee.id)}" data-template-ref="${esc(JSON.stringify(fee.template_ref))}" data-quantity-conditions="${esc(JSON.stringify(fee.quantity_conditions))}"><div class="panel-body"><div class="field-grid">${valueField('人工费用名称', `fcl-manual-name-${index}`, fee.name || '', 'name="name"')}${field('服务', `fcl-manual-service-${index}`, `<select id="fcl-manual-service-${index}" name="service">${Object.entries(serviceLabels).map(([id, label]) => `<option value="${id}"${fee.service === id ? ' selected' : ''}>${label}</option>`).join('')}</select>`)}${field('分组', `fcl-manual-group-${index}`, `<select id="fcl-manual-group-${index}" name="group">${['A','B','C'].map(group => `<option value="${group}"${fee.group === group ? ' selected' : ''}>${esc(configView?.catalog?.groups.find(item => item.group === group)?.label || {A:'起运段',B:'干线运输',C:'目的段'}[group])}</option>`).join('')}</select>`)}${field('单位', `fcl-manual-unit-${index}`, `<select id="fcl-manual-unit-${index}" name="unit"><option value="SHIPMENT"${fee.unit === 'SHIPMENT' ? ' selected' : ''}>按票计费</option><option value="CNTR"${fee.unit === 'CNTR' ? ' selected' : ''}>按柜计费</option></select>`)}${field('柜型', `fcl-manual-container-${index}`, `<select id="fcl-manual-container-${index}" name="container_type">${containerTypes.map(type => `<option value="${type}"${fee.container_type === type ? ' selected' : ''}>${type}</option>`).join('')}</select>`)}${manualTemplateSelect(fee, index)}${valueField('数量', `fcl-manual-quantity-${index}`, fee.quantity || '', 'name="quantity" inputmode="decimal"')}${valueField('成本价', `fcl-manual-cost-${index}`, fee.cost_price || '', 'name="cost_price" inputmode="decimal"')}${valueField('售价', `fcl-manual-sell-${index}`, fee.sell_price || '', 'name="sell_price" inputmode="decimal"')}${field('币种', `fcl-manual-currency-${index}`, `<select id="fcl-manual-currency-${index}" name="currency">${['USD','CAD','CNY'].map(code => `<option value="${code}"${fee.currency === code ? ' selected' : ''}>${code}</option>`).join('')}</select>`)}${valueField('费用依据', `fcl-manual-evidence-${index}`, fee.evidence_ref || '', 'name="evidence_ref"')}${valueField('依据版本', `fcl-manual-evidence-version-${index}`, fee.evidence_version || '', 'name="evidence_version"')}</div><div class="field"><label for="fcl-manual-conditions-${index}">数量条件</label><textarea id="fcl-manual-conditions-${index}" name="quantity_conditions" rows="2" maxlength="2000">${esc(fee.quantity_conditions || '')}</textarea></div><div class="field"><label for="fcl-manual-internal-${index}">内部备注</label><input id="fcl-manual-internal-${index}" name="internal_note" value="${esc(fee.internal_note || '')}"></div><div class="field"><label for="fcl-manual-customer-${index}">客户备注</label><input id="fcl-manual-customer-${index}" name="customer_note" value="${esc(fee.customer_note || '')}"></div><button type="button" class="text-button" data-action="fcl-manual-remove" data-index="${index}">删除人工费用</button></div></div>`).join('');
    const manualRefs = quoteDraft.manual_fees.map(fee => `manual:${fee.id}`);
    const availableRefs = [...quoteDraft.source_sell_prices.map(row => row.row_key), ...manualRefs];
    const feeName = (ref) => ref.startsWith('manual:') ? quoteDraft.manual_fees.find(fee => `manual:${fee.id}` === ref)?.name || '未命名人工费用' : ref.startsWith('ocean_freight:') ? `${ref.split(':')[1]} 海运费` : selected.rate.additional_fees?.[Number(ref.split(':')[1])]?.name || '来源附费';
    const scopes = Object.entries(serviceLabels).filter(([id]) => detail.current_input.selected_services.includes(id) || quoteDraft.service_scopes.some(scope => scope.service === id)).map(([id, label]) => {
      const existing = quoteDraft.service_scopes.find(scope => scope.service === id);
      const options = availableRefs.map(ref => `<option value="${esc(ref)}"${existing?.included_row_refs?.includes(ref) ? ' selected' : ''}>${esc(feeName(ref))}</option>`).join('');
      return `<div class="field-grid" data-fcl-scope="${id}"><strong>${label}</strong>${field('费用安排', `fcl-scope-${id}`, `<select id="fcl-scope-${id}" name="disposition"><option value=""${!existing ? ' selected' : ''}>使用费用行 / 待确认</option><option value="included"${existing?.disposition === 'included' ? ' selected' : ''}>已包含</option><option value="free"${existing?.disposition === 'free' ? ' selected' : ''}>明确免费</option><option value="out_of_scope"${existing?.disposition === 'out_of_scope' ? ' selected' : ''}>不在范围</option></select>`)}${valueField('说明', `fcl-scope-note-${id}`, existing?.note || '', 'name="scope_note"')}<div class="field fcl-inclusion-refs"><label for="fcl-scope-refs-${id}">包含费用行</label><select id="fcl-scope-refs-${id}" name="scope_refs" multiple size="3">${options}</select><small>选择承担本项服务费用的项目，可按住 Ctrl / ⌘ 多选。</small></div></div>`;
    }).join('');
    const operation = nextQuoteOperation(editingQuoteRef && quoteView?.quote_ref === editingQuoteRef ? quoteView : null);
    return `<form data-fcl-form="quote-save" data-case="${esc(detail.case_id)}" data-version="${detail.case_version}" data-ref="${esc(detail.review_context.latest_customer_supplement_ref || '')}" data-selected="${esc(selected.rate_id)}" data-release="${esc(selected.release_id)}" data-release-version="${selected.release_version}" data-digest="${esc(selected.dataset_digest)}">${formError}<h3 class="fcl-section-heading">客户售价</h3><p class="muted">成本来自所选运价；请按相同单位填写客户售价。</p>${sourcePriceRows}${manualRows}<button type="button" class="button" data-action="fcl-manual-add">添加人工费用</button><h3 class="fcl-section-heading">服务范围</h3><p class="muted">已有费用的服务会自动关联；其余服务请选择已包含、免费或不在本次范围，并填写说明。</p>${scopes}<h3>汇率（1 USD/CAD = 多少 CNY）</h3><div class="field-grid">${valueField('USD → CNY', 'fcl-fx-usd', quoteDraft.exchange_rates.USD || '', 'name="USD" inputmode="decimal"')}${valueField('CAD → CNY', 'fcl-fx-cad', quoteDraft.exchange_rates.CAD || '', 'name="CAD" inputmode="decimal"')}</div><div class="field"><label for="fcl-quote-remark">报价备注</label><textarea id="fcl-quote-remark" name="remark" rows="2" maxlength="500">${esc(quoteDraft.remark || '')}</textarea></div><button class="button primary" type="submit">${operation === 'create' ? '保存报价并计算' : '保存修改并重新计算'}</button></form>`;
  };
  const calculationPanel = (value) => {
    const calculation = value.calculation;
    return `<div class="fcl-profit-total"><span>折合人民币毛利</span><strong>${esc(calculation.unified_profit.gp_subtotal ?? '待补汇率')} <small>CNY</small></strong>${calculation.unified_profit.missing_fx?.length ? `<p>还需填写 ${esc(calculation.unified_profit.missing_fx.join('、'))} 对人民币的汇率</p>` : ''}</div><div class="fcl-currency-list">${Object.entries(calculation.by_currency).map(([currency, row]) => `<section class="fcl-currency"><h3>${currency}</h3><dl><div><dt>成本</dt><dd>${esc(row.cost_subtotal ?? '待补')}</dd></div><div><dt>销售额</dt><dd>${esc(row.revenue_subtotal ?? '待补')}</dd></div><div><dt>毛利</dt><dd class="${row.gp_subtotal?.startsWith('-') ? 'error' : ''}">${esc(row.gp_subtotal ?? '待补')}</dd></div><div><dt>毛利率</dt><dd>${esc(displayMargin(row.margin))}</dd></div></dl></section>`).join('')}</div>${calculation.blockers?.length ? note(`待补项目：${calculation.blockers.join('、')}`, 'warning') : ''}`;

  };
  const documentDisplayForm = () => {
    if (!quoteView) return '';
    const current = documentView?.quote_binding?.quote_ref === quoteView.quote_ref ? documentView.customer_input : null;
    const draft = documentDisplayDraft || current || {
      quote_no: `FCL-${detail.inquiry_no}`,
      quote_date: model().session?.fcl_capability?.business_date || new Date().toISOString().slice(0, 10),
      valid_until: quoteView.source_snapshot.valid_until,
      remark: null,
    };
    return `<form data-fcl-form="document-display" class="panel"><div class="panel-body"><h3>客户报价单信息</h3><div class="fcl-customer-totals" aria-label="客户报价合计">${Object.entries(quoteView.calculation.by_currency).filter(([, row]) => row.revenue_subtotal !== '0.00').map(([currency, row]) => `<div><span>${currency} 销售合计</span><strong>${esc(row.revenue_subtotal ?? '待补')}</strong></div>`).join('')}</div><div class="field-grid">${valueField('报价单编号', 'fcl-doc-quote-no', draft.quote_no || '', 'name="quote_no"')}${valueField('报价日期', 'fcl-doc-quote-date', draft.quote_date || '', 'name="quote_date" type="date"')}${valueField('有效期至', 'fcl-doc-valid-until', draft.valid_until || '', 'name="valid_until" type="date"')}</div><div class="field"><label for="fcl-doc-remark">报价单备注</label><textarea id="fcl-doc-remark" name="remark" rows="2" maxlength="4000">${esc(draft.remark || '')}</textarea></div><p class="muted">这些信息会显示在客户收到的报价单中。</p></div></form>`;
  };
  const documentActions = () => {
    if (!quoteView) return '';
    if (documentView?.historical) {
      const current = documentList?.items?.find(item => item.document_id === documentView.document_id && item.version === item.current_version);
      return current ? `<div class="head-actions"><button class="button" data-action="fcl-doc-open-history" data-document="${esc(current.document_id)}" data-version="${current.version}">返回当前报价单</button></div>` : '';
    }
    const current = documentView?.case_binding.case_ref === detail.case_id && !documentView.historical;
    const operation = current ? nextDocumentOperation(documentView) : 'create';
    const documentChanged = !documentView || documentView.quote_binding.quote_ref !== quoteView.quote_ref || documentView.quote_binding.quote_version !== quoteView.version || documentView.quote_binding.quote_digest !== quoteView.content_digest || documentView.template_version !== configView?.version;
    const operationLabel = { create: '生成报价单', refresh: '刷新报价单', resubmit: '重新提交报价单', re_quote: '按新报价重新出具' }[operation];
    const actionsList = [];
    const quoteLocked = quoteDirty ? ' disabled' : '';
    const workflowLocked = quoteDirty || documentDisplayDirty ? ' disabled' : '';
    actionsList.push(`<button class="button" data-action="fcl-doc-save"${quoteLocked || (current && operation !== 'resubmit' && !documentChanged && !documentDisplayDirty ? ' disabled' : '')}>${current && !documentChanged && operation !== 'resubmit' ? '保存报价单信息' : operationLabel}</button>`);
    if (current && documentView.state === 'draft') {
      actionsList.push(`<button class="button primary" data-action="fcl-doc-review"${workflowLocked}>核对报价单</button>`);
      actionsList.push(`<button class="button danger" data-action="fcl-doc-reject"${workflowLocked}>退回报价单</button>`);
    }
    if (current && reviewView) actionsList.push(`<button class="button primary" data-action="fcl-doc-approve"${workflowLocked}>确认审核通过</button>`);
    if (current && documentView.state === 'approved') {
      actionsList.push(`<button class="button" data-action="fcl-doc-export"${workflowLocked || (!documentView.currentness.valid_now || documentChanged ? ' disabled' : '')}>下载正式报价单 PDF</button>`);
    }
    return `<div data-fcl-document-dirty class="inline-note warning"${documentDisplayDirty ? '' : ' hidden'}>报价单信息已修改，请先保存，再核对或下载。</div>${quoteDirty ? note('当前报价有未保存修改；利润展示来自上次保存版本，请先保存报价再处理文件、审核或交接。', 'warning') : ''}<div class="head-actions">${actionsList.join('')}</div>`;
  };
  const reviewPanel = () => {
    if (!reviewView) return '';
    const totals = reviewView.quote.calculation.by_currency;
    const quote = reviewView.quote;
    const rows = quote.cost_rows.map(row => `<tr><td>${esc(row.source_kind === 'ocean_freight' ? `${row.container_type || ''} 海运费` : row.name)}</td><td>${esc(row.quantity)} ${esc(fclLabel(row.unit))}</td><td>${esc(row.cost_price ?? '待补')} ${esc(row.currency)}</td><td>${esc(row.sell_price ?? '待补')} ${esc(row.currency)}</td><td>${esc(row.cost_amount ?? '待补')}</td><td>${esc(row.sell_amount ?? '待补')}</td></tr>`).join('');
    const projection = quote.case_projection;
    const customerScope = reviewView.document.customer_scope.map(row => `${serviceLabels[row.service] || row.service}:${row.disposition === 'pending' ? '待补费用' : fclLabel(row.disposition)}`).join('、');
    return `<section class="panel"><div class="panel-body"><h3>请确认以下报价内容</h3><p>报价单第 ${reviewView.version} 版 · 本次核对结果可用至 ${esc(new Date(reviewView.review_expires_at).toLocaleString('zh-CN'))}</p><dl class="case-details"><div><dt>需求版本</dt><dd>第 ${quote.case_binding.case_version} 版</dd></div><div><dt>报价版本</dt><dd>第 ${quote.version} 版</dd></div><div><dt>来源</dt><dd>${esc(quote.source_snapshot.source_ref)} / ${esc(quote.source_snapshot.source_version)}</dd></div><div><dt>运价版本</dt><dd>第 ${quote.source_snapshot.release_version} 版</dd></div><div><dt>运价有效期</dt><dd>${esc(quote.source_snapshot.valid_from)} → ${esc(quote.source_snapshot.valid_until)}</dd></div><div><dt>参考汇率</dt><dd>USD ${esc(quote.exchange_rates.USD ?? '未填')} · CAD ${esc(quote.exchange_rates.CAD ?? '未填')}</dd></div></dl><div class="table-wrap"><table><thead><tr><th>费用</th><th>数量/单位</th><th>成本</th><th>售价</th><th>成本合计</th><th>销售合计</th></tr></thead><tbody>${rows}</tbody></table></div><div class="table-wrap"><table><thead><tr><th>币种</th><th>成本合计</th><th>销售合计</th><th>毛利</th><th>毛利率</th></tr></thead><tbody>${Object.entries(totals).map(([currency, row]) => `<tr><td>${currency}</td><td>${esc(row.cost_subtotal ?? '待补')}</td><td>${esc(row.revenue_subtotal ?? '待补')}</td><td>${esc(row.gp_subtotal ?? '待补')}</td><td>${esc(displayMargin(row.margin))}</td></tr>`).join('')}</tbody></table></div><p class="muted">统一利润 ${esc(quote.calculation.unified_profit.gp_subtotal ?? '待补')} CNY · 条款：${esc(reviewView.document.template.terms)}</p><p class="muted">报价日期/有效期：${esc(reviewView.document.customer_input.quote_date || '待确认')} → ${esc(reviewView.document.customer_input.valid_until || '待确认')} · 出具人版本 v${reviewView.document.template_version}</p><p class="muted">已核对需求：${esc(projection.containers.map(item=>`${item.type}×${item.quantity}`).join('、') || '待确认')} · ${esc(projection.services.map(id=>serviceLabels[id]||id).join('、') || '待确认')} · ${esc(projection.incoterm || '贸易条款待确认')} · 客户服务范围：${esc(customerScope || '待确认')}</p><details class="fcl-technical"><summary>查看审核凭证</summary><code>${esc(reviewView.review_hash)}</code></details></div></section>`;
  };
  const documentSnapshotPanel = () => {
    if (!documentView) return '';
    const display = documentView.customer_input || {};
    return `<details class="panel"${documentView.historical ? ' open' : ''}><summary>报价单快照 v${documentView.version}${documentView.historical ? '（历史）' : ''}</summary><div class="panel-body"><dl class="case-details"><div><dt>编号</dt><dd>${esc(display.quote_no || '待确认')}</dd></div><div><dt>日期</dt><dd>${esc(display.quote_date || '待确认')} → ${esc(display.valid_until || '待确认')}</dd></div><div><dt>Case/Quote</dt><dd>${esc(documentView.case_binding.case_ref)} v${documentView.case_binding.case_version} · quote v${documentView.quote_binding.quote_version}</dd></div><div><dt>运价来源版本</dt><dd>${esc(documentView.source_binding.source_ref)} · ${esc(documentView.source_binding.source_version)} · v${documentView.source_binding.release_version}</dd></div><div><dt>来源窗口</dt><dd>${esc(documentView.source_binding.valid_from)} → ${esc(documentView.source_binding.valid_until)}</dd></div><div><dt>客户合计</dt><dd>USD ${esc(documentView.customer_totals.by_currency.USD)} · CAD ${esc(documentView.customer_totals.by_currency.CAD)} · CNY ${esc(documentView.customer_totals.by_currency.CNY)}</dd></div><div><dt>客户服务范围</dt><dd>${esc(documentView.customer_scope.map(row => `${serviceLabels[row.service] || row.service}:${row.disposition === 'pending' ? '待补费用' : fclLabel(row.disposition)}`).join('、') || '待确认')}</dd></div><div><dt>出具人版本</dt><dd>${documentView.template_version}</dd></div><div><dt>状态</dt><dd>${esc(fclLabel(documentView.state))} · ${documentView.currentness.valid_now ? '当前有效' : '需要重新核对'}</dd></div></dl><p class="muted">条款：${esc(documentView.template.terms)}</p>${display.remark ? `<p>${esc(display.remark)}</p>` : ''}</div></details>`;
  };
  const documentHistoryPanel = () => {
    if (!documentList?.items?.length) return '';
    return `<details class="panel"><summary>报价单历史（${documentList.items.length}）</summary><div class="panel-body">${documentList.items.map(item => { const versions = Array.from({length:Math.min(item.current_version,1000)},(_,index)=>index+1); return `<div class="field-grid"><div><strong>v${item.version}</strong><small>${esc(fclLabel(item.state))} · quote v${item.quote_version} · ${item.currentness.valid_now ? '当前有效' : '需要重新核对'}</small></div><div class="field"><label for="fcl-doc-version-${esc(item.document_id)}">查看版本</label><select id="fcl-doc-version-${esc(item.document_id)}" data-fcl-doc-version="${esc(item.document_id)}">${versions.map(version=>`<option value="${version}"${version===item.version?' selected':''}>v${version}</option>`).join('')}</select></div><button class="button" data-action="fcl-doc-open-history" data-document="${esc(item.document_id)}" data-version="${item.version}">读取</button><button class="button" data-action="fcl-doc-export-history" data-document="${esc(item.document_id)}" data-version="${item.version}" data-current-version="${item.current_version}">下载所选历史 PDF</button></div>`; }).join('')}</div></details>`;
  };
  const handoffPanel = () => {
    if (!handoffView) return '';
    const current = handoffView.current;
    const ready = Boolean(quoteView && documentView?.state === 'approved' && documentView.currentness.valid_now && exportView && exportView.document_id === documentView.document_id && exportView.version === documentView.version && exportView.valid_now === true && !quoteDirty && !documentDisplayDirty);
    const reason = handoffView.status === 'handed_off' && !ready && !quoteDirty && !documentDisplayDirty ? '本版已完成交接。再次交接前，请先下载当前正式 PDF。' : !quoteView ? '尚无已保存报价。' : !documentView || documentView.state !== 'approved' || !documentView.currentness.valid_now ? '请先生成并审核当前报价单。' : !exportView || exportView.document_id !== documentView.document_id || exportView.version !== documentView.version ? '请先导出并校验当前正式 PDF。' : quoteDirty || documentDisplayDirty ? '存在未保存的报价或报价单修改。' : '';
    return `<section class="panel"><div class="panel-body"><h3>运营交接</h3><p class="fcl-handoff-status">${esc(fclLabel(handoffView.status))}</p>${handoffView.reason_codes.length ? `<p class="muted">${esc(handoffView.reason_codes.map(fclIssue).join('；'))}</p>` : ''}${current ? `<dl class="case-details"><div><dt>报价单</dt><dd>v${current.document_version}</dd></div><div><dt>报价</dt><dd>第 ${current.quote_version} 版</dd></div><div><dt>PDF</dt><dd><code>${esc(current.pdf_sha256.slice(0, 16))}…</code> · ${current.pdf_byte_length} bytes</dd></div><div><dt>交接记录</dt><dd>已保存本人操作记录</dd></div></dl>` : ''}<form data-fcl-form="handoff-note"><div class="field"><label for="fcl-handoff-note">本次交接备注</label><textarea id="fcl-handoff-note" name="fcl-handoff-note" rows="2" maxlength="2000" placeholder="仅在内部事件中保留">${esc(handoffDraft)}</textarea></div></form><button class="button primary" data-action="fcl-handoff"${ready ? '' : ' disabled'} title="${esc(reason || '交接前置条件已满足')}">${handoffView.status === 'handed_off' ? '再次交接' : '确认交接'}</button>${reason ? `<p class="muted">${esc(reason)}</p>` : ''}${handoffView.history.length ? `<details><summary>历史交接（${handoffView.history.length}）</summary><ul>${handoffView.history.map(item => `<li>${esc(item.recorded_at)} · quote v${item.quote_version} · doc v${item.document_version} · <code>${esc(item.pdf_sha256.slice(0, 12))}…</code></li>`).join('')}</ul></details>` : ''}<p class="muted">交接后请按实际业务安排后续操作；此处不会自动订舱。</p></div></section>`;
  };

  const ratePage = () => {
    void loadRate();
    const heading = head('运价管理', '维护来源、有效期、柜型海运费和附费；草稿保存不会立刻成为当前报价来源。', '<a class="button primary" href="#fcl">返回询价列表</a>');
    if (rateError) return heading + note(fclError({code: rateError}), 'error');
    if (!rateView) return heading + '<p role="status">正在读取运价草稿…</p>';
    const active = rateView.active_release;
    const history = rateView.history?.length ? `<details class="panel"><summary>历史发布</summary><div class="panel-body">${rateView.history.map(item => `<div class="field-grid"><span>第 ${item.version} 版 · ${esc(item.label)} · ${esc(item.published_at)}</span><button class="button" data-action="fcl-rate-rollback" data-release="${esc(item.release_id)}">回退并创建新发布</button></div>`).join('')}</div></details>` : '';
    const preview = ratePreview ? `<section class="inline-note ${ratePreview.can_publish ? '' : 'warning'}">${ratePreview.can_publish ? '预览通过，可确认发布。' : `预览未通过：${esc(ratePreview.blockers.join('、'))}`}<details class="fcl-technical"><summary>查看预览凭证</summary><code>${esc(ratePreview.preview_hash)}</code></details></section>` : '';
    return heading + messageNote() + preview + `<section class="inline-note">当前发布：${active ? `第 ${active.version} 版 · ${esc(active.input.label)}` : '尚未发布运价，请先保存并发布'}<span> 草稿版本 v${rateView.version}</span><div class="head-actions"><button type="button" class="button primary" data-action="fcl-rate-save">保存草稿</button><button type="button" class="button" data-action="fcl-rate-preview">预览草稿</button><button type="button" class="button" data-action="fcl-rate-publish"${ratePreview?.can_publish && ratePreview.preview_hash ? '' : ' disabled'}>确认发布</button>${active ? '<button type="button" class="button danger" data-action="fcl-rate-disable">停用当前发布</button>' : ''}</div></section>${rateEditor()}${history}`;
  };
  const rateEditor = () => `<form data-fcl-form="rate-save">${formError}<section class="panel"><div class="panel-body"><div class="field-grid">${valueField('运价表名称', 'fcl-rate-label', rateDraft.label || '', 'name="fcl-rate-label"')}</div><div data-fcl-rates>${(rateDraft.rates || []).map((rate, index) => rateRow(rate, index)).join('')}</div><button type="button" class="button" data-action="fcl-rate-add">添加来源</button><button class="button primary" type="submit">保存草稿</button></div></section></form>`;
  const rateRow = (rate, index) => `<details open class="panel" data-fcl-rate-index="${index}"><summary>${esc(rate.supplier_label || `来源 ${index + 1}`)} · ${esc(rate.pol || '起运港待填')} → ${esc(rate.pod || '目的港待填')}</summary><div class="panel-body"><div class="field-grid">${valueField('来源/供应商', `fcl-rate-${index}-supplier`, rate.supplier_label || '', `name="fcl-rate-${index}-supplier"`)}${valueField('起运港（POL）', `fcl-rate-${index}-pol`, rate.pol || '', `name="fcl-rate-${index}-pol"`)}${valueField('目的港（POD）', `fcl-rate-${index}-pod`, rate.pod || '', `name="fcl-rate-${index}-pod"`)}${valueField('有效起', `fcl-rate-${index}-from`, rate.valid_from || '', `name="fcl-rate-${index}-from" type="date"`)}${valueField('有效止', `fcl-rate-${index}-until`, rate.valid_until || '', `name="fcl-rate-${index}-until" type="date"`)}${valueField('运价依据（文件或邮件编号）', `fcl-rate-${index}-source`, rate.source_ref || '', `name="fcl-rate-${index}-source"`)}${valueField('依据版本', `fcl-rate-${index}-source-version`, rate.source_version || 'v1', `name="fcl-rate-${index}-source-version"`)}</div><div class="field"><label for="fcl-rate-${index}-note">来源备注</label><textarea id="fcl-rate-${index}-note" name="fcl-rate-${index}-note" rows="2" maxlength="2000">${esc(rate.note || '')}</textarea></div>${containerTypes.map(type => { const item = rate.items?.find(candidate => candidate.container_type === type); return `<div class="field-grid" data-fcl-rate-item="${index}:${type}"><strong>${type}</strong>${valueField('海运费 / 柜', `fcl-rate-${index}-${type}-price`, item?.ocean_freight || '', `name="fcl-rate-${index}-${type}-price"`)}${field('币种', `fcl-rate-${index}-${type}-currency`, `<select id="fcl-rate-${index}-${type}-currency" name="fcl-rate-${index}-${type}-currency">${['USD','CAD','CNY'].map(code => `<option value="${code}"${(item?.currency || 'USD') === code ? ' selected' : ''}>${code}</option>`).join('')}</select>`)}</div>`; }).join('')}<div class="field-grid">${(rate.additional_fees || []).map((fee, feeIndex) => `<div class="field-grid" data-fcl-rate-fee="${index}:${feeIndex}">${valueField('附费名称', `fcl-rate-${index}-fee-${feeIndex}-name`, fee.name || '', `name="fcl-rate-${index}-fee-${feeIndex}-name"`)}${field('服务', `fcl-rate-${index}-fee-${feeIndex}-service`, `<select id="fcl-rate-${index}-fee-${feeIndex}-service" name="fcl-rate-${index}-fee-${feeIndex}-service">${Object.entries(serviceLabels).map(([id, label]) => `<option value="${id}"${fee.service === id ? ' selected' : ''}>${label}</option>`).join('')}</select>`)}${field('分组', `fcl-rate-${index}-fee-${feeIndex}-group`, `<select id="fcl-rate-${index}-fee-${feeIndex}-group" name="fcl-rate-${index}-fee-${feeIndex}-group">${['A','B','C'].map(group => `<option value="${group}"${fee.group === group ? ' selected' : ''}>${esc(configView?.catalog?.groups.find(item => item.group === group)?.label || {A:'起运段',B:'干线运输',C:'目的段'}[group])}</option>`).join('')}</select>`)}${field('单位', `fcl-rate-${index}-fee-${feeIndex}-unit`, `<select id="fcl-rate-${index}-fee-${feeIndex}-unit" name="fcl-rate-${index}-fee-${feeIndex}-unit"><option value="SHIPMENT"${fee.unit === 'SHIPMENT' ? ' selected' : ''}>按票计费</option><option value="CNTR"${fee.unit === 'CNTR' ? ' selected' : ''}>按柜计费</option></select>`)}${field('柜型', `fcl-rate-${index}-fee-${feeIndex}-container`, `<select id="fcl-rate-${index}-fee-${feeIndex}-container" name="fcl-rate-${index}-fee-${feeIndex}-container">${containerTypes.map(type => `<option value="${type}"${fee.container_type === type ? ' selected' : ''}>${type}</option>`).join('')}</select>`)}${valueField('成本', `fcl-rate-${index}-fee-${feeIndex}-cost`, fee.cost_price || '', `name="fcl-rate-${index}-fee-${feeIndex}-cost"`)}${field('币种', `fcl-rate-${index}-fee-${feeIndex}-currency`, `<select id="fcl-rate-${index}-fee-${feeIndex}-currency" name="fcl-rate-${index}-fee-${feeIndex}-currency">${['USD','CAD','CNY'].map(code => `<option value="${code}"${(fee.currency || 'USD') === code ? ' selected' : ''}>${code}</option>`).join('')}</select>`)}${valueField('备注', `fcl-rate-${index}-fee-${feeIndex}-note`, fee.note || '', `name="fcl-rate-${index}-fee-${feeIndex}-note"`)}<button type="button" class="text-button" data-action="fcl-rate-fee-remove" data-index="${index}" data-fee="${feeIndex}">删除附费</button></div>`).join('')}</div><button type="button" class="button" data-action="fcl-rate-fee-add" data-index="${index}">添加附费</button><button type="button" class="text-button" data-action="fcl-rate-remove" data-index="${index}">删除来源</button></div></details>`;

  const configPage = () => {
    void loadConfig();
    const heading = head('报价与通知设置', '设置客户报价单上的出具人信息，以及新询价的内部通知收件人。', '<a class="button" href="#fcl">返回询价列表</a>');
    if (configError) return heading + note(fclError({code: configError}), 'error');
    if (!configView || !notificationView) return heading + '<p role="status">正在读取配置…</p>';
    const savedConfig = configView.input || {};
    const config = issuerDraft ? { ...savedConfig, ...issuerDraft } : savedConfig;
    const notification = notificationDraft ? { ...(notificationView.input || {}), ...notificationDraft } : (notificationView.input || { enabled: false, recipient: null, cc: [] });
    const savedTemplateKeys = (savedConfig.standard_fee_template_v1?.items || []).map(item => item.item_key);
    const selectedTemplateKeys = new Set(issuerDraft?.standard_fee_template_keys || savedTemplateKeys);
    const catalogItems = configView.catalog.groups.flatMap(group => group.items.map(item => ({...item, group_label: group.label})));
    const missingTemplateKeys = savedTemplateKeys.filter(key => !catalogItems.some(item => item.item_key === key));
    const templatePicker = `<details class="qdoc-template-picker"><summary>可选标准费用项目（${selectedTemplateKeys.size}）</summary>${configView.catalog.groups.map(group => `<section><h3>${esc(group.label)}</h3><div class="qdoc-template-grid">${group.items.map(item => `<label><input type="checkbox" data-fcl-template-ref value="${esc(item.item_key)}"${selectedTemplateKeys.has(item.item_key) ? ' checked' : ''}><span>${esc(item.name)}</span></label>`).join('')}</div></section>`).join('')}${missingTemplateKeys.length ? `<section><h3>当前保存但目录未列出</h3>${missingTemplateKeys.map(key => `<label><input type="checkbox" data-fcl-template-ref value="${esc(key)}" checked><span>${esc(key)}</span></label>`).join('')}</section>` : ''}</details>`;
    return heading + messageNote() + `<div class="form-layout"><form class="panel" data-fcl-form="issuer-config-save" data-version="${configView.version}">${formError}<div class="panel-body"><h2>报价出具人</h2><div class="field-grid">${valueField('出具人名称', 'fcl-issuer-name', config.issuer_name || '', 'name="fcl-issuer-name"')}${valueField('邮箱', 'fcl-issuer-email', config.issuer_email || '', 'name="fcl-issuer-email" type="email"')}${valueField('电话', 'fcl-issuer-phone', config.issuer_phone || '', 'name="fcl-issuer-phone"')}${valueField('地址', 'fcl-issuer-address', config.issuer_address || '', 'name="fcl-issuer-address"')}</div><div class="field"><label for="fcl-issuer-terms">报价条款</label><textarea id="fcl-issuer-terms" name="fcl-issuer-terms" rows="3" maxlength="4000">${esc(config.terms || '')}</textarea></div>${templatePicker}<button class="button primary" type="submit">保存出具人资料</button></div></form><form class="panel" data-fcl-form="notification-save" data-version="${notificationView.version}">${formError}<div class="panel-body"><h2>内部通知</h2><label class="check-row"><input type="checkbox" name="enabled"${notification.enabled ? ' checked' : ''}>启用内部通知</label>${valueField('收件人', 'fcl-notification-recipient', notification.recipient || '', 'name="fcl-notification-recipient" type="email"')}${valueField('抄送（逗号分隔）', 'fcl-notification-cc', (notification.cc || []).join(','), 'name="fcl-notification-cc"')}<button class="button primary" type="submit">保存通知配置</button><p class="muted">这里设置新询价的内部通知收件人。邮件发送成功后，仍需以收件箱实际收到为准。</p></div></form></div>`;
  };

  const captureRateForm = (form) => {
    const label = form.querySelector('[name=fcl-rate-label]').value.trim();
    const rates = [...form.querySelectorAll('[data-fcl-rate-index]')].map(section => {
      const index = Number(section.dataset.fclRateIndex);
      const previous = rateDraft.rates[index] || {};
      const value = (key) => section.querySelector(`[name=fcl-rate-${index}-${key}]`)?.value.trim() || null;
      const items = containerTypes.flatMap(type => {
        const row = section.querySelector(`[data-fcl-rate-item="${index}:${type}"]`);
        const price = row?.querySelector(`[name=fcl-rate-${index}-${type}-price]`)?.value.trim();
        return price ? [{ container_type: type, ocean_freight: price, currency: row.querySelector(`[name=fcl-rate-${index}-${type}-currency]`)?.value.trim() || 'USD' }] : [];
      });
      const additional_fees = [...section.querySelectorAll(`[data-fcl-rate-fee^="${index}:"]`)].map(feeRow => {
        const feeIndex = Number(feeRow.dataset.fclRateFee.split(':')[1]);
        const previousFee = previous.additional_fees?.[feeIndex] || {};
        const read = (key) => feeRow.querySelector(`[name="fcl-rate-${index}-fee-${feeIndex}-${key}"]`)?.value.trim() || null;
        const unit = read('unit') || 'SHIPMENT';
        return { name: read('name') || '', group: read('group') || previousFee.group || 'C', service: read('service') || previousFee.service || 'delivery', cost_price: read('cost'), currency: read('currency') || previousFee.currency || 'USD', note: read('note') || null, unit, container_type: unit === 'CNTR' ? (read('container') || previousFee.container_type || '40HQ') : null };
      });
      return { rate_id: previous.rate_id || crypto.randomUUID(), supplier_label: value('supplier') || '', pol: value('pol') || '', pod: value('pod') || '', valid_from: value('from') || '', valid_until: value('until') || '', source_ref: value('source') || '', source_version: value('source-version') || 'v1', note: section.querySelector(`[name="fcl-rate-${index}-note"]`)?.value.trim() || null, items, additional_fees };
    });
    rateDraft = { contract_version: 'fcl-rate-dataset@2026-09-20.v1', label: label || '个人 FCL 运价', rates };
  };
  const assertRateDraft = (value) => {
    const invalid = !value.label || !value.rates.length || value.rates.some(rate => !rate.supplier_label || !rate.pol || !rate.pod || !rate.valid_from || !rate.valid_until || !rate.source_ref || !rate.source_version || !rate.items.length) || value.rates.some(rate => rate.additional_fees.some(fee => !fee.name || !fee.cost_price));
    if (invalid) throw Object.assign(new Error('fcl_rate_input_invalid'), { code: 'fcl_rate_input_invalid' });
  };
  const captureQuoteForm = (form) => {
    if (!quoteDraft) return;
    quoteDraft.source_sell_prices = [...form.querySelectorAll('[data-fcl-source-price]')].map(row => {
      const key = row.dataset.key;
      const index = [...form.querySelectorAll('[data-fcl-source-price]')].indexOf(row);
      return { row_key: key, sell_price: row.querySelector(`[name="fcl-source-sell-${index}"]`)?.value.trim() || null, customer_note: row.querySelector(`[name="fcl-source-note-${index}"]`)?.value.trim() || null };
    });
    quoteDraft.manual_fees = [...form.querySelectorAll('[data-fcl-manual-row]')].map(row => ({
      id: row.dataset.id || crypto.randomUUID(),
      template_ref: (() => { try { const raw = row.querySelector('[name="template_ref"]')?.value; return raw ? JSON.parse(raw) : null; } catch { return null; } })(),
      name: row.querySelector('[name="name"]')?.value.trim() || '',
      group: row.querySelector('[name="group"]')?.value || 'C',
      service: row.querySelector('[name="service"]')?.value || 'delivery',
      unit: row.querySelector('[name="unit"]')?.value || 'SHIPMENT',
      quantity: row.querySelector('[name="unit"]')?.value === 'SHIPMENT' ? '1' : row.querySelector('[name="quantity"]')?.value.trim() || '1',
      container_type: row.querySelector('[name="unit"]')?.value === 'CNTR' ? row.querySelector('[name="container_type"]')?.value || '40HQ' : null,
      cost_price: row.querySelector('[name="cost_price"]')?.value.trim() || null,
      sell_price: row.querySelector('[name="sell_price"]')?.value.trim() || null,
      currency: row.querySelector('[name="currency"]')?.value || 'CAD',
      internal_note: row.querySelector('[name="internal_note"]')?.value.trim() || null,
      customer_note: row.querySelector('[name="customer_note"]')?.value.trim() || null,
      evidence_ref: row.querySelector('[name="evidence_ref"]')?.value.trim() || null,
      evidence_version: row.querySelector('[name="evidence_version"]')?.value.trim() || null,
      quantity_conditions: row.querySelector('[name="quantity_conditions"]')?.value.trim() || null,
    }));
    quoteDraft.service_scopes = [...form.querySelectorAll('[data-fcl-scope]')].flatMap(row => {
      const disposition = row.querySelector('[name="disposition"]')?.value;
      if (!disposition) return [];
      const service = row.dataset.fclScope;
      const note = row.querySelector('[name="scope_note"]')?.value.trim() || null;
      const refs = [...row.querySelectorAll('[name="scope_refs"] option:checked')].map(option => option.value);
      return [{ service, disposition, note, included_row_refs: disposition === 'included' ? refs : [] }];
    });
    quoteDraft.exchange_rates = { USD: form.querySelector('[name="USD"]')?.value.trim() || null, CAD: form.querySelector('[name="CAD"]')?.value.trim() || null };
    quoteDraft.remark = form.querySelector('[name="remark"]')?.value.trim() || null;
  };

  const page = () => {
    sync();
    const routeValue = syncRoute();
    if (!hasCapability()) return empty('当前账号没有整柜受理权限', '请使用指定的受理人账号登录。');
    const body = routeValue.action === 'rates' ? ratePage() : routeValue.action === 'config' ? configPage() : routeValue.action === 'case' && routeValue.id ? detailPage(routeValue.id) : listPage();
    return `<div class="fcl-workbench">${body}</div>`;
  };

  const responseMessage = (response, successMessage, pendingMessage) => {
    let text;
    if (response.status === 'success') text = successMessage;
    else if (response.status === 'needs_input' && response.data) text = pendingMessage;
    else if (response.status === 'manual_review' && response.data) text = `已按人工复核状态保存：${response.reason_codes.map(fclIssue).join('、') || '需要人工处理'}`;
    else text = fclError({ code: response.reason_codes?.[0] || response.status });
    if (!['success', 'needs_input', 'manual_review'].includes(response.status) || (!response.data && response.status !== 'success')) notify(text, true);
    return text;
  };
  const blockUnsavedQuote = () => {
    if (!quoteDirty) return false;
    message = '当前报价有未保存修改，请先保存报价后再处理文件、审核或交接。';
    notify(message, true);
    rerender();
    return true;
  };
  const blockUnsavedDocumentDisplay = (name) => {
    if (!documentDisplayDirty || name === 'fcl-doc-save') return false;
    message = '客户报价单信息有未保存修改，请先保存报价单。';
    notify(message, true);
    rerender();
    return true;
  };
  const captureFormDraft = (form) => {
    const type = form.dataset.fclForm;
    if (type === 'rate-save') { captureRateForm(form); rateDirty = true; ratePreview = null; return; }
    if (type === 'quote-save') {
      captureQuoteForm(form);
      quoteDirty = true;
      const draftNotice = document.querySelector('[data-fcl-quote-dirty]'); if (draftNotice) draftNotice.hidden = false;
      const stepLabel = document.querySelector('[data-step="quote"] small'); if (stepLabel) stepLabel.textContent = '有未保存修改';
      reviewView = null;
      exportView = null;
      document.querySelectorAll('[data-action="fcl-doc-approve"],[data-action="fcl-handoff"]').forEach(button => { button.disabled = true; });
      return;
    }
    const data = new FormData(form);
    const raw = (name) => String(data.get(name) ?? '');
    const value = (name) => String(data.get(name) ?? '').trim() || null;
    if (type === 'issuer-config-save') {
      issuerDraft = {
        issuer_name: raw('fcl-issuer-name'),
        issuer_address: raw('fcl-issuer-address'),
        issuer_phone: raw('fcl-issuer-phone'),
        issuer_email: raw('fcl-issuer-email'),
        terms: raw('fcl-issuer-terms'),
        standard_fee_template_keys: [...form.querySelectorAll('[data-fcl-template-ref]:checked')].map(element => element.value),
      };
      issuerDirty = true;
      return;
    }
    if (type === 'notification-save') {
      notificationDraft = { enabled: data.get('enabled') === 'on', recipient: raw('fcl-notification-recipient') || null, cc: raw('fcl-notification-cc').split(',').map(item => item.trim()).filter(Boolean) };
      notificationDirty = true;
      return;
    }
    if (type === 'case-status') {
      caseStatusDraft = { status: String(data.get('status') || 'in_review'), public_note: raw('public_note'), internal_note: raw('internal_note') };
      caseStatusDirty = true;
      operationsOpen = true;
      return;
    }
    if (type === 'case-confirm') {
      confirmReasonDraft = String(data.get('reason') || '');
      confirmDirty = true;
      return;
    }
    if (type === 'document-display') {
      documentDisplayDraft = { quote_no: value('quote_no'), quote_date: value('quote_date'), valid_until: value('valid_until'), remark: value('remark') };
      documentDisplayDirty = true;
      const draftNotice = document.querySelector('[data-fcl-document-dirty]'); if (draftNotice) draftNotice.hidden = false;
      const saveButton = document.querySelector('[data-action="fcl-doc-save"]'); if (saveButton) saveButton.disabled = quoteDirty;
      document.querySelectorAll('[data-action="fcl-doc-review"],[data-action="fcl-doc-export"]').forEach(button => { button.disabled = true; });
      reviewView = null;
      exportView = null;
      document.querySelectorAll('[data-action="fcl-doc-approve"],[data-action="fcl-handoff"]').forEach(button => { button.disabled = true; });
      return;
    }
    if (type === 'handoff-note') {
      handoffDraft = raw('fcl-handoff-note');
      handoffDirty = true;
      return;
    }
    if (type === 'staff-supplement') {
      staffSupplementDraft = captureStaffSupplement(form);
      staffSupplementMessage = raw('message');
      staffSupplementDirty = true;
      operationsOpen = true;
    }
  };

  const submit = async (form) => {
    if (!form.dataset.fclForm) return false;
    const type = form.dataset.fclForm;
    const e = epoch;
    if (type === 'rate-save') {
      captureRateForm(form);
      assertRateDraft(rateDraft);
      const response = await write('rate-save', { expected_version: rateView.version, input: rateDraft });
      if (e !== epoch) return true;
      if (response.data) { rateView = response.data; rateDraft = clone(response.data.draft); ratePreview = null; rateDirty = false; }
      message = responseMessage(response, '运价草稿已保存；当前发布未改变。', '运价草稿已保存，但仍待补齐。');
      rerender();
      return true;
    }
    if (type === 'issuer-config-save') {
      captureFormDraft(form);
      const catalogItems = configView.catalog.groups.flatMap(group => group.items);
      const savedItems = configView.input?.standard_fee_template_v1?.items || [];
      const selectedItems = issuerDraft.standard_fee_template_keys.map(key => catalogItems.find(item => item.item_key === key) || savedItems.find(item => item.item_key === key)).filter(Boolean);
      const input = {
        issuer_name: issuerDraft.issuer_name,
        issuer_address: issuerDraft.issuer_address,
        issuer_phone: issuerDraft.issuer_phone,
        issuer_email: issuerDraft.issuer_email,
        terms: issuerDraft.terms,
        standard_fee_template_v1: selectedItems.length ? { template_id: configView.catalog.template_id, template_version: configView.catalog.template_version, items: selectedItems } : null,
      };
      const response = await write('issuer-config-save', { contract_version: DOCUMENT_VERSION, expected_version: Number(form.dataset.version), confirmed: true, input });
      if (e !== epoch) return true;
      if (response.data) { configView = response.data; issuerDraft = null; issuerDirty = false; }
      clearCaseDependents(); message = responseMessage(response, '报价出具人资料已保存。', '报价出具人资料仍待补齐。'); rerender(); return true;
    }
    if (type === 'notification-save') {
      captureFormDraft(form);
      const response = await write('notification-save', { contract_version: NOTIFICATION_VERSION, expected_version: Number(form.dataset.version), confirmed: true, input: notificationDraft });
      if (e !== epoch) return true;
      if (response.data) { notificationView = response.data; notificationDraft = null; notificationDirty = false; }
      message = responseMessage(response, '通知配置已保存；运价版本未改变。', '通知配置仍待补齐。'); rerender();
      return true;
    }
    if (type === 'case-status') {
      captureFormDraft(form);
      const response = await write('case-status', { case_id: form.dataset.case, expected_version: Number(form.dataset.version), status: caseStatusDraft.status, public_note: caseStatusDraft.public_note, internal_note: caseStatusDraft.internal_note });
      if (e !== epoch) return true;
      if (response.data) { detail = response.data; clearCaseDependents(); caseStatusDraft = null; caseStatusDirty = false; }
      message = responseMessage(response, '处理状态已保存。', '处理状态已保存，仍需补充资料。'); rerender();
      return true;
    }
    if (type === 'staff-supplement') {
      const data = new FormData(form);
      captureFormDraft(form);
      const next = staffSupplementDraft;
      const changes = [];
      const currentValue = (field) => field.split('.').reduce((value, key) => value?.[key], detail.current_input);
      const compare = (field, value) => { if (JSON.stringify(currentValue(field) ?? null) !== JSON.stringify(value ?? null)) changes.push({ field, value }); };
      for (const field of ['origin_city','pol','pod','final_destination','containers','cargo_name','cargo_type','estimated_weight','cargo_ready_date','incoterm','incoterm_other','selected_services','notes']) compare(field, next[field]);
      for (const field of ['name','email','company','phone']) compare(`contact.${field}`, next.contact[field]);
      const messageValue = String(data.get('message') || '').trim() || null;
      if (!changes.length && !messageValue) { message = '没有检测到需要记录的变化。'; rerender(); return true; }
      const response = await write('case-staff-supplement', { case_id: form.dataset.case, expected_version: Number(form.dataset.version), fields: { changes }, message: messageValue });
      if (e !== epoch) return true;
      if (response.data) { detail = response.data; clearCaseDependents(); staffSupplementDraft = null; staffSupplementMessage = ''; staffSupplementDirty = false; }
      message = responseMessage(response, '补充或修改资料事件已保存。', '代录事件已保存，但仍待补充。'); rerender();
      return true;
    }
    if (type === 'case-confirm') {
      captureFormDraft(form);
      const response = await write('case-confirm', { case_id: form.dataset.case, expected_version: Number(form.dataset.version), expected_customer_supplement_ref: form.dataset.ref ? form.dataset.ref : null, confirmed_fields: { changes: [] }, reason: confirmReasonDraft.trim() });
      if (e !== epoch) return true;
      if (response.data) { detail = response.data; clearCaseDependents(); confirmReasonDraft = ''; confirmDirty = false; }
      message = responseMessage(response, '需求已确认，可以开始报价。', '需求确认已保存，但仍待补充。'); rerender();
      return true;
    }
    if (type === 'quote-save') {
      captureQuoteForm(form);
      const selected = matchedSelected();
      const source = selected?.rate;
      if (!source) throw Object.assign(new Error('请先查找适用运价'), { code: 'fcl_quote_source_unavailable' });
      const existing = editingQuoteRef && quoteView?.quote_ref === editingQuoteRef ? quoteView : null;
      const selectedBinding = { selected_rate_id: form.dataset.selected, expected_release_id: form.dataset.release, expected_release_version: Number(form.dataset.releaseVersion), expected_dataset_digest: form.dataset.digest };
      const caseChanged = existing?.case_binding.case_ref !== form.dataset.case || existing?.case_binding.case_version !== Number(form.dataset.version) || existing?.case_binding.latest_customer_supplement_ref !== (form.dataset.ref || null);
      const body = existing ? {
        contract_version: DOCUMENT_VERSION,
        operation: 'update',
        quote_ref: existing.quote_ref,
        expected_version: existing.version,
        source_binding: !caseChanged && existing.source_snapshot.rate_id === form.dataset.selected && existing.source_snapshot.release_id === form.dataset.release && existing.source_snapshot.dataset_digest === form.dataset.digest
          ? { mode: 'retain' }
          : { mode: 'replace', expected_case_version: Number(form.dataset.version), expected_customer_supplement_ref: form.dataset.ref || null, ...selectedBinding },
        input: quoteDraft,
      } : {
        contract_version: DOCUMENT_VERSION,
        operation: 'create',
        case_ref: form.dataset.case,
        expected_case_version: Number(form.dataset.version),
        expected_customer_supplement_ref: form.dataset.ref || null,
        ...selectedBinding,
        input: quoteDraft,
      };
      const response = await write('quote-save', body);
      if (e !== epoch) return true;
      if (response.data) {
        quoteView = response.data;
        if (response.status === 'success') {
          quoteDraft = null;
          matchResult = null;
          editingQuoteRef = null;
          documentDisplayDraft = null;
          documentDisplayDirty = false;
          requestRelatedRefresh();
        } else {
          editingQuoteRef = quoteView.quote_ref;
        }
        quoteDirty = false;
        reviewView = null;
        exportView = null;
      }
      message = responseMessage(response, response.data ? `报价 v${response.data.version} 已保存，金额与毛利已更新。` : '报价未保存。', response.data ? `报价 v${response.data.version} 已保存为待补状态；请在同一报价上继续补全。` : '报价未保存。');
      rerender();
      return true;
    }
    return false;
  };

  const action = async (button) => {
    const name = button.dataset.action;
    if (!name?.startsWith('fcl-')) return false;
    const e = epoch;
    if (name === 'fcl-workspace-step' && ['requirements', 'quote', 'documents'].includes(button.dataset.step)) { workspaceStep = button.dataset.step; rerender(); const heading = document.querySelector(`#fcl-step-${workspaceStep} h2`); heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true }); return true; }
    if (name === 'fcl-rate-add') { const form = document.querySelector('[data-fcl-form="rate-save"]'); if (form) captureRateForm(form); rateDraft.rates.push({ rate_id: crypto.randomUUID(), supplier_label: '', pol: '', pod: '', valid_from: '', valid_until: '', source_ref: '', source_version: 'v1', note: null, items: [], additional_fees: [] }); ratePreview = null; rateDirty = true; rerender(); return true; }
    if (name === 'fcl-rate-remove') { const form = document.querySelector('[data-fcl-form="rate-save"]'); if (form) captureRateForm(form); rateDraft.rates.splice(Number(button.dataset.index), 1); ratePreview = null; rateDirty = true; rerender(); return true; }
    if (name === 'fcl-rate-fee-add') { const form = document.querySelector('[data-fcl-form="rate-save"]'); if (form) captureRateForm(form); rateDraft.rates[Number(button.dataset.index)].additional_fees.push({ name:'', group:'C', service:'delivery', cost_price:null, currency:'USD', note:null, unit:'SHIPMENT', container_type:null }); ratePreview = null; rateDirty=true; rerender(); return true; }
    if (name === 'fcl-rate-fee-remove') { const form = document.querySelector('[data-fcl-form="rate-save"]'); if (form) captureRateForm(form); rateDraft.rates[Number(button.dataset.index)].additional_fees.splice(Number(button.dataset.fee),1); ratePreview = null; rateDirty=true; rerender(); return true; }
    if (name === 'fcl-manual-add') { const form = document.querySelector('[data-fcl-form="quote-save"]'); if (form) captureQuoteForm(form); quoteDraft.manual_fees.push(blankManualFee()); quoteDirty = true; rerender(); return true; }
    if (name === 'fcl-manual-remove') { const form = document.querySelector('[data-fcl-form="quote-save"]'); if (form) captureQuoteForm(form); quoteDraft.manual_fees.splice(Number(button.dataset.index), 1); quoteDirty = true; rerender(); return true; }
    if (name === 'fcl-rate-save') { const form = document.querySelector('[data-fcl-form="rate-save"]'); if (form) await submit(form); return true; }
    if (name === 'fcl-cases-more') { if (casesNextCursor) await loadCases(casesNextCursor, true); return true; }
    if (name === 'fcl-rate-preview') { if (rateDirty) { message = '请先保存运价草稿，再预览服务器版本。'; rerender(); return true; } const response = await call('rate-preview', null, 'GET'); if (e !== epoch) return true; ratePreview = response.data; message = response.data?.can_publish ? '预览通过，可确认发布。' : `预览未通过：${response.reason_codes.map(fclIssue).join('、') || response.data?.blockers?.join('、') || '请核对草稿'}`; if (!response.data) notify(message, true); rerender(); return true; }
    if (name === 'fcl-rate-publish') {
      if (!ratePreview?.preview_hash || !confirm('确认发布当前运价草稿？发布后报价来源会更新。')) return true;
      const response = await write('rate-publish', { expected_version: rateView.version, preview_hash: ratePreview.preview_hash, confirmation: 'reviewed_sources_and_conditions' });
      if (e !== epoch) return true;
      if (response.data) { rateView = response.data; rateDraft = clone(response.data.draft); ratePreview = null; clearCaseDependents(); }
      message = responseMessage(response, '运价已发布；请重新匹配报价来源。', '发布已保存，但仍需人工复核。'); rerender(); return true;
    }
    if (name === 'fcl-rate-disable') { if (!confirm('停用当前 FCL 运价发布？')) return true; const response = await write('rate-disable', { expected_version: rateView.version }); if (e !== epoch) return true; if (response.data) { rateView = response.data; rateDraft = clone(response.data.draft); ratePreview = null; clearCaseDependents(); } message = responseMessage(response, '当前运价发布已停用。', '停用请求已保存，但仍需人工复核。'); rerender(); return true; }
    if (name === 'fcl-rate-rollback') {
      const releaseId = button.dataset.release;
      if (!releaseId || !confirm('按所选历史版本创建新的 FCL 发布？')) return true;
      const preview = await call('rate-preview', null, 'GET', `?release_id=${encodeURIComponent(releaseId)}`);
      if (e !== epoch) return true;
      if (!preview.data?.preview_hash || !preview.data.can_publish) { message = `历史版本预览未通过：${preview.reason_codes.map(fclIssue).join('、') || preview.data?.blockers?.join('、') || '不可回退'}`; rerender(); return true; }
      const response = await write('rate-rollback', { expected_version: rateView.version, preview_hash: preview.data.preview_hash, confirmation: 'reviewed_sources_and_conditions', release_id: releaseId });
      if (e !== epoch) return true;
      if (response.data) { rateView = response.data; rateDraft = clone(response.data.draft); ratePreview = null; clearCaseDependents(); }
      message = responseMessage(response, '已按历史版本创建新的发布。', '回退已保存，但仍需人工复核。'); rerender(); return true;
    }
    if (['fcl-match','fcl-select-candidate'].includes(name) && quoteDirty && !window.confirm('重新选择运价会清空尚未保存的费用和售价。是否继续？')) return true;
    if (name === 'fcl-match') {
      const response = await call('quote-match', { contract_version: QUOTE_VERSION, case_ref: detail.case_id, expected_case_version: detail.case_version, expected_customer_supplement_ref: detail.review_context.latest_customer_supplement_ref, selected_rate_id: selectedRateId });
      if (e !== epoch) return true;
      matchResult = response; quoteDraft = response.status === 'success' && response.data.selected ? blankQuoteDraft(response.data.selected) : null; editingQuoteRef = quoteView?.case_binding.case_ref === detail.case_id && response.status === 'success' ? quoteView.quote_ref : null; message = response.status === 'success' ? '匹配成功，请核对客户售价。' : `匹配未完成：${response.reason_codes.map(fclIssue).join('、') || '请按状态处理'}`; if (!response.data) notify(message, true); rerender(); return true;
    }
    if (name === 'fcl-select-candidate') {
      const selected = document.querySelector('input[name="fcl-rate-candidate"]:checked');
      if (!selected) { message = '请先选择一个来源候选。'; rerender(); return true; }
      selectedRateId = selected.value;
      const response = await call('quote-match', { contract_version: QUOTE_VERSION, case_ref: detail.case_id, expected_case_version: detail.case_version, expected_customer_supplement_ref: detail.review_context.latest_customer_supplement_ref, selected_rate_id: selectedRateId });
      if (e !== epoch) return true;
      matchResult = response; quoteDraft = null; editingQuoteRef = quoteView?.case_binding.case_ref === detail.case_id && response.status === 'success' ? quoteView.quote_ref : null; message = response.status === 'success' ? '已按所选来源匹配，请核对客户售价。' : `所选来源仍无法完成匹配：${response.reason_codes.map(fclIssue).join('、') || '请人工复核'}`; rerender(); return true;
    }
    if (name === 'fcl-edit-quote') { beginQuoteEdit(); quoteDirty = false; message = '正在编辑当前报价。保存后会保留新的版本，历史报价仍可查看。'; rerender(); return true; }
    if (name === 'fcl-quote-open-history') { const target = Number(document.querySelector(`[data-fcl-quote-version="${button.dataset.quote}"]`)?.value || button.dataset.version); const response = await call('quote-get', { contract_version: DOCUMENT_VERSION, quote_ref: button.dataset.quote, version: target }); if (e !== epoch) return true; if (response.data) { quoteHistoryView = response.data; message = `正在只读查看报价 v${quoteHistoryView.version}。`; rerender(); } else { message = responseMessage(response, '', ''); rerender(); } return true; }
    if (['fcl-doc-save','fcl-doc-review','fcl-doc-approve','fcl-doc-reject','fcl-doc-export','fcl-handoff'].includes(name) && blockUnsavedQuote()) return true;
    if (blockUnsavedDocumentDisplay(name)) return true;
    if (name === 'fcl-doc-save') {
      if (!quoteView) return true;
      const displayForm = document.querySelector('[data-fcl-form="document-display"]');
      if (displayForm) captureFormDraft(displayForm);
      const currentDocument = documentView?.case_binding.case_ref === detail.case_id && !documentView.historical ? documentView : null;
      const operation = nextDocumentOperation(currentDocument);
      const display = documentDisplayDraft || currentDocument?.customer_input || {};
      const body = {
        contract_version: DOCUMENT_VERSION,
        operation,
        ...(currentDocument ? { document_id: currentDocument.document_id, expected_document_version: currentDocument.version } : {}),
        quote_ref: quoteView.quote_ref,
        expected_quote_version: quoteView.version,
        expected_quote_digest: quoteView.content_digest,
        expected_case_version: detail.case_version,
        expected_customer_supplement_ref: detail.review_context.latest_customer_supplement_ref,
        expected_config_version: configView?.version ?? 0,
        quote_no: display.quote_no || `FCL-${detail.inquiry_no}`,
        quote_date: display.quote_date || model().session?.fcl_capability?.business_date || new Date().toISOString().slice(0, 10),
        valid_until: display.valid_until || quoteView.source_snapshot.valid_until,
        remark: display.remark ?? null,
      };
      const response = await write('document-save', body);
      if (e !== epoch) return true;
      if (response.data) { documentView = response.data; documentDisplayDraft = null; documentDisplayDirty = false; reviewView = null; exportView = null; requestRelatedRefresh(); }
      message = responseMessage(response, response.data ? `报价单 v${response.data.version} 已保存。` : '报价单未保存。', response.data ? `报价单 v${response.data.version} 已保存为待补状态。` : '报价单未保存。'); rerender(); return true;
    }
    if (name === 'fcl-doc-review') { const response = await call('document-review', { contract_version: DOCUMENT_VERSION, document_id: documentView.document_id, expected_version: documentView.version }); if (e !== epoch) return true; if (response.data) { reviewView = response.data; exportView = null; } message = responseMessage(response, '核对结果已生成；编辑或来源变化后需要重新核对。', '核对结果仍待人工处理。'); rerender(); return true; }
    if (name === 'fcl-doc-approve') { if (!reviewView) return true; const response = await write('document-approve', { contract_version: DOCUMENT_VERSION, document_id: documentView.document_id, expected_version: documentView.version, review_hash: reviewView.review_hash, confirmed: true }); if (e !== epoch) return true; if (response.data) { documentView = response.data; reviewView = null; exportView = null; requestRelatedRefresh(); } message = responseMessage(response, '人工确认已保存；审核不会由保存自动触发。', '审核已保存，但仍需人工处理。'); rerender(); return true; }
    if (name === 'fcl-doc-reject') { const reason = window.prompt('填写退回原因（将保留在报价单审核记录中）'); if (!reason?.trim()) return true; const response = await write('document-reject', { contract_version: DOCUMENT_VERSION, document_id: documentView.document_id, expected_version: documentView.version, reason: reason.trim() }); if (e !== epoch) return true; if (response.data) { documentView = response.data; reviewView = null; exportView = null; requestRelatedRefresh(); } message = responseMessage(response, '报价单已退回；修正后可重新提交。', '退回已保存，但仍需人工处理。'); rerender(); return true; }
    if (name === 'fcl-doc-export') {
      const response = await write('document-export', { contract_version: DOCUMENT_VERSION, mode: 'formal', document_id: documentView.document_id, expected_version: documentView.version });
      if (e !== epoch) return true;
      if (response.status !== 'success' || !response.data) { message = responseMessage(response, '', ''); rerender(); return true; }
      const bytes = await verifyPdfOutput(response.data);
      if (e !== epoch) return true;
      exportView = response.data;
      downloadPdf(bytes, response.data.filename);
      message = `正式 PDF 已生成、校验并开始下载：${exportView.sha256.slice(0, 12)}…`;
      rerender(); return true;
    }
    if (name === 'fcl-doc-open-history') {
      const target = Number(document.querySelector(`[data-fcl-doc-version="${button.dataset.document}"]`)?.value || button.dataset.version);
      const response = await call('document-get', { contract_version: DOCUMENT_VERSION, document_id: button.dataset.document, version: target });
      if (e !== epoch) return true;
      if (response.data) { documentView = response.data; reviewView = null; exportView = null; message = `正在查看报价单 v${documentView.version}${documentView.historical ? '（历史版本）' : ''}。`; rerender(); }
      else { message = responseMessage(response, '', ''); rerender(); }
      return true;
    }
    if (name === 'fcl-doc-export-history') {
      const target = Number(document.querySelector(`[data-fcl-doc-version="${button.dataset.document}"]`)?.value || button.dataset.version);
      const response = await write('document-export', { contract_version: DOCUMENT_VERSION, mode: 'history', document_id: button.dataset.document, target_version: target, expected_current_version: Number(button.dataset.currentVersion) });
      if (e !== epoch) return true;
      if (response.status !== 'success' || !response.data) { message = responseMessage(response, '', ''); rerender(); return true; }
      const bytes = await verifyPdfOutput(response.data);
      if (e !== epoch) return true;
      downloadPdf(bytes, response.data.filename);
      message = `历史 PDF v${response.data.version} 已校验并开始下载。`; rerender(); return true;
    }
    if (name === 'fcl-handoff') {
      const handoffForm = document.querySelector('[data-fcl-form="handoff-note"]');
      if (handoffForm) captureFormDraft(handoffForm);
      const noteValue = handoffDraft.trim();
      if (!noteValue) { message = '请填写内部交接备注。'; rerender(); return true; }
      if (!exportView || !documentView || !quoteView) { message = '请先导出并校验当前正式 PDF。'; rerender(); return true; }
      if (exportView.document_id !== documentView.document_id || exportView.version !== documentView.version || exportView.valid_now !== true || documentView.state !== 'approved') { message = '当前正式 PDF 与已批准报价单不一致，请重新导出。'; rerender(); return true; }
      const response = await write('handoff-save', { contract_version: HANDOFF_VERSION, case_ref: detail.case_id, expected_case_version: detail.case_version, expected_customer_supplement_ref: detail.review_context.latest_customer_supplement_ref, quote_ref: quoteView.quote_ref, expected_quote_version: quoteView.version, expected_quote_digest: quoteView.content_digest, document_id: documentView.document_id, expected_document_version: documentView.version, expected_pdf_sha256: exportView.sha256, confirmed: true, note: noteValue });
      if (e !== epoch) return true;
      if (response.data) { handoffView = response.data; handoffDraft = ''; handoffDirty = false; requestRelatedRefresh(); }
      message = responseMessage(response, '交接事件已记录，未创建 Booking/SO。', '交接仍待人工处理。'); rerender(); return true;
    }
    return false;
  };

  return {
    page,
    reset,
    submit,
    action,
    change: (event) => {
      const form = event.target.closest('[data-fcl-form]');
      if (!form) return false;
      captureFormDraft(form);
      return false;
    },
    toggle: (event) => {
      if (event.target.matches('details.fcl-operations')) operationsOpen = event.target.open;
      return false;
    },
    input: (event) => {
      const form = event.target.closest('[data-fcl-form]');
      if (!form) return false;
      captureFormDraft(form);
      return false;
    },
    isDirty,
    canLeave: () => {
      if (!isDirty()) return true;
      if (!window.confirm('当前 FCL 有未保存修改，确定丢弃并离开吗？')) return false;
      discardDrafts();
      return true;
    },
  };
}
