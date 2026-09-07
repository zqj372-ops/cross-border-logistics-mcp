export const marketServices = Object.freeze([
  { id: 'cargo.calculate', configuration: { state:'fixed', description:'计算规则随服务版本发布，无需单独配置企业参数。' }, name: '货物计算', category: 'cargo', protocol: 'mcp', icon: 'box', tone: 'blue', provider: 'FreightClaw', description: '从件数、尺寸和重量，计算体积、体积重与计费重。', detail: '支持单件重量、逐件重量与整行总重三种证据模式。计算过程保留单位、规则版本和来源，缺少必要资料时明确提示补充。', outputs: ['货物总体积与总重量', '体积重、分泡与计费重', '逐项计算过程和规则依据'], path: '/api/v2/tools/cargo.calculate' },
  { id: 'container.plan_summary', configuration: { state:'fixed', description:'装柜限制由每次规划输入，当前没有独立企业配置项。' }, name: '装柜规划', category: 'cargo', protocol: 'mcp', icon: 'container', tone: 'cyan', provider: 'FreightClaw', description: '核对装载容量、超方超重与装柜限制，形成规划摘要。', detail: '结合货物清单和集装箱限制，区分理论容量与可操作容量。结果用于装载评估，实际作业仍需核对包装、设备与现场条件。', outputs: ['容量与装载汇总', '超方、超重与限制提示', '装载顺序摘要'], path: '/api/v2/tools/container.plan_summary' },
  { id: 'system.agent_context.get', configuration: { state:'fixed', description:'标准随平台版本发布，应用权限在个人中心管理。' }, name: 'Agent 接入上下文', category: 'agent', protocol: 'mcp', icon: 'code', tone: 'violet', provider: 'FreightClaw', description: '让 Agent 读取工具规范、权限范围和当前调用约束。', detail: '为 Agent 提供已生成的标准包与工具上下文，帮助它正确选择输入、处理结果和识别需要人工复核的情形。', outputs: ['当前工具调用规范', '输入与输出约束', '标准包版本引用'], path: '/api/v2/tools/system.agent_context.get' },
  { id: 'quote.zone_preview', configuration: { kind:'residential-rates', description:'固定私人地址派送：邮编覆盖、价格矩阵、计费规则和附加费。' }, name: '加拿大尾程询价', category: 'quote', protocol: 'api', icon: 'truck', tone: 'blue', provider: 'FreightClaw 询价服务', description: '按邮编、货物与卸货条件试算尾程运费，查看分区和费用依据。', detail: '复用现有询价系统的分区与计价规则。页面可继续保存报价记录、发起审核和查看报价文档，实际可执行操作由当前账号与来源服务决定。', outputs: ['邮编匹配与服务分区', '价格试算及费用构成', '缺失条件与人工复核提示'], path: '/api/v2/business/quote/zone-preview', online: 'quote' },
  { id: 'quote.ai_extract_preview', configuration: { state:'fixed', description:'原生文字解析随服务版本发布，无需模型密钥；缺失和冲突资料由询价页面确认。' }, name: '询价资料提取', category: 'quote', protocol: 'api', icon: 'file', tone: 'violet', provider: 'FreightClaw 询价服务', description: '把客户的询价描述整理为结构化资料，补齐询价前的关键条件。', detail: '提取邮编、数量、体积、重量和交付条件，并保留需要核对的内容。提取结果不代替计价规则，也不自动确认客户条件。', outputs: ['结构化货物与地址信息', '待补充的业务字段', '可继续试算的询价资料'], path: '/api/v2/business/quote/ai-extract-preview', online: 'quote' },
  { id: 'customs.query', configuration: { kind:'customs-data', description:'税号、税率、措施、单证和来源；与进口税费估算共用同一份关务数据。' }, name: '关税与商品归类', category: 'customs', protocol: 'api', icon: 'file', tone: 'teal', provider: 'ClearDDP 关务服务', description: '查询中国、美国与加拿大的商品归类、税则及适用措施。', detail: '按商品描述、属性、原产地和规则日期检索关务资料。税率与措施由关务服务负责；数据未发布或资料不足时会返回相应状态。', outputs: ['候选归类与税则详情', '适用措施和来源依据', '规则日期与发布状态'], path: '/api/v2/business/customs/query', online: 'customs' },
  { id: 'customs.tax.estimate', configuration: { kind:'customs-data', description:'与关税与商品归类共用已发布的关务数据，在此维护并统一生效。' }, name: '进口税费估算', category: 'customs', protocol: 'api', icon: 'grid', tone: 'teal', provider: 'ClearDDP 关务服务', description: '结合归类、原产地与申报金额，估算美国和加拿大的进口税费。', detail: '支持逐项估算与批量输入，展示税费构成、计算依据和需要补充的条件。估算依赖来源服务已发布的数据与适用规则。', outputs: ['逐项税费与计算依据', '缺失条件和复核事项', '批量估算结果'], path: '/api/v2/business/customs/tax-estimate', online: 'tax' },
  { id: 'quote.freightcom_ltl.preview', configuration: { kind:'freightcom', description:'维护当前企业的 Freightcom 连接，并通过实际询价核对。' }, name: '承运商 LTL 询价', category: 'quote', protocol: 'api', icon: 'truck', tone: 'orange', provider: 'Freightcom 适配服务', description: '查询承运商提供的 LTL 方案，核对运价与运输条件。', detail: '使用企业配置的 Freightcom 连接获取只读询价结果。需要有效承运商凭证和完整货物、地址资料，查询本身不提交订舱。', outputs: ['承运商询价结果', '服务条件与报价有效性', '连接或输入问题'], path: '/api/v2/business/quote/freightcom-ltl-preview', online: 'quote' },
]);

export function filterMarketServices({ query = '', protocol = 'all', category = 'all' } = {}) {
  const search = query.trim().toLocaleLowerCase();
  return marketServices.filter((item) => (protocol === 'all' || item.protocol === protocol) && (category === 'all' || item.category === category) && (!search || `${item.id} ${item.name} ${item.description} ${item.provider}`.toLocaleLowerCase().includes(search)));
}
export function agentInstallPrompt(serviceId = '') {
  const service = marketServices.find((item) => item.id === serviceId);
  return `阅读 https://www.freightclaw.net/console/skill.md，帮我接入 FreightClaw 物流能力${service ? `，使用 ${service.id}` : ''}。`;
}


// UI module routes share the public market catalog; they grant no server permissions.
export function configurationRoute(hash) {
  const [page, id, section = ''] = hash.replace(/^#/, '').split('/');
  const service = page === 'configure' ? marketServices.find(item => item.id === id) : undefined;
  return { service, kind: service?.configuration.kind, section };
}
export function legacyConfigurationRoute(id) {
  const [kind, section] = id.split('/');
  const service = marketServices.find(item => item.configuration.kind === kind);
  return service ? `configure/${service.id}${section ? '/' + section : ''}` : 'market/configure';
}
