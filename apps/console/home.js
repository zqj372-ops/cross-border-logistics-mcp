export function createServiceHome({ icon }) {
  const ribbon = ['box', 'container', 'file', 'truck', 'shield', 'code', 'key'];
  return () => `<section class="portal-home">
    <div class="portal-opening">
      <header class="portal-intro">
        <h1>询运费，<strong>查关税。</strong></h1>
        <p>海运与关务服务，一个入口开始。</p>
        <div class="portal-actions"><a class="button primary" href="/inquiry/">${icon('container')}开始海运询价</a><button class="button" type="button" data-go="customs">${icon('search')}查询关税</button></div>
      </header>
      <div class="service-ribbon" aria-hidden="true"><svg class="ribbon-line" viewBox="0 0 1440 180" preserveAspectRatio="none" fill="none"><path d="M-80 30C240 30 450 150 730 125S1190 0 1520 35"/></svg>${ribbon.map((name) => `<span class="ribbon-node">${icon(name)}</span>`).join('')}</div>
      <div class="portal-services portal-width">
        <a class="portal-service" href="/inquiry/">
          <div class="service-visual ocean-visual" aria-hidden="true"><span class="visual-label">中国 <span>→</span> 加拿大</span><div class="ocean-options"><span>整柜</span><span class="visual-symbol">${icon('container')}</span><span>拼箱</span></div></div>
          <div class="service-copy"><h2>海运询价 ${icon('arrow')}</h2><p>按需选择运输环节，<br>整理货物与服务需求。</p><span class="service-detail">中国到加拿大 · 整柜 / 拼箱</span></div>
        </a>
        <a class="portal-service" href="/console/#customs">
          <div class="service-visual customs-visual" aria-hidden="true"><div class="country-route"><span>CN</span><i></i><span class="visual-symbol">${icon('file')}</span><i></i><span>CA / US</span></div><span class="visual-label">商品归类 / 税则 / 适用措施</span></div>
          <div class="service-copy"><h2>关税查询 ${icon('arrow')}</h2><p>查询中国原产商品，<br>核对税则与来源依据。</p><span class="service-detail public-detail">免登录 · 每天 20 次</span></div>
        </a>
        <a class="portal-service" href="/console/#tax">
          <div class="service-visual tax-visual" aria-hidden="true"><span class="visual-symbol">${icon('file')}</span><div class="tax-inputs"><span>HS 编码</span><span>原产地</span><span>货值</span></div></div>
          <div class="service-copy"><h2>进口税费估算 ${icon('arrow')}</h2><p>已有 HS 编码，<br>继续估算进口税费。</p><span class="service-detail">与关税查询共用访客额度</span></div>
        </a>
        <a class="portal-service" href="/console/#cli">
          <div class="service-visual cli-visual" aria-hidden="true"><div class="mini-terminal"><div><span></span><span></span><span></span></div><code><b>$</b> freightclaw --help</code><span class="terminal-line"></span><span class="terminal-line short"></span></div></div>
          <div class="service-copy"><h2>CLI 命令行 ${icon('arrow')}</h2><p>把常用查询接入脚本，<br>让重复工作更轻松。</p><span class="service-detail">下载安装 · JSON 示例</span></div>
        </a>
      </div>
    </div>
    <div class="portal-width">
      <section class="portal-more" aria-label="更多物流服务"><a href="/console/#market">${icon('grid')}浏览全部服务 ${icon('arrow')}</a><span class="portal-more-divider" aria-hidden="true"></span><button type="button" data-go="quote">${icon('truck')}加拿大尾程询价 <span>登录后使用</span>${icon('arrow')}</button></section>
      <section class="portal-connect" aria-labelledby="connect-heading"><div class="connect-heading"><h2 id="connect-heading">网页之外，也能直接调用。</h2><p>同一把 API Key，连接已开通的服务。</p></div><div class="connect-content"><div class="connect-copy"><div class="connection-options"><span>${icon('code')}API</span><span>${icon('key')}MCP</span><span>${icon('grid')}Agent</span></div><p>从一次在线查询，到日常业务自动化。<br>按你的工作方式接入。</p><a class="button primary" href="/console/#guide">查看接入手册 ${icon('arrow')}</a></div><div class="connect-terminal"><div class="connect-terminal-title"><span>从第一条命令开始</span><a href="/console/#cli">CLI 指南 ${icon('arrow')}</a></div><pre><span># 查看命令与输入说明</span>\nfreightclaw --help\n\n<span># 检查门户连接</span>\nfreightclaw status</pre></div></div></section>
    </div>
    <footer class="portal-footer"><div class="portal-width"><div><a class="footer-brand" href="/console/#home">${icon('box')}FreightClaw</a><p>海运询价 · 关税查询 · 系统接入</p></div><nav aria-label="页脚导航"><a href="/inquiry/">海运询价</a><a href="/console/#customs">关税查询</a><a href="/console/#cli">CLI</a><a href="/console/#guide">操作手册</a></nav></div></footer>
  </section>`;
}
