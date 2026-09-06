# RFC：API 统一工作台人员与接入闭环 v1

- 状态：accepted for provider-neutral implementation and isolated local verification；生产启用仍需真实 provider 和目标环境证据。
- 接受依据：用户已确认 11–14 号产品规划及跨原服务独立分支改造，并明确“开始执行交付”。本文件由本次根代理作为基线维护者记录实现边界；不要求再次批准相同范围。
- 日期：2026-09-05。
- 版本：`portal@2026-09-05.v1`。
- 产品依据：[PRD](../product/2026-09-05-mcp-product-redesign/11-api-native-platform-prd.md)、[页面](../product/2026-09-05-mcp-product-redesign/12-api-platform-pages.md)、[验收](../product/2026-09-05-mcp-product-redesign/14-api-platform-delivery.md)。

## 1. 目的与兼容性

增加真正通过服务器 API 执行的人员、企业、应用申请与精确授权闭环。门户不再把业务网页链接当作集成，不向客户开放现有 loopback Admin API。报价与 RiskCustoms 接入按后续业务切片逐项实现和验证。

现有 Access Gateway `POST /access/v1/token/exchange`、T0 三工具、MCP 五状态、原 Key 格式与哈希/一次性交付合同保持兼容。新增人员角色不进入旧机器 JWT。旧 client/credential 不推断负责人，也不自动获得新业务能力。

## 2. 本次新增所有权

| 责任 | 可写范围 |
| --- | --- |
| 基线 / 根代理 | 本 RFC、产品与实施记录、`apps/console/**`、构建与启动集成、端到端验证 |
| 人员与申请域 | `services/access-gateway/portal/contracts.ts`、`store.ts`、`service.ts`、`schemas/access-gateway/portal-*.schema.json`、对应 portal-domain 测试 |
| 人员会话与 HTTP | `services/access-gateway/portal/{http,identity,session,server}.ts`、对应 portal-http/session/identity 测试 |
| 既有接入复用 | `services/access-gateway/portal/access-bridge.ts`、对应测试；经根代理协调后可对现有 TenantAccessService/repository 添加窄的显式 client 创建 |

这些目录归属扩展本次已授权工作，不能用作通用代理、通用写工具、跨租户查询或静态新模块注册的授权。原服务变更在各自独立工作树中进行，不覆盖原报价当前未提交修改。

## 3. 身份与隔离

人员身份来自受验证 IdP；本地 fixture 可选择明确标注的合成人员，且只在显式 fixtures 模式与严格 loopback Host/Origin 下提供。生产入口不得启用 fixture-login，也不得把缺失 IdP/仓储自动降级成测试用户。

浏览器使用 HttpOnly、SameSite 会话 Cookie 和 CSRF 校验。服务器绑定 user、Membership、tenant、角色、渠道，客户端不能提交 actor/tenant override。切换企业只可选择当前有效 Membership。平台审核身份不能领取客户 Key 或代替业务人员调用。

受信委托到下游时同时保留服务身份与原始操作者；无法验证归属的业务接口保持 blocked/unavailable。不得转发浏览器 Cookie、原站长期 Key 或管理员会话给客户端。

## 4. 对象和生命周期

- User 与 Organization/Membership/Invitation 是新增人员域，独立于机器 client。
- Application 使用现有 client_id，增加负责人、用途、环境和接入方式；必须在领取 Key 前显式创建并读回 client。
- AccessRequest 保存权限快照、版本和审核决定；草稿→提交→补充/批准/拒绝/撤回。申请人不能自审，旧版本审批拒绝。
- Grant 与申请分离；provisioning/active/suspended/revoked/expired 只描述授权。来源连接和实际调用另记证据，不因批准或 Key 签发标为已接通。
- Key 只由获准应用维护者主动领取；审核页面不创建 Key。复用原 TenantAccessService、CredentialRepository、Gateway、轮换/吊销/交付确认，不复制密码算法或 Key 权威表。
- Grant 失效/缩权必须约束新 Web 请求与新换票。已签短 JWT 按当前撤销/到期策略收敛；保留 Key 元数据不会保留旧权限。
- 最后 owner 不能移除；应用唯一负责人先移交或暂停。邀请单次、限时、绑定身份与企业，重发失效旧邀请。

## 5. HTTP 与 Schema

