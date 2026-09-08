import { marketServices, filterMarketServices, agentInstallPrompt } from './service-catalog.js';
export { marketServices, filterMarketServices, agentInstallPrompt } from './service-catalog.js';

export function createCapabilityMarket(ui) {
  const { esc, icon, link, head, note, empty } = ui;
  const filters = { query: '', protocol: 'all', category: 'all' };
  const categoryNames = { all: '全部分类', quote: '运费询价', customs: '关务与税费', cargo: '货物与装载', ocean: '船期与港口', agent: 'Agent 工具' };
  const protocolName = (item) => item.protocol === 'workspace' ? '网页 · 人员 CLI' : item.protocol === 'mcp' ? 'MCP · REST' : 'REST API';
  const stamp = (item) => `<span class="cap-icon ${item.tone}">${icon(item.icon)}</span>`;
  const copy = (id = '', label = '复制接入指令') => `<button type="button" class="button primary" data-action="market-copy" data-id="${esc(id)}">${icon('code')}${esc(label)}</button>`;
  function installBox(id = '') { return `<div class="install-command"><code>${esc(agentInstallPrompt(id))}</code>${copy(id, '复制指令')}</div>`; }
  const configuring = () => location.hash === '#market/configure';
  function card(item) {
    if(configuring()) return `<button type="button" class="cap-card module-config-card" data-go="configure/${esc(item.id)}"><span class="cap-card-head">${stamp(item)}<span class="protocol-label">${esc(item.configuration.kind ? ui.configurationStatus(item.configuration.kind) : item.configuration.state === 'fixed' ? '无需配置' : '配置待接入')}</span></span><h3>${esc(item.name)}</h3><p>${esc(item.configuration.description)}</p><span class="cap-card-foot"><span>${item.configuration.kind ? '配置模块' : '查看配置说明'}</span>${icon('arrow')}</span></button>`;
    return `<button type="button" class="cap-card" data-go="service/${esc(item.id)}"><span class="cap-card-head">${stamp(item)}<span class="protocol-label">${protocolName(item)}</span></span><h3>${esc(item.name)}</h3><p>${esc(item.description)}</p><span class="cap-card-foot"><span>${esc(item.provider)}</span>${icon('arrow')}</span></button>`;
  }
  function results() {
    const items = filterMarketServices(configuring() ? {...filters,protocol:'all'} : filters);
    if (configuring()) items.sort((a,b)=>Number(Boolean(b.configuration.kind))-Number(Boolean(a.configuration.kind)));
    return `<div class="market-result-heading"><h2>${esc(categoryNames[filters.category] || '全部能力')}</h2><span role="status">${items.length} 项能力</span></div>${items.length ? `<div class="cap-grid">${items.map(card).join('')}</div>` : empty('没有找到相关能力', '试试“邮编”“关税”“货物”，或清除筛选重新查看。', '<button class="button" type="button" data-action="market-reset">清除筛选</button>', 'grid')}`;
  }
  function page(home = false) {
    const intro = home ? `<section class="market-intro"><h1>把物流能力，接入你的工作流。</h1><p>询价、关税、货物计算与装柜规划。在线使用，或交给你的 Agent。</p><div class="hero-install"><span class="install-label">把这句话交给 Agent，开始接入</span>${installBox()}</div></section>` : head('服务市场', configuring() ? '按服务模块维护当前企业配置。' : '找到业务需要的能力，在线使用或接入你的系统。');
    return `${intro}${ui.canConfigure() ? `<nav class="native-tabs market-mode" aria-label="市场视图"><a href="#market" ${!configuring()?'aria-current="page"':''}>使用服务</a><a href="#market/configure" ${configuring()?'aria-current="page"':''}>模块配置</a></nav>` : ''}<section class="market-browser" aria-label="浏览物流能力"><div class="market-toolbar"><div class="market-protocols" ${configuring()?'hidden':''} role="group" aria-label="接入方式">${[['all', '全部能力'], ['mcp', 'MCP'], ['api', '业务 API'], ['workspace','网页 / CLI']].map(([key, title]) => `<button type="button" data-action="market-protocol" data-id="${key}" class="market-tab${filters.protocol === key ? ' selected' : ''}" aria-pressed="${filters.protocol === key}">${title}<span>${filterMarketServices({ protocol: key }).length}</span></button>`).join('')}</div><div class="market-search">${icon('search')}<label class="sr-only" for="market-search">搜索能力</label><input id="market-search" type="search" value="${esc(filters.query)}" placeholder="搜索能力、业务或服务" autocomplete="off"></div></div><div class="market-layout"><nav class="market-categories" aria-label="能力分类">${Object.entries(categoryNames).map(([key, title]) => `<button type="button" class="market-category${filters.category === key ? ' selected' : ''}" data-action="market-category" data-id="${key}" aria-pressed="${filters.category === key}">${esc(title)}</button>`).join('')}<a href="#guide" class="market-help">接入指南 ${icon('arrow')}</a></nav><div id="market-results">${results()}</div></div></section>${configuring()?'':`<div class="market-bottom"><p>业务人员直接使用工作台；系统与 Agent 通过 API Key 接入。</p>${link('打开业务工作台', 'workbench')}</div>`}`;
  }
  function detail(id) {
    const item = marketServices.find((value) => value.id === id);
    if (!item) return empty('未找到这项能力', '返回市场查看当前提供的服务。', link('返回能力市场', 'market'));
    const configured = ui.model().businessCatalog?.find((value) => value.operation === id)?.configured;
    const connection = item.protocol === 'api' && ui.model().session?.organization_id ? note(configured ? '当前企业已配置服务连接，数据可用性与授权在实际调用时核对。' : '当前企业尚未配置此服务连接，可先查看接口说明并申请开通。', configured ? '' : 'warning') : '';
    return `<button type="button" class="back-link" data-go="market">${icon('back')}返回能力市场</button><div class="service-detail-head">${stamp(item)}<div><h1>${esc(item.name)}</h1><p>${esc(item.provider)}<span class="detail-divider">/</span>${protocolName(item)}</p></div></div><div class="service-detail-layout"><div class="service-detail-body"><section><h2>能力介绍</h2><p>${esc(item.detail)}</p>${connection}</section><section><h2>可以获得什么</h2><ul class="output-list">${item.outputs.map((value) => `<li>${icon('check')}<span>${esc(value)}</span></li>`).join('')}</ul></section><section><h2>接口与使用</h2><div class="endpoint-row"><span>POST</span><code>${esc(item.path)}</code></div><p>操作标识 <code>${esc(item.id)}</code>。输入字段与完整响应见接口文档。</p><a class="text-button" href="/console/openapi.json" target="_blank" rel="noopener">查看 OpenAPI 文档</a>${item.protocol === 'workspace' ? '<p>此模块使用已登录人员会话与 CLI 授权。查询 API Key 不授予人员管理权限。</p>' : item.protocol === 'api' ? '<p class="detail-fineprint">当前通过 REST API 提供，Agent 可按接口文档调用。</p>' : '<p class="detail-fineprint">支持 MCP 客户端与 REST 调用。接入指南会说明客户端的令牌配置。</p>'}</section></div><aside class="service-install"><h2>开始使用</h2><p>${item.protocol==='workspace'?'网页与 CLI 共用人员权限。企业数据仅本企业成员可见，管理员在对应模块维护配置。':'关务查询支持每天 20 次访客使用；尾程询价需登录。连接系统时，在个人中心管理 API Key。'}</p>${item.online ? link('在线使用', item.online, true, 'arrow') : link('查看接入指南', 'guide', true, 'code')}${ui.canConfigure() ? link(item.configuration.kind ? '配置模块' : '查看配置说明', `configure/${id}`) : ''}<div class="service-agent"><h3>接入 Agent</h3><p>复制以下指令，发送给你的 Agent。</p><code>${esc(agentInstallPrompt(id))}</code>${copy(id)}</div><div class="service-install-footer">${item.protocol==='workspace'?link('人员 CLI 指南','cli'):link('管理 API Key','api-keys')+link('申请服务',`apply/${id}`)}</div></aside></div>`;
  }
  function guide() {
    return head('接入指南', '一把 API Key，连接应用已开通的物流能力。', link('管理 API Key', 'api-keys', true, 'key')) + `<div class="guide-layout"><div><section class="guide-section"><h2>让 Agent 帮你接入</h2><p>复制这句话给 Codex、Claude Code 或其他能读取网页的 Agent。它会按公开指南配置接口，并帮你完成一次只读调用。</p>${installBox()}<p class="guide-caption">Key 填入你自己的凭证管理工具或本机环境变量，避免放进聊天和代码仓库。</p></section><section class="guide-section"><h2>直接调用 API</h2><p>在控制台申请服务并创建 Key，按接口文档构造请求即可。鉴权、权限校验与服务转发由平台处理。</p><div class="endpoint-row"><span>HTTPS</span><code>https://www.freightclaw.net</code></div><pre class="code-sample">${esc("Authorization: ApiKey ${FREIGHTCLAW_API_KEY}\nContent-Type: application/json")}</pre><div class="guide-links"><a class="button" href="/console/openapi.json" download="freightclaw-openapi.json">下载 OpenAPI</a><a class="button" href="/console/skill.md" target="_blank" rel="noopener">查看 Agent 指南</a></div></section><section class="guide-section"><h2>MCP 客户端</h2><p>货物计算、装柜规划和 Agent 上下文支持 MCP。使用同一 API Key 兑换短期令牌后，配置到支持 HTTP 的 MCP 客户端。</p><div class="endpoint-row"><span>POST</span><code>/access/v2/application/token/exchange</code></div><p class="guide-caption">长期 Key 由接入网关验证。报价和关务目前使用 REST API，Agent 按对应接口调用。</p><details class="guide-advanced"><summary>排查接入问题</summary><p>遇到权限或输入问题时，可使用诊断页查看请求编号和接口返回。</p>${link('打开调用诊断', 'diagnostics')}</details></section></div><aside class="guide-aside"><h3>按返回状态继续处理</h3><dl><dt>已完成</dt><dd>核对本次结果与来源版本。</dd><dt>待补充</dt><dd>补齐接口列出的资料。</dd><dt>需人工复核</dt><dd>将具体事项交给业务负责人。</dd><dt>已阻止</dt><dd>检查 Key、有效期与服务权限。</dd><dt>暂不可用</dt><dd>检查服务连接和数据发布状态。</dd></dl></aside></div>`;
  }
  async function action(button) {
    const action = button.dataset.action;
    if (!action?.startsWith('market-')) return false;
    if (action === 'market-copy') { await navigator.clipboard.writeText(agentInstallPrompt(button.dataset.id)); ui.notify('接入指令已复制，可发送给你的 Agent。'); return true; }
    if (action === 'market-protocol' && ['all', 'mcp', 'api', 'workspace'].includes(button.dataset.id)) filters.protocol = button.dataset.id;
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
  return { page, detail, guide, action, input };
}
