import {createCustomsPackages} from './customs-packages.js';
import { configurationRoute } from './service-catalog.js';
import { createRateEditor } from './native-rate-editor.js';
import { browseCustoms } from '../../services/customs-native/catalog.ts';
import { customsDatasetSchema } from '../../services/customs-native/contracts.ts';
import { residentialRatesSchema } from '../../services/quote-native/contracts.ts';

const names = { 'customs-data': '关务管理', 'residential-rates': '私人地址运价', freightcom: 'Freightcom 配置' };
const rateSections = { base: '基本资料', coverage: '邮编覆盖', pricing: '价格与计费', fees: '附加费', publish: '核验与发布' };
const customsSections = { updates:'数据更新', nomenclature: '税号目录', tariffs: '税率', measures: '贸易措施', requirements: '单证要求', sources: '来源', import: '手动补录', publish: '核验与发布' };
const countries = { all: '全部国家', CN: '中国', US: '美国', CA: '加拿大' };
const billingLabels = { cbm_per_pallet: '每托体积 · m³', kg_per_pallet: '每托重量 · kg', long_piece_threshold_cm: '超长起点 · cm', long_piece_multiplier: '超长件折托倍数', flexible_packaging_threshold: '柔性包装人工复核起点 · 件', suspicious_min_pallets: '异常超长托数下限', suspicious_multiplier: '异常超长托数倍数', max_weight_kg: '最大总重 · kg', max_cbm: '最大体积 · m³', max_length_cm: '最大长度 · cm' };
const feeLabels = { fuel_percent: '燃油比例 · %', residential: '住宅费 · USD', liftgate: '尾板费 · USD', pallet_jack: '地牛费 · USD', appointment: '预约费 · USD', detention_free_minutes: '免费等待 · 分钟', detention_half_hour: '每半小时等待费 · USD' };
const integerKeys = new Set(['long_piece_multiplier', 'flexible_packaging_threshold', 'suspicious_min_pallets', 'suspicious_multiplier', 'detention_free_minutes', 'zone', 'pallets', 'quote_valid_days_v1']);
const freshRates = () => ({ label: '', currency: 'USD', origin: '', valid_from: '', valid_until: '', evidence_ref: '', evidence_version: '', customer_terms: '', zones: [], rates: [], billing: {}, fees: {} });

