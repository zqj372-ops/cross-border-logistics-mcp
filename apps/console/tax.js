export function createTaxWorkspace(ui) {
  const { esc, head, panel, field, input, actions, formError, note, icon } = ui;
  const state = { rows: [{}], openRow: 0, date: new Date().toLocaleDateString('en-CA'), result: null };
  const labels = { success: '估算完成', needs_input: '资料待补充', manual_review: '需要复核', blocked: '未获授权', unavailable: '来源不可用' };
  const reasons = { business_connection_unconfigured: '当前企业尚未配置税费 API 连接，请由平台运维接入关务服务。', business_operation_not_enabled: '当前企业尚未开通税费估算。', customs_status_not_ready: '关务发布数据未就绪，暂时无法给出税额。', estimate_input_incomplete: '商品、金额或目的国资料不完整。', tariff_rate_requires_review: '税率包含需要人工确认的条件，无法确定全部应缴金额。', tax_source_unavailable: '未能核验当前税则或汇率来源，请稍后重试。' };
  const displayMoney = (value) => value ? `${esc(value.amount)} <small>${esc(value.currency)}</small>` : '<span class="muted">待确认</span>';
  function rowInput(row, i) {
    const suffix = `_${i}`;
    const value = (name) => esc(row[name] || '');
    return `<details class="estimate-item tax-input-item" data-tax-input="${i}" ${state.rows.length === 1 || state.openRow === i ? 'open' : ''}><summary class="estimate-item-head"><span><strong>商品 ${i + 1}</strong><small>${esc(row.description || '待填写商品资料')}</small></span><span class="muted">${esc(row.hsCode || '展开填写')}</span></summary><div class="estimate-item-body">${state.rows.length > 1 ? `<button class="text-button" type="button" data-action="tax-remove-row" data-index="${i}">移除</button>` : ''}<div class="field-grid">${field('商品名称', `description${suffix}`, input(`description${suffix}`, `required maxlength="200" value="${value('description')}" placeholder="例如：不锈钢水杯"`), '', true)}${field('HS 编码', `hsCode${suffix}`, input(`hsCode${suffix}`, `required inputmode="numeric" pattern="[0-9]{6,10}" maxlength="10" value="${value('hsCode')}" placeholder="6–10 位编码"`))}${field('进口地区', `destinationCountry${suffix}`, `<select id="destinationCountry${suffix}" name="destinationCountry${suffix}"><option value="CA" ${row.destinationCountry === 'CA' ? 'selected' : ''}>加拿大</option><option value="US" ${row.destinationCountry === 'US' ? 'selected' : ''}>美国</option></select>`)}${field('申报价值', `declaredValue${suffix}`, input(`declaredValue${suffix}`, `required inputmode="decimal" pattern="[0-9]+([.][0-9]{1,4})?" value="${value('declaredValue')}" placeholder="输入金额"`))}${field('金额币种', `currency${suffix}`, `<select id="currency${suffix}" name="currency${suffix}">${['CAD', 'USD', 'CNY'].map((currency) => `<option value="${currency}" ${row.currency === currency ? 'selected' : ''}>${currency}</option>`).join('')}</select>`)}${field('材质', `material${suffix}`, input(`material${suffix}`, `maxlength="200" value="${esc(row.attributes?.material || '')}" placeholder="需要判断税率时填写"`))}${field('用途', `use${suffix}`, input(`use${suffix}`, `maxlength="200" value="${esc(row.attributes?.use || '')}"`))}${field('是否含钢或铝', `metal${suffix}`, `<select id="metal${suffix}" name="metal${suffix}"><option value="">尚未确认</option><option value="true" ${row.attributes?.contains_steel_aluminum === true ? 'selected' : ''}>是</option><option value="false" ${row.attributes?.contains_steel_aluminum === false ? 'selected' : ''}>否</option></select>`, '', true)}</div></div></details>`;
  }
  function resultRow(row, i) {
    const amount = row.customsPayable;
    return `<details class="tax-result-row" ${i === 0 || row.status !== 'success' ? 'open' : ''}><summary class="estimate-item-head"><span><strong>${esc(row.input.description || `商品 ${i + 1}`)}</strong><small>${esc(row.input.hsCode || '待补充编码')} · ${row.input.destinationCountry === 'US' ? '美国' : '加拿大'}</small></span><span class="badge ${row.status === 'success' ? 'success' : 'warning'}">${esc(labels[row.status])}</span></summary><div class="tax-result-body"><button class="text-button" type="button" data-action="tax-edit-row" data-line="${esc(row.lineId)}">修改此项资料</button><div class="result-summary"><small>估算应缴税费</small><div class="result-metric">${displayMoney(amount)}</div>${!amount && row.confirmedSubtotal ? `<p>已确认税项小计 ${displayMoney(row.confirmedSubtotal)}，仍有税项待核对，不能作为应缴总额。</p>` : ''}</div><dl class="detail-list"><dt>HS 编码</dt><dd>${esc(row.input.hsCode || '待补充')}</dd><dt>申报价值</dt><dd>${esc(row.input.declaredValue || '待补充')} ${esc(row.input.currency || '')}</dd><dt>关税计税基础</dt><dd>${displayMoney(row.valueForDuty)}</dd></dl>${row.lines.length ? `<div class="table-scroll"><table><thead><tr><th>税费项目 / 原始税率</th><th>估算金额</th></tr></thead><tbody>${row.lines.map((line) => `<tr><td><span class="cell-title">${esc(line.label)}</span><span class="cell-detail">${esc(line.rateExpressionRaw || '税率待确认')}</span>${line.note ? `<span class="cell-detail">${esc(line.note)}</span>` : ''}</td><td class="numeric">${line.amount === null ? '需复核' : `${esc(line.amount)} ${esc(row.valueForDuty?.currency || '')}`}</td></tr>`).join('')}</tbody></table></div>` : ''}${row.reasonCodes.length ? note(row.reasonCodes.map((code) => reasons[code] || `需核对：${code}`).join('；'), 'warning') : ''}<details class="business-details"><summary>发布与汇率依据</summary>${row.publication ? `<p>税则日期 ${esc(row.publication.ruleDate)} · 版本 ${esc(row.publication.serviceVersion)}</p><small>快照 ${esc(row.publication.snapshotHash)}</small>` : '<p>没有可核验的发布快照。</p>'}${row.exchangeRate ? `<p>${esc(row.exchangeRate.fromCurrency)} → ${esc(row.exchangeRate.toCurrency)}：${esc(row.exchangeRate.rate)}</p><p>生效 ${esc(row.exchangeRate.effectiveDate)} · ${esc(row.exchangeRate.sourceAuthorities.join(' / '))}</p>` : '<p>无跨币种换算证据，或本项无需换算。</p>'}<p>来源 ${row.sources.length} 条；结果是估算，具体缴纳以实际申报核定为准。</p></details></div></details>`;
  }
  function results() {
    const result = state.result;
    if (!result) return panel('税费估算结果', '逐项展示金额、未确认税项与依据', `<div class="empty-state"><div class="empty-symbol">${icon('file')}</div><h2>先确认商品与申报价值</h2><p>税则和汇率由关务服务读取。输入一件商品可以单项估算，添加商品后最多批量处理 20 项。</p></div>`);
    const data = result.data;
    const rows = data?.results || (data?.result ? [data.result] : []);
    return panel('税费估算结果', data?.partialFailure ? '部分商品需要补充或复核，请逐项处理' : `${labels[result.status] || '查看结果'}`, `<div class="panel-body"><p class="muted" data-result-state>结果对应上一次提交的资料。</p>${result.reason_codes.length ? note(result.reason_codes.map((code) => reasons[code] || `服务提示：${code}`).join('；'), result.status === 'success' ? 'success' : 'warning') : ''}${data?.counts ? `<div class="batch-counts"><span>共 ${data.counts.total} 项</span><span>完成 ${data.counts.success} 项</span><span>待处理 ${data.counts.total - data.counts.success} 项</span></div>` : ''}${rows.map(resultRow).join('')}${!rows.length ? '<p class="muted">未返回可核验的金额。商品资料已保留，可以检查接入状态后重试。</p>' : ''}</div>`);
  }
  function page() {
    return head('税费估算', '中国原产商品 · 单项与批量都沿用关务服务的税则、汇率和计算规则。') + `<div class="business-layout"><form class="panel" data-form="business-tax"><div class="panel-head"><h2>申报商品</h2><span class="badge">${state.rows.length} / 20 项</span></div><div class="panel-body">${formError}${field('税则日期', 'tax-rule-date', input('tax-rule-date', `required type="date" value="${esc(state.date)}"`), '同一批次使用同一税则日期。')}${state.rows.map(rowInput).join('')}<button type="button" class="button" data-action="tax-add-row" ${state.rows.length >= 20 ? 'disabled' : ''}>${icon('plus')}添加商品</button>${actions(state.rows.length === 1 ? '估算税费' : `估算 ${state.rows.length} 项商品`)}<p class="form-fineprint">不确定的税项会保留为待复核。未确认金额不会按零计入总额。</p></div></form><div id="tax-results">${results()}</div></div>`;
  }
  function capture() {
    const form = document.querySelector('[data-form="business-tax"]'); if (!form) return;
    const data = new FormData(form); const get = (name) => String(data.get(name) || '').trim(); state.date = get('tax-rule-date');
    state.rows = state.rows.map((row, i) => ({ lineId: row.lineId || `item_${crypto.randomUUID().replaceAll('-', '')}`, description: get(`description_${i}`), hsCode: get(`hsCode_${i}`), destinationCountry: get(`destinationCountry_${i}`), declaredValue: get(`declaredValue_${i}`), currency: get(`currency_${i}`), attributes: { originCountry: 'CN', ...(get(`material_${i}`) ? { material: get(`material_${i}`) } : {}), ...(get(`use_${i}`) ? { use: get(`use_${i}`) } : {}), ...(get(`metal_${i}`) ? { contains_steel_aluminum: get(`metal_${i}`) === 'true' } : {}) } }));
  }
  async function action(button) {
    if (button.dataset.action === 'tax-edit-row') {
      const index = state.rows.findIndex((row) => row.lineId === button.dataset.line);
      const item = document.querySelector(`[data-tax-input="${index}"]`);
      if (item) { item.open = true; state.openRow = index; item.scrollIntoView({ block: 'start', behavior: 'smooth' }); item.querySelector('input')?.focus({ preventScroll: true }); }
      return true;
    }
    if (!['tax-add-row', 'tax-remove-row'].includes(button.dataset.action)) return false;
    capture(); if (button.dataset.action === 'tax-add-row' && state.rows.length < 20) { state.rows.push({}); state.openRow = state.rows.length - 1; }
    if (button.dataset.action === 'tax-remove-row' && state.rows.length > 1) { state.rows.splice(Number(button.dataset.index), 1); state.openRow = Math.min(Number(button.dataset.index), state.rows.length - 1); }
    state.result = null; ui.rerender(); return true;
  }
  async function submit(form) {
    if (form.dataset.form !== 'business-tax') return false; capture();
    const batch = state.rows.length > 1; const value = batch ? { ruleDate: state.date, items: state.rows } : { ruleDate: state.date, ...state.rows[0] };
    state.result = await ui.api(`/business/customs/${batch ? 'tax-estimates/batch' : 'tax-estimate'}`, { method: 'POST', body: { input: value }, acceptBusiness: true }); ui.rerender(); document.querySelector('#tax-results')?.scrollIntoView({ block: 'start' }); return true;
  }
  function reset() { state.rows = [{}]; state.openRow = 0; state.result = null; state.date = new Date().toLocaleDateString('en-CA'); }
  return { page, action, submit, reset, restoreHistory(input) { reset(); state.date = input.ruleDate; state.rows = [structuredClone(input)]; } };
}
