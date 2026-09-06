export type InquiryMode = 'shipping' | 'business';
export type Draft = {
  mode: InquiryMode; services: string[]; transportMode: string; origin: string; destination: string;
  product: string; readyDate: string; containerType: string; containerCount: string; containerCountUnknown: boolean;
  volume: string; volumeUnknown: boolean; weight: string; weightUnknown: boolean; cargoType: string;
  palletCount: string; skuCount: string; deliverySite: string; unloading: string;
  businessRegion: string; notes: string; contactName: string; email: string; company: string; phone: string; consent: boolean;
};
export const RECIPIENT = 'ops@freightclaw.net';
export const SHIPPING_SERVICES = [
  { id: 'pickup', name: '中国提货', description: '从工厂或仓库提货', icon: 'truck' },
  { id: 'ocean', name: '海运订舱', description: '整柜或拼箱运往加拿大', icon: 'container' },
  { id: 'customs', name: '加拿大清关', description: '办理到港进口清关', icon: 'document' },
  { id: 'warehouse', name: '拆柜与仓储', description: '拆柜、入仓及仓库操作', icon: 'warehouse' },
  { id: 'delivery', name: '加拿大派送', description: '送到指定地址或仓库', icon: 'truck' },
] as const;
export const BUSINESS_SERVICES = [
  { id: 'company', name: '公司与进口资质', description: '公司注册、进口商相关事项', icon: 'warehouse' },
  { id: 'bond', name: 'Bond 与财税', description: 'Bond、报税与财税服务咨询', icon: 'document' },
  { id: 'compliance', name: '产品合规', description: '产品许可、注册与备案咨询', icon: 'document' },
] as const;
export const TRANSPORT_LABELS: Record<string, string> = { fcl: '整柜', lcl: '拼箱', unsure: '尚未确定' };
export const CARGO_LABELS: Record<string, string> = {
  '': '待确认', normal: '普通货', battery: '含电池', liquid: '液体或粉末', wood: '木制品', regulated: '食品或受监管货物', other: '其他，见补充说明',
};
export const SITE_LABELS: Record<string, string> = { '': '待确认', commercial: '商业地址', residential: '住宅地址', warehouse: '仓库 / FBA' };
export const UNLOADING_LABELS: Record<string, string> = { '': '待确认', self: '收货方可自行卸货', assistance: '需要卸货协助' };

export function createDraft(mode: InquiryMode = 'shipping'): Draft {
  return { mode, services: [], transportMode: '', origin: '', destination: '', product: '', readyDate: '',
    containerType: '', containerCount: '', containerCountUnknown: false, volume: '', volumeUnknown: false,
    weight: '', weightUnknown: false, cargoType: '', palletCount: '', skuCount: '', deliverySite: '', unloading: '',
    businessRegion: '', notes: '', contactName: '', email: '', company: '', phone: '', consent: false };
}
export const serviceOptions = (draft: Draft) => draft.mode === 'business' ? BUSINESS_SERVICES : SHIPPING_SERVICES;
export const selectedServices = (draft: Draft) => serviceOptions(draft).filter(service => draft.services.includes(service.id));
export const needsOrigin = (draft: Draft) => draft.services.some(id => id === 'pickup' || id === 'ocean');
export const escapeHtml = (value: string | number | boolean | null | undefined): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

