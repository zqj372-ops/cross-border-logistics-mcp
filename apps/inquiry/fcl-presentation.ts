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
  'FCL quotation handed off.': '已记录报价交接。',
  'Staff recorded an offline structured supplement.': '工作人员已记录线下确认的资料。',
};
export const fclEventMessage = (value: string): string => systemMessages[value] ?? value;

const issues: Record<string, string> = {
  operations_date_order_invalid:'失效日期不能早于生效日期',operations_duplicate_version:'同一费用不能使用重复版本号',operations_validity_overlap:'同一项目的有效期重叠，请先缩短原版本的有效期',operations_capacity_invalid:'最低重量或体积不能大于上限',operations_tier_invalid:'重量区间上下限颠倒',operations_tier_overlap:'重量阶梯重叠，请使用互不重叠的区间',operations_charge_reference_invalid:'固定费用引用不存在或重复',operations_delivery_reference_invalid:'模板引用的内陆运价不存在',operations_schedule_duplicate:'同一海运来源只能维护一份班期',operations_rate_reference_invalid:'班期对应的海运来源不存在',operations_schedule_date_invalid:'预计到港不能早于开船日期',
  fcl_estimate_too_many_customer_lines: '费用明细超过客户报价上限，请精简模板后重算',
  fcl_operations_not_configured:'请先在报价工作台维护固定费用和模板，保存并发布',
  fcl_operations_input_invalid:'输入格式不正确，请核对金额、日期、柜型和必填项目',
  fcl_estimate_source_changed:'所用费用已变化，请重新计算',fcl_estimate_source_unavailable:'价格来源暂不可用，请核对已发布费用',
  fcl_estimate_expired:'报价已过期 Expired',fcl_estimate_historical:'历史版本，仅供核对',fcl_estimate_incomplete:'方案仍有待补费用或条件',
  fcl_estimate_case_mismatch:'方案与本票线路、柜数或重量不一致，请从本票重新计算',
  fcl_estimate_shipping_date_invalid:'出运日期不能早于客户备货日期',fcl_estimate_binding_invalid:'所选方案已变化，请刷新并重新选择',
  fcl_estimate_adjust_in_workbench:'请在报价工作台调整方案，再生成新客户报价',fcl_estimate_no_candidates:'没有匹配方案，请核对起运港与已发布模板',
  fcl_estimate_locked:'请先解除锁定，再调整售价',fcl_estimate_limit:'方案数量已达到本阶段上限，请联系维护人员',
  fcl_rate_unsaved_publication:'存在未发布的配置，请先发布或还原草稿',fcl_bulk_rate_window_conflict:'同一海运来源的柜型需使用一致的来源编号和版本',
  legacy_ocean_fee_review:'模板含历史基础海运费，请核对金额后确认改从海运费表取价',
  legacy_rate_ocean_fee_review:'历史附费含基础海运费，请核对后确认排除重复项',
  legacy_rate_fee_collision:'历史运价附费与模板费用重复，请先核对费用来源',
  charge_ambiguous:'该费用存在多个启用版本，请核对后只保留一个启用版本',
  fcl_legacy_ocean_fee_review:'历史基础海运费尚未核对，不能删除或改写原金额；请先确认排除重复项',
  fcl_base_ocean_fee_duplicate:'基础海运费已从所选运价读取，不能再作为人工费用添加',
  template_ambiguous:'该模板存在多个启用版本，请核对后只保留一个启用版本',template_expired:'出运日期没有对应的有效模板',ocean_rate_expired:'海运费有效期不覆盖出运日期',route_mismatch:'起运港或目的港与模板不一致',
  delivery_route_mismatch:'内陆运价的起终点或运输模式与模板不一致',delivery_container_mismatch:'内陆运价不支持所选柜型',delivery_postal_code_mismatch:'内陆运价不适用当前邮编',delivery_zone_mismatch:'内陆运价不适用当前区域',delivery_tier_unavailable:'重量未落在已维护的阶梯内',delivery_tier_ambiguous:'重量阶梯重叠，请修正内陆运价',

  fcl_state_conflict: '当前处理状态不允许此操作，请刷新后核对',
  fcl_quote_not_current_version: '这是历史报价，请查看最新版本',
  fcl_quote_case_version_changed: '客户需求已更新，这份报价基于较早资料',
  fcl_quote_case_supplement_changed: '客户补充了资料，请重新核对报价',
  fcl_quote_case_closed: '本票已结束或取消，历史报价仅供查看',
  fcl_quote_case_review_required: '当前需求尚未核对确认',
  fcl_quote_case_unavailable: '暂时无法读取客户需求，请稍后重试',
  fcl_quote_source_release_changed: '运价表已更新，请重新核对所用价格',
  fcl_quote_source_rate_changed: '报价所用运价已变更，请重新核对',
  fcl_quote_source_expired: '报价所用运价不在当前有效期内',
  fcl_document_not_current_version: '这是历史报价单，请查看最新版本',
  fcl_document_quote_changed: '报价金额或内容已更新，请重新生成并审核报价单',
  fcl_document_quote_unavailable: '暂时无法读取对应报价，请稍后重试',
  fcl_document_template_unavailable: '报价出具人或条款尚未配置',
  fcl_document_template_changed: '出具人或条款已更新，请重新生成报价单',
  fcl_document_expired: '报价单不在当前有效期内',
  fcl_document_case_closed: '本票已结束或取消，不能重新出具报价单',
  fcl_currentness_manual_review: '资料或价格已发生变化，请核对提示后处理',

  fcl_handoff_not_recorded: '尚未完成报价交接',
  fcl_handoff_source_changed: '运价或报价条款已变化，请重新核对后交接',
  fcl_handoff_pdf_unavailable: '交接文件暂时不可用，请重新下载并校验',
  fcl_handoff_quote_changed: '报价已更新，需要重新完成审核和交接',
  fcl_handoff_document_changed: '报价单已更新，请下载最新的正式文件后交接',
  fcl_handoff_case_changed: '需求已更新，请重新核对',
  fcl_case_version_conflict: '需求已更新，请刷新后重新核对',
  fcl_customer_supplement_conflict: '客户已补充资料，请先核对最新需求',
  fcl_case_closed: '本票已结束，不能继续报价',
  fcl_case_input_incomplete: '需求资料尚不完整，请先补充',
  fcl_case_review_required: '请先确认当前需求',
  fcl_rate_source_unavailable: '暂无可用运价，请在运价管理中核对并发布',
  fcl_quote_source_unavailable: '报价所用运价当前不可用，请核对已发布运价',
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
  const [prefix,value]=code.split(':');
  const scoped:Record<string,string>={fx_missing:'缺少对人民币汇率',charge_unavailable:'没有有效费用',charge_ambiguous:'费用有效期重叠',charge_duplicate:'费用被重复计入',charge_route_mismatch:'费用不适用当前路线',charge_container_mismatch:'费用不适用当前柜型',delivery_unavailable:'没有有效内陆运价',delivery_ambiguous:'内陆运价有效期重叠',container_unavailable:'柜型无可用价格',adjustment_source_changed:'人工调整对应费用已变化'};
  if(prefix&&issues[prefix])return `${issues[prefix]}：${value||''}`;
  if(prefix&&scoped[prefix])return `${scoped[prefix]}：${value||''}`;
  const limits=/^(template|delivery)_(kg|cbm)_(required|out_of_range)$/u.exec(code);
  if(limits)return `${limits[1]==='template'?'模板':'内陆运输'}：${limits[3]==='required'?'请填写':'超出适用范围，核对'}${limits[2]==='kg'?'重量':'体积'}`;

  const fee = /^\/cost_rows\/(\d+)\/(cost_price|sell_price|evidence_ref|evidence_version)$/u.exec(code);
  if (fee) return `第 ${Number(fee[1]) + 1} 项费用：请填写${({cost_price:'成本单价',sell_price:'客户单价',evidence_ref:'费用依据',evidence_version:'依据版本'} as Record<string,string>)[fee[2] ?? '']}`;
  const currency = /^\/exchange_rates\/(USD|CAD)$/u.exec(code);
  if (currency) return `请填写 ${currency[1]} 对人民币的汇率`;
  const service = /^\/service_coverage\/(\d+)$/u.exec(code);
  if (service) return `第 ${Number(service[1]) + 1} 项服务的费用安排待确认`;
  return code;
}
