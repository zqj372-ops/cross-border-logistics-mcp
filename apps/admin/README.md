# 跨境物流 MCP 控制台原型

这是 08A 的单页控制面原型。它管理客户端接入、角色/工具授权、API-first 来源状态、适配器引用、系统结构、就绪状态、审批差异和审计摘要；它不是报价、关税、Zone 或装柜业务数据库。

前端以中文业务名称和状态为主；Tenant Access 的精确授权选择器会同时显示 canonical MCP
tool name，便于核对实际 entitlement。权限码、配置路径、接口引用、凭证引用、完整凭证、版本号
和追踪号仍只保留在底层契约或脱敏状态中，页面不回显具体值。

## 本地运行

仓库根目录执行：

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

浏览器打开：

```text
http://127.0.0.1:4173/apps/admin/?fixture=1
```

`?fixture=1` 是唯一启用演示数据的方式。演示页面会醒目标出“演示数据 / 未连接正式后台”；草稿差异只在浏览器本地预览，不会持久化。

模块中心的 `?fixture=1` 页面还会显示两个本地演示身份按钮：申请人和审批人。按钮不展示身份凭证；凭证只由模块作用域 API client 在当前页面内短暂使用，不写入浏览器存储、地址栏、页面文本或日志。非 fixture 页面只显示密码身份输入框。

不带 `fixture=1` 时，页面只请求同源：

```text
GET /admin/api/v1/snapshot
```

运行时会为该入口提供只读、中文、脱敏的平台快照；请求失败、返回非 2xx 或快照缺少必需对象/数组时显示 `unavailable`，不会回退到演示数据或默认配置。快照不读取业务正文，也不调用报价、关务或写入接口做探测。

## 模块中心（Batch 2）

`#modules` 是独立的模块控制面视图，同时保留原有总览、Agent 接入、适配器状态、审批与发布、审计日志等只读视图。页面固定提示：`报价、关务与客户数据仍由外部权威系统管理`；本页不复制报价、关务或客户数据，也不把任何运行时状态写成签名或生产资格。

模块中心按“登记制品 → 生成预览 → 双人审批 → 发布读回”展示 release rail，并提供已登记、待审批、当前激活三张状态卡。模块表的开关只修改当前页面内存中的期望草稿；模块检查器、预览差异、逐项校验、发布轨迹和回滚目标均以服务端控制状态为准，并隐藏具体引用与凭证。

登记、预览、审批、发布、读回和回滚按钮只调用同源模块控制面 API。操作成功后必须再次读取并验证服务端控制状态，运行时卡片不会乐观更新；服务端返回 `manual_review`、`blocked` 或 `unavailable` 时保留原状态并显示人工复核/失败闭合提示。回滚也先生成预览，不能直接修改运行时。

## 租户与 API Key（Tenant Access）

`#tenant-access` 是独立的租户接入视图，不依赖旧的业务快照来生成租户或凭证。它只做租户、
客户端 Key metadata 和 T0 内置工具权限配置，不加载模块、不配置报价/关务/Freightcom，也不发起
业务写操作。它只请求固定前缀 `/admin/api/v1/access`：

- `GET /state` 读取租户、机器客户端凭证元数据和最近 operation；列表只显示 `key_prefix` 与 `secret_last_four`，不显示完整 key、salt、哈希或业务数据。
- `POST /tenants` 创建租户；`POST /tenants/{tenant_id}/status` 设置 `active`/`suspended`；`POST /credentials` 签发凭证；`POST /credentials/{credential_id}/acknowledge-delivery` 确认安全交付；`POST /credentials/{credential_id}/rotate` 轮换；`POST /credentials/{credential_id}/revoke` 吊销。
- 签发与轮换按服务端 `available_tools` 选择 canonical `tool_names`。当前 allowlist 只包含
  `cargo.calculate`、`container.plan_summary`、`system.agent_context.get`。页面不提交 broad
  scope；每枚 API Key 的 `tools/list` 只暴露被选择工具。工具授权不代表模块已激活、依赖已
  ready 或已获生产资格。
- active 凭证的“调整功能”不是原地改权限：旧 Key 原子吊销，新 Key 进入 `pending_delivery`，并重新执行一次性显示、安全交付确认和 `operation_id` + `credential_id` + `tool_names` 精确读回。
- 所有请求使用当前页面内存中的 Bearer 身份；POST 自动携带至少 16 个字符的 `Idempotency-Key`，请求不携带 cookie。客户端不接受页面提交的租户归属作为认证依据。
- 写操作只有在随后读取的 `/state.operations` 精确出现同一 `operation_id` 时才显示完成；HTTP 成功或任意状态 GET 不能替代精确读回。按钮只服从服务端 `allowed_actions`，不按页面猜测状态。
- 完整 key 只在签发或轮换成功、并通过响应格式校验后，于当前窗口内存和一次性弹窗中显示。新 Key 先处于 `pending_delivery`；点击“确认已安全保存”且确认 operation 精确读回后才可调用 MCP。未确认就关闭时 Key 无法恢复，必须吊销待交付凭证并重新签发。幂等重放或 `withheld` 响应不会显示 key。
- `?fixture=1` 仅允许本地演示路径尝试写操作；非 fixture 路径固定关闭创建、状态切换、签发、轮换和吊销。正式路径失败、不可用或身份未绑定时保持 `blocked`/`unavailable`/`needs_input`，不会补造数据，也不代表生产资格。

