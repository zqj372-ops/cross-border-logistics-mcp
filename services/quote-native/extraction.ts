import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { extractDataSchema, extractInputSchema, QUOTE_PORTAL_SCHEMA_VERSION, QUOTE_SOURCE_SCHEMA_VERSION } from '../access-gateway/portal/business/quote-client';
import type { QuoteBusinessClientPort, PortalBusinessClientResult } from '../access-gateway/portal/business/service';

// Adapted from the owner's quoteParser.ts and quote_extractor.py; provenance.json
// records the frozen source. Unlike the originals, omitted evidence is not inferred.
const D = Decimal.clone({ precision: 48 });
const VERSION = 'freightclaw-native-extraction/1';
const NUM = String.raw`(?<![\d.-])(?<!\d,)(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const PIECE = String.raw`(?:纸箱|木箱|托盘|cartons?|boxes|pieces?|pallets?|skids?|ctns?|pcs?|pkgs?|crates?|箱|件|包|袋|托|台)`;
const LENGTH = String.raw`(?:mm|cm|inches|inch|in|ft|feet|m|毫米|厘米|英寸|英尺|米|\")`;
const WEIGHT = String.raw`(?:kilograms?|kgs?|公斤|千克|lbs?|pounds?|磅|grams?|克|g|tonnes?|吨|t)`;
const VOLUME = String.raw`(?:cbm|m\^?3|cubic\s*metres?|cu\.?\s*ft|cuft|ft\^?3|立方米|立方|方)`;
const END = String.raw`(?![a-zA-Z])`;
const DIM = new RegExp(`(${NUM})\\s*(${LENGTH})?\\s*[*x×]\\s*(${NUM})\\s*(${LENGTH})?\\s*[*x×]\\s*(${NUM})\\s*(${LENGTH})?${END}`, 'gi');
const dec = (s: string) => new D(s.replaceAll(',', ''));
const str = (v: Decimal | null) => v === null ? null : v.toFixed();
function cm(n: string, unit: string) {
  const factor = /^(mm|毫米)$/i.test(unit) ? '0.1' : /^(m|米)$/i.test(unit) ? '100' : /^(in|inch|inches|英寸|")$/i.test(unit) ? '2.54' : /^(ft|feet|英尺)$/i.test(unit) ? '30.48' : '1';
  return dec(n).mul(factor);
}
function kg(n: string, unit: string) {
  return dec(n).mul(/^(lb|lbs|pound|pounds|磅)$/i.test(unit) ? '0.45359237' : /^(g|gram|grams|克)$/i.test(unit) ? '0.001' : /^(t|tonne|tonnes|吨)$/i.test(unit) ? '1000' : '1');
}
function cbm(n: string, unit: string) { return dec(n).mul(/ft/i.test(unit) ? '0.028316846592' : '1'); }
type Item = { quantity: number; length_cm: string | null; width_cm: string | null; height_cm: string | null; weight_kg: string | null; cbm: string | null; total_weight_kg: string | null; total_cbm: string | null; source_span: string };
const labels: Record<string, string> = { postal_code: '唯一收货邮编', cbm: '总体积', weight_kg: '总重量及单件／总重口径', piece_count: '件数', packaging_type: '包装类型', address_type: '地址类型', longest_side_cm: '最长边', dimension_unit: '尺寸单位', requires_liftgate: '尾板／自行卸货', requires_pallet_jack: '地牛服务', requires_appointment: '送货预约', cargo_lines: '未识别的货物行' };

function parseNativeQuote({ input, requestId }: Parameters<QuoteBusinessClientPort['extract']>[0]): PortalBusinessClientResult {
  const base = { schema_version: QUOTE_PORTAL_SCHEMA_VERSION, source_schema_version: QUOTE_SOURCE_SCHEMA_VERSION, request_id: requestId, preview_only: true, saved: false, sendable: false };
  const parsed = extractInputSchema.safeParse(input);
  if (!parsed.success) return { ...base, status: 'needs_input', data: null, reason_codes: ['quote_request_invalid'], source_refs: [] };
  const raw = parsed.data.customer_message;
  const text = raw.normalize('NFKC').replace(/\r/g, '').replace(/[✕✖]/g, '×');
  if (/\d[\d,.]{30}/.test(text)) return { ...base, status: 'needs_input', data: null, reason_codes: ['extraction_number_too_large'], source_refs: [] };
  if (/(?<![A-Za-z0-9])\d+(?:\.\d+)?e[+-]?\d+/i.test(text)) return { ...base, status: 'needs_input', data: null, reason_codes: ['extraction_numeric_format_unsupported'], source_refs: [] };
  const missing = new Set<string>(), conflicts = new Set<string>(), notes: string[] = [], items: Item[] = [];
  const problem = (field: string, note: string, conflict = false) => { missing.add(field); if (conflict) conflicts.add(field); if (notes.length < 100) notes.push(note); };
  const totals: Record<string, Decimal[]> = { piece_count: [], cbm: [], weight_kg: [] };
  let incomplete = false, unknownQuantity = false;
  const collectTotals = (line: string) => {
    const patterns: [string, RegExp, (n: string, unit: string) => Decimal][] = [
      ['piece_count', new RegExp(`(?:总件数|总箱数|总数量|total\\s*(?:pieces|cartons|quantity|qty))\\s*[:：=]?\\s*(${NUM})\\s*(?:${PIECE})?`, 'gi'), n => dec(n)],
      ['piece_count', new RegExp(`(?:合计|总计|共)\\s*[:：=]?\\s*(${NUM})\\s*${PIECE}${END}`, 'gi'), n => dec(n)],
      ['weight_kg', new RegExp(`(?:总(?:重量|毛重|重)|重量合计|合计|总计|共|total\\s*(?:gross\\s*)?(?:weight|wt)|gross\\s*weight)\\s*[:：=]?\\s*(${NUM})\\s*(${WEIGHT})${END}`, 'gi'), kg],
      ['cbm', new RegExp(`(?:总体积|总方数|体积合计|total\\s*(?:volume|cbm))\\s*[:：=]?\\s*(${NUM})\\s*(${VOLUME})?${END}`, 'gi'), cbm],
    ];
    for (const [field, pattern, convert] of patterns) for (const m of line.matchAll(pattern)) totals[field]!.push(convert(m[1]!, m[2] ?? 'cbm'));
  };
  const quantity = (line: string): number | null => {
    const matches = [...line.matchAll(new RegExp(`(${NUM})\\s*${PIECE}${END}|(?:qty|quantity|数量|件数|箱数)\\s*[:：=]?\\s*(${NUM})`, 'gi'))];
    const values = [...new Set(matches.map(m => dec(m[1] ?? m[2]!).toFixed()))];
    if (values.length !== 1 || !/^\d+$/.test(values[0]!) || dec(values[0]!).lte(0) || dec(values[0]!).gt(1_000_000)) {
      unknownQuantity = true; problem('piece_count', values.length > 1 ? '同一货物行出现不同件数，请拆分或确认。' : '货物行未提供有效件数，不默认按一件计算。', values.length > 1); return null;
    }
    return Number(values[0]);
  };
  const addRow = (line: string, evidence: string) => {
    const dims = [...line.matchAll(DIM)];
    if (dims.length > 1) { incomplete = true; problem('cargo_lines', '同一行有多组尺寸，请按货物分行或用分号分隔。'); return; }
    const q = quantity(line), m = dims[0];
    let dimensions: Decimal[] | null = null;
    if (m) {
      const units = [m[2], m[4], m[6]], explicit = units.filter((u): u is string => Boolean(u));
      if (!explicit.length || new Set(explicit.map(u => u.toLowerCase())).size > 1 && explicit.length < 3) problem('dimension_unit', '尺寸单位缺失或混合单位未完整标明，不按数值大小猜测。');
      else dimensions = [cm(m[1]!, units[0] ?? explicit[0]!), cm(m[3]!, units[1] ?? explicit[0]!), cm(m[5]!, units[2] ?? explicit[0]!)];
    }
    if (dimensions?.some(d => d.lte(0) || d.gt('1000000'))) { dimensions = null; problem('cbm', '尺寸必须为正数且在可解析范围内。'); }
    const withoutDims = m ? line.replace(m[0], '') : line;
    const weights = [...withoutDims.matchAll(new RegExp(`(${NUM})\\s*(${WEIGHT})${END}`, 'gi'))];
    let unitWeight: Decimal | null = null, rowWeight: Decimal | null = null;
    for (const w of weights) {
      const before = withoutDims.slice(Math.max(0, w.index - 25), w.index), after = withoutDims.slice(w.index + w[0].length, w.index + w[0].length + 25);
      const per = /(?:每|单)(?:件|箱|包|托盘|托)?(?:毛重|重量|重)?\s*[:：=]?\s*$|(?:each|per\s*(?:piece|carton|box|pallet))\s*[:：=]?\s*$/i.test(before) || /^\s*(?:each\b|ea\b|per\s*(?:piece|carton|box|pallet)|\/\s*(?:pc|ctn|piece|carton|box|件|箱)\b)/i.test(after);
      const total = /(?:总(?:重量|毛重|重)|合计|total\s*(?:weight|wt)?|gross\s*weight)\s*[:：=]?\s*$/i.test(before) || /^\s*(?:total\b|合计|总重)/i.test(after);
      const value = kg(w[1]!, w[2]!);
      if (value.lte(0)) { problem('weight_kg', '重量必须大于零。'); continue; }
      if (per && !total) {
        if (unitWeight !== null && !unitWeight.eq(value)) problem('weight_kg', '同一行的单件重量存在冲突。', true);
        unitWeight = value;
      } else if (total && !per || q === 1) {
        if (rowWeight !== null && !rowWeight.eq(value)) problem('weight_kg', '同一行的总重量存在冲突。', true);
        rowWeight = value;
      } else problem('weight_kg', '多件货物的重量未说明“每件”或“总重”，请确认口径。');
    }
    if (unitWeight && q) {
      const calculated = unitWeight.mul(q);
      if (rowWeight !== null && !rowWeight.eq(calculated)) problem('weight_kg', '单重 × 件数与该行总重不一致。', true);
      rowWeight = calculated;
    }
    const volume = dimensions ? dimensions.reduce((a, b) => a.mul(b), new D(1)).div(1_000_000) : null;
    const explicitVolumes = [...withoutDims.matchAll(new RegExp(`(${NUM})\\s*(${VOLUME})${END}`, 'gi'))];
    let rowVolume = volume && q ? volume.mul(q) : null;
    if (explicitVolumes.length === 1) {
      const v = explicitVolumes[0]!, before = withoutDims.slice(0, v.index), after = withoutDims.slice(v.index + v[0].length);
      const per = /(?:每件|每箱|单件|each)\s*[:：=]?\s*$/i.test(before) || /^\s*each\b/i.test(after);
      const declared = cbm(v[1]!, v[2]!).mul(per ? q ?? 1 : 1);
      if (rowVolume && !rowVolume.eq(declared)) problem('cbm', '尺寸 × 件数与申报体积不一致。', true);
      else rowVolume = q ? declared : null;
    } else if (explicitVolumes.length > 1) problem('cbm', '一行出现多个体积值，请拆分或确认。', true);
    if (!q) { incomplete = true; return; }
    items.push({ quantity: q, length_cm: str(dimensions?.[0] ?? null), width_cm: str(dimensions?.[1] ?? null), height_cm: str(dimensions?.[2] ?? null), weight_kg: str(unitWeight), cbm: str(volume), total_weight_kg: str(rowWeight), total_cbm: str(rowVolume), source_span: evidence.slice(0, 600) });
  };
  let table: { title: string; columns: string[] } | null = null;
  const lines = text.split(/[\n;；]+/).map(s => s.trim()).filter(Boolean);
  if (lines.length > 150) return { ...base, status: 'needs_input', data: null, reason_codes: ['extraction_too_many_lines'], source_refs: [] };
  for (const line of lines) {
    const cells = line.split(/\t|\s*\|\s*/).map(s => s.trim());
    if (line.startsWith('|')) cells.shift();
    if (line.endsWith('|')) cells.pop();
    if (cells.length >= 4 && /长|length/i.test(line) && /宽|width/i.test(line) && /高|height/i.test(line)) { table = { title: line, columns: cells }; continue; }
    if (table && cells.length === table.columns.length && cells.every(c => new RegExp(`^${NUM}$`).test(c) || /^(?:|待确认|未知|n\/a|unknown|-)$/i.test(c))) {
      let q = '', weight = '';
      const dimensions = ['', '', ''];
      table.columns.forEach((header, i) => {
        const value = cells[i]!;
        if (!new RegExp(`^${NUM}$`).test(value)) return;
        if (/数量|件数|qty|quantity/i.test(header)) q = `${value}件`;
        else if (/重量|单重|总重|weight/i.test(header)) {
          const unit = header.match(/\(([^)]+)\)/)?.[1];
          if (unit) weight = `${/单重|每件|each|unit/i.test(header) ? '每件' : /总重|total/i.test(header) ? '总重' : ''}${value}${unit}`;
        } else {
          const axis = /长|length/i.test(header) ? 0 : /宽|width/i.test(header) ? 1 : /高|height/i.test(header) ? 2 : -1;
          if (axis >= 0) dimensions[axis] = value + (header.match(/\(([^)]+)\)/)?.[1] ?? '');
        }
      });
      addRow(`${q} ${dimensions.join('x')} ${weight}`, `${table.title}\n${line}`); continue;
    }
    if (table && cells.length > 1 && cells.some(c => /^\d/.test(c)) && !/地址|address|[A-Z]\d[A-Z]\s?\d[A-Z]\d/i.test(line)) {
      incomplete = true; unknownQuantity = true; problem('cargo_lines', '表格行的列数或单元格内容不符合表头，未将其他行当成整票合计。'); continue;
    }
    table = null;
    const hasDim = new RegExp(DIM.source, 'i').test(line);
    const hasQty = new RegExp(`(?:${NUM})\\s*${PIECE}${END}|(?:数量|件数|箱数|qty|quantity)\\s*[:：=]?\\s*${NUM}`, 'i').test(line);
    const summary = /^(?:总件数|总箱数|总数量|总重|总毛重|总体积|总方数|合计|总计|共|total\b)/i.test(line);
    if (summary && !hasDim) { collectTotals(line); continue; }
    if (hasDim || hasQty) addRow(line, line);
    else if (new RegExp(`(${NUM})\\s*(${WEIGHT}|${VOLUME})${END}`, 'i').test(line)) {
      collectTotals(line);
      // An unlabelled measurement line cannot be attached to an earlier item implicitly.
      if (!/总重|总体积|total/i.test(line)) { incomplete = true; problem('cargo_lines', '独立的重量／体积行未明确关联哪组货物，请合并到对应货物行。'); }
    }
  }
  if (items.length > 100) return { ...base, status: 'needs_input', data: null, reason_codes: ['extraction_too_many_items'], source_refs: [] };
  const total = (field: 'piece_count' | 'cbm' | 'weight_kg', key?: 'total_cbm' | 'total_weight_kg') => {
    const declared = totals[field]!, distinct = new Set(declared.map(d => d.toFixed()));
    let calculated = !incomplete && items.length && (!key || items.every(item => item[key] !== null)) ? items.reduce((sum, item) => sum.add(key ? item[key]! : item.quantity), new D(0)) : null;
    if (field === 'piece_count' && unknownQuantity) calculated = null;
    if (distinct.size > 1 || calculated && declared[0] && !calculated.eq(declared[0])) problem(field, `${labels[field]}：逐行合计与申报合计存在冲突，保留原行等待确认。`, true);
    const value = declared[0] ?? calculated;
    if (value?.lte(0) || field === 'piece_count' && value && (!value.isInteger() || value.gt(1_000_000))) problem(field, '合计数值无效。', true);
    return conflicts.has(field) ? null : value;
  };
  const pieces = total('piece_count'), volume = total('cbm', 'total_cbm'), weight = total('weight_kg', 'total_weight_kg');
  const postals = [...new Set([...text.matchAll(/(?<![A-Za-z0-9])[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTVWXYZ][ -]?\d[ABCEGHJ-NPRSTVWXYZ]\d(?![A-Za-z0-9])/gi)].map(m => m[0].replace(/[ -]/g, '').toUpperCase()).map(s => s.slice(0, 3) + ' ' + s.slice(3)))];
  if (postals.length > 1) problem('postal_code', '识别到多个邮编，请保留本次唯一收货地址。', true);
  const postal = postals.length === 1 ? postals[0]! : null;
  const addressLine = lines.find(line => /^(?:收货地址|送货地址|地址|delivery address|address)\s*[:：]/i.test(line)) ?? lines.find(line => /\b\d+\s+[A-Za-z][A-Za-z .'-]+\b(?:Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Lane|Ln|Way|Court|Ct)\b/i.test(line));
  const address = addressLine?.replace(/^(?:收货地址|送货地址|地址|delivery address|address)\s*[:：]\s*/i, '').slice(0, 500) ?? null;
  const provinceMatch = (address ?? '').match(/(?:^|[,\s])(ON|BC|AB|QC|MB|SK|NS|NB|NL|PE|YT|NT|NU)(?=$|[,\s])/i);
  const explicitProvince = text.match(/(?:省份|province)\s*[:：]\s*(ON|BC|AB|QC|MB|SK|NS|NB|NL|PE|YT|NT|NU)\b/i)?.[1];
  const province = (explicitProvince ?? provinceMatch?.[1])?.toUpperCase() ?? null;
  const city = text.match(/(?:城市|city)\s*[:：]\s*([A-Za-z][A-Za-z '-]{1,100})(?=\n|$|[,;])/i)?.[1]?.trim() ?? (provinceMatch ? address?.slice(0, provinceMatch.index).split(',').slice(1).at(-1)?.trim() : null) ?? null;
  const bool = (field: string, yes: RegExp, no: RegExp) => {
    const negatives = text.match(no) ?? [];
    const positiveText = text.replace(no, '');
    const positive = yes.test(positiveText), negative = negatives.length > 0;
    const tentative = text.split(/[\n,，;；。.]/).some(part => /不确定|待确认|可能|是否|maybe|possibly|unsure|\?/i.test(part) && (yes.test(part) || new RegExp(no.source, 'i').test(part)));
    if (tentative) problem(field, `${labels[field]}带有不确定表述，请确认。`);
    if (positive === negative) problem(field, positive ? `${labels[field] ?? field}出现相反要求，请确认。` : `${labels[field] ?? field}尚未明确。`, positive);
    return positive && !negative;
  };
  const liftgate = bool('requires_liftgate', /(?:需要|需|要|提供)\s*尾板|(?:need|require|with)\s*(?:a\s*)?(?:liftgate|tailgate)/i, /(?:不需要|不需|无需|不用|不要|无)\s*尾板|自行卸货|自卸|(?:no|without|do not need)\s*(?:a\s*)?(?:liftgate|tailgate)|self[ -]?unload/gi);
  const jack = bool('requires_pallet_jack', /(?:需要|需|要|提供)\s*地牛|(?:need|require|with)\s*(?:a\s*)?pallet jack/i, /(?:不需要|不需|无需|不用|不要|无)\s*地牛|(?:no|without|do not need)\s*(?:a\s*)?pallet jack/gi);
  const appointment = bool('requires_appointment', /(?:需要|需|要)\s*预约|(?:need|require|with)\s*(?:an?\s*)?appointment/i, /(?:不需要|不需|无需|不用|不要|无)\s*预约|(?:no|without|do not need)\s*(?:an?\s*)?appointment/gi);
  const packagingText = text.replace(/pallet\s*jack/gi, '');
  const packaging = [...new Set([/纸箱|cartons?|\bbox(?:es)?\b/i.test(packagingText) ? 'carton' : null, /木箱|crates?/i.test(packagingText) ? 'crate' : null, /托盘|pallets?|skids?/i.test(packagingText) ? 'pallet' : null].filter(Boolean))];
  const residential = /私人地址|住宅|residential/i.test(text), commercial = /商业地址|commercial/i.test(text);
  if (residential && commercial) problem('address_type', '地址同时标注住宅和商业，请确认。', true);
  const dimensions = items.flatMap(item => [item.length_cm, item.width_cm, item.height_cm]).filter((v): v is string => v !== null);
  const longest = items.length && items.every(item => item.length_cm !== null) && !incomplete && dimensions.length ? D.max(...dimensions).toFixed() : null;
  const stackNo = /不可堆叠|不能堆叠|不可叠放|non[ -]?stackable|not stackable/i.test(text);
  const stackYes = /可堆叠|可叠放|stackable/i.test(text.replace(/不可堆叠|不能堆叠|不可叠放|non[ -]?stackable|not stackable/gi, ''));
  if (stackYes && stackNo) problem('is_stackable', '堆叠条件存在冲突。', true);
  const waits = [...text.matchAll(/(?:预计等待|等待|等候|detention|waiting)\s*[:：]?\s*(\d+)\s*(分钟|小时|minutes?|mins?|hours?|hrs?)/gi)].map(m => Number(m[1]) * (/小时|hours?|hrs?/i.test(m[2]!) ? 60 : 1));
  if (new Set(waits).size > 1 || waits.some(n => n > 10080)) problem('detention_minutes', '等待时长不一致或超出一周，请确认。', true);
  const extraction = { address_line: postal ? address : null, postal_code: postal, city: postal ? city : null, province: postal ? province : null,
    cbm: str(volume), weight_kg: str(weight), piece_count: pieces ? pieces.toNumber() : null, packaging_type: packaging.length === 1 ? packaging[0]! : null,
    longest_side_cm: longest, explicit_pallet_count: packaging.length === 1 && packaging[0] === 'pallet' && pieces ? pieces.toNumber() : null,
    is_stackable: stackYes === stackNo ? null : stackYes, address_type: residential === commercial ? null : residential ? 'residential' : 'commercial',
    requires_liftgate: liftgate, requires_pallet_jack: jack, requires_appointment: appointment, detention_minutes: conflicts.has('detention_minutes') ? 0 : waits[0] ?? 0,
    missing_fields: [] as string[], confidence: 0, extraction_notes: '仅整理用户提供的文字；未查询地图、未计算运费。数值使用十进制精确换算，缺失与冲突项需人工确认。',
    cargo_items: items, cargo_agent: { parser_version: VERSION, quantity_inferred: false, dimensions_inferred: false, weight_basis_inferred: false }, address_agent: null, validation_notes: notes };
  for (const field of ['postal_code', 'cbm', 'weight_kg', 'piece_count', 'packaging_type', 'address_type', 'longest_side_cm'] as const) if (extraction[field] === null) missing.add(field);
  extraction.missing_fields = [...missing];
  extraction.confidence = conflicts.size ? 0 : Math.max(0, 100 - missing.size * 10);
  const data = extractDataSchema.parse({ extraction, extraction_mode: 'deterministic_recovery', missing_fields: [...missing], follow_up_question: missing.size ? `请确认：${[...missing].map(k => labels[k] ?? k).join('、')}。` : null, quote_result: null });
  return { ...base, status: conflicts.size ? 'manual_review' : missing.size ? 'needs_input' : 'success', data, reason_codes: [conflicts.size ? 'extraction_conflict' : missing.size ? 'extraction_needs_confirmation' : 'extraction_ready_for_confirmation'], source_refs: [{ source_id: 'customer_inquiry', source_type: 'user_input', system: 'freightclaw-native-extraction', locator: 'request:customer_message', version: VERSION, authority: 'user_provided', retrieved_at: new Date().toISOString(), content_hash: `sha256:${createHash('sha256').update(raw).digest('hex')}` }] };
}

export const extractNativeQuote: QuoteBusinessClientPort['extract'] = request => Promise.resolve(parseNativeQuote(request));
