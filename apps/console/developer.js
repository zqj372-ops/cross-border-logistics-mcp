import { cargoExample } from './api-examples.js';
export function createDeveloperGuide(ui) {
  const { esc, head, panel, field, input, actions, note, formError } = ui;
  const options = {
    'cargo.calculate': { label: '货物计算 · T0', path: '/api/v2/tools/cargo.calculate', kind: 't0', input: cargoExample },
    'customs.query': { label: '关税与归类 · Business API', path: '/api/v2/business/customs/query', kind: 'business', input: { query: '不锈钢水杯', ruleDate: new Date().toLocaleDateString('en-CA'), codeCountry: 'CN', attributes: { originCountry: 'CN', material: '不锈钢', use: '日常饮水' } } },
    'customs.tax.estimate': { label: '税费估算 · Business API', path: '/api/v2/business/customs/tax-estimate', kind: 'business', input: { ruleDate: new Date().toLocaleDateString('en-CA'), lineId: 'item_1', description: '不锈钢水杯', hsCode: '732393', destinationCountry: 'CA', declaredValue: '1000', currency: 'CAD', attributes: { originCountry: 'CN', material: '不锈钢' } } },
    'quote.zone_preview': { label: '加拿大尾程试算 · Business API', path: '/api/v2/business/quote/zone-preview', kind: 'business', input: { postal_code: 'M1B 5W9', city: 'Toronto', province: 'ON', cbm: '1.2', weight_kg: '300', piece_count: 2, packaging_type: 'carton', address_type: 'commercial', requires_liftgate: false, requires_pallet_jack: false, requires_appointment: false, explicit_pallet_count: null, is_stackable: null, detention_minutes: 0 } },
    'quote.ai_extract_preview': { label: '询价资料提取 · Business API', path: '/api/v2/business/quote/ai-extract-preview', kind: 'business', input: { customer_message: 'Toronto M1B 5W9，商业地址，两箱货共300kg，1.2m³，卸货条件待确认。' } },
  };
  let selected = 'cargo.calculate'; let lastResult = null;
  const fixture = () => ui.mode() === 'fixtures';
  const operationPath = (option) => !fixture() || option.kind === 'business' ? option.path : option.path.replace('/api/v2/tools/', '/api/fixture/v1/tools/');
  const exchangeRoute = (business) => business ? '/access/v2/business/token/exchange' : fixture() ? '/access/v1/token/exchange' : '/access/v2/tools/token/exchange';
  const envelope = (operation) => options[operation].kind === 'business' ? { schema_version: 'business-call@2026-09-05.v1', input: options[operation].input } : fixture() ? { input: options[operation].input } : options[operation].input;
  function page() {
    const selectedOption = options[selected]; const business = selectedOption.kind === 'business';
    const command = `curl '${location.origin}${selectedOption.path}' -H 'Authorization: ApiKey <保存的 API Key>' -H 'Content-Type: application/json' --data '${JSON.stringify(business ? envelope(selected) : selectedOption.input)}'`;
    return head('接口调试', '选择已开通的服务，用保存的 API Key 发起一次调用。', '<a class="button" href="/console/openapi.json" download="freightclaw-openapi.json">下载 OpenAPI</a>' + ui.link('管理 API Key', 'api-keys')) + `<div class="form-layout"><div>${panel('检查接入准备', '人员账号管理应用，系统用应用凭证调用服务', '<div class="panel-body"><ol class="guide-list"><li><span class="step-number">1</span><div><h3>确认批准范围</h3><p>审批通过后，等待服务授权实际开通。</p></div></li><li><span class="step-number">2</span><div><h3>创建一把 API Key</h3><p>由应用负责人保存完整 Key，后续复用这把 Key 调用已开通的服务。</p></div></li><li><span class="step-number">3</span><div><h3>直接调用 API</h3><p>REST 接口直接使用同一 API Key。连接 MCP 客户端时再按操作手册兑换短期令牌。</p></div></li></ol></div>')}${panel('验证一次调用', '结果来自当前接口；失败原因可以用于排查接入', `<form class="panel-body" data-form="api-diagnostic">${formError}<div class="field-grid">${field('验证服务', 'diagnostic-operation', `<select name="operation" id="diagnostic-operation">${Object.entries(options).map(([key, value]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${value.label}</option>`).join('')}</select>`, '', true)}${field('应用 Key', 'diagnostic-key', input('diagnostic-key', 'type="password" required autocomplete="off" spellcheck="false" placeholder="粘贴已保存的 API Key"'), '仅在本次调用过程中使用。点击验证后输入框立即清空。', true)}${field('请求内容', 'diagnostic-input', `<textarea class="request-json" name="payload" id="diagnostic-input" required spellcheck="false">${esc(JSON.stringify(envelope(selected), null, 2))}</textarea>`, '可以替换业务资料；不要添加企业、操作者、密钥或连接地址。', true)}</div>${actions('验证调用')}${lastResult ? `<div class="api-diagnostic-result"><h3>最近一次验证</h3>${note(lastResult.summary, lastResult.status === 'success' ? 'success' : 'warning')}<pre class="code-sample">${esc(JSON.stringify(lastResult.details, null, 2))}</pre></div>` : ''}</form>`)}${panel('接口示例', '一把 API Key 直接调用已开通的服务', `<div class="panel-body"><p class="muted">使用 Authorization: ApiKey 请求头。示例中的占位符由你的凭证管理工具提供，不要把 Key 写入代码或日志。</p><pre class="code-sample">${esc(command)}</pre><p class="muted">请求体见上方。只有响应和来源证据核验通过，才能判断业务调用完成。原有基础工具 Key 仍兼容旧版兑换流程。</p></div>`)}</div><aside class="side-help"><h3>接入状态怎么判断</h3><p>success：本次操作完成。</p><p>needs_input：补充返回所需资料。</p><p>manual_review：保留结果，交由人工核对。</p><p>blocked：核对应用、凭证与当前授权。</p><p>unavailable：检查服务连接与发布状态。</p><p>这里的基础计算样例使用明确的测试规则，不能作为正式渠道计费配置。</p></aside></div>`;
  }
  async function submit(form) {
    if (form.dataset.form !== 'api-diagnostic') return false;
    const keyField = form.querySelector('#diagnostic-key'); let key = keyField.value.trim(); keyField.value = '';
    let token = null; const operation = form.querySelector('[name="operation"]').value;
    const option = options[operation]; if (!option) throw Object.assign(new Error('body_invalid'), { code: 'body_invalid' });
    let payload; try { payload = JSON.parse(form.querySelector('[name="payload"]').value); } catch { key = ''; throw Object.assign(new Error('body_invalid'), { code: 'body_invalid' }); }
    const business = option.kind === 'business';
    try {
      if (key.startsWith('flcbk_')) {
        const response = await fetch(option.path, { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${key}` }, body: JSON.stringify(!business && fixture() ? payload.input : payload), signal: AbortSignal.timeout(45000) });
        key = ''; const result = await response.json();
        const succeeded = response.ok && result.status === 'success';
        lastResult = { status: succeeded ? 'success' : result.status === 'success' ? 'blocked' : result.status, summary: succeeded ? '本次接口调用完成。请继续核对业务结果和来源版本。' : '接口已返回处理状态，请按原因补充资料或检查服务接入。', details: { operation, http_status: response.status, status: result.status, request_id: result.request_id || null, reason_codes: result.reason_codes || [], data: result.data ?? null } };
        ui.rerender(); return true;
      }
      const exchange = await fetch(exchangeRoute(business), { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${key}` }, body: JSON.stringify(business ? { schema_version: 'business-exchange@2026-09-05.v1', requested_operations: [operation] } : { schema_version: '2026-08-27.v1', requested_tool_names: [operation] }), signal: AbortSignal.timeout(15000) });
      key = ''; const exchangeResult = await exchange.json(); token = exchangeResult.data?.access_token || exchangeResult.access_token;
      if (!exchange.ok || !token) { lastResult = { status: 'blocked', summary: '凭证兑换未通过，请核对凭证交付状态、有效期与授权范围。', details: { stage: 'token_exchange', status: exchangeResult.status, reason_codes: exchangeResult.reason_codes || exchangeResult.error?.reason_codes || [], request_id: exchangeResult.request_id || null } }; }
      else {
        const response = await fetch(operationPath(option), { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
        token = null; const result = await response.json(); lastResult = { status: response.ok ? result.status : result.status === 'success' ? 'blocked' : result.status, summary: response.ok && result.status === 'success' ? '本次接口调用完成。请继续核对业务结果和来源版本。' : '接口已返回处理状态，请按原因补充资料或检查服务接入。', details: { operation, http_status: response.status, status: result.status, request_id: result.request_id || result.data?.requestId || null, reason_codes: result.reason_codes || [], data: result.data ?? null } };
      }
    } catch { lastResult = { status: 'unavailable', summary: '请求未完成，请检查服务连接后重试。', details: { operation, reason_codes: ['connection_unavailable'] } }; }
    finally { key = ''; token = null; }
    ui.rerender(); return true;
  }
  function change(event) { if (event.target.id !== 'diagnostic-operation') return false; selected = event.target.value; lastResult = null; ui.rerender(); return true; }
  function reset() { lastResult = null; }
  return { page, submit, change, reset };
}