前端不会把身份或完整 key 写入 URL、`localStorage`、`sessionStorage`、cookie、持久化 DOM 模板或日志；输入提交后立即清空。生产客户端不得把长期 API Key 直接交给每个 MCP 实例；必须先由统一凭证网关换短期 JWT，再调用现有生产 JWT 入口。Tenant Access 服务端接口和生产身份/审批能力仍需按 RFC 与对应后端验收结果确认。

## 边界

- AI 报价 API、RiskCustoms API、PDF API 均为外部 API；当前 quote 生产路径保持 unavailable/fail-closed，PDF 未注册；MCP 本地只有 cargo/container 确定性计算。
- 数据源快照可以为业务 API 提供可选字段 `category`、`environment`、`adapter_contract_version`、`business_version_evidence`、`update_mode`、`last_checked_at`、`last_success_at`、`affected_tools`、`registration_status` 和 `blocker`；缺字段显示“未返回”，不会由前端推断。
- 工具快照可提供独立的 `availability`；`kind` 不是可用性，字段未返回时显示“未返回”，不会推断为已就绪。
- `#adapters` 顶部只把 `category=business_api` 的来源渲染为 API 状态卡；fixture 包含 AI 报价 API、RiskCustoms API 和未配置/未注册的 PDF API，knowledge/status/review 仍在普通引用表中。
- 页面只展示接口、凭证和版本证据是否已配置；不展示具体引用值、版本号、原始凭证、客户内容、报价明细或税务材料。
- 一个业务 API 不可达只关闭其 `affected_tools`；只有身份、审计、session 等平台基础设施故障才影响全局 `/readyz`，来源卡不会被汇总为整个 MCP 健康。
- 角色和 Phase 1 工具只按已校验快照中的平台 RBAC 展示；快照缺失时不生成默认权限，不能从页面新增 generic write。
- `#architecture` 只把已校验快照中的 clients、tools、sources 和 `approvals.chain` 画成静态关系：clients → MCP 控制层 → 两类执行 → sources。本地确定性执行明确列出 `cargo.calculate`、`container.plan_summary`；外部 API 窄适配明确关联 quote 与 RiskCustoms；PDF 仅显示未配置/未注册来源，不生成可用工具节点。未知/空/异常 name 仍保留在平台支持/其他工具中。
- 结构图不证明真实网络连通、认证已接通或正式配置生效；tool allowlist、client check、source readiness、approval 状态分别展示，不汇总为“系统健康”或“可发布”。节点详情只显示脱敏字段，`secret_ref` 仅作引用，实际 endpoint、凭证、客户内容和下游响应不显示。
- 真实写操作必须经过 `draft → validate/preview → approval → publish → readback/rollback`；控制台没有写入回退路径，不会把 HTTP 成功或本地草稿伪造成运行时成功。

## 运行安全边界

构建始终校验并复制 `index.html`、`styles.css`、`app.js`、`fixture-data.js` 四个固定资源；这不等于开启控制台。`MCP_ADMIN_UI_ENABLED` 默认关闭；未显式设置为 `true` 时不开放，默认未设置返回 blocked/404，非法值返回 unavailable/503。

运行时静态 `/admin` 路由在 MCP bearer auth 之前，因此当前只接受本机回环访问，并且 `MCP_ADMIN_UI_ENABLED` 默认关闭。多人访问必须先接入批准的企业身份网关/访问控制，再独立实现管理端角色权限、租户绑定和来源校验；不得直接暴露公网。只读快照不返回客户端、租户、用户、接口地址、凭证、审计明细或业务正文，也不提供真实保存、发布或回滚。

## 最小检查

不需要新增 npm 依赖。可运行：

```bash
node --check apps/admin/app.js
node --check apps/admin/fixture-data.js
node apps/admin/self-check.mjs
```

self-check 还会验证前端中文展示边界、技术字段不回显、三业务 API 卡字段、引用隐藏、旧快照缺新字段仍可校验、缺字段不造状态、工具到来源分组、PDF 未注册、原始工具顺序、未知工具保留、空数组不造节点、审批链缺步骤不标记为成功，以及模块控制面状态、发布阶段、fixture 身份可见性、引用脱敏和生产资格 fail-closed 约束。

静态服务器 smoke 应使用明确的 `?fixture=1` URL；运行时不带该参数时读取只读正式快照，读取失败也不会展示演示数据。

可选的本地静态预览：

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

分别打开 `http://127.0.0.1:4173/apps/admin/?fixture=1` 和不带 `fixture=1` 的地址，确认演示标记与 live fail-closed 状态彼此独立。
