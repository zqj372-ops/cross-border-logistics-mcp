import {
  createDraft, serviceOptions, selectedServices, needsOrigin, escapeHtml as esc,
  validateStep, reconcileErrors, shipmentLines, buildInquiry, CARGO_LABELS, SITE_LABELS, UNLOADING_LABELS,
} from './model.ts';

const root = document.querySelector('#inquiry');
const drafts = { shipping: createDraft(), business: createDraft('business') };
let mode = location.hash === '#business' ? 'business' : 'shipping';
let step = 1;
let errors = {};
let generated = null;
let submitted = null;
let submitting = false;
let submitMessage = '';
let loginRequired = false;
const submissionKeys = new Map();
async function submitInquiry() {
  if (submitting) return;
  submitting = true; submitMessage = ''; loginRequired = false;
  const snapshot = structuredClone(draft()), fingerprint = JSON.stringify(snapshot);
  if (!submissionKeys.has(fingerprint)) submissionKeys.set(fingerprint, crypto.randomUUID());
  render();
  try {
    const sessionResponse = await fetch('/console/api/v1/session', { credentials: 'same-origin' });
    if (!sessionResponse.ok) throw new Error('unavailable');
    const session = await sessionResponse.json();
    if (!session.authenticated) { loginRequired = true; throw new Error('login'); }
    const response = await fetch('/console/api/v1/cases', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token, 'idempotency-key': submissionKeys.get(fingerprint) }, body: fingerprint });
    const result = await response.json();
    if (!response.ok || result.status !== 'success') {
      const code = result.reason_codes?.[0];
      if (response.status === 401) loginRequired = true;
      throw new Error(code || 'unavailable');
    }
    submitted = result.data;
  } catch (error) {
    submitMessage = loginRequired ? '请先登录以保存需求和查看进度。已填写资料保留在当前页面，登录后返回此页再次提交。' : error.message === 'case_daily_limit' ? '今日提交次数已达上限，请稍后再试。' : '暂未确认提交成功。请重试；同一份需求不会重复创建。也可选择生成邮件联系。';
  } finally { submitting = false; render({ focus: true }); }
}
const draft = () => drafts[mode];
const isBusiness = () => mode === 'business';
const icons = {
  truck: '<path d="M3 6h11v11H3zM14 10h4l3 4v3h-7M5 17a2 2 0 1 0 4 0m7 0a2 2 0 1 0 4 0"/>',
  container: '<path d="M3 5h18v14H3zM7 8v8m5-8v8m5-8v8"/>',
  document: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h4"/>',
  warehouse: '<path d="m3 10 9-7 9 7v11H3zM8 21V11h8v10M8 15h8m-8 3h8"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`; }
function error(id) { return errors[id] ? `<p class="field-error" id="error-${id}">${esc(errors[id])}</p>` : ''; }
function invalid(id) { return errors[id] ? ` aria-invalid="true" aria-describedby="error-${id}"` : ''; }
function input(id, label, { type = 'text', placeholder = '', optional = false, autocomplete = 'off', maxlength = 200, inputmode = '', disabled = false } = {}) {
  return `<div class="field"><label for="${id}">${label}${optional ? '<span class="optional">选填</span>' : ''}</label><input id="${id}" name="${id}" type="${type}" value="${esc(draft()[id])}" placeholder="${placeholder}" autocomplete="${autocomplete}" maxlength="${maxlength}"${inputmode ? ` inputmode="${inputmode}"` : ''}${disabled ? ' disabled' : ''}${invalid(id)}>${error(id)}</div>`;
}
function select(id, label, options) {
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${id}"${invalid(id)}>${Object.entries(options).map(([value, text]) => `<option value="${value}"${draft()[id] === value ? ' selected' : ''}>${text}</option>`).join('')}</select>${error(id)}</div>`;
}
function unknown(id) {
  const label = { containerCount: '柜数', volume: '总体积', weight: '总毛重' }[id];
  return `<label class="check-small"><input type="checkbox" name="${id}Unknown" aria-label="${label}待确认" data-rebuild${draft()[`${id}Unknown`] ? ' checked' : ''}>待确认</label>`;
}
function notes(required = false) {
  return `<div class="field"><label for="notes">${required ? '办理需求' : '补充说明'}${required ? '' : '<span class="optional">选填</span>'}</label><textarea id="notes" name="notes" rows="3" maxlength="4000" placeholder="${required ? '请简要说明需要办理的事项' : '例如：预计时效、送仓要求，或其他需要协助的事项'}"${invalid('notes')}>${esc(draft().notes)}</textarea>${error('notes')}</div>`;
}
function serviceStep() {
  return `<h2 id="step-title" tabindex="-1">${isBusiness() ? '需要办理什么？' : '需要哪些服务？'}</h2><p class="section-intro">可多选，按实际需要选择。</p>
    <fieldset id="services" class="service-list"${invalid('services')}><legend class="sr-only">选择需要的服务</legend>${serviceOptions(draft()).map(service => `<label class="service-choice"><input type="checkbox" name="services" value="${service.id}"${draft().services.includes(service.id) ? ' checked' : ''}><span class="service-icon">${icon(service.icon)}</span><span><strong>${service.name}</strong><small>${service.description}</small></span></label>`).join('')}</fieldset>${error('services')}
    <div class="secondary-links"><a href="/inquiry/details/" target="_blank" rel="noopener">全部服务与费用 <span aria-hidden="true">↗</span></a><a href="${isBusiness() ? '#' : '#business'}">${isBusiness() ? '返回海运询价' : '企业与合规服务'} <span aria-hidden="true">→</span></a></div>`;
}
function cargoStep() {
  if (isBusiness()) return `<h2 id="step-title" tabindex="-1">说明办理需求</h2><p class="section-intro">写下需要协助的事项，具体资料后续确认。</p>${input('businessRegion', '办理地区', { optional: true, placeholder: '例如：加拿大 · 安大略省', maxlength: 160 })}${notes(true)}`;
  const d = draft();
  return `<h2 id="step-title" tabindex="-1">填写运输信息</h2><p class="section-intro">先填写已知信息，数量和日期可待确认。</p>
    <fieldset id="transportMode" class="transport-field"${invalid('transportMode')}><legend>运输方式</legend><div class="mode-options">${[['fcl', '整柜'], ['lcl', '拼箱'], ['unsure', '还不确定']].map(([value, label]) => `<label><input type="radio" name="transportMode" value="${value}" data-rebuild${d.transportMode === value ? ' checked' : ''}>${label}</label>`).join('')}</div>${error('transportMode')}</fieldset>
    <div class="field-grid">${needsOrigin(d) ? input('origin', '中国起运地', { placeholder: '城市或提货地区' }) : ''}${input('destination', '加拿大目的地', { placeholder: '城市、邮编或港口' })}</div>
    <div class="field-grid">${input('product', '货物品名', { placeholder: '例如：家具、服装' })}${input('readyDate', needsOrigin(d) ? '预计出货日期' : '预计服务日期', { type: 'date', optional: true })}</div>
    ${d.transportMode === 'fcl' ? `<div class="field-grid cargo-quantity">${select('containerType', '柜型', { '': '请选择', '20GP': '20GP · 20 尺普柜', '40GP': '40GP · 40 尺普柜', '40HQ': '40HQ · 40 尺高柜', '45HQ': '45HQ · 45 尺高柜', unknown: '待确认' })}<div>${input('containerCount', '柜数', { inputmode: 'numeric', placeholder: '例如：1', maxlength: 9, disabled: d.containerCountUnknown })}${unknown('containerCount')}</div></div>` : ''}
    ${d.transportMode === 'lcl' ? `<div class="field-grid cargo-quantity"><div>${input('volume', '总体积（m³）', { inputmode: 'decimal', placeholder: '例如：12.5', maxlength: 20, disabled: d.volumeUnknown })}${unknown('volume')}</div><div>${input('weight', '总毛重（kg）', { inputmode: 'decimal', placeholder: '例如：1800', maxlength: 20, disabled: d.weightUnknown })}${unknown('weight')}</div></div>` : ''}
    ${select('cargoType', '货物属性', CARGO_LABELS)}
    ${d.services.includes('warehouse') ? `<details class="extra-fields"${errors.palletCount || errors.skuCount ? ' open' : ''}><summary>补充仓储资料<span>选填</span></summary><div class="field-grid">${input('palletCount', '托盘数量', { inputmode: 'numeric', maxlength: 9 })}${input('skuCount', 'SKU 数量', { inputmode: 'numeric', maxlength: 9 })}</div></details>` : ''}
    ${d.services.includes('delivery') ? `<details class="extra-fields"><summary>补充派送要求<span>选填</span></summary><div class="field-grid">${select('deliverySite', '收货场所', SITE_LABELS)}${select('unloading', '卸货安排', UNLOADING_LABELS)}</div></details>` : ''}
    ${notes()}`;
}
function reviewContent() {
  const d = draft();
  return `<div class="review-block"><div class="review-heading"><h3>已选服务</h3><button type="button" class="text-button" data-step="1">修改服务</button></div><p>${selectedServices(d).map(service => esc(service.name)).join('、')}</p></div>
    <div class="review-block"><div class="review-heading"><h3>${isBusiness() ? '办理信息' : '运输信息'}</h3><button type="button" class="text-button" data-step="2">修改信息</button></div><dl class="review-grid">${shipmentLines(d).map(line => { const [label, ...value] = line.split('：'); return `<div><dt>${esc(label)}</dt><dd>${esc(value.join('：'))}</dd></div>`; }).join('')}</dl>${d.notes.trim() ? `<p class="review-notes">${esc(d.notes)}</p>` : ''}</div>`;
}
function contactStep() {
  return `<h2 id="step-title" tabindex="-1">确认需求，留下联系方式</h2><p class="section-intro">提交后可在“我的询价”查看进度；具体费用由工作人员确认。</p>${reviewContent()}
    <div class="contact-fields"><div class="field-grid">${input('contactName', '联系人', { autocomplete: 'name', maxlength: 80 })}${input('email', '电子邮箱', { type: 'email', autocomplete: 'email', maxlength: 254 })}</div><div class="field-grid">${input('company', '公司名称', { optional: true, autocomplete: 'organization', maxlength: 160 })}${input('phone', '联系电话', { optional: true, type: 'tel', autocomplete: 'tel', maxlength: 80 })}</div></div>
    <label class="consent"><input id="consent" name="consent" type="checkbox"${draft().consent ? ' checked' : ''}${invalid('consent')}><span>我已核对以上需求；具体服务范围和费用待报价确认。</span></label>${error('consent')}`;
}
function summaryContent() {
  const d = draft();
  const services = selectedServices(d);
  const route = isBusiness() ? d.businessRegion.trim() : [needsOrigin(d) && d.origin.trim(), d.destination.trim()].filter(Boolean).join(' → ');
  return `<div class="summary-services">${services.length ? `<ul>${services.map(service => `<li><span aria-hidden="true">✓</span>${service.name}</li>`).join('')}</ul>` : '<p>选择服务后，在这里核对需求。</p>'}</div>${route || (!isBusiness() && d.product.trim()) ? `<div class="summary-route">${route ? `<p>${esc(route)}</p>` : ''}${!isBusiness() && d.product.trim() ? `<small>${esc(d.product)}</small>` : ''}</div>` : ''}<div class="quote-pending"><span>${isBusiness() ? '服务费' : '运费及服务费'}</span><strong>待报价</strong></div><p class="summary-note">具体费用根据货物、路线及服务要求确认。</p>`;
}
function refreshSummary() {
  const content = root.querySelector('#summary-content');
  if (content) content.innerHTML = summaryContent();
  const count = root.querySelector('#service-count');
  if (count) count.textContent = `${selectedServices(draft()).length} 项服务`;
}
function heading() {
  return `<div class="page-heading"><div><h1>${isBusiness() ? '企业与合规服务' : '加拿大海运询价'}</h1><p>${isBusiness() ? '说明办理需求，获取服务方案与报价。' : '选好服务，整理需求，获取报价。'}</p></div>${isBusiness() ? '<a class="back-link" href="#">返回海运询价 →</a>' : '<span class="route-label">中国 → 加拿大</span>'}</div>`;
}
function render({ focus = false, restore } = {}) {
  if (submitted) {
    root.innerHTML = `${heading()}<section class="generated submission-success"><div class="generated-heading"><span class="document-icon">${icon('document')}</span><div><h2 id="submitted-title" tabindex="-1">需求已提交</h2><p>工作人员收到后会跟进，您可随时查看进度。</p></div></div><dl class="mail-meta submission-meta"><div><dt>需求编号</dt><dd>${esc(submitted.case_id)}</dd></div><div><dt>当前状态</dt><dd>${({submitted:'待处理',in_review:'处理中',needs_input:'待补充',closed:'已结束',cancelled:'已取消'})[submitted.status]}</dd></div></dl><div class="mail-actions"><a class="button primary" href="/console/#case/${encodeURIComponent(submitted.case_id)}">查看询价进度</a><a class="button secondary" href="/console/#cases">我的询价</a></div><p class="mail-note">本次提交为询价需求，服务范围和费用仍待确认。</p></section>`;
    root.querySelector('#submitted-title')?.focus(); return;
  }
  if (generated) { renderGenerated(); return; }
  document.title = `${isBusiness() ? '企业与合规服务' : '加拿大海运询价'} · FreightClaw`;
  const steps = ['选择服务', isBusiness() ? '办理信息' : '运输信息', '确认询价'];
  root.innerHTML = `${heading()}<nav class="steps" aria-label="询价步骤"><ol>${steps.map((label, i) => `<li${step === i + 1 ? ' class="current"' : ''}><button type="button" data-step="${i + 1}"${step === i + 1 ? ' aria-current="step"' : ''}><span class="step-number">${i + 1 < step ? '✓' : i + 1}</span>${label}</button></li>`).join('')}</ol></nav>
    <form novalidate class="inquiry-layout" aria-busy="${submitting}"><section class="form-content" aria-labelledby="step-title">${Object.keys(errors).length ? '<p class="error-summary" role="alert">请检查下方标注的信息，再继续。</p>' : ''}${submitMessage ? `<div class="error-summary" role="alert">${esc(submitMessage)}${loginRequired ? ' <a href="/console/#cases" target="_blank" rel="noopener">登录账号 ↗</a>' : ''}</div>` : ''}${step === 1 ? serviceStep() : step === 2 ? cargoStep() : contactStep()}</section>
    <aside class="summary-panel"><details${matchMedia('(min-width: 960px)').matches ? ' open' : ''}><summary>询价摘要 <span id="service-count">${selectedServices(draft()).length} 项服务</span></summary><div id="summary-content">${summaryContent()}</div></details></aside>
    <div class="actions">${step > 1 ? '<button type="button" class="button secondary" data-back>上一步</button>' : '<span class="action-note">服务可单独询价</span>'}<button type="submit" class="button primary"${submitting ? ' disabled' : ''}>${step === 3 ? (submitting ? '正在提交…' : '提交询价') : `下一步：${steps[step]}`}<span aria-hidden="true">→</span></button></div>${step === 3 ? '<button type="button" class="text-button" data-email>通过邮件询价</button>' : ''}</form>`;
  if (submitting) root.querySelectorAll('input, select, textarea, button').forEach(control => { control.disabled = true; });
  if (restore) root.querySelector(restore)?.focus({ preventScroll: true });
  else if (focus) {
    const firstError = root.querySelector('[aria-invalid="true"]');
    const target = firstError?.matches('fieldset') ? firstError.querySelector('input') : firstError;
    (target || root.querySelector('#step-title'))?.focus();
    if (!firstError) root.scrollIntoView({ block: 'start' });
  }
}
function renderGenerated() {
  const g = generated;
  root.innerHTML = `${heading()}<section class="generated" aria-labelledby="generated-title"><div class="generated-heading"><span class="document-icon">${icon('document')}</span><div><h2 id="generated-title" tabindex="-1">询价邮件已生成，尚未发送</h2><p>打开邮件应用或复制内容，确认后发送给我们。</p></div></div><dl class="mail-meta"><div><dt>收件人</dt><dd>${esc(g.recipient)}</dd></div><div><dt>主题</dt><dd>${esc(g.subject)}</dd></div></dl><details class="mail-preview" open><summary>查看邮件内容</summary><pre>${esc(g.body)}</pre></details>
    <div class="mail-actions">${g.mailto ? `<a class="button primary" href="${esc(g.mailto)}">用邮件应用打开 <span aria-hidden="true">↗</span></a>` : '<p class="long-mail-note">内容较长，请复制完整邮件内容后发送。</p>'}<button type="button" class="button secondary" data-copy>复制完整询价</button><button type="button" class="text-button" data-edit>返回修改</button></div><p id="copy-status" class="copy-status" role="status"></p><div id="manual-copy"></div><p class="mail-note">打开邮件应用不会自动发送。此邮件方式尚未保存线上需求，请在邮件中完成发送。</p></section>`;
  root.querySelector('#generated-title').focus();
  root.scrollIntoView({ block: 'start' });
}
function capture(event) {
  const el = event.target;
  if (submitting || !el.name || !(el.name in draft())) return;
  if (el.name === 'services') {
    draft().services = [...root.querySelectorAll('input[name="services"]:checked')].map(input => input.value);
  } else draft()[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  // Changing a reviewed request requires the user to confirm it again.
  if (el.name !== 'consent') draft().consent = false;
  if (el.hasAttribute('data-rebuild') && event.type === 'change') {
    const selector = `[name="${el.name}"]${el.type === 'radio' ? `[value="${el.value}"]` : ''}`;
    errors = reconcileErrors(draft(), step, errors);
    render({ restore: selector });
  } else {
    const consent = root.querySelector('#consent');
    if (consent && el.name !== 'consent') consent.checked = false;
    refreshSummary();
  }
}
root.addEventListener('input', capture);
root.addEventListener('change', capture);
root.addEventListener('submit', async event => {
  event.preventDefault();
  errors = validateStep(draft(), step);
  if (Object.keys(errors).length) { render({ focus: true }); return; }
  if (step < 3) step += 1;
  else {
    for (let previous = 1; previous < 3; previous++) {
      errors = validateStep(draft(), previous);
      if (Object.keys(errors).length) { step = previous; render({ focus: true }); return; }
    }
    await submitInquiry(); return;
  }
  render({ focus: true });
});
root.addEventListener('click', async event => {
  const el = event.target.closest('button');
  if (!el || submitting) return;
  if (el.hasAttribute('data-email')) { errors = validateStep(draft(), 3); if (Object.keys(errors).length) { render({ focus: true }); return; } generated = buildInquiry(draft()); render(); return; }
  if (el.hasAttribute('data-step') || el.hasAttribute('data-back')) {
    const target = el.hasAttribute('data-back') ? step - 1 : Number(el.dataset.step);
    for (let previous = 1; previous < target; previous++) {
      errors = validateStep(draft(), previous);
      if (Object.keys(errors).length) { step = previous; render({ focus: true }); return; }
    }
    errors = {}; step = target; render({ focus: true });
  } else if (el.hasAttribute('data-edit')) {
    generated = null; step = 3; draft().consent = false; render({ focus: true });
  } else if (el.hasAttribute('data-copy')) {
    const request = generated;
    const copy = request.copyText;
    try {
      await navigator.clipboard.writeText(copy);
      if (generated !== request) return;
      root.querySelector('#copy-status').textContent = '已复制完整询价，请粘贴到邮件中发送。';
    } catch {
      if (generated !== request) return;
      root.querySelector('#copy-status').textContent = '浏览器未允许自动复制，请选中下方内容手动复制。';
      root.querySelector('#manual-copy').innerHTML = `<label class="manual-copy">完整询价<textarea readonly rows="8">${esc(copy)}</textarea></label>`;
      const area = root.querySelector('#manual-copy textarea'); area.focus(); area.select();
    }
  }
});
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault(); root.focus(); root.scrollIntoView({ block: 'start' });
});
window.addEventListener('hashchange', () => {
  mode = location.hash === '#business' ? 'business' : 'shipping';
  step = 1; errors = {}; generated = null; submitted = null; submitMessage = ''; render({ focus: true });
});
render();
