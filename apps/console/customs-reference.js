const countries = { CN: '中国', US: '美国', CA: '加拿大' };
const treatments = { general: '一般税率（General）', special: '优惠税率（Special，资格待核对）', other: '其他税率（Other，适用性待核对）', import_ordinary: '进口普通税率', import_preferential: '进口优惠税率（资格待核对）', MFN: '最惠国税率（MFN）', mfn: '最惠国税率（MFN）' };
const measureLabels = { customs_duty: '关税', import_duty: '进口关税', export_duty: '出口关税', base_duty: '基础关税' };
const measureGroups = {
  '反倾销': ['anti_dumping', 'antidumping', 'anti_dumping_duty', 'antidumping_duty', 'ad', 'ad_cvd'],
  '反补贴': ['countervailing', 'countervailing_duty', 'countervailing_duties', 'cvd', 'ad_cvd'],
  '进口限制': ['license', 'import_license', 'licensing', 'permit', 'quota', 'restriction', 'import_restriction', 'prohibition', 'import_ban'],
  '认证与标签': ['certification', 'labeling', 'labelling', 'inspection', 'testing', 'sps', 'tbt'],
};
const matchLabels = { not_indicated: '来源未提示适用，仍需核对范围', possible: '可能涉及', confirmed_by_rule: '来源规则命中', manual_review: '待复核' };
const documentLabels = { prepare_retain: '准备并留存', required_now: '当前需要', conditional: '条件适用', on_request: '要求时提供', not_applicable: '来源标记不适用', manual_review: '待复核' };
const measureKind = value => String(value).toLowerCase().replace(/[\s/-]+/gu, '_');

// Display source conclusions only; an absent measure is never evidence of exemption.
export function renderCustomsImportBrief(ui, result, input = {}, reference = false) {
  const { esc } = ui;
  const names = result.legalNames || [];
  const nameFor = lang => {
    const name = names.find(value => value.language.toLowerCase().startsWith(lang))?.text;
    if (name && /^(?:[-—\s]*)(?:other|autres|其他|其它)[.。]?$/iu.test(name)) {
      const parent = result.hierarchy?.filter(value => value.code !== result.code).at(-1)?.legalNames.find(value => value.language.toLowerCase().startsWith(lang))?.text;
      return parent ? `${parent} — ${name}` : undefined;
    }
    return name;
  };
  const descriptiveQuery = input.query && !/^\d{4,10}$/u.test(input.query.replace(/[.\s]/gu, ''));
  const chineseQuery = descriptiveQuery && /\p{Script=Han}/u.test(input.query);
  const draft = chineseQuery ? [...new Set([input.query, input.attributes?.material, input.attributes?.use].filter(Boolean))].join('，') : null;
  const chinese = nameFor('zh') || (['machine','human_reviewed'].includes(result.chineseExplanation?.status) ? result.chineseExplanation.text : undefined);
  const english = nameFor('en');
  const row = (label, content) => `<div class="customs-brief-row"><dt>${label}</dt><dd>${content}</dd></div>`;
  const pending = message => `<span class="customs-pending">待核验</span> ${esc(message)}`;
  const rates = result.rates || [];
  // Prefer the source's general schedule for a brief; this does not determine eligibility.
  const generalRates = reference ? rates.filter(rate => ['MFN','mfn','general'].includes(rate.treatment)) : [];
  const shownRates = (generalRates.length ? generalRates : rates).slice(0, 3);
  const measures = result.measures || [];
  const documents = result.documents || [];
  const rateLine = rate => `<div class="customs-rate-line"><strong>${esc(rate.displayValue)}</strong> <span>${esc(rate.label)} · ${esc(treatments[rate.treatment] || rate.treatment)}</span><small>${esc(rate.conditionText || '适用条件以原文为准')}${rate.scope ? ` · ${esc(rate.scope)}` : ''} · ${rate.confirmed ? '来源已核验此税项' : '适用性待核验'}</small></div>`;
  const measureText = measure => [measure.label, matchLabels[measure.matchStatus] || '待复核', measure.rateExpressionRaw, measure.exporterOrProducer ? `生产商／出口商：${measure.exporterOrProducer}` : '', measure.legalScope].filter(Boolean).map(esc).join(' · ');
  const translated = result.nameTranslationLanguage;
  const languageLabel = (lang, label) => {
    if (!(lang === 'zh' ? chinese : english)) return label;
    const source = translated === lang || lang === 'zh' && result.chineseExplanation?.status === 'machine' ? '参考译文' : lang === 'zh' && result.chineseExplanation?.status === 'human_reviewed' ? '已审核译文' : '官方原文';
    return `${label}（${source}）`;
  };
  let body = row('建议申报品名', `${draft ? `<div>品名草案：${esc(draft)}</div><small>按所填资料整理；下方为对应税则品名。</small>` : ''}<div>${languageLabel('zh','中文')}：${esc(chinese || '译文暂不可用，请核对原文')}</div><div>${languageLabel('en','英文')}：${esc(english || '译文暂不可用，请核对原文')}</div><small>${translated || result.chineseExplanation?.status === 'machine' ? '机器翻译，仅供理解原文；' : ''}税则品名仅供拟名参考，不能直接作为申报品名；须与实际材质、用途和结构一致。</small>`);
  body += row('建议归类', `<strong class="customs-code">${esc(result.displayCode)}</strong> <span class="badge ${result.status === 'confirmed' && !reference ? 'success' : 'warning'}">${result.status === 'confirmed' && !reference ? '来源已确认归类' : '候选 · 待复核'}</span><small>${esc(result.classificationReason)}${result.isDeclarable === false ? ' · 这是父级税目，需进一步确定完整税号。' : ''}</small>`);
  body += row('税率', `${rates.length ? shownRates.map(rateLine).join('') : pending('未匹配税率记录；不代表免税或零税率。')}${rates.length > shownRates.length ? `<small>另有 ${rates.length - shownRates.length} 条原文税率及待遇，展开下方依据查看。</small>` : ''}<small>${reference ? '原文参考，完整税费待核验；不自动相加或判断优惠资格。' : result.confirmedTotalPercent != null ? `来源已确认关税小计 ${esc(result.confirmedTotalPercent)}%；其他税费与贸易措施仍逐项核对。` : '完整税费待核验，未确认税项不按零计入。'}</small>`);
  for (const [label, kinds] of Object.entries(measureGroups)) {
    const items = measures.filter(measure => kinds.includes(measureKind(measure.measureType)));
    body += row(label, items.length ? items.slice(0,2).map(item => `<div>${measureText(item)}</div>`).join('') + (items.length > 2 ? `<small>共 ${items.length} 项，请展开完整依据逐项核对。</small>` : '') : pending(label === '反倾销' || label === '反补贴' ? '商品范围及生产商／出口商待核对。' : '尚无完整适用性结论。'));
  }
  const other = measures.filter(measure => !Object.values(measureGroups).some(kinds => kinds.includes(measureKind(measure.measureType))));
  if (other.length) body += row('其他监管措施', other.map(item => `<div>${measureText(item)}</div>`).join(''));
  body += row('清关资料', documents.length ? documents.map(item => `<div>${esc(item.label)} · ${esc(documentLabels[item.status] || '待复核')}<small>${esc([item.reason, ...(item.conditions || [])].filter(Boolean).join('；'))}</small></div>`).join('') : pending('该商品的完整单证清单待核对。'));
  return `<dl class="customs-brief">${body}</dl>`;
}

