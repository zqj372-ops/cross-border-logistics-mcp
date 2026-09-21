import Decimal from 'decimal.js';

// Presentation only. Business states, stored values and calculations remain server-owned.
export const fclLabels: Record<string, string> = {
  submitted: '待处理', in_review: '处理中', needs_input: '待补充', closed: '已结束', cancelled: '已取消',
  handed_off: '已交接', pending: '待交接', draft: '草稿', approved: '已审核', rejected: '已退回',
  general: '普通货物', battery: '含电池', liquid_powder: '液体或粉末', wood: '木制品', regulated: '受监管货物', other: '其他',
  pickup: '中国提货', export_customs: '中国出口报关', ocean_freight: '海运干线', canada_customs: '加拿大清关', devanning_storage: '拆柜与仓储', delivery: '加拿大派送',
  included: '已包含', free: '明确免费', out_of_scope: '不在本次范围', priced: '已计价', missing: '待补费用',
  anonymous_customer: '客户', staff: '受理人员', system: '系统', customer: '客户', internal: '仅内部可见',
  fcl_inquiry_submitted: '提交询价', fcl_receiver_assigned: '分配受理人', fcl_customer_supplement: '客户补充资料',
  fcl_staff_supplement: '工作人员补充资料', fcl_case_status_updated: '更新处理进度', fcl_staff_confirmation: '确认需求', fcl_handoff_recorded: '完成交接',
  origin_city: '中国起运城市', pol: '起运港', pod: '目的港', final_destination: '最终目的地', containers: '柜型与柜数',
  cargo_name: '货物品名', cargo_type: '货物属性', estimated_weight: '预计毛重', cargo_ready_date: '备货日期', incoterm: '贸易条款', incoterm_other: '其他条款说明',
  selected_services: '服务范围', 'contact.name': '联系人', 'contact.email': '电子邮箱', 'contact.company': '公司名称', 'contact.phone': '联系电话', notes: '补充说明',
  CNTR: '柜', SHIPMENT: '票', success: '已完成', manual_review: '需要人工核对', blocked: '暂不能操作', unavailable: '暂不可用',
};
export const fclLabel = (value: string | null | undefined): string => fclLabels[value ?? ''] ?? '待核对';

export function displayMargin(value: string | null | undefined): string {
  if (value == null) return '—';
  try { return `${new Decimal(value).mul(100).toFixed(2)}%`; } catch { return '—'; }
}

export function fclValue(field: string, value: unknown): string {
  if (value == null || value === '') return '未填写';
  if (field === 'containers' && Array.isArray(value)) return value.map((row: {type: string; quantity: number | null}) => `${row.type} × ${row.quantity ?? '待确认'}`).join('、') || '未选择';
  if (field === 'selected_services' && Array.isArray(value)) return value.map((item: string) => fclLabel(item)).join('、') || '未选择';
  if (field === 'cargo_type' && typeof value === 'string') return fclLabel(value);
  if (field === 'estimated_weight' && typeof value === 'object' && 'value' in value && 'unit' in value) return `${String(value.value)} ${String(value.unit)}`;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

const systemMessages: Record<string, string> = {
  'FCL inquiry submitted by anonymous customer.': '客户已提交整柜询价。',
  'FCL inquiry assigned to configured receiver.': '询价已分配给受理人员。',
  'Customer supplied structured FCL fields.': '客户已补充询价资料，等待工作人员核对。',
  'Staff recorded an offline structured supplement.': '工作人员已记录线下确认的资料。',
};
export const fclEventMessage = (value: string): string => systemMessages[value] ?? value;

const issues: Record<string, string> = {
  fcl_handoff_quote_changed: '报价已更新，需要重新完成审核和交接',
  fcl_handoff_document_changed: '报价单已更新，请下载最新的正式文件后交接',
  fcl_handoff_case_changed: '需求已更新，请重新核对',
  fcl_case_version_conflict: '需求已更新，请刷新后重新核对',
  fcl_customer_supplement_conflict: '客户已补充资料，请先核对最新需求',
  fcl_case_closed: '本票已结束，不能继续报价',
  fcl_case_input_incomplete: '需求资料尚不完整，请先补充',
  fcl_case_review_required: '请先确认当前需求',
  fcl_rate_source_unavailable: '暂无可用运价，请在运价管理中核对并发布',
  fcl_quote_source_unavailable: '请先选择适用的运价',
  fcl_rate_no_match: '没有匹配的运价，请核对港口、柜型和备货日期',
  fcl_rate_selection_required: '找到多个运价，请选择实际采用的来源',
  fcl_selected_rate_not_candidate: '所选运价不适用，请重新选择',
  fcl_quote_scope_invalid: '服务范围与费用不一致，请核对已包含、免费或不在范围的选择',
  fcl_quote_incomplete: '报价仍有待补项目，请补齐费用与汇率',
  fcl_source_changed: '运价来源已更新，请重新选择并核对报价',
  fcl_quote_changed: '报价已更新，请重新生成并审核报价单',
  fcl_template_changed: '出具人或条款已更新，请重新生成报价单',
  fcl_version_conflict: '记录已更新，请刷新后重试',
  fcl_pdf_hash_mismatch: '报价文件校验失败，请重新下载',
  fcl_pdf_bytes_invalid: '报价文件不完整，请重新下载',
  fcl_response_invalid: '服务响应异常，请稍后重试',
};
export function fclIssue(code: string): string {
  if (issues[code]) return issues[code];
  const fee = /^\/cost_rows\/(\d+)\/(cost_price|sell_price|evidence_ref|evidence_version)$/u.exec(code);
  if (fee) return `第 ${Number(fee[1]) + 1} 项费用：请填写${({cost_price:'成本单价',sell_price:'客户单价',evidence_ref:'费用依据',evidence_version:'依据版本'} as Record<string,string>)[fee[2] ?? '']}`;
  const currency = /^\/exchange_rates\/(USD|CAD)$/u.exec(code);
  if (currency) return `请填写 ${currency[1]} 对人民币的汇率`;
  const service = /^\/service_coverage\/(\d+)$/u.exec(code);
  if (service) return `第 ${Number(service[1]) + 1} 项服务的费用安排待确认`;
  return code;
}