// Deliberately reject control characters in values used as single-line mail headers.
// eslint-disable-next-line no-control-regex
const singleLine = (value: string, max: number) => value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const positiveDecimal = (value: string) => /^\d{1,12}(?:\.\d{1,6})?$/.test(value.trim()) && /[1-9]/.test(value);
const positiveInteger = (value: string) => /^\d{1,9}$/.test(value.trim()) && /[1-9]/.test(value);
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateStep(draft: Draft, step: number): Record<string, string> {
  const errors: Record<string, string> = {};
  if (step === 1) {
    const ids: readonly string[] = serviceOptions(draft).map(service => service.id);
    if (!draft.services.length || draft.services.some(id => !ids.includes(id))) errors.services = '请至少选择一项需要的服务。';
  }
  if (step === 2) {
    if (draft.mode === 'shipping') {
      if (!Object.hasOwn(TRANSPORT_LABELS, draft.transportMode)) errors.transportMode = '请选择整柜、拼箱，或“还不确定”。';
      if (needsOrigin(draft) && (!draft.origin.trim() || !singleLine(draft.origin, 200))) errors.origin = '请填写中国起运城市或提货地区。';
      if (!draft.destination.trim() || !singleLine(draft.destination, 200)) errors.destination = '请填写加拿大目的城市、邮编或港口。';
      if (!draft.product.trim() || !singleLine(draft.product, 200)) errors.product = '请填写货物品名。';
      if (draft.readyDate && !validDate(draft.readyDate)) errors.readyDate = '请填写有效日期，或留空待确认。';
      if (!Object.hasOwn(CARGO_LABELS, draft.cargoType)) errors.cargoType = '请选择货物属性，或“待确认”。';
      if (draft.transportMode === 'fcl') {
        if (!['20GP', '40GP', '40HQ', '45HQ', 'unknown'].includes(draft.containerType)) errors.containerType = '请选择柜型，或“待确认”。';
        if (!draft.containerCountUnknown && !positiveInteger(draft.containerCount)) errors.containerCount = '请填写大于 0 的整数柜数，或勾选“待确认”。';
      }
      if (draft.transportMode === 'lcl') {
        if (!draft.volumeUnknown && !positiveDecimal(draft.volume)) errors.volume = '请填写大于 0 的体积，或勾选“待确认”。';
        if (!draft.weightUnknown && !positiveDecimal(draft.weight)) errors.weight = '请填写大于 0 的毛重，或勾选“待确认”。';
      }
      if (draft.services.includes('warehouse')) {
        if (draft.palletCount && !positiveInteger(draft.palletCount)) errors.palletCount = '请填写大于 0 的整数托盘数，或留空。';
        if (draft.skuCount && !positiveInteger(draft.skuCount)) errors.skuCount = '请填写大于 0 的整数 SKU 数量，或留空。';
      }
      if (draft.services.includes('delivery')) {
        if (!Object.hasOwn(SITE_LABELS, draft.deliverySite)) errors.deliverySite = '请选择收货场所，或“待确认”。';
        if (!Object.hasOwn(UNLOADING_LABELS, draft.unloading)) errors.unloading = '请选择卸货安排，或“待确认”。';
      }
    } else {
      if (!singleLine(draft.businessRegion, 160)) errors.businessRegion = '办理地区请使用单行文字，最多 160 字。';
      if (!draft.notes.trim()) errors.notes = '请简要说明需要办理的事项。';
    }
    // Multi-line notes allow tabs and line breaks, but no other control characters.
    // eslint-disable-next-line no-control-regex
    if (draft.notes.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.notes)) errors.notes = '补充说明最多 4,000 字，请去掉异常控制字符。';
  }
  if (step === 3) {
    if (!draft.contactName.trim() || !singleLine(draft.contactName, 80)) errors.contactName = '请填写联系人姓名，最多 80 字。';
    if (!singleLine(draft.email, 254) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(draft.email.trim())) errors.email = '请填写有效的电子邮箱。';
    if (!singleLine(draft.company, 160)) errors.company = '公司名称请使用单行文字，最多 160 字。';
    if (!singleLine(draft.phone, 80)) errors.phone = '联系电话请使用单行文字，最多 80 字。';
    if (!draft.consent) errors.consent = '请先核对需求并勾选确认。';
  }
  return errors;
}

export function reconcileErrors(draft: Draft, step: number, previous: Record<string, string>): Record<string, string> {
  const current = validateStep(draft, step);
  return Object.fromEntries(Object.keys(previous).filter(field => current[field]).map(field => [field, current[field]!]));
}