export function createNativeAdminUi({ api, mutate, esc, head, note, icon, formError, model, rerender, canConfigure }) {
  const packages=createCustomsPackages({api,mutate,esc,rerender});
  let scope = '', epoch = 0, cache = new Map(), approval = null, editor = null, dirty = false, issues = [], notice = '', noticeKind = '', rowPage = 0, catalogSection = '';
  const rateEditor = createRateEditor({esc,field:(...args)=>field(...args),button:(...args)=>button(...args),icon,getEditor:()=>editor,setEditor:value=>{editor=value;},changed:()=>{dirty=true;approval=null;notice='';issues=[];document.querySelectorAll('[data-native-dirty]').forEach(node=>{node.textContent='有未保存修改';});},rerender});
  let filters = { selection: 'published', country: 'all', query: '', offset: 0, limit: 25 };
  const context = () => JSON.stringify([model().sessionGeneration, model().session?.identity?.user_id, model().session?.organization_id]);
  const route = () => configurationRoute(location.hash);
  function reset() { epoch++;packages.reset(); rateEditor.reset(); cache = new Map(); approval = null; editor = null; dirty = false; issues = []; notice = ''; rowPage = 0; filters = { selection: 'published', country: 'all', query: '', offset: 0, limit: 25 }; }
  function sync() { const next = context(); if (next !== scope) { reset(); scope = next; } }
  function load(kind) {
    sync();
    if (!cache.has(kind)) {
      const record = { pending: true }; cache.set(kind, record); const generation = epoch;
      api('/admin/' + kind).then(r => { if (generation === epoch) record.data = r.data; }).catch(e => { if (generation === epoch) record.error = e.code; }).finally(() => { if (generation === epoch) { record.pending = false; if (location.hash.startsWith('#configure/') || location.hash === '#market/configure') rerender(); } });
    }
    return cache.get(kind);
  }
  const button = (label, action, id = '', primary = false) => `<button class="button ${primary ? 'primary' : ''}" type="button" data-action="native-${action}" data-id="${esc(id)}">${label}</button>`;
  const link = label => `<a class="button" href="#market/configure">${label}</a>`;
  const field = (label, name, value = '', type = 'text', hint = '') => `<div class="field"><label for="native-${name}">${label}</label><input id="native-${name}" name="${name}" type="${type}" value="${esc(value ?? '')}" ${type === 'password' ? 'autocomplete="new-password"' : ''} maxlength="${type === 'password' ? 4096 : 2000}">${hint ? `<small>${hint}</small>` : ''}</div>`;
  const issueNote = () => issues.length ? `<div class="inline-note error" role="alert"><strong>请检查以下内容</strong><ul>${issues.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
  function schemaIssues(result) {
    const labels = { ...billingLabels, ...feeLabels, label: '名称', origin: '始发仓', valid_from: '开始日期', valid_until: '截止日期', evidence_ref: '来源编号', evidence_version: '来源版本', customer_terms: '适用条件', zones: '邮编覆盖', rates: '价格表', postal_prefix: '邮编', amount: '金额', zone: '分区', pallets: '计费托数', sources: '来源', nomenclature: '税号', tariffs: '税率', measures: '贸易措施', requirements: '单证', billing: '计费规则', fees: '附加费' };
    return result.error.issues.slice(0, 8).map(item => item.path.map(k => typeof k === 'number' ? `第 ${k + 1} 条` : labels[k] || k).join(' / ') + '：缺失或格式不正确，请核对。');
  }
  function stateLine(kind, value) {
    if (kind === 'freightcom') return value.credential_present ? '已保存凭证 · 实时报价待验证' : '未配置凭证';
    if (!value.active_release) return value.draft ? '已有草稿 · 尚未发布' : '尚未配置';
    const data = value.active_release.input;
    if (kind === 'residential-rates') { const today = new Date().toISOString().slice(0, 10); if (data.valid_until < today) return '运价已过期 · 需要更新'; if (data.valid_from > today) return '已发布 · 尚未到生效日期'; }
    return `已发布 · 版本 ${value.active_release.version}`;
  }
  function configurationStatus(kind) {
    if (!canConfigure()) return '需要企业管理权限';
    const record=load(kind);
    return record.pending ? '正在读取…' : record.error ? '状态读取失败' : stateLine(kind,record.data);
  }
  function facts(kind, input) {
    const items = kind === 'residential-rates' ? [['运价', input.label], ['始发仓', input.origin], ['币种', input.currency], ['有效期', input.valid_from + ' 至 ' + input.valid_until], ['来源', input.evidence_ref + ' / ' + input.evidence_version], ['覆盖', input.zones.length + ' 项邮编 · ' + input.rates.length + ' 档价格'], ['适用条件', input.customer_terms]] : [['数据批次', input.label], ['核验日期', input.rule_date], ['数据量', input.nomenclature.length + ' 项税号 · ' + input.tariffs.length + ' 项税率 · ' + input.measures.length + ' 项措施 · ' + input.requirements.length + ' 项单证'], ['来源数量', input.sources.length]];
    return `<dl class="channel-preview-details">${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
  }
  function publishPage(kind, value) {
    return `${approval?.kind === kind ? '' : `<section class="panel"><div class="panel-body"><h2>待发布草稿</h2>${value.draft ? facts(kind, value.draft) + button('核验并预览发布', 'preview', '', true) : '<p>尚无草稿。请先填写运价或导入关务数据。</p>'}${kind === 'residential-rates' && dirty ? note('表单仍有未保存修改。请先保存全部草稿，再预览发布。', 'warning') : ''}</div></section>`}${approval?.kind === kind ? `<section class="panel channel-confirm" aria-label="确认发布"><div class="panel-body"><h2>${approval.disable ? '确认停用' : approval.release_id ? '确认回退' : '确认发布'}</h2>${approval.input ? facts(kind, approval.input) : '<p>停用后新查询将不可用，历史版本保留。</p>'}${approval.blockers?.length ? note(approval.blockers.join(' '), 'error') : ''}${approval.input && kind === 'residential-rates' ? rateEditor.review(approval.input,billingLabels,feeLabels) : ''}${approval.input ? `<details class="business-details"><summary>逐项核对完整配置与来源</summary><pre class="native-config-preview">${esc(JSON.stringify(approval.input, null, 2))}</pre></details><p>请核对来源真实性、适用范围、费用及有效期。格式校验不能代替业务复核。</p>` : ''}<div class="channel-actions">${approval.disable || approval.can_publish ? button('确认' + (approval.disable ? '停用' : approval.release_id ? '回退' : '发布'), 'confirm', '', true) : ''}${button('取消', 'cancel')}</div></div></section>` : ''}<section class="panel channel-history"><div class="panel-body"><h2>发布记录</h2>${value.history.length ? value.history.map(r => `<div class="channel-release"><div><strong>${esc(r.label)}</strong><p>${esc(new Date(r.published_at).toLocaleString('zh-CN'))} · 版本 ${r.version}</p></div>${r.release_id === value.active_release?.release_id ? '<span>当前发布</span>' : button('预览回退', 'rollback', r.release_id)}</div>`).join('') : '<p>尚无发布记录。</p>'}${value.active_release ? button('停用当前版本', 'disable') : ''}</div></section>`;
  }
  function ratesEditor(section) {
    const d = editor;
    let body = '';
    if (section === 'base') body = `<h2>基本资料</h2><p>私人地址派送使用一套固定业务配置，无需选择渠道。</p><div class="field-grid">${field('运价名称', 'label', d.label)}${field('当前起运地', 'origin', d.origin)}${field('开始日期', 'valid_from', d.valid_from, 'date')}${field('截止日期', 'valid_until', d.valid_until, 'date')}${field('来源文件或协议编号', 'evidence_ref', d.evidence_ref)}${field('来源版本', 'evidence_version', d.evidence_version)}${field('报价单有效天数', 'extensions.quote_valid_days_v1', d.extensions?.quote_valid_days_v1, 'number', '沿用来源约定；不得超过运价截止日期。')}</div><div class="field"><label for="native-customer_terms">客户适用条件</label><textarea id="native-customer_terms" name="customer_terms" rows="5" maxlength="2000">${esc(d.customer_terms)}</textarea><small>说明交付范围、卸货、预约和有效条件。</small></div><p class="muted">自有运价按 USD 维护。</p>`;
    if (section === 'coverage') body = `<h2>邮编覆盖</h2><p>完整邮编优先于前三位；城市分区模式按邮编和城市匹配，仍有多分区时转人工复核。</p><label class="native-zone-enabled"><input type="checkbox" name="extensions.postal_city_v1" ${d.extensions?.postal_city_v1?'checked':''}> 同一邮编按城市区分分区</label><p class="muted">适用于原运价表中同一邮编覆盖多个城市的情况；同城仍有多个分区时，不自动选价。</p>${rateEditor.filterBar('zones')}${editTable('zones', [['postal_prefix', '邮编 / 前三位'], ['zone', '分区编号'], ['city', '城市'], ['province', '省份代码']])}`;
    if (section === 'pricing') body = `${rateEditor.matrix()}<details class="native-row-editor" ${d.rates.length===0||d.rates.some(r=>r.zone===''||r.pallets==='')?'open':''}><summary>逐条新增或删除价格</summary>${editTable('rates', [['zone', '分区编号'], ['pallets', '计费托数'], ['amount', '基础价 · USD']])}</details><details class="native-row-editor native-billing-editor"><summary>计费规则与货物范围</summary><p>最大总重、最大体积和最大长度留空表示来源未设上限，仍执行其他计费及人工复核规则。</p><div class="field-grid">${Object.entries(billingLabels).map(([key, label]) => field(label, 'billing.' + key, d.billing[key])).join('')}</div></details>`;
    if (section === 'fees') body = `<h2>住宅与派送附加费</h2><p>每项都需要明确填写；免费填 0，留空不按免费计算。</p><div class="field-grid">${Object.entries(feeLabels).map(([key, label]) => field(label, 'fees.' + key, d.fees[key])).join('')}</div>`;
    return `<form class="panel" data-form="native-save" data-kind="residential-rates" novalidate><div class="panel-body">${formError}${issueNote()}${body}<div class="native-savebar"><button type="submit" class="button primary">保存全部草稿</button><span data-native-dirty>${dirty ? '有未保存修改' : '当前没有未保存修改'}</span></div><p class="form-fineprint">分页面填写同一份运价。切换页签会保留本次输入；首次配置需填齐所有页面后保存，刷新或离开浏览器前请保存。</p></div></form>`;
  }
  function editTable(group, columns) {
    const indexed = group === 'zones' ? rateEditor.visibleRows(editor[group]) : editor[group].map((row,index)=>({row,index})), rows = indexed, start = Math.min(rowPage * 25, Math.max(0, Math.floor((rows.length - 1) / 25) * 25));
    return `<div class="native-edit-table">${rows.length ? rows.slice(start, start + 25).map(({row,index}) => `<div class="native-edit-row" data-native-row="${group}" data-index="${index}"><strong class="native-row-number">第 ${index + 1} 条</strong>${columns.map(([key, label]) => field(label, `${group}.${index}.${key}`, row[key])).join('')}${button('删除', 'row-remove', group + ':' + index)}</div>`).join('') : '<p class="native-empty">尚无条目，请添加第一条。</p>'}</div><div class="channel-actions">${button('添加一条', 'row-add', group)}${start > 0 ? button('上一页', 'row-page', String(start / 25 - 1)) : ''}${start + 25 < rows.length ? button('下一页', 'row-page', String(start / 25 + 1)) : ''}<span>共 ${rows.length} 条${rows.length ? ` · 当前 ${start + 1}–${Math.min(start + 25, rows.length)}` : ''}</span></div>`;
  }
  function catalogPage(section, value) {
    if (catalogSection !== section) { catalogSection = section; filters.offset = 0; }
    const packageCatalog=packages.catalog({...filters,collection:section});if(packageCatalog.pending)return '<p>正在读取目录…</p>';if(packageCatalog.error)return note(packageCatalog.error,'error');const result = packageCatalog.data||browseCustoms(value, { ...filters, collection: section });
    const rows = result.rows;
    return `<form class="native-search" data-form="native-browse">${formError}<div class="field"><label for="native-selection">查看版本</label><select id="native-selection" name="selection">${[['published', '当前发布'], ['draft', '已保存草稿']].map(([v, l]) => `<option value="${v}" ${filters.selection === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div class="field"><label for="native-country">国家</label><select id="native-country" name="country">${Object.entries(countries).map(([v, l]) => `<option value="${v}" ${filters.country === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div class="field native-search-query"><label for="native-query">搜索${customsSections[section]}</label><input id="native-query" name="query" maxlength="200" value="${esc(filters.query)}" placeholder="编码、名称、规则或来源"></div><button type="submit" class="button primary">搜索</button></form><p class="native-catalog-context">${result.label ? esc(result.label) + ` · ${filters.selection === 'draft' ? '草稿' : '发布'}版本 ${result.version||esc(result.release_id||'')} · ${result.total} 条匹配` : filters.selection === 'draft' ? '尚无已保存草稿，请先导入数据。' : '尚未发布数据。草稿不会作为当前发布显示。'}</p>${result.label && !rows.length ? '<div class="native-empty"><h2>没有匹配的记录</h2><p>请调整国家或搜索词。</p></div>' : `<div class="native-catalog-list">${rows.map(row => `<article class="native-catalog-row"><div class="native-catalog-title"><span>${esc(countries[row.country])}</span><h2>${esc(row.display_code || row.code || row.code_hint || row.label || row.dataset || row.measure_type)}</h2>${row.rate_expression_raw ? `<strong>${esc(row.rate_expression_raw)}</strong>` : ''}</div><p>${esc(row.description_original || row.legal_scope || row.reason || row.condition_text_raw || [row.authority, row.edition, row.revision].filter(Boolean).join(' · '))}</p><small>有效期 ${esc(row.effective_from)} 至 ${esc(row.effective_to || '未指定截止日期')} · ${esc(row.release_authority || row.authority || '来源待核对')}</small><details class="business-details"><summary>查看完整记录与来源</summary><pre class="native-config-preview">${esc(JSON.stringify(row, null, 2))}</pre></details></article>`).join('')}</div>`}<div class="channel-actions">${filters.offset > 0 ? button('上一页', 'catalog-page', String(Math.max(0, filters.offset - filters.limit))) : ''}${filters.offset + filters.limit < result.total ? button('下一页', 'catalog-page', String(filters.offset + filters.limit)) : ''}</div>`;
  }
  function customsImport(value) {
    return `<form class="panel" data-form="native-save" data-kind="customs-data"><div class="panel-body">${formError}<h2>导入关务数据</h2><p>上传已核验来源的规范化数据包。保存草稿后可在目录逐项查看，确认发布后才用于查询。</p>${issueNote()}<div class="field"><label for="native-file">数据包 · JSON</label><input id="native-file" type="file" name="dataset_file" accept=".json,application/json" required><small>最大 16 MiB；<a href="/console/native-business.md" target="_blank" rel="noopener">查看字段格式与 CLI 说明</a>。</small></div><button type="submit" class="button primary">校验并保存草稿</button>${value.draft ? `<section class="form-section"><h2>已保存草稿</h2>${facts('customs-data', value.draft)}</section>` : ''}</div></form>`;
  }
  function freightcomPage(value) {
    return `<div class="channel-layout"><form class="panel" data-form="native-freightcom"><div class="panel-body">${formError}<h2>Freightcom 企业连接</h2><dl class="detail-list"><dt>凭证状态</dt><dd>${value.credential_present ? '已保存，内容不回显' : '尚未配置'}</dd><dt>实时报价</dt><dd>待通过实际询价验证</dd><dt>最近配置更新</dt><dd>${value.updated_at ? esc(new Date(value.updated_at).toLocaleString('zh-CN')) : '暂无'}</dd></dl><div class="field-grid">${field('连接名称', 'label', value.label)}${field(value.credential_present ? '替换正式凭证' : 'Freightcom 正式凭证', 'credential', '', 'password')}</div><label class="choice-row"><input type="checkbox" name="confirmed" required><span>确认用于当前企业的承运商询价</span></label><div class="channel-actions"><button class="button primary" type="submit">保存连接</button>${value.credential_present ? button('停用连接', 'fc-disable') : ''}</div>${approval?.kind === 'freightcom' ? `<div class="native-confirm-inline"><p>停用后当前企业无法读取 Freightcom 报价。确认继续？</p>${button('确认停用', 'fc-confirm', '', true)} ${button('取消', 'cancel')}</div>` : ''}</div></form><aside class="channel-guide"><h2>验证连接</h2><p>保存凭证只确认配置已入库。承运商是否接受账号、地址及货物，需用实际询价确认。</p><a class="button" href="#quote/private">填写询价并验证 ${icon('arrow')}</a><p>选择 Freightcom 后提交询价，可查看承运商结果或错误原因。不会发送邮件或订舱。</p></aside></div>`;
  }
  function page() {
    sync(); const { service, kind, section: requested } = route();
    if (!canConfigure()) return head('需要企业管理权限', '请使用当前企业的负责人或管理员账号配置模块。') + '<a class="button" href="#market">返回服务市场</a>';
    if (!service) return head('未找到服务模块', '') + link('返回模块配置');
    if (!kind) return head(service.name, service.configuration.description, link('返回模块配置')) + '<p>' + (service.configuration.state === 'fixed' ? '当前模块无需企业配置。' : '此模块的配置功能尚未接入。') + '</p><a class="button" href="#service/' + service.id + '">查看模块说明</a>';
    const record = load(kind), sections = kind === 'residential-rates' ? rateSections : customsSections;
    const section = Object.hasOwn(sections, requested) ? requested : kind === 'residential-rates' ? 'base' : 'nomenclature';
    const heading = head(service.name, kind === 'residential-rates' ? '固定私人地址派送 · 维护一套明确的运价与交付条件。' : kind === 'customs-data' ? '关税与商品归类、进口税费估算共用此数据；修改后统一发布。' : '按当前企业管理外部服务。', link('返回模块配置')).replace('class="page-head"', 'class="page-head native-admin-head"');
    if (record.pending) return heading + '<p role="status">正在读取配置…</p>';
    if (record.error) return heading + note(record.error === 'native_management_denied' ? '当前账号无权管理此配置。' : '当前环境暂时无法读取业务配置，请重新加载。', 'error') + button('重新加载', 'reload');
    const value = record.data;
    if (kind === 'freightcom') return heading + (notice && noticeKind === kind ? note(notice, 'success') : '') + freightcomPage(value);
    if (kind === 'residential-rates' && !editor) editor = structuredClone(value.draft || freshRates());
    const originSwitch=kind==='residential-rates'&&editor.extensions?.origins_v1?.length?`<label class="field"><span>正在配置的起运地</span><select data-native-origin>${[editor.origin,...editor.extensions.origins_v1.map(o=>o.origin)].map(o=>`<option value="${esc(o)}" ${o===editor.origin?'selected':''}>${esc(o)}</option>`).join('')}</select></label>`:'';
    const nav = originSwitch+`<nav class="native-tabs" aria-label="${names[kind]}页面">${Object.entries(sections).map(([id, label]) => `<a href="#configure/${service.id}/${id}" ${id === section ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
    const status = kind==='customs-data'?'':`<section class="native-publication" aria-label="当前发布状态"><strong>${esc(stateLine(kind, value))}</strong><span>${value.active_release ? esc(value.active_release.input.label) : '查询尚不可用，保存草稿不会立即生效。'}</span></section>`;
    return '<div class="native-admin-surface">' + heading + nav + status + (notice && noticeKind === kind ? note(notice, 'success') : '') + (section === 'updates' ? packages.page() : section === 'publish' ? publishPage(kind, value) : kind === 'residential-rates' ? (rateEditor.importPanel() || ratesEditor(section)) : section === 'import' ? customsImport(value) : catalogPage(section, value)) + '</div>';
  }
  function input(event) {
    if (rateEditor.input(event)) return true;
    if (!event.target.closest('form[data-kind="residential-rates"]') || !editor) return false;
    const key = event.target.name; if (!key) return false;
    const parts = key.split('.'); let target = editor;
    for (const part of parts.slice(0, -1)) {target[part]??=part==='extensions'?{zone_controls_v1:[]}:{};target = target[part];}
    const last = parts.at(-1), text = event.target.value.trim(); if(last==='postal_city_v1'){if(event.target.checked)target[last]=true;else delete target[last];}else target[last] = integerKeys.has(last) && text !== '' ? Number(text) : text;
    dirty = true; approval = null; notice = ''; issues = [];
    document.querySelectorAll('[data-native-dirty]').forEach(node => { node.textContent = '有未保存修改'; });
    return true;
  }
  async function submit(form) {
    if(await packages.submit(form))return true;
    if (!form.dataset.form?.startsWith('native-')) return false;
    const f = new FormData(form); const generation = epoch;
    if (form.dataset.form === 'native-browse') { filters = { ...filters, selection: String(f.get('selection')), country: String(f.get('country')), query: String(f.get('query')), offset: 0 }; rerender(); return true; }
    if (form.dataset.form === 'native-freightcom') {
      await mutate('/admin/freightcom/save', 'POST', { expected_version: cache.get('freightcom').data.version, label: String(f.get('label')), credential: String(f.get('credential')), confirmation: 'use_for_current_organization' });
      if (generation !== epoch) return true;
      form.reset(); cache.delete('freightcom'); noticeKind = 'freightcom'; notice = '企业连接已保存，实际费率仍需询价验证。'; rerender(); return true;
    }
    const kind = form.dataset.kind; let data;
    if (kind === 'residential-rates') {
      const normalized = structuredClone(editor);if(normalized.extensions?.quote_valid_days_v1==='')delete normalized.extensions.quote_valid_days_v1;for(const key of ['max_weight_kg','max_cbm','max_length_cm'])if(normalized.billing[key]==='')normalized.billing[key]=null; normalized.zones = normalized.zones.map(row => ({ ...row, postal_prefix: String(row.postal_prefix || '').replaceAll(' ', '').toUpperCase(), province: String(row.province || '').toUpperCase() }));
      const parsed = residentialRatesSchema.safeParse(normalized);
      if (!parsed.success) { issues = schemaIssues(parsed); rerender(); return true; }
      data = parsed.data;
    } else {
      const file = f.get('dataset_file');
      if (!file?.size || file.size > 16 * 1024 * 1024) { issues = ['请选择不超过 16 MiB 的 JSON 数据包。']; rerender(); return true; }
      try { data = JSON.parse(await file.text()); } catch { issues = ['无法解析 JSON，请检查文件格式。']; rerender(); return true; }
      if (generation !== epoch) return true;
      const parsed = customsDatasetSchema.safeParse(data);
      if (!parsed.success) { issues = schemaIssues(parsed); rerender(); return true; }
      data = parsed.data;
    }
    await mutate('/admin/' + kind + '/save', 'POST', { expected_version: cache.get(kind).data.version, input: data });
    if (generation !== epoch) return true;
    cache.delete(kind); if (kind === 'residential-rates') { editor = null; dirty = false; } issues = []; approval = null; noticeKind = kind; notice = '草稿已保存，当前发布版本没有改变。'; rerender(); return true;
  }
  async function action(b) {
    if(await packages.action(b))return true;
    if (rateEditor.action(b)) return true;
    const a = b.dataset.action; if (!a?.startsWith('native-')) return false;
    const { kind } = route(), generation = epoch;
    if (a === 'native-reload') { if (dirty) throw Object.assign(new Error('channel_unsaved_changes'), {code:'channel_unsaved_changes'}); reset(); rerender(); return true; }
    if (a === 'native-cancel') { approval = null; rerender(); return true; }
    if (a === 'native-row-add') { rateEditor.clearFilters(); const group = b.dataset.id; editor[group].push(group === 'zones' ? { postal_prefix: '', zone: '', city: '', province: '' } : { zone: '', pallets: '', amount: '' }); rowPage = Math.floor((editor[group].length - 1) / 25); dirty = true; approval = null; rerender(); return true; }
    if (a === 'native-row-remove') { const [group, index] = b.dataset.id.split(':'); editor[group].splice(Number(index), 1); dirty = true; approval = null; rerender(); return true; }
    if (a === 'native-row-page') { rowPage = Number(b.dataset.id); rerender(); return true; }
    if (a === 'native-catalog-page') { filters.offset = Number(b.dataset.id); rerender(); return true; }
    if (a === 'native-fc-disable') { approval = { kind: 'freightcom' }; rerender(); return true; }
    if (a === 'native-fc-confirm') { await mutate('/admin/freightcom/disable', 'POST', { expected_version: cache.get(kind).data.version }); if (generation === epoch) { approval = null; cache.delete(kind); noticeKind = kind; notice = '连接已停用。'; rerender(); } return true; }
    if (kind === 'residential-rates' && dirty) throw Object.assign(new Error('channel_unsaved_changes'), { code: 'channel_unsaved_changes' });
    if (a === 'native-preview' || a === 'native-rollback') { const data = (await api('/admin/' + kind + '/preview' + (a === 'native-rollback' ? '?release_id=' + encodeURIComponent(b.dataset.id) : ''))).data; if (generation === epoch) { approval = { ...data, kind }; rerender(); document.querySelector('.channel-confirm')?.scrollIntoView({ block: 'center' }); } return true; }
    if (a === 'native-disable') { approval = { kind, disable: true, version: cache.get(kind).data.version }; rerender(); return true; }
    if (a === 'native-confirm') { const p = approval; await mutate('/admin/' + kind + '/' + (p.disable ? 'disable' : p.release_id ? 'rollback' : 'publish'), 'POST', { expected_version: p.version, ...(p.disable ? {} : { preview_hash: p.preview_hash, confirmation: 'reviewed_sources_and_conditions' }), ...(p.release_id ? { release_id: p.release_id } : {}) }); if (generation === epoch) { approval = null; cache.delete(kind); noticeKind = kind; notice = p.disable ? '当前版本已停用。' : p.release_id ? '已回退到选定版本。' : '已发布，网页与 CLI 将使用此版本。'; rerender(); } return true; }
    return false;
  }
  return { page, configurationStatus, submit, action, input, reset, async change(event){if(event.target.matches('[data-native-origin]')){const origins=editor.extensions.origins_v1,selected=origins.find(o=>o.origin===event.target.value);if(selected){const previous={origin:editor.origin,zones:editor.zones,rates:editor.rates,zone_controls_v1:editor.extensions.zone_controls_v1};editor={...editor,origin:selected.origin,zones:selected.zones,rates:selected.rates,extensions:{...editor.extensions,zone_controls_v1:selected.zone_controls_v1,origins_v1:[...origins.filter(o=>o.origin!==selected.origin),previous]}};rateEditor.clearFilters();approval=null;rerender();}return true;}return rateEditor.file(event);}, isDirty:()=>dirty };
}
