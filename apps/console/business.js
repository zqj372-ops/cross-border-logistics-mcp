import {createFreightcomForm} from './freightcom-form.js';
import {createCargoLines} from './cargo-lines.js';
export function createBusinessWorkspace(ui) {
  const { esc, head, panel, field, input, actions, formError, note, icon } = ui;
  const cargoLines=createCargoLines(esc);
  const carrierForm=createFreightcomForm({esc,field,input});
  const state = { customsInput: null, customsResult: null, quoteInput: null, quoteResult: null, privateAddress:false, freightcomInput: null, freightcomResult: null, extraction: null, customerMessage: null, prepared: null, saved: null, history: null, historyLoading: false, historyError: null, historyRecord: null, review: null, reviewQueue: null, reviewQueueLoading: false, reviewPrepared: null, reviewResolved: null, documentResult: null };
  const privateSelect=(name,options,value='')=>`<select id="${name}" name="${name}" required><option value="">请选择并确认</option>${options.map(([id,label])=>`<option value="${id}" ${value===id?'selected':''}>${label}</option>`).join('')}</select>`;
  const today = () => new Date().toLocaleDateString('en-CA');
  const money = (value, currency) => value === null || value === undefined ? '待确认' : `${esc(value)} ${esc(currency)}`;
  const labels = { CN: '中国出口', US: '美国进口', CA: '加拿大进口', confirmed: '已确认', candidate: '候选', possible: '待核对', manual_review: '需人工复核', success: '查询完成', needs_input: '需要补充资料', unavailable: '来源服务不可用', blocked: '当前无法使用', prepare_retain: '准备并留存', required_now: '当前需要', conditional: '条件适用', on_request: '要求时提供', not_applicable: '不适用', human_reviewed: '已人工复核', machine: '机器解释', not_needed: '无需翻译' };
  const reasons = {postal_city_required:'这个邮编覆盖多个派送分区，请填写收货城市后重试。',postal_city_not_covered:'该邮编下未找到所填城市，请核对城市拼写或交由人工确认。',postal_zone_conflict:'同一邮编与城市存在分区冲突，需要管理员核对，暂不自动报价。',quote_origin_required:'邮编匹配多个起运地，请指定 toronto 或 calgary 后重新查询。',origin_postal_not_covered:'所选起运地未覆盖此邮编，请核对。',shared_quote_incomplete:'共用资料必须是实体托盘，逐托重量和叠放条件应明确；地牛需承运商另行确认。请返回货物明细核对。', cargo_lines_invalid:'请补齐逐组货物的尺寸、包装和重量口径。',cargo_totals_conflict:'逐组明细与汇总不一致，请重新核对。',cargo_item_details_required:'多件超长或混装货物需要逐组填写尺寸与包装。', extraction_numeric_format_unsupported:'请将科学计数法改成普通十进制数值后重新解析。', extraction_conflict:'资料中存在冲突，请核对标记项后再试算。', extraction_needs_confirmation:'已整理可识别资料，请补充待确认项。', extraction_ready_for_confirmation:'资料已整理，请核对货物明细与交付条件后试算。', extraction_too_many_lines:'一次最多解析 150 行资料，请拆分询价。', extraction_too_many_items:'一次最多解析 100 组货物，请拆分询价。', extraction_number_too_large:'数值长度超出范围，请检查原文。', zone_disabled:'该派送分区已停用，请联系管理员确认。', zone_control_conflict:'该分区设置存在冲突，请管理员核对后重新发布。', native_customs_not_published:'当前企业尚未发布关务数据，请先在业务管理中导入并核验。', native_quote_not_published:'当前企业尚未发布自有运价，请先配置分区、计费规则和费用。', native_quote_release_expired:'当前运价已过期，请管理员更新有效期并重新发布。', postal_not_covered:'该邮编尚未覆盖，请人工确认派送范围。', pallet_rate_not_configured:'该计费托数没有已发布价格，请人工确认。', cargo_measurements_required:'请补充完整的体积、重量和最长边。', cargo_outside_published_limits:'货物超出已发布服务范围，需要人工确认。', native_customs_release_not_ready:'关务版本未通过发布校验，暂时无法提供已核实结果。', customs_status_not_ready: '关务数据尚未就绪，暂时无法提供已核实的归类与税则。你的资料已保留。', public_daily_limit_insufficient: '今日剩余额度不足，请减少批量商品数后重试。', public_daily_limit_reached: '今日访客额度已用完，请于北京时间零点后再试，或登录已开通服务的账号。', public_customs_unavailable: '关税查询暂时无法连接，请稍后重试。', public_customs_input_invalid: '请检查商品资料和查询日期后重试。',
    business_connection_unconfigured: '当前企业尚未配置该业务服务的 API 连接。请由平台运维完成连接和身份映射。',
    business_operation_not_enabled: '该业务尚未向当前企业开放。请联系平台运维开通。',
    business_client_unconfigured: '业务连接未完成配置，暂时无法获取真实结果。',
    customs_connection_unconfigured: '关务 API 连接尚未配置。', quote_connection_unconfigured: '询价 API 连接尚未配置。', quote_record_operation_unconfigured: '当前企业尚未开通报价记录功能，请由平台配置保存与本人记录读取权限。', quote_record_connection_unconfigured: '报价记录 API 尚未接通。', quote_source_not_authoritative: '当前价格来源需要人工核对，保存后会进入待复核状态。', quote_preview_changed: '重新核对后的价格或来源已经变化，请确认新结果后再保存。', preview_changed: '重新核对后的价格或来源已经变化，请确认新结果后再保存。', write_readback_pending: '原记录可能已保存，但尚未完成读回。请重试核对，避免重复创建新记录。', preview_expired: '预览已过期，请重新核对后保存。',
    customs_publication_unavailable: '关务数据尚未满足发布条件，请等待来源服务恢复。',
    customs_snapshot_changed: '查询期间税则发布发生变化，请重新查询。',
    quote_source_evidence_missing: '已取得规则试算，但来源证据不完整，需要复核后才能作为报价依据。',
    quote_request_invalid: '请补齐有效邮编、货物信息和所需服务。',
    customs_request_invalid: '请检查商品、日期和原产国。目前接口支持中国原产商品。',
    quote_upstream_unavailable: '询价来源服务暂时无法响应。', quote_upstream_timeout: '询价服务响应超时，资料已保留，可以重试。',
    freightcom_connection_unconfigured: '当前企业尚未配置 Freightcom 正式账号连接。测试凭证不会被当作正式配置。',
    freightcom_credential_unavailable: 'Freightcom 正式凭证未配置或当前不可用。', freightcom_authorization_rejected: 'Freightcom 拒绝了当前正式账号凭证。',
    freightcom_request_invalid: '请补齐发货地、收货地、托盘尺寸重量、货物描述和提货时间。', freightcom_request_rejected: 'Freightcom 拒绝了询价资料，请核对地址、托盘和附加服务。',
    freightcom_rate_evidence_incomplete: '承运商返回的服务、金额或有效期不完整，需人工复核。', freightcom_rate_expired: '返回的费率已过有效日期。', freightcom_rate_currency_mismatch: '费用明细存在币种不一致，不能直接使用。', freightcom_currency_exponent_unsupported: '当前币种的最小货币单位规则尚未冻结，已保留原始数值供复核。', freightcom_no_rates_returned: '本次查询未返回可用承运商费率。', freightcom_poll_incomplete: '承运商询价在有界等待时间内未完成，可以重试。', freightcom_upstream_unavailable: 'Freightcom 暂时不可用，资料已保留。', freightcom_upstream_timeout: 'Freightcom 响应超时，资料已保留。',
    quote_reviewer_role_required: '只有企业所有者或管理员可以进入人工复核。', quote_reviewer_required: '当前账号未列入原报价服务的复核人员名单。',
    quote_review_resolution_invalid: '请完整填写逐项费用、总价、证据版本、有效期、客户条款和复核说明；逐项费用合计必须等于总价。',
    quote_validity_expired: '该人工确认报价已过有效期，不能继续作为当前正式报价。', quote_document_expired: '该 PDF 是历史快照，报价有效期已结束。',
    quote_not_ready_for_formal_pdf: '该记录尚未完成价格与来源复核，只能生成带水印的草稿。', draft_document_not_formal: '这是带水印的草稿文件，不能作为正式报价。',
    review_context_changed: '记录或价格依据已经变化，请重新读取复核资料。',
    document_readback_pending: '文件可能已生成，但尚未完成读回核对。请沿用当前操作重试。', quote_document_download_invalid: '文件校验未通过，未向浏览器传送。',
  };
  function resultNote(result) {
    if (!result) return '';
    const detail = result.reason_codes?.map((code) => reasons[code] || `服务返回：${code}`).join('；');
    const title = labels[result.status] || result.status;
    return `<div class="inline-note ${result.status === 'success' ? 'success' : result.status === 'needs_input' || result.status === 'manual_review' ? 'warning' : 'error'}"><strong>${esc(title)}</strong>${detail ? `<p>${esc(detail)}</p>` : ''}<p data-result-state>结果对应上一次提交的资料。</p></div>`;
  }
  function sourceList(sources = []) {
    if (!sources.length) return '<p class="muted">来源尚未返回可展示的引用。</p>';
    return `<div class="source-list">${sources.map((source) => {
      let href = null; try { const url = new URL(source.officialUrl || ''); if (url.protocol === 'https:' && !url.username && !url.password) href = url.href; } catch { /* A quote reference may intentionally have no public URL. */ }
      return `<div class="source-row"><strong>${esc(source.authority || source.system)}</strong><span>${esc(source.dataset || source.version || '')}</span>${source.effectiveFrom ? `<small>生效 ${esc(source.effectiveFrom)}${source.effectiveTo ? ` 至 ${esc(source.effectiveTo)}` : ''}</small>` : ''}${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">查看官方依据</a>` : `<small>${esc(source.locator || '')}</small>`}</div>`;
    }).join('')}</div>`;
  }
  function extractionSummary(result) {
    const data = result.data, draft = data?.extraction;
    if (!draft) return resultNote(result);
    const value = (n, unit = '') => n === null || n === undefined ? '待确认' : `${esc(n)}${unit}`;
    const rows = (draft.cargo_items || []).map((item, i) => `<tr><td>${i + 1}<details><summary>原文</summary><p class="extraction-evidence">${esc(item.source_span || '未提供原文')}</p></details></td><td>${value(item.quantity)}</td><td>${[item.length_cm,item.width_cm,item.height_cm].map(n=>value(n)).join(' × ')}<small class="cell-detail">cm · 每件</small></td><td>${value(item.weight_kg,' kg')}<small class="cell-detail">行总重 ${value(item.total_weight_kg,' kg')}</small></td><td>${value(item.total_cbm,' m³')}</td></tr>`).join('');
    return `${resultNote(result)}<section class="extraction-review"><h3>核对解析结果</h3><div class="extraction-totals"><div><small>件数</small><strong>${value(draft.piece_count)}</strong></div><div><small>总体积 · m³</small><strong>${value(draft.cbm)}</strong></div><div><small>总重量 · kg</small><strong>${value(draft.weight_kg)}</strong></div></div>${rows ? `<details class="business-details" open><summary>货物明细 · ${draft.cargo_items.length} 组</summary><div class="table-wrap"><table><thead><tr><th>货物</th><th>件数</th><th>尺寸</th><th>重量</th><th>行体积</th></tr></thead><tbody>${rows}</tbody></table></div></details>` : '<p class="muted">未识别出完整货物行，请在下方核对合计资料。</p>'}${data.follow_up_question ? note(data.follow_up_question,'warning') : ''}${draft.validation_notes?.length ? `<details class="business-details"><summary>需要核对的依据 · ${draft.validation_notes.length} 项</summary><ul>${draft.validation_notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}<p class="form-fineprint">资料已填入下方表单。核对后再试算；更换原文解析会清除上次试算结果。</p></section>`;
  }
  function customsResults() {
    const result = state.customsResult;
    if (!result) return panel('查询结果', '候选、税率与单证将在这里展示', '<div class="empty-state"><div class="empty-symbol">' + icon('file') + '</div><h2>从商品名称或编码开始</h2><p>查询将核对来源服务的当前发布。缺少信息时，会在工作台内继续补充。</p></div>');
    const data = result.data;
    let body = resultNote(result);
    if (!data) return panel('查询结果', result.reason_codes?.includes('public_daily_limit_reached') ? '今日额度已用完，已保留填写的资料' : '资料已保留，可以稍后重试', `<div class="panel-body">${body}</div>`);
    if (data.nextQuestion) body += `<form data-form="business-customs-answer" class="question-form"><h3>${esc(data.nextQuestion.label)}</h3>${formError}<div class="choice-list">${data.nextQuestion.options.map((option) => `<label class="choice-row"><input type="radio" name="answer" value="${esc(option)}" required><span>${esc(option)}</span></label>`).join('')}</div>${actions('补充并继续查询')}</form>`;
    if (data.candidates?.length) body += `<section class="result-section"><h3>候选归类</h3><p class="muted">根据商品实际属性确认候选，编码相似不代表归类相同。</p><div class="candidate-list">${data.candidates.map((candidate) => `<div class="candidate-row"><div><span class="badge">${esc(labels[candidate.country])}</span><h3>${esc(candidate.displayCode)}</h3><p>${esc(candidate.chineseExplanation?.text || candidate.legalNames?.[0]?.text || '')}</p><small>${esc(candidate.classificationReason)}</small></div>${candidate.hs6 ? `<button type="button" class="button small" data-action="business-customs-candidate" data-id="${esc(candidate.hs6)}">按此候选复查</button>` : '<span class="badge">需更细分类</span>'}</div>`).join('')}</div></section>`;
    body += (data.results || []).map((country) => `<section class="country-result"><div class="panel-head"><div><h2>${esc(labels[country.country])}</h2><p>${esc(country.displayCode)} · ${esc(country.legalNames?.[0]?.text || '')}</p></div><span class="badge ${country.status === 'confirmed' ? 'success' : 'warning'}">${esc(labels[country.status] || country.status)}</span></div><div class="panel-body"><p>${esc(country.chineseExplanation?.text || '')}</p><div class="result-summary"><small>已确认的关税合计</small><div class="result-metric">${country.confirmedTotalPercent === null ? '待确认' : `${esc(country.confirmedTotalPercent)}%`}</div><p>合计范围以来源服务为准，税费和其他措施逐项查看。</p></div><div class="table-wrap"><table><thead><tr><th>税费项目</th><th>税率 / 表达式</th><th>适用条件</th></tr></thead><tbody>${country.rates.map((rate) => `<tr><td><span class="cell-title">${esc(rate.label)}</span><span class="cell-detail">${rate.confirmed ? '已确认' : '待复核'} · ${esc(rate.treatment)}</span></td><td>${esc(rate.displayValue)}<span class="cell-detail">${esc(rate.rateExpressionRaw)}</span></td><td>${esc(rate.conditionText || '以对应税则条件为准')}<span class="cell-detail">${esc(rate.interactionNote)}</span></td></tr>`).join('')}</tbody></table></div>${country.documents.length ? `<details class="business-details"><summary>单证与准备事项 · ${country.documents.length} 项</summary>${country.documents.map((document) => `<div class="source-row"><strong>${esc(document.label)}</strong><span>${esc(labels[document.status] || document.status)}</span><p>${esc(document.reason)}</p>${document.conditions.length ? `<small>${document.conditions.map(esc).join('；')}</small>` : ''}</div>`).join('')}</details>` : ''}${country.measures.length ? `<details class="business-details"><summary>贸易措施 · ${country.measures.length} 项</summary>${country.measures.map((measure) => `<div class="source-row"><strong>${esc(measure.label)}</strong><p>${esc(measure.legalScope)}</p><small>${esc(measure.rateExpressionRaw || '具体税率需核对适用范围')}</small>${measure.exceptions.length ? `<small>${measure.exceptions.map(esc).join('；')}</small>` : ''}</div>`).join('')}</details>` : ''}${country.warnings.length ? note(country.warnings.join('；'), 'warning') : ''}</div></section>`).join('');
    body += `<details class="business-details"><summary>来源与发布依据 · ${data.sources?.length || 0} 条</summary><p class="muted">税则日期 ${esc(data.ruleDate)} · 服务版本 ${esc(data.serviceVersion)}</p>${sourceList(data.sources)}<small>发布快照 ${esc(data.snapshotHash)}</small></details>`;
    return panel('关务查询结果', `查询编号 ${data.queryId}`, `<div class="panel-body">${body}</div>`);
  }
  function customsPage() {
    const saved = state.customsInput || { query: '', ruleDate: today(), codeCountry: 'CN', attributes: { originCountry: 'CN' } };
    return head('关税与归类查询', '中国原产商品 · 在同一页面核对中国出口、美国进口与加拿大进口。') + `<div class="business-layout"><form class="panel business-input-panel" data-form="business-customs"><div class="panel-head"><h2>商品资料</h2></div><div class="panel-body">${formError}<div class="field-grid">${field('商品名称或 HS 编码', 'query', input('query', `required maxlength="200" value="${esc(saved.query)}" placeholder="例如：不锈钢水杯 / 732393"`), '名称查询请尽量说明材质和用途。', true)}${field('税则日期', 'ruleDate', input('ruleDate', `type="date" required value="${esc(saved.ruleDate)}"`))}${field('编码所属地区', 'codeCountry', `<select id="codeCountry" name="codeCountry">${Object.entries(labels).filter(([key]) => ['CN', 'US', 'CA'].includes(key)).map(([key, value]) => `<option value="${key}" ${saved.codeCountry === key ? 'selected' : ''}>${value}</option>`).join('')}</select>`)}${field('原产国', 'originCountry', '<input id="originCountry" value="中国" readonly>', '当前支持中国原产商品。', true)}${field('主要材质', 'material', input('material', `maxlength="200" value="${esc(saved.attributes.material || '')}" placeholder="例如：不锈钢"`), '', true)}${field('用途', 'use', input('use', `maxlength="200" value="${esc(saved.attributes.use || '')}" placeholder="例如：日常饮水"`), '', true)}</div><div class="field-grid">${[['vacuumInsulated', '真空或双层保温结构'], ['contains_steel_aluminum', '含钢铁或铝成分']].map(([key, label]) => field(label, key, `<select id="${key}" name="${key}"><option value="">尚未补充</option>${[['yes', '是'], ['no', '否'], ['unknown', '不确定']].map(([value, text]) => `<option value="${value}" ${saved.attributes[key] === value ? 'selected' : ''}>${text}</option>`).join('')}</select>`)).join('')}</div>${actions('查询关税与归类')}<p class="form-fineprint">结果来自关务服务。归类未确认或数据未就绪时，会保留复核提示。</p></div></form><div id="business-results" aria-live="polite">${customsResults()}</div></div>`;
  }
  function freightcomAmount(value) {
    if (!value) return '待确认';
    return value.amount === null ? `${esc(value.minor_value)} ${esc(value.currency)} 最小货币单位` : `${esc(value.amount)} ${esc(value.currency)}`;
  }
  function freightcomResults() {
    const result = state.freightcomResult;
    if (!result) return panel('承运商询价结果', '费率、附加费和有效期将在这里展示', '<div class="empty-state"><div class="empty-symbol">' + icon('truck') + '</div><h2>填写托盘和收发货资料</h2><p>查询只读取承运商当前预估费用，不会保存报价或创建订舱。</p></div>');
    let body = resultNote(result); const data = result.data;
    if (!data) return panel('承运商询价结果', '资料已保留，可在服务恢复后重试', `<div class="panel-body">${body}</div>`);
    body += `<p class="muted">以下为 Freightcom 承运商预估费用。仅对本次输入和有效日期成立，尚未保存、发送或订舱。</p>`;
    if (!data.rates?.length) body += '<div class="empty-state"><h2>未返回可用费率</h2><p>请核对地址、托盘和服务条件后重试。</p></div>';
    else body += `<div class="candidate-list">${data.rates.map((rate) => `<section class="candidate-row"><div><span class="badge ${result.status === 'success' ? 'success' : 'warning'}">${esc(rate.carrier_name || '承运商待确认')}</span><h3>${esc(rate.service_name || rate.service_id || '服务待确认')}</h3><div class="result-metric">${freightcomAmount(rate.total)}</div><small>有效至 ${esc(rate.valid_until || '待确认')}${rate.transit_time_days !== null ? ` · 预计 ${esc(rate.transit_time_days)} 天` : ''}</small></div><details class="business-details"><summary>费用明细与服务信息</summary><dl class="detail-list"><dt>基础费</dt><dd>${freightcomAmount(rate.base)}</dd>${(rate.surcharges || []).map((item) => `<dt>${esc(item.type)}</dt><dd>${freightcomAmount(item.amount)}</dd>`).join('')}${(rate.taxes || []).map((item) => `<dt>${esc(item.type)}</dt><dd>${freightcomAmount(item.amount)}</dd>`).join('')}<dt>无纸化资料</dt><dd>${rate.paperless === true ? '支持' : rate.paperless === false ? '不支持' : '待确认'}</dd><dt>关务费用保证</dt><dd>${rate.customs_charge_data?.is_rate_guaranteed === true ? '已标记保证' : '未标记保证'}</dd></dl></details></section>`).join('')}</div>`;
    body += `<details class="business-details"><summary>承运商来源与请求引用</summary><p><code>${esc(data.rate_request_ref)}</code></p>${sourceList(result.source_refs)}</details>`;
    return panel('承运商预估费用', `${esc(data.rates?.length || 0)} 个可查看结果`, `<div class="panel-body">${body}</div>`);
  }
  function freightcomPage() {
    return head('私人地址报价 · Freightcom', '按实际托盘查询承运商费率，核对原币种、附加费和有效期。', ui.canConfigure?.() ? '<a class="button" href="#configure/quote.freightcom_ltl.preview">配置 Freightcom</a>' : '') + `<div class="business-layout carrier-business-layout"><form class="panel business-input-panel" data-form="business-freightcom"><div class="panel-head"><div><h2>承运商询价资料</h2><p>加拿大住宅派送 · Freightcom 实时报价</p></div></div><div class="panel-body">${formError}${carrierForm.render(state.freightcomInput || {})}${actions('获取承运商当前费率')}<p class="form-fineprint">查询使用当前企业的 Freightcom 凭证；确认运输方案后另行安排订舱。</p></div></form><div id="business-results" aria-live="polite">${freightcomResults()}</div></div>`;
  }
  function quoteResults() {
    const result = state.quoteResult;
    if (!result) return panel('询价结果', '计算后查看费用拆分与适用条件', '<div class="empty-state"><div class="empty-symbol">' + icon('truck') + '</div><h2>确认资料后获取规则试算</h2><p>填写邮编、货物和派送条件后，查看计费托数、费用拆分与来源版本。</p></div>');
    const data = result.data;
    let body = resultNote(result);
    const rateSource=result.source_refs?.find(ref=>ref.system==='freightclaw-native-quote')||result.source_refs?.[0];
    const evidence=`<dl class="detail-list"><dt>运价来源</dt><dd>${esc(rateSource?.locator||'来源未提供，请核对')}</dd><dt>发布版本</dt><dd>${esc(data?.match_trace?.published_version??rateSource?.version??'版本未提供')}</dd><dt>适用有效期</dt><dd>${esc(data?.match_trace?.valid_from&&data?.match_trace?.valid_until?data.match_trace.valid_from+' 至 '+data.match_trace.valid_until:'有效期未提供，请核对')}</dd></dl>`;
    if (data) body += `<div class="result-summary"><small>规则试算合计</small><div class="result-metric">${money(data.total_price, data.currency)}</div><p>本次报价币种 ${esc(data.currency)}，尚未保存或发出正式报价。</p>${evidence}</div><dl class="detail-list"><dt>发货起点</dt><dd>${esc(data.origin || '待确认')}</dd><dt>目的地</dt><dd>${esc([data.city, data.province, data.postal_code].filter(Boolean).join(' · ') || '待确认')}</dd><dt>计费托数</dt><dd>${esc(data.billing_pallets ?? '待确认')}</dd><dt>基础运费</dt><dd>${money(data.base_price, data.currency)}</dd><dt>燃油费</dt><dd>${money(data.fuel, data.currency)}</dd>${Object.entries(data.accessorials || {}).map(([key, value]) => `<dt>${esc(({ liftgate: '尾板', pallet_jack: '地牛', appointment: '预约', detention: '等待费', residential_fee_usd:'住宅费',liftgate_fee_usd:'尾板',pallet_jack_fee_usd:'地牛',appointment_fee_usd:'预约',detention_fee_usd:'等待费' })[key] || key)}</dt><dd>${money(value, data.currency)}</dd>`).join('')}</dl>${data.risk_tags.length ? `<div class="result-section">${note(`需要核对：${data.risk_tags.join('、')}`, 'warning')}</div>` : ''}${data.sales_note ? `<div class="result-section"><h3>业务说明</h3><p>${esc(data.sales_note)}</p></div>` : ''}<details class="business-details"><summary>计算与来源依据</summary><p>匹配规则：${esc(data.matched_rule)} · 计价区域：${esc(data.zone ?? '待确认')}</p>${sourceList(result.source_refs)}</details>`;
    if (data && result.status === 'success' && data.total_price != null) body += `<section class="result-section"><button class="button primary" data-action="business-quote-document" data-save-preview>制作报价单</button><p>将本次试算转入报价单草稿，补充客户信息后核对。</p></section>`;
    if (data && !result.source_refs?.some(ref=>ref.system==='freightclaw-native-quote') && ['success', 'manual_review'].includes(result.status)) body += `<section class="result-section"><h3>保存到原报价系统</h3><p class="muted">保存会重新核对本次输入和价格依据。需要复核的结果将建立待处理记录，不会通知客户。</p>${state.saved ? resultNote(state.saved) : ''}${state.saved?.data?.saved && state.saved.data.readback_verified ? `${note('已保存到原系统，并已读回确认。当前记录未发送；需要人工复核的报价应先完成复核。', 'success')}<p><code>${esc(state.saved.data.record_ref)}</code></p><button class="button" data-go="quote-history">查看我的报价记录</button>` : state.prepared?.data?.preview_handle ? `<p>本次核对有效至 ${esc(new Date(state.prepared.data.expires_at).toLocaleTimeString('zh-CN'))}。</p><button class="button primary" data-action="business-quote-save" data-save-preview>${state.saved?.data?.saved && !state.saved.data.readback_verified ? '重试核对保存结果' : '保存待复核记录'}</button>` : `<button class="button" data-action="business-quote-prepare" data-save-preview>核对并准备保存</button>`}</section>`;
    return panel('费用与条件', '依据已发布运价与明确的派送条件', `<div class="panel-body">${body}</div>`);
  }
  function quotePage(kind) {
    state.privateAddress=kind==='private'||kind==='freightcom';
    if (kind === 'freightcom') return freightcomPage();
    const saved = state.quoteInput || {};
    const extraction = state.extraction;window.queueMicrotask(()=>{const form=document.querySelector('[data-form="business-quote"]');if(form&&cargoLines.enabled())cargoLines.update(form);});
    const confirmChoices = state.privateAddress || Boolean(extraction);
    const choice = (key, yes, no) => typeof saved[key] === 'boolean' ? (saved[key] ? yes : no) : '';
    return head('私人地址报价 · 自有运价', '按已发布的邮编分区与运价表计算，核对货物、卸货条件和费用。', ui.canConfigure?.() ? '<a class="button" href="#configure/quote.zone_preview">管理自有运价</a>' : '') + `<div class="quote-extraction">${panel('粘贴询价资料', '支持多行货物、表格与混合单位，先整理再确认', `<form class="panel-body" data-form="business-extract">${formError}${field('客户询价资料', 'customer_message', '<textarea id="customer_message" name="customer_message" rows="4" maxlength="20000" required placeholder="粘贴客户发来的地址、件数、尺寸、重量和卸货条件…">' + esc(state.customerMessage || '') + '</textarea>')}${actions('提取资料')}${extraction ? extractionSummary(extraction) : ''}</form>`)}</div><div class="business-layout quote-business-layout"><div><form class="panel" data-form="business-quote"><div class="panel-head"><div><h2>确认询价资料</h2><p>数量与单位分开确认，缺失条件会影响结果。</p></div></div><div class="panel-body">${formError}<section class="form-section"><h3>收货地址</h3><div class="field-grid">${field('起运地（可选）','quote_origin',input('quote_origin',`maxlength="100" value="${esc(saved.extensions?.origin_v1||'')}" placeholder="留空按邮编匹配；如 toronto、calgary"`),'一个邮编匹配多个起运地时需明确选择。')}${field('详细地址', 'address_line', input('address_line', `maxlength="500" value="${esc(saved.address_line || '')}" placeholder="街道、门牌号"`), '', true)}${field('加拿大邮编', 'postal_code', input('postal_code', `required maxlength="7" value="${esc(saved.postal_code || '')}" placeholder="例如：M1B 5W9"`))}${field('地址类型', 'address_type', `<select id="address_type" name="address_type" required><option value="">请选择地址类型</option>${[['commercial', '商业地址'], ['residential', '住宅地址'], ['private', '私人地址'], ['rural_residential', '偏远住宅']].filter(([value])=>!state.privateAddress||value!=='commercial').map(([value, label]) => `<option value="${value}" ${saved.address_type === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}${field('城市', 'city', input('city', `maxlength="120" value="${esc(saved.city || '')}" placeholder="城市"`))}${field('省份', 'province', input('province', `maxlength="32" value="${esc(saved.province || '')}" placeholder="例如：ON"`))}</div></section>${cargoLines.render()}<section class="form-section"><h3>货物信息</h3><div class="field-grid">${field('总体积 · m³', 'cbm', input('cbm', `inputmode="decimal" required pattern="[0-9]+([.][0-9]+)?" value="${esc(saved.cbm || '')}" placeholder="例如：1.2"`))}${field('总重量 · kg', 'weight_kg', input('weight_kg', `inputmode="decimal" required pattern="[0-9]+([.][0-9]+)?" value="${esc(saved.weight_kg || '')}" placeholder="例如：300"`))}${field('件数', 'piece_count', input('piece_count', `type="number" min="1" step="1" required value="${esc(saved.piece_count || '')}"`))}${field('包装类型', 'packaging_type', `<select id="packaging_type" name="packaging_type" required><option value="">请选择包装类型</option>${[['carton', '纸箱'], ['pallet', '托盘'], ['crate', '木箱'], ['mixed','按逐组包装']].map(([value, label]) => `<option value="${value}" ${saved.packaging_type === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}${field('最长边 · cm', 'longest_side_cm', input('longest_side_cm', `inputmode="decimal" pattern="[0-9]+([.][0-9]+)?" value="${esc(saved.longest_side_cm || '')}"`))}${field('实际托盘数', 'explicit_pallet_count', input('explicit_pallet_count', `type="number" min="1" step="1" value="${esc(saved.explicit_pallet_count || '')}"`), '只有明确提供托盘数量时填写。')}${field('能否叠放', 'is_stackable', `<select id="is_stackable" name="is_stackable"><option value="">待确认</option><option value="true" ${saved.is_stackable === true ? 'selected' : ''}>可叠放</option><option value="false" ${saved.is_stackable === false ? 'selected' : ''}>不可叠放</option></select>`)}</div></section><section class="form-section"><h3>卸货与预约</h3>${confirmChoices?`<div class="field-grid">${field('卸货方式','delivery_unload',privateSelect('delivery_unload',[['self','收货人自行卸货，无需尾板'],['liftgate','需要尾板卸货']],choice('requires_liftgate','liftgate','self')))}${field('地牛服务','pallet_jack_choice',privateSelect('pallet_jack_choice',[['yes','需要地牛'],['no','无需地牛']],choice('requires_pallet_jack','yes','no')))}${field('送货预约','appointment_choice',privateSelect('appointment_choice',[['yes','需要预约'],['no','无需预约']],choice('requires_appointment','yes','no')))}</div>`:''}<div class="choice-list">${(confirmChoices?[]:[['requires_liftgate', '需要尾板'], ['requires_pallet_jack', '需要地牛'], ['requires_appointment', '需要预约']]).map(([key, label]) => `<label class="choice-row"><input type="checkbox" name="${key}" ${saved[key] ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div><div class="field-grid">${field('预计等待时间 · 分钟', 'detention_minutes', input('detention_minutes', `type="number" min="0" step="1" value="${esc(saved.detention_minutes || '0')}"`))}</div></section>${extraction?.data ? '<label class="choice-row"><input type="checkbox" name="extraction_confirmed" required><span>我已核对逐行货物、合计数值和交付条件</span></label>' : ''}${actions('查询规则试算')}<p class="form-fineprint">不会自动保存报价或通知客户。正式发送前仍需核对费率来源和业务条件。</p></div></form></div><div id="business-results" aria-live="polite">${quoteResults()}</div></div>`;
  }

  function captureQuote(form){if(!form)return;const data=new FormData(form),get=n=>String(data.get(n)||'');state.quoteInput=readQuote(data,get);if(cargoLines.enabled()){try{const {lines:_lines,...totals}=cargoLines.read(form);void _lines;Object.assign(state.quoteInput,totals,{extensions:{...(state.quoteInput.extensions||{}),cargo_lines_v1:cargoLines.lines()}});}catch{/* Keep incomplete rows editable. */}}}
  function readQuote(data,get){return { ...(get('quote_origin')?{extensions:{origin_v1:get('quote_origin')}}:{}),postal_code: get('postal_code'), address_line: get('address_line') || null, city: get('city') || null, province: get('province') || null, cbm: get('cbm'), weight_kg: get('weight_kg'), piece_count: Number(get('piece_count')), packaging_type: get('packaging_type'), address_type: get('address_type'), longest_side_cm: get('longest_side_cm') || null, explicit_pallet_count: get('explicit_pallet_count') ? Number(get('explicit_pallet_count')) : null, is_stackable: get('is_stackable') ? get('is_stackable') === 'true' : null, requires_liftgate: data.has('delivery_unload')?(get('delivery_unload')?get('delivery_unload')==='liftgate':null):data.has('requires_liftgate'), requires_pallet_jack: data.has('pallet_jack_choice')?(get('pallet_jack_choice')?get('pallet_jack_choice')==='yes':null):data.has('requires_pallet_jack'), requires_appointment: data.has('appointment_choice')?(get('appointment_choice')?get('appointment_choice')==='yes':null):data.has('requires_appointment'), detention_minutes: Number(get('detention_minutes')) };}
  async function call(path, value) { return ui.api(`/business/${path}`, { method: 'POST', body: { input: value }, acceptBusiness: true }); }
  async function submit(form) {
    const type = form.dataset.form;
    if (!type?.startsWith('business-')) return false;
    const data = new FormData(form); const get = (key) => String(data.get(key) || '').trim();
    if (type === 'business-customs') {
      state.customsInput = { query: get('query'), ruleDate: get('ruleDate'), codeCountry: get('codeCountry'), attributes: { originCountry: 'CN', ...(get('material') ? { material: get('material') } : {}), ...(get('use') ? { use: get('use') } : {}), ...(get('vacuumInsulated') ? { vacuumInsulated: get('vacuumInsulated') } : {}), ...(get('contains_steel_aluminum') ? { contains_steel_aluminum: get('contains_steel_aluminum') } : {}) } };
      state.customsResult = await call('customs/query', state.customsInput);
    } else if (type === 'business-customs-answer') {
      const attribute = state.customsResult?.data?.nextQuestion?.attribute;
      const answer = get('answer');
      if (attribute === 'codeCountry' && ['中国', '美国', '加拿大'].includes(answer)) state.customsInput = { ...state.customsInput, codeCountry: { 中国: 'CN', 美国: 'US', 加拿大: 'CA' }[answer] };
      else if (['vacuumInsulated', 'contains_steel_aluminum'].includes(attribute) && ['是', '否', '不确定'].includes(answer)) state.customsInput = { ...state.customsInput, attributes: { ...state.customsInput.attributes, [attribute]: { 是: 'yes', 否: 'no', 不确定: 'unknown' }[answer] } };
      else if (['material', 'use'].includes(attribute)) state.customsInput = { ...state.customsInput, attributes: { ...state.customsInput.attributes, [attribute]: answer } };
      else throw Object.assign(new Error('customs_additional_evidence_required'), { code: 'customs_additional_evidence_required' });
      state.customsResult = await call('customs/query', state.customsInput);
    } else if (type === 'business-extract') {
      state.customerMessage = get('customer_message');
      state.extraction = await call('quote/extract', { customer_message: state.customerMessage });
      state.quoteResult = null; state.prepared = null; state.saved = null; state.quoteInput = null; cargoLines.reset();
      if (state.extraction.data?.extraction) {
        const extracted = state.extraction.data.extraction;if(!state.extraction.reason_codes?.includes('extraction_conflict')&&!extracted.missing_fields?.some(k=>['weight_kg','cbm','piece_count','longest_side_cm'].includes(k)))cargoLines.extract(extracted.cargo_items||[]);
        const keys = ['address_line','postal_code','city','province','cbm','weight_kg','piece_count','packaging_type','longest_side_cm','explicit_pallet_count','is_stackable','address_type','requires_liftgate','requires_pallet_jack','requires_appointment','detention_minutes'];
        state.quoteInput = Object.fromEntries(keys.map(key => [key, extracted.missing_fields?.includes(key) ? null : extracted[key]]));
      }
    } else if (type === 'business-quote') {
      state.prepared = null; state.saved = null;
      state.quoteInput = readQuote(data,get);
      if(cargoLines.enabled()){try{const totals=cargoLines.read(form);const {lines:_lines,...summary}=totals;void _lines;Object.assign(state.quoteInput,summary,{packaging_type:'mixed',extensions:{...(state.quoteInput.extensions||{}),cargo_lines_v1:cargoLines.lines()}});}catch{throw Object.assign(new Error('cargo_lines_invalid'),{code:'cargo_lines_invalid'});}}
      state.quoteResult = await call('quote/preview', state.quoteInput);
    } else if (type === 'business-freightcom') {
      state.freightcomInput=carrierForm.read(data);
      state.freightcomResult = await call('quote/freightcom-ltl-preview', state.freightcomInput);
    } else if (type === 'business-quote-review-resolve') {
      const prepared = state.reviewPrepared?.data;
      if (!prepared?.resolution_handle) return true;
      const decision = get('decision'); const approving = decision === 'approve_manual_price';
      let chargeLines;
      if (approving) {
        chargeLines = get('charge_lines').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
          const parts = line.split('|').map((item) => item.trim());
          if (parts.length !== 3 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(parts[0]) || !/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(parts[2])) throw Object.assign(new Error('quote_review_resolution_invalid'), { code: 'quote_review_resolution_invalid' });
          return { code: parts[0], label: parts[1], amount_usd: parts[2] };
        });
      }
      if (approving && (!data.has('confirmed') || !get('total_price_usd') || !get('evidence_ref') || !get('evidence_version') || !get('effective_at') || !get('valid_until') || !chargeLines?.length || !get('customer_terms'))) throw Object.assign(new Error('quote_review_resolution_invalid'), { code: 'quote_review_resolution_invalid' });
      const body = { expected_task_version: prepared.task_version, resolution_handle: prepared.resolution_handle, decision,
        note: get('note'), ...(approving ? { total_price_usd: get('total_price_usd'), evidence_ref: get('evidence_ref'), evidence_version: get('evidence_version'), effective_at: new Date(get('effective_at')).toISOString(), valid_until: new Date(get('valid_until')).toISOString(), charge_lines: chargeLines, customer_terms: get('customer_terms'), confirmed: 'human_verified_price_and_source' } : {}) };
      state.reviewResolved = await ui.mutate(`/business/quote/review-tasks/${encodeURIComponent(prepared.task_ref)}/resolve`, 'POST', body, { acceptBusiness: true });
      if (state.reviewResolved.data?.readback_verified) { state.reviewPrepared = null; state.reviewQueue = null; state.history = null; state.historyRecord = null; }
    }
    ui.rerender(); if (matchMedia('(max-width: 900px)').matches) document.querySelector('#business-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return true;
  }
  async function action(button) {
    const quoteForm=document.querySelector('[data-form="business-quote"]');
    if(button.dataset.action?.startsWith('business-cargo-')){captureQuote(quoteForm);cargoLines.action(button,quoteForm);state.quoteResult=null;ui.rerender();return true;}
    if (['business-fc-add','business-fc-remove'].includes(button.dataset.action)) {
      const form=document.querySelector('[data-form="business-freightcom"]');
      state.freightcomInput=carrierForm.read(new FormData(form));
      const pallets=state.freightcomInput.details.packaging_properties.pallets;
      if(button.dataset.action==='business-fc-add'&&pallets.length<50) pallets.push({});
      if(button.dataset.action==='business-fc-remove'&&pallets.length>1) pallets.splice(Number(button.dataset.index),1);
      state.freightcomResult=null;ui.rerender();return true;
    }
    if (button.dataset.action === 'business-quote-document') { if(state.quoteResult?.status==='success') ui.quoteDocumentFromPreview(state.quoteResult,state.quoteInput); return true; }
    if (button.dataset.action === 'business-quote-prepare') {
      state.prepared = await call('quote/records/prepare', state.quoteInput); state.saved = null;
      if (state.prepared.data?.preview) state.quoteResult = { ...state.prepared, data: state.prepared.data.preview };
      else state.saved = state.prepared;
      ui.rerender(); return true;
    }
    if (button.dataset.action === 'business-quote-save') {
      if (!state.prepared?.data?.preview_handle) return true;
      state.saved = await ui.mutate('/business/quote/records/save', 'POST', { input: { request: state.quoteInput, preview_handle: state.prepared.data.preview_handle, intent: 'save_draft' } }, { acceptBusiness: true });
      if (state.saved.data?.preview_changed) { state.prepared = { ...state.saved, data: { preview: state.saved.data.preview, preview_handle: state.saved.data.preview_handle, expires_at: state.saved.data.expires_at } }; state.quoteResult = { ...state.saved, data: state.saved.data.preview }; }
      if (state.saved.data?.readback_verified) state.history = null;
      ui.rerender(); return true;
    }
    if (button.dataset.action === 'business-record-open') {
      state.historyRecord = await call('quote/records/get', { record_ref: button.dataset.id }); state.documentResult = null;
      state.review = await call('quote/records/review', { record_ref: button.dataset.id }); ui.rerender(); return true;
    }
    if (button.dataset.action === 'business-record-more') {
      if (!state.history?.data?.next_cursor) return true;
      const next = await call('quote/records/list', { limit: 50, cursor: state.history.data.next_cursor });
      if (next.status === 'success' && next.data?.records) { state.history = { ...next, data: { ...next.data, records: [...new Map([...state.history.data.records, ...next.data.records].map((record) => [record.record_ref, record])).values()] } }; state.historyError = null; }
      else state.historyError = next;
      ui.rerender(); return true;
    }
    if (button.dataset.action === 'business-review-open') {
      state.reviewResolved = null; state.reviewPrepared = await ui.api(`/business/quote/review-tasks/${encodeURIComponent(button.dataset.id)}/resolution-preview`, { acceptBusiness: true }); ui.rerender(); return true;
    }
    if (button.dataset.action === 'business-document-create') {
      state.documentResult = await ui.mutate(`/business/quote/records/${encodeURIComponent(button.dataset.id)}/documents`, 'POST', { document_kind: button.dataset.kind }, { acceptBusiness: true });
      if (state.documentResult.data?.readback_verified) { state.historyRecord = await call('quote/records/get', { record_ref: button.dataset.id }); state.history = null; }
      ui.rerender(); return true;
    }
    if (button.dataset.action === 'business-record-refresh') { state.history = null; state.historyError = null; state.historyRecord = null; state.review = null; state.reviewQueue = null; state.reviewPrepared = null; state.reviewResolved = null; state.documentResult = null; ui.rerender(); return true; }
    if (button.dataset.action !== 'business-customs-candidate') return false;
    state.customsInput = { ...state.customsInput, selectedHs6: button.dataset.id };
    state.customsResult = await call('customs/query', state.customsInput); ui.rerender(); return true;
  }
  function reset() { cargoLines.reset(); Object.keys(state).forEach((key) => { state[key] = null; }); }
  function reviewPanel() {
    if (state.reviewQueue?.status === 'blocked' && state.reviewQueue.reason_codes?.includes('quote_reviewer_role_required')) return '';
    const tasks = state.reviewQueue?.data?.tasks || []; const prepared = state.reviewPrepared?.data;
    const queueBody = !state.reviewQueue ? '<div class="panel-body"><p class="muted">正在读取待复核记录…</p></div>' : state.reviewQueue.status !== 'success' ? `<div class="panel-body">${resultNote(state.reviewQueue)}</div>` : tasks.length ? `<div class="table-scroll"><table><thead><tr><th>记录 / 任务</th><th>原因与版本</th><th></th></tr></thead><tbody>${tasks.map((task) => `<tr><td><span class="cell-title"><code>${esc(task.record_ref)}</code></span><small>${esc(new Date(task.created_at).toLocaleString('zh-CN'))}</small></td><td>${esc(task.reason)}<small>记录 v${esc(task.record_version)} · 任务 v${esc(task.task_version)}</small></td><td><button class="text-button" data-action="business-review-open" data-id="${esc(task.task_ref)}">重新计算并复核</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="panel-body"><p class="muted">当前没有待处理的人工复核任务。</p></div>';
    const chargeDraft = prepared ? [['base_freight', '基础运费', prepared.preview.base_price], ['fuel', '燃油附加费', prepared.preview.fuel], ...Object.entries(prepared.preview.accessorials || {}).map(([code, amount]) => [code, code, amount])].filter((line) => line[2] !== null).map((line) => line.join(' | ')).join('\n') : '';
    const form = prepared ? panel('人工证据确认', `${prepared.record_ref} · 任务 v${prepared.task_version}`, `<form class="panel-body" data-form="business-quote-review-resolve">${formError}${state.reviewResolved ? resultNote(state.reviewResolved) : ''}<div class="result-summary"><small>重新计算的规则试算</small><div class="result-metric">${money(prepared.preview.total_price, prepared.preview.currency)}</div><p>这里的规则试算不是人工确认价。必须核对独立费率证据后填写。</p></div><div class="field-grid">${field('处理方式', 'decision', '<select id="decision" name="decision"><option value="approve_manual_price">确认人工价格与来源</option><option value="keep_manual_review">保留待复核</option></select>')}${field('人工确认总价 · USD', 'total_price_usd', input('total_price_usd', 'inputmode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" placeholder="例如：245.50"'))}${field('逐项费用 · 每行 code | 名称 | USD 金额', 'charge_lines', `<textarea id="charge_lines" name="charge_lines" maxlength="4000" required>${esc(chargeDraft)}</textarea>`, '逐项合计必须等于人工确认总价。', true)}${field('证据引用', 'evidence_ref', input('evidence_ref', 'maxlength="128" placeholder="供应商费率或审批引用"'))}${field('证据版本', 'evidence_version', input('evidence_version', 'maxlength="128" placeholder="费率发布版本"'))}${field('证据生效时间', 'effective_at', input('effective_at', 'type="datetime-local"'))}${field('报价有效期至', 'valid_until', input('valid_until', 'type="datetime-local"'))}${field('客户可见条款与卸货条件', 'customer_terms', '<textarea id="customer_terms" name="customer_terms" maxlength="4000" required></textarea>', '请写明卸货责任、额外服务与金额适用条件。', true)}${field('复核说明', 'note', '<textarea id="note" name="note" maxlength="1000" required></textarea>', '', true)}</div><label class="choice-row"><input type="checkbox" name="confirmed"><span>我已人工核对逐项金额、币种、服务条件、费率来源与有效期</span></label>${actions('提交复核结果')}<p class="form-fineprint">提交不会通知客户、发送报价或创建订舱。</p></form>`) : '';
    return panel('人工复核队列', '仅企业所有者或管理员可请求；原报价服务仍按复核名单最终判权', queueBody) + form;
  }
  function historyPage() {
    if (!state.history && !state.historyLoading) {
      state.historyLoading = true;
      call('quote/records/list', { limit: 50 }).then((result) => { state.history = result; }).catch(() => { state.history = { status: 'unavailable', data: null, reason_codes: ['quote_record_connection_unconfigured'] }; }).finally(() => { state.historyLoading = false; if (location.hash === '#quote-history') ui.rerender(); });
    }
    if (!state.reviewQueue && !state.reviewQueueLoading) { state.reviewQueueLoading = true; ui.api('/business/quote/review-queue', { acceptBusiness: true }).then((result) => { state.reviewQueue = result; }).catch(() => { state.reviewQueue = { status: 'unavailable', data: null, reason_codes: ['quote_record_connection_unconfigured'] }; }).finally(() => { state.reviewQueueLoading = false; if (location.hash === '#quote-history') ui.rerender(); }); }
    const rows = state.history?.data?.records || [];
    const record = state.historyRecord?.data;
    const pagination = state.history?.data?.next_cursor ? '<div class="panel-body"><button class="button" data-action="business-record-more">加载更多记录</button></div>' : '';
    const historyFooter = `${state.historyError ? resultNote(state.historyError) : ''}${pagination}`;
    const table = panel('已保存的记录', '只展示当前企业、当前人员有权恢复的原记录', !state.history ? '<div class="panel-body"><p class="muted">正在读取原系统记录…</p></div>' : rows.length ? `<div class="table-scroll"><table><thead><tr><th>目的地 / 记录</th><th>保存状态</th><th>金额</th><th></th></tr></thead><tbody>${rows.map((item) => `<tr><td><span class="cell-title">${esc([item.request.city, item.request.postal_code].filter(Boolean).join(' · '))}</span><small>${esc(new Date(item.created_at).toLocaleString('zh-CN'))}</small></td><td><span class="badge ${item.record_status === 'quoted' && item.quote_ready ? 'success' : 'warning'}">${item.record_status === 'quoted' ? (item.quote_ready ? '已人工确认' : '已过有效期') : item.record_status === 'manual_required' ? '等待人工复核' : '草稿'}</span></td><td class="numeric">${money(item.total_price_usd || item.preview.total_price, item.currency)}</td><td><button class="text-button" data-action="business-record-open" data-id="${esc(item.record_ref)}">查看原记录</button></td></tr>`).join('')}</tbody></table></div>${historyFooter}` : `<div class="panel-body">${state.history.status === 'success' ? '<div class="empty-state"><h2>暂无本人报价记录</h2><p>完成询价后，明确保存的结果才会出现在这里。</p><button class="button primary" data-go="quote">开始询价</button></div>' : resultNote(state.history)}</div>`);
    const detail = state.historyRecord ? panel('原记录详情', record?.record_ref || '读取未完成', `<div class="panel-body">${resultNote(state.historyRecord)}${record ? `<dl class="detail-list"><dt>保存与读回</dt><dd>${record.readback_verified ? '已读回确认' : '等待核对'}</dd><dt>当前状态</dt><dd>${record.record_status === 'quoted' ? (record.quote_ready ? '已人工确认价格与来源' : '人工确认已过有效期') : record.record_status === 'manual_required' ? '等待人工复核' : '草稿'}</dd><dt>货物</dt><dd>${esc(record.request.piece_count)} 件 · ${esc(record.request.cbm)} m³ · ${esc(record.request.weight_kg)} kg</dd><dt>规则试算</dt><dd>${money(record.preview.total_price, record.currency)}</dd><dt>人工确认总价</dt><dd>${money(record.total_price_usd, record.currency)}</dd><dt>可否发送</dt><dd>当前 API 不会发送报价</dd></dl>${record.review_evidence ? `<section class="result-section"><h3>人工价格证据</h3><p><code>${esc(record.review_evidence.evidence_ref)}</code></p><small>版本 ${esc(record.review_evidence.evidence_version)} · 生效 ${esc(new Date(record.review_evidence.effective_at).toLocaleString('zh-CN'))} · 有效至 ${esc(new Date(record.review_evidence.valid_until).toLocaleString('zh-CN'))}</small>${record.quote_ready ? '' : '<p class="muted">当前已过有效期，只能作为历史记录查看。</p>'}${record.charge_lines?.length ? `<dl class="detail-list">${record.charge_lines.map((line) => `<dt>${esc(line.label)}</dt><dd>${money(line.amount_usd, 'USD')}</dd>`).join('')}</dl>` : ''}${record.customer_terms ? `<p>${esc(record.customer_terms)}</p>` : ''}</section>` : ''}${state.review?.data?.tasks?.map((task) => `<section class="result-section"><h3>人工复核任务</h3><p>${esc(({ pending: '等待处理', in_progress: '处理中', resolved: '已处理', closed: '已关闭' })[task.status] || task.status)} · ${esc(task.reason)}</p></section>`).join('') || ''}<section class="result-section"><h3>导出报价 PDF</h3><p class="muted">正式文件只使用已读回的人工确认价；草稿会显示不可正式使用水印。</p>${state.documentResult ? resultNote(state.documentResult) : ''}<div class="form-actions"><button class="button" data-action="business-document-create" data-kind="draft_quote_pdf" data-id="${esc(record.record_ref)}">生成带水印草稿</button>${record.quote_ready ? `<button class="button primary" data-action="business-document-create" data-kind="formal_quote_pdf" data-id="${esc(record.record_ref)}">生成正式 PDF</button>` : ''}</div>${state.documentResult?.data?.document_ref && state.documentResult.data.readback_verified ? `<p><a class="button" href="/console/api/v1/business/quote/documents/${encodeURIComponent(state.documentResult.data.document_ref)}/content">下载并校验文件</a></p>` : ''}</section>${record.resolution?.recalculation?.source_refs ? `<details class="business-details"><summary>人工处置时重新计算的来源</summary>${sourceList(record.resolution.recalculation.source_refs)}</details>` : ''}${sourceList(record.source_refs)}` : ''}</div>`) : '';
    return head('我的报价记录', '从原报价系统读取本人保存的记录与人工复核状态。', '<button class="button" data-action="business-record-refresh">刷新记录</button>') + reviewPanel() + table + detail;
  }
  return { input(event){
    cargoLines.input(event);
    const form=event.target.closest('form');
    if(form?.dataset.form==='business-quote') {captureQuote(form);state.quoteResult=null;state.prepared=null;state.saved=null;}
    if(form?.dataset.form==='business-freightcom') {state.freightcomInput=carrierForm.read(new FormData(form));state.freightcomResult=null;}
  }, change(event){if(cargoLines.change(event)){captureQuote(event.target.closest('form'));state.quoteResult=null;ui.rerender();return true;}return false;}, customsPage, quotePage, historyPage, submit, action, reset, restoreHistory(input) { state.customsInput = structuredClone(input); state.customsResult = null; } };
}
