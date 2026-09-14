import { shipmentLines, selectedServices } from '../inquiry/model.ts';
import { CASE_LINK_VERSION, caseResponseV2Schema } from '../../services/access-gateway/portal/case-contracts.ts';

const statuses = { submitted: '待处理', in_review: '处理中', needs_input: '待补充', closed: '已结束', cancelled: '已取消' };
export function createCasesUi({ api, mutate, head, panel, empty, esc, date, icon, formError, rerender, model, openLinkedQuote }) {
  let generation = 0, scope = '', cache = new Map(), filter = '', cursor = '', linkedConfirmation = { caseId: '', ref: null, checked: false };
  function reset() { generation++; cache.clear(); filter = ''; cursor = ''; linkedConfirmation = { caseId: '', ref: null, checked: false }; }
  function sync() { const state = model(); const next = JSON.stringify([state.sessionGeneration, state.session?.identity?.user_id, state.session?.organization_id]); if (next !== scope) { scope = next; reset(); } }
  function load(path) {
    sync();
    if (!cache.has(path)) {
      const record = { loading: true }; const epoch = generation; cache.set(path, record);
      api(path).then(result => { if (epoch === generation) { record.result = result; record.data = result.data; record.version = result.schema_version; } }).catch(error => { if (epoch === generation) record.error = error; }).finally(() => { if (epoch === generation) { record.loading = false; rerender(); } });
    }
    return cache.get(path);
  }
  const refresh = '<button type="button" class="button" data-action="case-refresh">刷新进度</button>';
  const label = value => `<span class="badge ${value === 'needs_input' ? 'warning' : value === 'in_review' ? 'info' : ''}">${statuses[value] || esc(value)}</span>`;
  function loading(record) {
    if (record.loading) return '<div class="case-loading" role="status">正在读取询价记录…</div>';
    if (record.error) return empty('暂时无法读取询价', record.error.code === 'cases_unavailable' ? '询价受理尚未在当前环境启用，请稍后重试。' : '请确认登录状态与操作权限，再刷新重试。', refresh);
    return '';
  }
  function page(management = false) {
    const path = `/cases?management=${management}${filter ? `&status=${filter}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const record = load(path);
    const heading = head(management ? '询价管理' : '我的询价', management ? '接收需求、跟进处理，让客户及时看到进展。' : '查看已提交的需求，跟进处理进度。', management ? refresh : '<a class="button primary" href="/inquiry/">发起询价</a>');
    const filters = `<div class="case-toolbar"><nav aria-label="询价状态" class="case-filters">${[['', '全部'], ...Object.entries(statuses)].map(([value, title]) => `<button type="button" class="button ${filter === value ? 'primary' : ''}" data-action="case-filter" data-status="${value}" aria-pressed="${filter === value}">${title}</button>`).join('')}</nav>${management ? '' : refresh}</div>`;
    const pending = loading(record); if (pending) return heading + filters + pending;
    const items = record.data.items;
    if (!items.length) return heading + filters + empty(filter ? '暂无此状态的询价' : management ? '还没有收到询价' : '还没有提交询价', filter ? '可以切换状态查看其他需求。' : management ? '客户提交后，需求和联系方式会出现在这里。' : '整理运输需求并提交，后续进展都会保存在这里。', management || filter ? '' : '<a class="button primary" href="/inquiry/">开始询价</a>');
    return heading + filters + `<div class="case-list">${items.map(item => `<a class="case-card" href="#case/${encodeURIComponent(item.case_id)}"><span class="case-card-icon">${icon(item.input.mode === 'business' ? 'file' : 'truck')}</span><div class="case-card-body"><div class="case-card-top"><h2>${esc(item.input.product || '企业与合规服务')}</h2>${label(item.status)}</div><p>${esc([item.input.origin, item.input.destination || item.input.businessRegion].filter(Boolean).join(' → ') || '办理地区待确认')}</p><div class="case-meta"><span>${esc(selectedServices(item.input).map(s => s.name).join(' · '))}</span><span>${management ? esc(item.input.contactName) + ' · ' : ''}${date(item.updated_at)}</span></div><span class="case-reference">需求编号 ${esc(item.case_id)}</span></div><span class="case-arrow" aria-hidden="true">${icon('arrow')}</span></a>`).join('')}</div><div class="case-pagination">${cursor ? '<button class="button" data-action="case-first">返回第一页</button>' : ''}${record.data.next_cursor ? `<button class="button" data-action="case-next" data-cursor="${esc(record.data.next_cursor)}">下一页</button>` : ''}</div>`;
  }
  function detail(id) {
    const record = load(`/cases/${encodeURIComponent(id)}`), pending = loading(record);
    if (pending) return head('询价详情', '查看需求与处理进展。', refresh) + pending;
    const base = record.data, linkable = Boolean(base.can_manage);
    const linkedRecord = linkable ? load(`/cases/${encodeURIComponent(id)}?contract_version=${encodeURIComponent(CASE_LINK_VERSION)}`) : null;
    const snapshot = linkedRecord && !loading(linkedRecord) && !linkedRecord.error ? linkedRecord : null;
    const parsed = snapshot ? caseResponseV2Schema.safeParse(snapshot.result) : { success: false };
    const view = parsed.success ? parsed.data.data : null;
    const ref = view ? view.review_context.latest_customer_supplement_ref : undefined;
    const visibleRef = ref == null || Boolean((view?.events || []).some(event => event.visibility === 'customer' && event.event_id === ref));
    const linkedReady = Boolean(view) && visibleRef;
    const item = linkedReady ? view : base, d = item.input;
    const derived = linkedReady ? ref : undefined;
    if (derived !== undefined && (linkedConfirmation.caseId !== id || linkedConfirmation.ref !== derived)) linkedConfirmation = { caseId: id, ref: derived, checked: false };
    const confirmed = derived !== undefined && linkedConfirmation.checked && linkedConfirmation.caseId === id && linkedConfirmation.ref === derived;
    const rows = [...shipmentLines(d), `联系人：${d.contactName}`, `邮箱：${d.email}`, ...(d.company ? [`公司：${d.company}`] : []), ...(d.phone ? [`电话：${d.phone}`] : [])];
    const info = panel('需求资料', selectedServices(d).map(s => s.name).join(' · '), `<div class="panel-body"><dl class="case-details">${rows.map(line => { const [title, ...value] = line.split('：'); return `<div><dt>${esc(title)}</dt><dd>${esc(value.join('：'))}</dd></div>`; }).join('')}</dl>${d.notes ? `<div class="case-notes"><h3>补充说明</h3><p>${esc(d.notes)}</p></div>` : ''}</div>`);
    const timeline = panel('处理进展', '按时间保留每次处理与补充记录', `<ol class="case-timeline">${item.events.map(event => `<li><div class="case-event-head"><strong>${esc(event.actor_label)}${event.visibility === 'internal' ? ' · 仅后台可见' : ''}</strong><time>${date(event.created_at)}</time></div><p>${esc(event.message)}</p><small>${statuses[event.status]}</small></li>`).join('')}</ol>`);
    const question = [...item.events].reverse().find(event => event.visibility === 'customer' && event.status === 'needs_input');
    let form = '';
    if (item.can_manage && !['closed', 'cancelled'].includes(item.status)) form = panel('处理这票询价', '客户可见的进展将同步到他的询价详情。', `<form class="panel-body" data-form="case-update" data-id="${esc(id)}" data-version="${item.version}">${formError}<div class="field"><label for="case-status">处理状态</label><select id="case-status" name="status">${['in_review', 'needs_input', 'closed', 'cancelled'].map(value => `<option value="${value}"${value === item.status ? ' selected' : ''}>${statuses[value]}</option>`).join('')}</select></div><div class="field"><label for="case-public">告知客户的进展</label><textarea id="case-public" name="public_note" rows="3" maxlength="2000" required placeholder="例如：已收到需求，请补充货物包装方式。"></textarea></div><div class="field"><label for="case-internal">内部备注（选填）</label><textarea id="case-internal" name="internal_note" rows="2" maxlength="2000"></textarea><small>仅有处理权限的人员可见。</small></div><p class="muted">结束询价不代表已订舱或已发运。</p><div class="form-actions"><button class="button primary" type="submit">保存并同步进展</button></div></form>`);
    else if (item.can_reply) form = panel('补充资料', '工作人员需要更多信息，回复后会继续处理。', `<form class="panel-body" data-form="case-reply" data-id="${esc(id)}" data-version="${item.version}">${formError}${question ? `<div class="case-question"><h3>需要补充的信息</h3><p>${esc(question.message)}</p></div>` : ''}<div class="field"><label for="case-message">补充说明</label><textarea id="case-message" name="message" rows="4" maxlength="2000" required></textarea></div><div class="form-actions"><button class="button primary" type="submit">提交补充资料</button></div></form>`);
    const linked = !linkable || ['closed', 'cancelled'].includes(item.status) ? '' : panel('关联报价单', '由服务端派生最新客户补充；仅本企业有处理权限的人员可制作。', `<div class="panel-body">${linkedReady ? `<p>服务端已核对的最新客户补充：<code data-linked-ref data-ref="${esc(derived ?? '')}">${derived ? esc(derived) : '（无客户补充）'}</code></p><label><input type="checkbox" data-linked-confirm ${linkedConfirmation.checked ? 'checked' : ''}>我已核对本次显示的客户补充、需求资料与联系信息。</label><p class="muted">客户补充更新后本确认会自动失效，需重新读取并再次核对。</p><button type="button" class="button primary" data-action="case-linked-quote" data-id="${esc(id)}" data-ref="${esc(derived ?? '')}" ${confirmed ? '' : 'disabled'}>用自有运价制作关联报价单</button>` : linkedRecord?.error ? `<p class="muted">无法读取服务端复核上下文：${esc(linkedRecord.error.code || 'portal_unavailable')}。请稍后刷新重试；这不影响查看需求与进度。</p>` : snapshot && view && !visibleRef ? '<p class="muted">服务端引用的客户补充在当前 v2 快照中不可见，已拒绝仅凭引用编号确认；请刷新或联系管理员。</p>' : snapshot && !view ? '<p class="muted">服务端复核上下文不符合已审 case v2 合同，已拒绝按“无客户补充”继续。</p>' : '<p class="muted">正在读取服务端复核上下文…</p>'}</div>`);
    return `<a class="case-back" href="#${item.can_manage ? 'operations' : 'cases'}">${icon('back')}返回询价列表</a>` + head(d.product || '企业与合规服务', `需求编号 ${item.case_id}`, refresh) + `<div class="case-status-line">${label(item.status)}<span>创建于 ${date(item.created_at)}</span><span>费用待报价确认</span></div><div class="case-workspace"><div>${info}</div><div>${linked}${form}${timeline}</div></div>`;
  }
  function change(event) {
    if (!event.target.closest('[data-linked-confirm]')) return false;
    linkedConfirmation = { ...linkedConfirmation, checked: event.target.checked };
    rerender();
    return true;
  }
  async function action(button) {
    const action = button.dataset.action;
    if (action === 'case-linked-quote') {
      const id = button.dataset.id || '', ref = button.dataset.ref || '';
      const displayed = ref === '' ? null : ref;
      if (linkedConfirmation.caseId !== id || linkedConfirmation.ref !== displayed || !linkedConfirmation.checked) return true;
      if (!openLinkedQuote) throw Object.assign(new Error('linked_quote_unavailable'), { code: 'linked_quote_unavailable' });
      const handedOff = openLinkedQuote({ case_ref: id, reviewed_customer_event_ref: displayed });
      if (handedOff !== true) return true; // cancelled unsaved-input guard: keep the reviewed confirmation
      linkedConfirmation = { caseId: '', ref: null, checked: false };
      return true;
    }
    if (!['case-refresh', 'case-filter', 'case-next', 'case-first'].includes(action)) return false;
    generation++; cache.clear();
    if (action === 'case-filter') { filter = button.dataset.status; cursor = ''; }
    if (action === 'case-next') cursor = button.dataset.cursor;
    if (action === 'case-first') cursor = '';
    rerender(); return true;
  }
  async function submit(form) {
    if (!['case-update', 'case-reply'].includes(form.dataset.form)) return false;
    const data = new FormData(form), reply = form.dataset.form === 'case-reply';
    const payload = { expected_version: Number(form.dataset.version), ...(reply ? { message: String(data.get('message') || '').trim() } : { status: String(data.get('status')), public_note: String(data.get('public_note') || '').trim(), internal_note: String(data.get('internal_note') || '').trim() }) };
    if (!(reply ? payload.message : payload.public_note)) throw Object.assign(new Error('case_input_invalid'), { code: 'case_input_invalid' });
    await mutate(`/cases/${encodeURIComponent(form.dataset.id)}/${reply ? 'reply' : 'update'}`, 'POST', payload);
    generation++; cache.clear(); rerender(); return true;
  }
  return { page, detail, action, submit, change, reset };
}
