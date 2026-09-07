export const marketServices = Object.freeze([
  { id: 'cargo.calculate', name: '货物计算', category: 'cargo', protocol: 'mcp', icon: 'box', tone: 'blue', provider: 'FreightClaw', description: '从件数、尺寸和重量，计算体积、体积重与计费重。', detail: '支持单件重量、逐件重量与整行总重三种证据模式。计算过程保留单位、规则版本和来源，缺少必要资料时明确提示补充。', outputs: ['货物总体积与总重量', '体积重、分泡与计费重', '逐项计算过程和规则依据'], path: '/api/v2/tools/cargo.calculate' },
  { id: 'container.plan_summary', name: '装柜规划', category: 'cargo', protocol: 'mcp', icon: 'container', tone: 'cyan', provider: 'FreightClaw', description: '核对装载容量、超方超重与装柜限制，形成规划摘要。', detail: '结合货物清单和集装箱限制，区分理论容量与可操作容量。结果用于装载评估，实际作业仍需核对包装、设备与现场条件。', outputs: ['容量与装载汇总', '超方、超重与限制提示', '装载顺序摘要'], path: '/api/v2/tools/container.plan_summary' },
  { id: 'system.agent_context.get', name: 'Agent 接入上下文', category: 'agent', protocol: 'mcp', icon: 'code', tone: 'violet', provider: 'FreightClaw', description: '让 Agent 读取工具规范、权限范围和当前调用约束。', detail: '为 Agent 提供已生成的标准包与工具上下文，帮助它正确选择输入、处理结果和识别需要人工复核的情形。', outputs: ['当前工具调用规范', '输入与输出约束', '标准包版本引用'], path: '/api/v2/tools/system.agent_context.get' },
  { id: 'quote.zone_preview', name: '加拿大尾程询价', category: 'quote', protocol: 'api', icon: 'truck', tone: 'blue', provider: 'FreightClaw 询价服务', description: '按邮编、货物与卸货条件试算尾程运费，查看分区和费用依据。', detail: '复用现有询价系统的分区与计价规则。页面可继续保存报价记录、发起审核和查看报价文档，实际可执行操作由当前账号与来源服务决定。', outputs: ['邮编匹配与服务分区', '价格试算及费用构成', '缺失条件与人工复核提示'], path: '/api/v2/business/quote/zone-preview', online: 'quote' },
  { id: 'quote.ai_extract_preview', name: '询价资料提取', category: 'quote', protocol: 'api', icon: 'file', tone: 'violet', provider: 'FreightClaw 询价服务', description: '把客户的询价描述整理为结构化资料，补齐询价前的关键条件。', detail: '提取邮编、数量、体积、重量和交付条件，并保留需要核对的内容。提取结果不代替计价规则，也不自动确认客户条件。', outputs: ['结构化货物与地址信息', '待补充的业务字段', '可继续试算的询价资料'], path: '/api/v2/business/quote/ai-extract-preview', online: 'quote' },
  { id: 'customs.query', name: '关税与商品归类', category: 'customs', protocol: 'api', icon: 'file', tone: 'teal', provider: 'ClearDDP 关务服务', description: '查询中国、美国与加拿大的商品归类、税则及适用措施。', detail: '按商品描述、属性、原产地和规则日期检索关务资料。税率与措施由关务服务负责；数据未发布或资料不足时会返回相应状态。', outputs: ['候选归类与税则详情', '适用措施和来源依据', '规则日期与发布状态'], path: '/api/v2/business/customs/query', online: 'customs' },
  { id: 'customs.tax.estimate', name: '进口税费估算', category: 'customs', protocol: 'api', icon: 'grid', tone: 'teal', provider: 'ClearDDP 关务服务', description: '结合归类、原产地与申报金额，估算美国和加拿大的进口税费。', detail: '支持逐项估算与批量输入，展示税费构成、计算依据和需要补充的条件。估算依赖来源服务已发布的数据与适用规则。', outputs: ['逐项税费与计算依据', '缺失条件和复核事项', '批量估算结果'], path: '/api/v2/business/customs/tax-estimate', online: 'tax' },
  { id: 'quote.freightcom_ltl.preview', name: '承运商 LTL 询价', category: 'quote', protocol: 'api', icon: 'truck', tone: 'orange', provider: 'Freightcom 适配服务', description: '查询承运商提供的 LTL 方案，核对运价与运输条件。', detail: '使用企业配置的 Freightcom 连接获取只读询价结果。需要有效承运商凭证和完整货物、地址资料，查询本身不提交订舱。', outputs: ['承运商询价结果', '服务条件与报价有效性', '连接或输入问题'], path: '/api/v2/business/quote/freightcom-ltl-preview', online: 'quote' },
]);