客户静态页面位于 `/console/`，人员 API 位于 `/console/api/v1/`；未知 API 路径返回结构化错误，不回退 HTML。GET session/state 提供身份与有界权限内投影；写操作使用专用资源路由、闭合 JSON、`Idempotency-Key`、版本和 CSRF。禁止任意 operation/URL proxy。

实施合同由 `portal/contracts.ts` 和对应 Draft 2020-12 Schema 精确定义。所有状态响应保持五状态及 request/operation 引用，必要的人员资料只返回给获准主体；日志仅保留脱敏 ID、动作和结果。

旧管理签发示意：

```json
{"tenant_id":"tenant_example","client_id":"client_example","tool_names":["cargo.calculate"],"label":"旧管理操作","expires_in_seconds":86400}
```

门户人员操作示意（路由绑定已受权的应用，组织和 actor 从会话注入）：

```json
{"label":"ERP 接入","tool_names":["cargo.calculate"],"expires_in_seconds":86400}
```

旧请求不改语义。新请求不得直接传给旧管理 HTTP；bridge 必须重新检查当前人员、企业、应用、环境与 grant，并只调用窄领域服务。具体请求字段以随后冻结的 Schema 为准，未知字段拒绝。

## 6. 首条端到端验证

以既有三项 T0 能力验证平台接入，其他能力在目录中明确待适配，不能通过页面标为正式可用。人员/机器分别通过同源业务 API 与严格 Bearer 验证执行共同确定性计算。REST 消费已有 MCP audience 的兼容行为只限明确本地验证入口；生产 REST 需独立 audience/版本化合同，不能宽松接受管理或任意 token。

本地运行采用真实持久化、真实 Key 签发/交付/换票/验证、真实确定性计算，但合成身份、测试租户与示例规则必须清楚标注。该证据不替代生产 IdP、数据库、签名、来源数据和运行验证。

本地验收的固定机器入口为 `POST /api/fixture/v1/tools/cargo.calculate`、`container.plan_summary` 和 `system.agent_context.get`（后两项使用同一路径前缀）；请求为闭合对象 `{ "input": <原工具输入> }`，输出原工具五状态包络。使用 Bearer 短期 Token，拒绝 Cookie、非 loopback、错误 Host、未知工具、超限请求和越权。换票复用原 `/access/v1/token/exchange`，通过 bridge 在验密之后、签名前检查当前 Grant。此入口的构造和挂载在 production 模式均被拒绝，不是正式 REST 发布合同。

人员状态提供未选企业的最小 onboarding 投影。平台审核及开通使用独立 `/console/api/v1/platform-state`、`review-queue`、`provisioning-queue`；操作者只取得审核用途、对象名称、版本、权限和状态，不获取客户凭证。普通成员只取得当前组织的业务数组。操作编号的幂等作用域包含原始人员、组织、动作、目标和版本。

## 7. 测试、迁移和回滚

先运行负例再实现：跨企业、自审、旧版本、最后 owner、重复邀请、未知写结果、Key 泄露/回显、待交付换票、grant 暂停/缩权、Cookie/Token 混用、Host/Origin/CSRF、API 404 与生产缺 provider。

新增用户/申请元数据可迁移，不改报价/关税权威表。所有写返回前读回，重复写复用幂等结果；secret 重放只返回 withheld，不恢复明文。持久层不可用时停止写入，不回退内存成功。

验证命令以实际文件名维护：`npx vitest run tests/access-gateway/portal-*.test.ts`、相关旧 Gateway/TenantAccess 回归、`npm run typecheck`、`npm run validate:schemas`、`npm run validate:agent-standards`、`npm run build:agent-pack`、`npm run build`、`git diff --check`。浏览器验证桌面/手机、成员→应用→申请→审批→交付→调用→撤销以及异常恢复。

回滚只停用新门户/新授权入口或回退构建；保留原 T0 接口、原系统记录、审计和凭证元数据，不能复活撤销的 Key、丢弃未知操作或自动重放业务写入。

## 已接受的企业准入补充

平台operator使用独立组织服务创建tenant并读回后记录企业和首位owner邀请。首位owner必须通过已验证匹配邮箱领取；operator不自动成为企业成员。双状态分别显示organization与tenant接入，失配为reconciliation_required。启用/暂停使用expected_status与固定reason code（operational_pause、customer_request、security_review、resume_verified），无自由客户正文审计。恢复企业不恢复已撤销grant。`GET /console/api/v1/my-organizations` 只返回当前已验证身份的成员企业摘要、本人membership与本人可领取邀请，用于跨企业选择；不返回其他企业业务对象。