export function renderCustomsReference(ui, data, options = {}) {
  const { esc, panel, note } = ui;
  const input = options.input || {};
  const country = options.country || input.codeCountry || data.candidates[0]?.item.country || 'CA';
  const groups = new Map();
  for (const candidate of data.candidates) {
    const key = `${candidate.item.country}:${candidate.item.code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const local = [...groups.values()].filter(group => group[0].item.country === country);
  const code = options.code || input.query?.replace(/[.\s]/gu, '');
  const group = local.find(items => items[0].item.code === code) || local[0];
  const tabs = `<nav class="customs-country-tabs" aria-label="结果地区">${['CA','US','CN'].map(key => `<button type="button" class="button small" data-action="business-customs-country" data-country="${key}" aria-pressed="${key === country}">${countries[key]}${key === 'CN' ? '税号资料' : '进口'} <span>${[...groups.values()].filter(items => items[0].item.country === key).length}</span></button>`).join('')}</nav>`;
  let content;
  if (!group) content = `<div class="empty-state"><h3>${esc(countries[country])}暂无匹配候选</h3><p>请核对税号地区，或用该地区的原文品名检索。未匹配不表示没有进口限制或税费。</p></div>`;
  else {
    const current = group.find(entry => entry.item.language.startsWith(country === 'CN' ? 'zh' : 'en')) || group[0];
    const { item } = current;
    const sources = new Map(data.sources.map(source => [source.id, source]));
    const namePath = entry => [...new Set([entry.hierarchy.at(-1)?.description_original, entry.item.description_original].filter(Boolean))].join(' — ');
    const rawRates = [...new Map(group.flatMap(entry => entry.rates).map(rate => [JSON.stringify([rate.code, rate.treatment, rate.measure_type, rate.rate_expression_raw, rate.condition_text_raw, rate.effective_from, rate.effective_to]), rate])).values()];
    const result = {
      displayCode: item.display_code, status: 'candidate', isDeclarable: group.every(entry => Boolean(entry.item.is_declarable)),
      legalNames: [...group.map(entry => ({language:entry.item.language,text:entry.display_name?.text || namePath(entry)})),...(current.display_name?.translation ? [current.display_name.translation] : [])],
      nameTranslationLanguage: current.display_name?.translation?.language,
      classificationReason: item.code === input.query?.replace(/[.\s]/gu, '') && input.codeCountry === country ? '与所填税号精确匹配；商品归类适用性仍待复核。' : `当前查看的候选，按编码顺序展示，不代表最佳归类。${country !== input.codeCountry ? '跨地区同 HS 前缀仅供对照，不代表归类等同。' : ''}`,
      rates: rawRates.map(rate => ({label:measureLabels[rate.measure_type] || rate.measure_type,treatment:rate.treatment,displayValue:rate.rate_expression_raw,conditionText:rate.condition_text_raw,confirmed:false,scope:`所属税目 ${rate.code}`})),
    };
    const sourceText = [...new Set(group.map(entry => {const source=sources.get(entry.item.release_id);return source ? `${source.authority} · ${source.edition}/${source.revision} · 抓取 ${source.retrieved_at}` : '来源版本待核对';}))].join('；');
    const details = group.map(entry => `<section class="customs-source-detail"><h4>${esc(countries[country])}税号 · ${esc(entry.item.display_code)} · ${esc(entry.item.language)}</h4>${entry.hierarchy.map(parent => `<p>${esc(parent.display_code)} · ${esc(parent.description_original)}</p>`).join('')}<p>${esc(entry.item.description_original)}</p><small>来源位置：${esc(entry.item.source_locator)}</small></section>`).join('');
    const rates = rawRates.map(rate => `<tr><td>${esc(rate.code)}<small>${esc(measureLabels[rate.measure_type] || rate.measure_type)} · ${esc(treatments[rate.treatment] || rate.treatment)}</small></td><td>${esc(rate.rate_expression_raw)}</td><td>${esc(rate.condition_text_raw || '以原文条件为准')}<small>${esc(rate.effective_from)} 起${rate.effective_to ? `，至 ${esc(rate.effective_to)}` : ''} · ${rate.code_match_type === 'prefix' ? '前缀规则' : '来源税目规则'}</small></td></tr>`).join('');
    content = `<label class="customs-candidate-picker" for="customs-reference-code">查看候选税号<select id="customs-reference-code" data-customs-reference-code>${local.map(items => {const entry=items.find(candidate=>candidate.item.language.startsWith(country==='CN'?'zh':'en'))||items[0];return `<option value="${esc(entry.item.code)}"${entry.item.code===item.code?' selected':''}>${esc(entry.item.display_code)} · ${esc(entry.item.description_original)}</option>`;}).join('')}</select></label><section data-customs-brief><p class="customs-brief-context">${esc(countries[country])}${country === 'CN' ? '税号资料' : '进口'} · 中国原产 · ${esc(data.rule_date)} · 官方原文参考</p>${renderCustomsImportBrief(ui,result,input,true)}<p class="customs-evidence-line">${esc(sourceText)}</p><p class="customs-boundary">参考建议，尚未完成正式归类及措施核验。${country === 'CN' ? '中国资料中的进口税率不能作为出口税率使用。' : ''}</p></section><button type="button" class="button" data-action="business-customs-copy" data-save-preview ${options.dirty?'disabled':''}>复制参考摘要</button><span class="customs-copy-status" data-customs-copy-status role="status"></span><details class="business-details"><summary>税率、品名与来源依据</summary>${details}${rates ? `<div class="table-wrap"><table><thead><tr><th>所属税目 / 税种 / 待遇</th><th>原始税率</th><th>条件与有效期</th></tr></thead><tbody>${rates}</tbody></table></div>` : '<p>本候选未匹配到税率记录；这不代表免税或零税率。</p>'}</details>`;
  }
  const sources = data.sources.map(source => `<div class="source-row"><strong>${esc(source.country)} · ${esc(source.authority)} · ${esc(source.edition)} / ${esc(source.revision)}</strong><span>${esc(source.dataset)} · 原审核状态 ${esc(source.status)}</span><small>原件抓取 ${esc(source.retrieved_at)} · 版本生效 ${esc(source.effective_from)}</small><a href="${esc(source.official_url)}" target="_blank" rel="noopener noreferrer">查看官方原文</a><small>来源清单 SHA-256：${esc(source.manifest_sha256)}</small></div>`).join('');
  return panel('商品进口建议与要求','官方资料可查 · 正式归类与完整税费待核验',`<div class="panel-body">${tabs}<p class="customs-result-state" data-result-state>${options.dirty?'资料已修改，请重新查询后使用结果。':`本次返回 ${local.length} 个${esc(countries[country])}税号候选，语言版本合并展示；结果可能不完整。`}</p>${content}<details class="business-details"><summary>查询范围与全部来源 · ${data.sources.length} 项</summary>${note(data.warnings.join(' '),'warning')}${sources}<small>参考资料 SHA-256：${esc(data.snapshot_sha256)}</small></details></div>`);
}
