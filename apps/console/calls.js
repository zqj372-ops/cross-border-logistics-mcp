export function createCallLogUi(ui) {
  const statuses = { success: '已完成', needs_input: '待补充', manual_review: '待复核', blocked: '已阻止', unavailable: '暂不可用' };
  const operations = ['cargo.calculate', 'container.plan_summary', 'system.agent_context.get', 'customs.query', 'customs.tax.estimate', 'quote.zone_preview', 'quote.ai_extract_preview', 'quote.freightcom_ltl.preview'];
  const state = { data: null, error: '', loading: false, generation: 0, organization: null, application: '', operation: '', status: '', days: '1', range: null };
  function reset() { state.generation++; state.data = null; state.error = ''; state.loading = false; state.organization = null; state.range = null; state.application = ''; state.operation = ''; state.status = ''; }
  async function load(cursor = '') {
    const generation = ++state.generation;
    const organization = ui.model().session?.organization_id;
    state.organization = organization; state.loading = true; state.error = '';
    if (!cursor || !state.range) { const now = Date.now(); state.range = { from: new Date(now-Number(state.days)*86400000).toISOString(), to: new Date(now).toISOString() }; }
    const query = new URLSearchParams({ ...state.range, limit: '25' });
    if (state.application) query.set('application_id', state.application);
    if (state.operation) query.set('operation', state.operation);
    if (state.status) query.set('status', state.status);
    if (cursor) query.set('cursor', cursor);
    try {
      const result = await ui.api(`/calls?${query}`);
      if (generation !== state.generation || ui.model().session?.organization_id !== organization) return;
      state.data = result.data;
    } catch {
      if (generation !== state.generation) return;
      state.data = null; state.error = '暂时无法读取调用记录，请刷新重试。';
    } finally { if (generation === state.generation) { state.loading = false; ui.rerender(); } }
  }
  const options = (values, selected) => values.map(([value, label]) => `<option value="${ui.esc(value)}" ${value === selected ? 'selected' : ''}>${ui.esc(label)}</option>`).join('');
  function page() {
    const model = ui.model();
    if (state.organization !== null && state.organization !== model.session?.organization_id) reset();
    if (!state.data && !state.loading && !state.error) void load();
    const data = state.data;
    const filters = `<form class="call-log-filters" data-form="call-log-filter">${ui.formError}
      <label>应用<select name="application">${options([['', '所有可见调用'], ...(model.state?.applications || []).map(app => [app.application_id, app.name])], state.application)}</select></label>
      <label>服务<select name="operation">${options([['', '全部服务'], ...operations.map(operation => [operation, ui.capName(operation)])], state.operation)}</select></label>
      <label>结果<select name="status">${options([['', '全部结果'], ...Object.entries(statuses)], state.status)}</select></label>
      <label>时间<select name="days">${options([['1', '最近 24 小时'], ['7', '最近 7 天'], ['30', '最近 30 天']], state.days)}</select></label>
      <button class="button primary" type="submit" ${state.loading ? 'disabled' : ''}>查询</button>
    </form>`;
    const summary = data ? `<div class="call-log-summary" aria-label="当前范围统计">
      <div><span>调用次数</span><strong>${data.summary.total}</strong></div>
      <div><span>已完成</span><strong>${data.summary.status_counts.success}</strong></div>
      <div><span>待处理或未完成</span><strong>${data.summary.total-data.summary.status_counts.success}</strong></div>
      <div><span>平均耗时</span><strong>${data.summary.average_duration_ms}<small> ms</small></strong></div>
    </div>` : '';
    const rows = data?.events.map(event => {
      const application = model.state?.applications.find(app => app.client_id === event.client_id);
      const actor = event.client_id ? application?.name || '应用调用' : '网页操作';
      return `<tr><td>${ui.esc(ui.date(event.created_at))}</td><td>${ui.esc(ui.capName(event.operation))}</td><td>${ui.esc(actor)}</td><td><span class="badge ${event.status === 'success' ? 'success' : 'warning'}">${ui.esc(statuses[event.status])}</span></td><td class="numeric">${event.duration_ms} ms</td><td><code class="call-request-id">${ui.esc(event.request_id)}</code></td></tr>`;
    }).join('');
    const body = state.error ? ui.note(state.error, 'error') : state.loading ? '<div class="panel-body" role="status">正在读取调用记录…</div>' : rows
      ? `<div class="table-wrap call-log-table" role="region" aria-label="调用明细，可横向滚动" tabindex="0"><table><thead><tr>${['时间','服务','调用身份','结果','耗时','请求编号'].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="panel-body"><p>这个范围内还没有调用记录。完成一次服务调用后，可在这里核对结果。</p></div>';
    return ui.head('调用记录', '核对服务调用、处理结果与耗时，用请求编号定位问题。', '<button class="button" data-action="calls-refresh">刷新</button>') + filters + summary
      + ui.panel('调用明细', data ? `统计基于当前可见且已保留的记录；保留 ${data.window.retention_days} 天，每家企业最多 ${data.window.maximum_events_per_tenant.toLocaleString()} 条。` : '只显示当前账号有权查看的企业与应用。', body)
      + (data?.next_cursor ? '<div class="form-actions"><button class="button" data-action="calls-next">下一页</button><button class="button quiet" data-action="calls-refresh">返回第一页</button></div>' : '');
  }
  async function action(button) {
    if (button.dataset.action === 'calls-refresh') { await load(); return true; }
    if (button.dataset.action === 'calls-next' && state.data?.next_cursor) { await load(state.data.next_cursor); return true; }
    return false;
  }
  async function submit(form) {
    if (form.dataset.form !== 'call-log-filter') return false;
    const data = new FormData(form);
    for (const field of ['application','operation','status','days']) state[field] = String(data.get(field) || (field === 'days' ? '1' : ''));
    await load(); return true;
  }
  return { page, action, submit, reset };
}
