# 跨境物流 MCP 控制台原型

这是 08A 的单页控制面原型。它管理客户端接入、角色/工具授权、API-first 来源状态、适配器引用、系统结构、就绪状态、审批差异和审计摘要；它不是报价、关税、Zone 或装柜业务数据库。

## 本地运行

仓库根目录执行：

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

浏览器打开：

```text
http://127.0.0.1:4173/apps/admin/?fixture=1
```

`?fixture=1` 是唯一启用演示数据的方式。演示页面会醒目标出“演示数据 / 未连接正式后台”，发布、回滚和保存到服务器按钮保持禁用；草稿差异只在浏览器本地预览，不会持久化。

不带 `fixture=1` 时，页面只请求同源：

```text
GET /admin/api/v1/snapshot
```

请求失败、返回非 2xx 或快照缺少必需对象/数组时显示 `unavailable`，不会回退到演示数据或默认配置。本仓库没有为该入口新增后台接口。

## 边界

- Quote Engine 继续是报价权威源；RiskCustoms 继续是关务权威源；货物、分泡和装柜仍由确定性工具计算。
- 数据源快照可以为业务 API 提供可选字段 `category`、`environment`、`adapter_contract_version`、`business_version_evidence`、`update_mode`、`last_checked_at`、`last_success_at`、`affected_tools`、`registration_status` 和 `blocker`；缺字段显示“未返回”，不会由前端推断。
- `#adapters` 顶部只把 `category=business_api` 的来源渲染为 API 状态卡；fixture 包含 AI 报价 API、RiskCustoms API 和未配置/未注册的 PDF API，knowledge/status/review 仍在普通引用表中。
- 页面只展示 opaque `endpoint_ref`、opaque `secret_ref`、adapter contract version、业务证据和 readiness，不展示原始凭证、客户内容、报价明细或税务材料。
- 一个业务 API 不可达只关闭其 `affected_tools`；只有身份、审计、session 等平台基础设施故障才影响全局 `/readyz`，来源卡不会被汇总为整个 MCP 健康。
- 角色和 Phase 1 工具只按已校验快照中的平台 RBAC 展示；快照缺失时不生成默认权限，不能从页面新增 generic write。
- `#architecture` 只把已校验快照中的 clients、tools、sources 和 `approvals.chain` 画成静态关系：clients → MCP 控制层 → 两类执行 → sources。本地确定性执行明确列出 `cargo.calculate`、`container.plan_summary`；外部 API 窄适配明确关联 quote 与 RiskCustoms；PDF 仅显示未配置/未注册来源，不生成可用工具节点。未知/空/异常 name 仍保留在平台支持/其他工具中。
- 结构图不证明真实网络连通、认证已接通或正式配置生效；tool allowlist、client check、source readiness、approval 状态分别展示，不汇总为“系统健康”或“可发布”。节点详情只显示脱敏字段，`secret_ref` 仅作引用，实际 endpoint、凭证、客户内容和下游响应不显示。
- 真实写操作必须经过 `draft → validate/preview → approval → publish → readback/rollback`；本原型没有正式写 API，因此不伪造成功。

## 运行安全边界

构建始终校验并复制 `index.html`、`styles.css`、`app.js`、`fixture-data.js` 四个固定资源；这不等于开启控制台。`MCP_ADMIN_UI_ENABLED` 默认关闭；未显式设置为 `true` 时不开放，默认未设置返回 blocked/404，非法值返回 unavailable/503。

运行时静态 `/admin` 路由在 `start.ts` 中位于 MCP bearer auth 之前。由于当前只有静态壳和固定 `503/unavailable` 的快照占位，只有在批准的企业身份网关/访问控制之后才能开启 `MCP_ADMIN_UI_ENABLED=true`，不得直接暴露公网。未来接入正式 snapshot/provider 仍必须独立实现 admin RBAC、tenant binding、CSRF/Origin、版本/审批/审计；本原型不新增 header bypass、共享密钥、万能 admin token 或真实保存/发布/回滚。

## 最小检查

不需要新增 npm 依赖。可运行：

```bash
node --check apps/admin/app.js
node --check apps/admin/fixture-data.js
node apps/admin/self-check.mjs
```

self-check 还会验证三业务 API 卡字段、opaque 引用隐藏、旧快照缺新字段仍可校验、缺字段不造状态、工具到来源分组、PDF 未注册、原始工具顺序、未知工具保留、空数组不造节点，以及审批链缺步骤不标记为成功。

静态服务器 smoke 应使用明确的 `?fixture=1` URL；正式模式的预期结果是显示 `正式快照不可用`，而不是展示演示数据。

可选的本地静态预览：

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

分别打开 `http://127.0.0.1:4173/apps/admin/?fixture=1` 和不带 `fixture=1` 的地址，确认演示标记与 live fail-closed 状态彼此独立。
