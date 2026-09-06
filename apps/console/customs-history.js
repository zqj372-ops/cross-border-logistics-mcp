export function createCustomsHistoryUi(ui) {
  const { esc, head, panel, note, date } = ui;
  const labels = { success: '已完成', manual_review: '需人工复核', needs_input: '需补充资料', blocked: '未获授权', unavailable: '来源不可用' };
  let state = { operation: 'customs.query', list: null, detail: null, loading: false }, generation = 0;
  const call = (action, input) => ui.api(`/business/customs/history/${action}`, { method: 'POST', body: { input }, acceptBusiness: true });
  const message = (result) => !result ? '' : result.status === 'success' ? '' : note(result.reason_codes?.includes('customs_history_source_unconfigured') ? '关务来源尚未接入历史记录服务。接入后可查看本人记录及原始版本。' : '暂时无法读取来源记录，请稍后重试或联系平台运维。', 'warning');
  async function load(more = false) {
    const ticket = generation;
    state.loading = true;
    try {
      const result = await call('list', { operation: state.operation, limit: 25, ...(more && state.list?.data?.next_cursor ? { cursor: state.list.data.next_cursor } : {}) });
      if (ticket !== generation) return;
      state.list = more && result.status === 'success' ? { ...result, data: { ...result.data, records: [...new Map([...(state.list?.data?.records || []), ...result.data.records].map(record => [record.record_ref, record])).values()] } } : result;
    } catch { if (ticket === generation) state.list = { status: 'unavailable' }; }
    finally { if (ticket === generation) { state.loading = false; ui.rerender(); } }
  }
  function page() {
    if (!state.list && !state.loading) void load();
    const rows = state.list?.data?.records || [], detail = state.detail?.data;
    const saved = detail?.input;
    const lines = detail?.operation === 'customs.query' ? detail.snapshot?.results || [] : detail?.snapshot?.result?.lines || [];
    return head('关务历史', '从关务来源读取本人查询与税费记录。') + `<form class="call-log-filters panel-body" data-form="customs-history-filter">${ui.formError}<label>记录类型<select name="operation"><option value="customs.query" ${state.operation === 'customs.query' ? 'selected' : ''}>关税与归类</option><option value="customs.tax.estimate" ${state.operation === 'customs.tax.estimate' ? 'selected' : ''}>税费估算</option></select></label><button class="button primary" type="submit">查询记录</button></form>` + panel('来源记录', '当前企业 · 仅本人有权恢复的记录', `${message(state.list)}${state.loading ? '<p class="panel-body" role="status">正在读取…</p>' : ''}${rows.length ? `<div class="table-wrap call-log-table" role="region" aria-label="来源记录，可横向滚动" tabindex="0"><table><thead><tr><th>时间</th><th>来源版本</th><th>结果</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(date(row.created_at))}</td><td class="call-log-request">${esc(row.data_version)}</td><td>${esc(labels[row.status])}</td><td><button class="button quiet" data-action="customs-history-open" data-id="${esc(row.record_ref)}">查看记录</button></td></tr>`).join('')}</tbody></table></div>` : state.list?.status === 'success' ? '<p class="panel-body">尚无来源记录。</p>' : ''}${state.list?.data?.next_cursor ? '<button class="button" data-action="customs-history-more">加载更多</button>' : ''}<button class="button quiet" data-action="customs-history-refresh">刷新</button>`) + (state.detail ? panel('历史记录详情', detail?.record.data_version || '来源读取未完成', `${message(state.detail)}${saved ? `<div class="panel-body">${note('以下内容是历史快照。重新使用前请核对日期，并提交查询以取得当前来源结果。', 'warning')}<dl class="detail-list"><dt>商品 / 编码</dt><dd>${esc(saved.query || saved.description || saved.hsCode)}</dd><dt>规则日期</dt><dd>${esc(saved.ruleDate)}</dd><dt>当时结果</dt><dd>${esc(labels[detail.record.status])}</dd><dt>来源记录</dt><dd class="call-log-request">${esc(detail.record.record_ref)}</dd></dl>${lines.length ? `<ul>${lines.map(line => `<li>${esc(line.country || line.label)}：${esc(line.code || line.rateExpressionRaw || '待确认')}${line.amount ? ` · ${esc(line.amount)}` : ''}</li>`).join('')}</ul>` : ''}<button class="button primary" data-action="customs-history-restore">恢复到查询表单</button></div>` : ''}`) : '');
  }
  async function action(button) {
    const name = button.dataset.action;
    if (!name?.startsWith('customs-history-')) return false;
    if (name === 'customs-history-open') { const ticket = generation; const result = await call('get', { operation: state.operation, record_ref: button.dataset.id }); if (ticket === generation) state.detail = result; }
    if (name === 'customs-history-more') await load(true);
    if (name === 'customs-history-refresh') { generation++; state.list = null; state.detail = null; state.loading = false; }
    if (name === 'customs-history-restore' && state.detail?.data) ui.restore(state.detail.data.operation, state.detail.data.input);
    ui.rerender(); return true;
  }
  async function submit(form) { if (form.dataset.form !== 'customs-history-filter') return false; generation++; state = { operation: new FormData(form).get('operation'), list: null, detail: null, loading: false }; await load(); return true; }
  function reset() { generation++; state = { operation: 'customs.query', list: null, detail: null, loading: false }; }
  return { page, action, submit, reset };
}
