export function createServiceHome({ icon, link }) {
  return () => `<section class="portal-home">
    <header class="portal-intro"><h1>询运费，<span>查关税。</span></h1><p>从运输需求到进口税费，让每一步更清楚。</p></header>
    <div class="portal-services">
      <article class="ocean-feature">
        <div class="feature-heading"><h2>海运询价</h2><span>整柜 / 拼箱</span></div>
        <p>中国到加拿大，按需安排运输。<br>整理货物与服务需求，获取询价清单。</p>
        <a class="button primary" href="/inquiry/">开始海运询价 ${icon('arrow')}</a>
        <ol class="ocean-journey" aria-label="海运服务环节"><li><span>中国起运</span><small>订舱 · 装柜</small></li><li><span>加拿大到港</span><small>提柜 · 清关</small></li><li><span>送达目的地</span><small>仓储 · 派送</small></li></ol>
      </article>
      <article class="customs-feature">
        <div class="feature-heading"><h2>关税查询</h2><span class="customs-symbol">${icon('file')}</span></div>
        <p>输入商品，查归类、税则和适用措施。<br>中国出口，美国与加拿大进口。</p>
        ${link('查询关税', 'customs', true, 'arrow')}
        <div class="customs-access"><span class="access-dot" aria-hidden="true"></span><span>免登录，每天可查 <strong>20</strong> 次</span></div>
        <div class="customs-secondary"><span>已有 HS 编码？</span><button type="button" data-go="tax">估算进口税费 ${icon('arrow')}</button></div>
      </article>
    </div>
    <section class="portal-tools" aria-label="更多物流工具"><div><h2>更多工具</h2><p>按业务需要，继续下一步。</p></div><button type="button" class="portal-tool" data-go="quote">${icon('truck')}<span><strong>加拿大尾程询价</strong><small>登录后使用</small></span>${icon('arrow')}</button><button type="button" class="portal-tool" data-go="market">${icon('grid')}<span><strong>浏览全部服务</strong><small>货物计算、装柜规划与更多能力</small></span>${icon('arrow')}</button></section>
    <section class="portal-connect"><div><h2>把重复工作交给工具。</h2><p>CLI、API 与 Agent，连接你已有的工作流程。</p></div><div class="connect-terminal"><code><span aria-hidden="true">$ </span>freightclaw --help</code><span>从第一条命令开始</span></div><div class="connect-links"><a href="/console/#cli">CLI 命令行 ${icon('arrow')}</a><a href="/console/#guide">API 与接入手册 ${icon('arrow')}</a></div></section>
    <footer class="portal-footer"><span>FreightClaw</span><span>海运询价 · 关税查询 · 系统接入</span></footer>
  </section>`;
}