export function shipmentLines(draft: Draft): string[] {
  if (draft.mode === 'business') return [`办理地区：${draft.businessRegion.trim() || '待确认'}`];
  const lines = [
    ...(needsOrigin(draft) ? [`中国起运地：${draft.origin.trim() || '待确认'}`] : []),
    `加拿大目的地：${draft.destination.trim() || '待确认'}`,
    `货物品名：${draft.product.trim() || '待确认'}`,
    `运输方式：${TRANSPORT_LABELS[draft.transportMode] ?? '待确认'}`,
  ];
  if (draft.transportMode === 'fcl') {
    const type = draft.containerType && draft.containerType !== 'unknown' ? draft.containerType : '待确认';
    const count = draft.containerCountUnknown || !draft.containerCount.trim() ? '待确认' : draft.containerCount.trim();
    lines.push(type !== '待确认' && count !== '待确认' ? `集装箱：${type} × ${count} 柜` : `柜型：${type}`, ...(type === '待确认' || count === '待确认' ? [`柜数：${count === '待确认' ? count : `${count} 柜`}`] : []));
  }
  if (draft.transportMode === 'lcl') {
    lines.push(`总体积：${draft.volumeUnknown || !draft.volume.trim() ? '待确认' : `${draft.volume.trim()} m³`}`);
    lines.push(`总毛重：${draft.weightUnknown || !draft.weight.trim() ? '待确认' : `${draft.weight.trim()} kg`}`);
  }
  lines.push(`货物属性：${CARGO_LABELS[draft.cargoType] ?? '待确认'}`);
  lines.push(`${needsOrigin(draft) ? '预计出货日期' : '预计服务日期'}：${draft.readyDate || '待确认'}`);
  if (draft.services.includes('warehouse')) {
    lines.push(`托盘数量：${draft.palletCount.trim() ? `${draft.palletCount.trim()} 托` : '待确认'}`);
    lines.push(`SKU 数量：${draft.skuCount.trim() || '待确认'}`);
  }
  if (draft.services.includes('delivery')) lines.push(`收货场所：${SITE_LABELS[draft.deliverySite] ?? '待确认'}`, `卸货安排：${UNLOADING_LABELS[draft.unloading] ?? '待确认'}`);
  return lines;
}

export function buildInquiry(draft: Draft) {
  if ([1, 2, 3].some(step => Object.keys(validateStep(draft, step)).length)) throw new Error('inquiry_incomplete');
  const title = draft.mode === 'business' ? '企业与合规服务咨询' : '加拿大海运询价';
  const subject = `${title}｜${draft.contactName.trim()}`;
  const body = [
    '您好，请根据以下需求提供服务方案与正式报价。', '',
    '【需要的服务】', ...selectedServices(draft).map(service => `• ${service.name}`), '',
    draft.mode === 'business' ? '【办理信息】' : '【运输与货物】', ...shipmentLines(draft), '',
    ...(draft.notes.trim() ? ['【补充说明】', draft.notes.trim(), ''] : []),
    '【联系方式】', `联系人：${draft.contactName.trim()}`, `邮箱：${draft.email.trim()}`,
    ...(draft.company.trim() ? [`公司：${draft.company.trim()}`] : []),
    ...(draft.phone.trim() ? [`电话：${draft.phone.trim()}`] : []), '',
    draft.mode === 'business' ? '服务费：待正式报价。' : '运费及服务费：待正式报价。',
    '未选择的环节不代表已包含；实际服务范围、费用和适用条件以双方书面确认为准。',
    '标记“待确认”的信息请协助核实。本邮件为询价需求，不构成订舱或下单。',
  ].join('\n');
  const uri = `mailto:${RECIPIENT}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return { recipient: RECIPIENT, subject, body, copyText: `收件人：${RECIPIENT}\n主题：${subject}\n\n${body}`, mailto: uri.length <= 10000 ? uri : null };
}
