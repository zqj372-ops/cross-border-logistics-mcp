export const cliCommands = Object.freeze([
  { id: 'customs-query', command: 'customs query', label: '关税与商品归类' },
  { id: 'customs-tax', command: 'customs tax', label: '单项进口税费' },
  { id: 'customs-tax-batch', command: 'customs tax-batch', label: '批量税费估算' },
  { id: 'quote-zone', command: 'quote zone', label: '加拿大尾程询价' },
  { id: 'quote-extract', command: 'quote extract', label: '询价资料提取' },
  { id: 'quote-freightcom', command: 'quote freightcom', label: '承运商 LTL 询价' },
  { id: 'cargo', command: 'cargo calculate', label: '货物与计费重计算' },
  { id: 'container', command: 'container plan', label: '装柜容量与摘要' },
  { id: 'agent', command: 'agent context', label: 'Agent 标准上下文' },
]);
export const cliDownload = '/downloads/freightclaw-cli-0.1.0.tgz';
const installCommand = `npm install --global https://www.freightclaw.net${cliDownload}`;

export function createCliGuide(ui) {
  const { esc, icon, link } = ui;
  let selected = cliCommands[0];
  const command = () => `freightclaw ${selected.command} --input ./${selected.id}.json --json`;
  const block = (text, id, label = '复制命令') => `<div class="cli-code"><pre><code>${esc(text)}</code></pre><button type="button" class="button" data-action="cli-copy" data-id="${id}">${esc(label)}</button></div>`;
  function page() {
    return `<div class="cli-page"><div class="cli-intro"><div><p class="entry-eyebrow">FREIGHTCLAW CLI <span>v0.1.0</span></p><h1>把物流能力，<br>带进你的终端。</h1><p>询价、关税、货物计算。使用同一把 API Key，在本机、脚本或 Agent 中调用已开通的服务。</p><div class="entry-actions"><a class="button primary" href="${cliDownload}" download>下载安装包 ${icon('arrow')}</a>${link('管理 API Key', 'api-keys')}</div><p class="cli-requirement">macOS / Windows / Linux · 需要 Node.js 22.13 或更新版本</p></div><div class="cli-terminal" aria-label="命令示例"><div class="cli-terminal-bar"><span>FreightClaw / Terminal</span><span>JSON 输出</span></div><pre><span class="terminal-comment"># 检查连接，无需 Key</span>\n$ freightclaw status\n\n<span class="terminal-comment"># 查看关税查询的输入要求</span>\n$ freightclaw schema customs query\n\n<span class="terminal-comment"># 选择业务，传入 JSON 文件</span>\n$ freightclaw customs query \\\n    --input ./customs-query.json --json</pre><p>命令示例；实际结果以服务返回为准。</p></div></div>
    <div class="cli-body"><article><section class="cli-step"><div class="cli-step-title"><span>1</span><h2>安装并检查连接</h2></div><p>复制下方命令安装，或下载上方安装包后使用 npm 安装本地文件。当前通过本站提供安装包，未发布到公共 npm registry。</p>${block(installCommand, 'install')}${block('freightclaw --version\nfreightclaw status', 'status')}<p class="muted">连接检查只说明门户状态；每次业务调用仍会检查服务授权与来源数据。</p><a class="text-button" href="/downloads/freightclaw-cli-0.1.0.sha256" download>下载安装包校验值</a></section>
    <section class="cli-step"><div class="cli-step-title"><span>2</span><h2>使用已有的 API Key</h2></div><p>由应用负责人在个人中心管理同一把 Key。服务开通后，CLI 直接使用已有 Key。</p><p>将 Key 通过本机凭证工具或 CI secret 注入环境变量 <code>FREIGHTCLAW_API_KEY</code>。也可使用 <code>--key-file</code> 读取已有的私有文件，两种方式选择一种。</p>${link('前往 API Key', 'api-keys')}<details class="cli-detail"><summary>使用私有 Key 文件</summary>${block('freightclaw customs query --input ./customs-query.json --key-file ~/.config/freightclaw/application-key --json', 'keyfile')}<p>macOS / Linux 的文件须归本人所有且无其他用户权限，例如 600；Windows 使用仅本人可读的文件权限。不要把 Key 放进命令参数、聊天或代码仓库。</p></details></section>
    <section class="cli-step"><div class="cli-step-title"><span>3</span><h2>选择命令，准备输入</h2></div><p>下载对应 JSON 示例，替换为自己的货物、日期、地址及来源信息，再执行命令。示例仅展示输入格式。</p><label class="cli-select-label" for="cli-command">要处理的业务</label><select id="cli-command">${cliCommands.map(item => `<option value="${item.id}" ${item.id === selected.id ? 'selected' : ''}>${esc(item.label)} · ${item.command}</option>`).join('')}</select><div id="cli-command-example">${example()}</div><details class="cli-detail"><summary>查看全部九条命令</summary><div class="table-wrap"><table><thead><tr><th scope="col">业务</th><th scope="col">命令</th><th scope="col">输入示例</th></tr></thead><tbody>${cliCommands.map(item => `<tr><td>${item.label}</td><td><code>${item.command}</code></td><td><a href="/downloads/cli-0.1.0/examples/${item.id}.json" download="${item.id}.json">下载 JSON</a></td></tr>`).join('')}</tbody></table></div></details></section>
    <section class="cli-step"><div class="cli-step-title"><span>4</span><h2>按返回结果继续</h2></div><p><code>--json</code> 输出紧凑 JSON，方便脚本读取。HTTP 请求成功不代表业务完成，请同时检查业务状态和退出码。</p><dl class="cli-exits">${[['0', '成功', '核对结果与来源版本'], ['1 / 2', '连接或输入问题', '修正网络、参数、文件或凭证配置'], ['3', '待补充', '补齐缺失资料'], ['4', '需人工复核', '交给业务负责人核对'], ['5', '已阻止', '检查身份和服务权限'], ['6', '暂不可用', '按原因检查服务或来源数据']].map(([exit, title, text]) => `<div><dt><code>${exit}</code> ${title}</dt><dd>${text}</dd></div>`).join('')}</dl></section></article>
    <aside class="cli-aside"><h2>接着了解</h2><a href="https://github.com/zqj372-ops/cross-border-logistics-mcp/blob/main/docs/runbooks/freightclaw-cli-illustrated.md" target="_blank" rel="noopener">图文使用指南 ${icon('arrow')}</a><a href="https://github.com/zqj372-ops/cross-border-logistics-mcp/blob/main/deploy/cli/README.md" target="_blank" rel="noopener">完整命令参考 ${icon('arrow')}</a><a href="/console/openapi.json" target="_blank" rel="noopener">OpenAPI 文档 ${icon('arrow')}</a>${link('操作手册', 'guide')}<div><h3>日常业务继续在线办理</h3><p>个人关务历史、报价保存、审核与文档使用网页登录。</p>${link('打开业务工作台', 'workbench')}</div></aside></div></div>`;
  }
  function example() {
    return `<div class="cli-example-links"><a class="button" href="/downloads/cli-0.1.0/examples/${selected.id}.json" download="${selected.id}.json">下载 ${selected.id}.json</a><span>合成输入示例，使用前请替换</span></div>${block(command(), 'business')}${block(`freightclaw schema ${selected.command}`, 'schema', '复制 Schema 命令')}`;
  }
  function change(event) {
    if (event.target.id !== 'cli-command') return false;
    selected = cliCommands.find(item => item.id === event.target.value) || cliCommands[0];
    document.querySelector('#cli-command-example').innerHTML = example();
    return true;
  }
  async function action(button) {
    if (button.dataset.action !== 'cli-copy') return false;
    const commands = { install: installCommand, status: 'freightclaw --version\nfreightclaw status', business: command(), schema: `freightclaw schema ${selected.command}`, keyfile: 'freightclaw customs query --input ./customs-query.json --key-file ~/.config/freightclaw/application-key --json' };
    if (!Object.hasOwn(commands, button.dataset.id)) return true;
    await navigator.clipboard.writeText(commands[button.dataset.id]);
    ui.notify('命令已复制。');
    return true;
  }
  return { page, action, change };
}
