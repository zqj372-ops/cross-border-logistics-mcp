const statuses = { submitted: '待处理', in_review: '处理中', needs_input: '待补充', closed: '已结束', cancelled: '已取消' };
export function createWorkspaceHome({ api, model, head, esc, icon, rerender }) {
  let epoch = 0, scope = '', cached = null;
  function reset() { epoch++; cached = null; }
  function page() {
    const m = model(), current = JSON.stringify([m.sessionGeneration, m.session?.identity?.user_id, m.session?.organization_id]);
    if (current !== scope) { scope = current; reset(); }
    if (!m.session?.organization_id) return head('工作台', '加入企业后处理询价与业务。') + '<a class="button" href="#members">查看企业邀请</a>';
    if (!cached) { cached = { loading: true }; const token = epoch; api('/cases?management=false').then(r => { if (token === epoch) cached = { data: r.data }; }).catch(() => { if (token === epoch) cached = { error: true }; }).finally(() => { if (token === epoch && location.hash === '#workbench') rerender(); }); }
    const member = m.state?.memberships?.find(v => v.user_id === m.session.identity.user_id && v.organization_id === m.session.organization_id && v.status === 'active');
    const manager = ['owner', 'admin'].includes(member?.role);
    const rows = cached.data?.items || [];
    return head('工作台', '查看自己的询价进度，继续处理业务。', '<button type="button" class="button" data-action="workspace-refresh">刷新进度</button>') + `<div class="workspace-actions"><a class="button primary" href="/inquiry/">发起海运询价 ${icon('arrow')}</a><a class="button" href="#quote/private">私人地址 · 自有运价</a><a class="button" href="#quote/freightcom">私人地址 · Freightcom</a><a class="button" href="#customs">关税查询</a><a class="button" href="#tax">税费估算</a>${manager ? '<a class="button" href="#operations">处理企业询价</a><a class="button" href="#market/configure">模块配置</a>' : ''}</div><section aria-label="最近询价"><h2>最近的询价</h2>${cached.loading ? '<p role="status">正在读取真实记录…</p>' : cached.error ? '<p>当前环境暂时无法读取询价进度，请刷新重试。</p>' : rows.length ? `<div class="workspace-recent">${rows.slice(0, 8).map(item => `<a class="workspace-recent-row" href="#case/${encodeURIComponent(item.case_id)}"><div><h3>${esc(item.input.product || '运输需求')}</h3><p>${esc([item.input.origin, item.input.destination].filter(Boolean).join(' → ') || '地区待确认')}</p><time>${esc(new Date(item.updated_at).toLocaleString('zh-CN'))}</time></div><span class="badge ${item.status === 'needs_input' ? 'warning' : ''}">${esc(statuses[item.status] || item.status)}</span></a>`).join('')}</div>` : '<div class="native-empty"><h3>还没有提交询价</h3><p>提交海运需求后，可在这里查看处理进展和待补充事项。</p></div>'}<p><a class="button" href="#cases">查看全部个人询价 ${icon('arrow')}</a></p></section>`;
  }
  function action(button) { if (button.dataset.action !== 'workspace-refresh') return false; reset(); rerender(); return true; }
  return { page, action, reset };
}