export function filterMarketServices({ query = '', protocol = 'all', category = 'all' } = {}) {
  const search = query.trim().toLocaleLowerCase();
  return marketServices.filter((item) => (protocol === 'all' || item.protocol === protocol) && (category === 'all' || item.category === category) && (!search || `${item.id} ${item.name} ${item.description} ${item.provider}`.toLocaleLowerCase().includes(search)));
}
export function agentInstallPrompt(serviceId = '') {
  const service = marketServices.find((item) => item.id === serviceId);
  return `阅读 https://www.freightclaw.net/console/skill.md，帮我接入 FreightClaw 物流能力${service ? `，使用 ${service.id}` : ''}。`;
}

export function createCapabilityMarket(ui) {
  const { esc, icon, link, head, panel, note, empty } = ui;
  const filters = { query: '', protocol: 'all', category: 'all' };
  const categoryNames = { all: '全部分类', quote: '运费询价', customs: '关务与税费', cargo: '货物与装载', agent: 'Agent 工具' };
  const protocolName = (item) => item.protocol === 'mcp' ? 'MCP · REST' : 'REST API';
  const stamp = (item) => `<span class="cap-icon ${item.tone}">${icon(item.icon)}</span>`;
  const copy = (id = '', label = '复制接入指令') => `<button type="button" class="button primary" data-action="market-copy" data-id="${esc(id)}">${icon('code')}${esc(label)}</button>`;
  function installBox(id = '') { return `<div class="install-command"><code>${esc(agentInstallPrompt(id))}</code>${copy(id, '复制指令')}</div>`; }
  function card(item) {
    return `<button type="button" class="cap-card" data-go="service/${esc(item.id)}"><span class="cap-card-head">${stamp(item)}<span class="protocol-label">${protocolName(item)}</span></span><h3>${esc(item.name)}</h3><p>${esc(item.description)}</p><span class="cap-card-foot"><span>${esc(item.provider)}</span>${icon('arrow')}</span></button>`;
  }
  function results() {
    const items = filterMarketServices(filters);
    return `<div class="market-result-heading"><h2>${esc(categoryNames[filters.category] || '全部能力')}</h2><span role="status">${items.length} 项能力</span></div>${items.length ? `<div class="cap-grid">${items.map(card).join('')}</div>` : empty('没有找到相关能力', '试试“邮编”“关税”“货物”，或清除筛选重新查看。', '<button class="button" type="button" data-action="market-reset">清除筛选</button>', 'grid')}`;
  }
  function page(home = false) {
    const intro = home ? `<section class="market-intro"><h1>把物流能力，接入你的工作流。</h1><p>询价、关税、货物计算与装柜规划。在线使用，或交给你的 Agent。</p><div class="hero-install"><span class="install-label">把这句话交给 Agent，开始接入</span>${installBox()}</div></section>` : head('能力市场', '找到业务需要的能力，查看说明后在线使用或接入你的系统。');
    return `${intro}<section class="market-browser" aria-label="浏览物流能力"><div class="market-toolbar"><div class="market-protocols" role="group" aria-label="接入方式">${[['all', '全部能力'], ['mcp', 'MCP'], ['api', '业务 API']].map(([key, title]) => `<button type="button" data-action="market-protocol" data-id="${key}" class="market-tab${filters.protocol === key ? ' selected' : ''}" aria-pressed="${filters.protocol === key}">${title}<span>${filterMarketServices({ protocol: key }).length}</span></button>`).join('')}</div><div class="market-search">${icon('search')}<label class="sr-only" for="market-search">搜索能力</label><input id="market-search" type="search" value="${esc(filters.query)}" placeholder="搜索能力、业务或服务" autocomplete="off"></div></div><div class="market-layout"><nav class="market-categories" aria-label="能力分类">${Object.entries(categoryNames).map(([key, title]) => `<button type="button" class="market-category${filters.category === key ? ' selected' : ''}" data-action="market-category" data-id="${key}" aria-pressed="${filters.category === key}">${esc(title)}</button>`).join('')}<a href="#guide" class="market-help">接入指南 ${icon('arrow')}</a></nav><div id="market-results">${results()}</div></div></section><div class="market-bottom"><p>业务人员直接使用工作台；系统与 Agent 通过 API Key 接入。</p>${link('打开业务工作台', 'workbench')}</div>`;
  }
  function detail(id) {
    const item = marketServices.find((value) => value.id === id);
    if (!item) return empty('未找到这项能力', '返回市场查看当前提供的服务。', link('返回能力市场', 'market'));
    const configured = ui.model().businessCatalog?.find((value) => value.operation === id)?.configured;
    const connection = item.protocol === 'api' && ui.model().session?.organization_id ? note(configured ? '当前企业已配置服务连接，数据可用性与授权在实际调用时核对。' : '当前企业尚未配置此服务连接，可先查看接口说明并申请开通。', configured ? '' : 'warning') : '';
    return `<button type="button" class="back-link" data-go="market">${icon('back')}返回能力市场</button><div class="service-detail-head">${stamp(item)}<div><h1>${esc(item.name)}</h1><p>${esc(item.provider)}<span class="detail-divider">/</span>${protocolName(item)}</p></div></div><div class="service-detail-layout"><div class="service-detail-body"><section><h2>能力介绍</h2><p>${esc(item.detail)}</p>${connection}</section><section><h2>可以获得什么</h2><ul class="output-list">${item.outputs.map((value) => `<li>${icon('check')}<span>${esc(value)}</span></li>`).join('')}</ul></section><section><h2>接口与使用</h2><div class="endpoint-row"><span>POST</span><code>${esc(item.path)}</code></div><p>操作标识 <code>${esc(item.id)}</code>。输入字段与完整响应见接口文档。</p><a class="text-button" href="/console/openapi.json" target="_blank" rel="noopener">查看 OpenAPI 文档</a>${item.protocol === 'api' ? '<p class="detail-fineprint">当前通过 REST API 提供，Agent 可按接口文档调用。</p>' : '<p class="detail-fineprint">支持 MCP 客户端与 REST 调用。接入指南会说明客户端的令牌配置。</p>'}</section></div><aside class="service-install"><h2>开始使用</h2><p>关务查询支持每天 20 次访客使用；尾程询价需登录。连接系统时，在个人中心管理 API Key。</p>${item.online ? link('在线使用', item.online, true, 'arrow') : link('查看接入指南', 'guide', true, 'code')}<div class="service-agent"><h3>接入 Agent</h3><p>复制以下指令，发送给你的 Agent。</p><code>${esc(agentInstallPrompt(id))}</code>${copy(id)}</div><div class="service-install-footer">${link('管理 API Key', 'api-keys')}${link('申请服务', `apply/${id}`)}</div></aside></div>`;
  }
  function guide() {
    return head('接入指南', '一把 API Key，连接应用已开通的物流能力。', link('管理 API Key', 'api-keys', true, 'key')) + `<div class="guide-layout"><div><section class="guide-section"><h2>让 Agent 帮你接入</h2><p>复制这句话给 Codex、Claude Code 或其他能读取网页的 Agent。它会按公开指南配置接口，并帮你完成一次只读调用。</p>${installBox()}<p class="guide-caption">Key 填入你自己的凭证管理工具或本机环境变量，避免放进聊天和代码仓库。</p></section><section class="guide-section"><h2>直接调用 API</h2><p>在控制台申请服务并创建 Key，按接口文档构造请求即可。鉴权、权限校验与服务转发由平台处理。</p><div class="endpoint-row"><span>HTTPS</span><code>https://www.freightclaw.net</code></div><pre class="code-sample">${esc("Authorization: ApiKey ${FREIGHTCLAW_API_KEY}\nContent-Type: application/json")}</pre><div class="guide-links"><a class="button" href="/console/openapi.json" download="freightclaw-openapi.json">下载 OpenAPI</a><a class="button" href="/console/skill.md" target="_blank" rel="noopener">查看 Agent 指南</a></div></section><section class="guide-section"><h2>MCP 客户端</h2><p>货物计算、装柜规划和 Agent 上下文支持 MCP。使用同一 API Key 兑换短期令牌后，配置到支持 HTTP 的 MCP 客户端。</p><div class="endpoint-row"><span>POST</span><code>/access/v2/application/token/exchange</code></div><p class="guide-caption">长期 Key 由接入网关验证。报价和关务目前使用 REST API，Agent 按对应接口调用。</p><details class="guide-advanced"><summary>排查接入问题</summary><p>遇到权限或输入问题时，可使用诊断页查看请求编号和接口返回。</p>${link('打开调用诊断', 'diagnostics')}</details></section></div><aside class="guide-aside"><h3>按返回状态继续处理</h3><dl><dt>已完成</dt><dd>核对本次结果与来源版本。</dd><dt>待补充</dt><dd>补齐接口列出的资料。</dd><dt>需人工复核</dt><dd>将具体事项交给业务负责人。</dd><dt>已阻止</dt><dd>检查 Key、有效期与服务权限。</dd><dt>暂不可用</dt><dd>检查服务连接和数据发布状态。</dd></dl></aside></div>`;
  }
  function workbench() {
    if (!ui.model().session?.organization_id) return head('业务工作台', '加入企业后，使用已开放的询价和关务服务。') + empty('先加入你的企业', '使用企业邀请对应的邮箱登录，并在成员页面接受邀请。', link('查看企业邀请', 'members', true), 'users');
    return head('业务工作台', '选择要处理的业务。使用当前账号操作，无需创建或粘贴 API Key。', link('我的报价记录', 'quote-history', false, 'clock')) + `<div class="workbench-tasks">${[['quote', 'truck', '加拿大尾程询价', '整理客户需求，核对邮编与货物信息，查看试算并保存报价记录。', '开始询价'], ['customs', 'file', '关税与商品归类', '输入商品描述和属性，查询三国税则、适用措施及来源。', '查询关税'], ['tax', 'grid', '进口税费估算', '按归类、原产地和申报金额估算税费，支持批量资料。', '估算税费']].map(([target, glyph, title, description, action]) => `<section class="workbench-task"><span class="cap-icon blue">${icon(glyph)}</span><h2>${title}</h2><p>${description}</p>${link(action, target, true, 'arrow')}</section>`).join('')}</div>${panel('连接你的系统或 Agent', '', `<div class="workbench-api"><p>同一把 API Key 使用已开通的服务，凭证与权限在控制台集中管理。</p>${link('前往控制台', 'api-keys')}${link('查看接入指南', 'guide')}</div>`)}`;
  }
  async function action(button) {
    const action = button.dataset.action;
    if (!action?.startsWith('market-')) return false;
    if (action === 'market-copy') { await navigator.clipboard.writeText(agentInstallPrompt(button.dataset.id)); ui.notify('接入指令已复制，可发送给你的 Agent。'); return true; }
    if (action === 'market-protocol' && ['all', 'mcp', 'api'].includes(button.dataset.id)) filters.protocol = button.dataset.id;
    else if (action === 'market-category' && Object.hasOwn(categoryNames, button.dataset.id)) filters.category = button.dataset.id;
    else if (action === 'market-reset') Object.assign(filters, { query: '', protocol: 'all', category: 'all' });
    ui.rerender(); return true;
  }
  function input(event) {
    if (event.target.id !== 'market-search') return false;
    filters.query = event.target.value;
    const target = document.querySelector('#market-results'); if (target) target.innerHTML = results();
    return true;
  }
  return { page, detail, guide, workbench, action, input };
}
