# RFC：Access Operations Overview v1

- 日期：2026-08-30
- 状态：accepted for implementation by the user's 2026-08-30 instruction to plan and begin the missing product capabilities
- 所有权：07 接入网关
- 影响目录：`services/access-gateway/**`、`apps/access-console/**`、`schemas/access-gateway/**`、`tests/access-gateway/**`
- 不改变：MCP 工具目录、三个 T0 工具合同、租户/API Key 写合同、业务数据权威、生产资格判定

## 1. 产品问题

现有 Access Console 可以真实管理租户、Client、Key 和精确工具权限，也能读回状态流转；但管理员
看不到当前可用对象数量、最近 24 小时五状态分布、最近失败引用和 Agent 接入路径。运营人员只能
逐条翻状态或直接查询数据库，无法在不接触凭证和客户数据的情况下判断系统是否可用。

本 RFC 只补一个只读运营纵向切片。它不引入新的业务工具、不开放报价/关务/订舱、不安装任意
插件，也不把审计库变成业务主库。

## 2. 决策

新增管理员只读端点：

```text
GET /admin/api/v1/access/overview
```

成功响应使用 `schema_version=2026-08-30.v1`，并由 Draft 2020-12 closed Schema 约束。响应包含：

- 租户 active/suspended 汇总；
- Client active/disabled 汇总；
- Key 的 active、pending_delivery、tenant_suspended、client_disabled、expired、revoked 汇总；
- 固定 24 小时窗口的五状态审计计数；
- 最多 20 条最近非 success 审计引用，只包含 audit ref、受控 action、status、reason code 和时间；
- 三类 Agent 客户端、短期 JWT 兑换路径、MCP 路径和精确三个 T0 工具名。

端点不得返回 tenant ID、client ID、credential ID、Key 前缀/后四位、request ID/hash、JTI、IP、
原始请求、JWT、email、客户资料或日志正文。控制台只使用 `textContent`/DOM 节点渲染这些受控字段。

## 3. 身份与网络边界

- 复用当前企业管理员 verifier；必须是 management tenant 的 `admin`，并同时具有
  `platform:admin` 与 `tenant:admin`。
- 只允许 loopback 或显式 trusted proxy；trusted proxy 必须提供唯一
  `X-Forwarded-Proto: https`。
- Host 必须命中显式 allowlist；Origin 若存在必须命中 allowlist。
- 拒绝 Cookie、重复 Authorization、query credential 和非 Bearer 认证。
- Cloudflare Access 仍由受控 Nginx 把 `Cf-Access-Jwt-Assertion` 投影为 Bearer；Gateway 必须继续
  独立校验签名、issuer、AUD、时效和管理员映射。

## 4. 存储与一致性

SQLite 与 PostgreSQL 使用同一 `GatewayOperationsReader` 投影：

- 查询固定 `window_started_at` 之后的审计行；
- 按五状态聚合，不计算或输出浮点成功率；
- 最近异常按 `created_at DESC, audit_id DESC` 稳定排序；
- 查询是只读快照，不更新审计、不改变限流窗口；
- 任一损坏行、未知状态或依赖异常使端点返回 `unavailable`，不得返回部分汇总。

## 5. 兼容、迁移与回滚

- 这是新 GET 端点；现有 `2026-08-27.v1` exchange、JWKS、Tenant Access API 均不变。
- PostgreSQL/SQLite 不新增表、不迁移数据，只读取现有 `gateway_audit`。
- Nginx 现有 `/admin/api/v1/access/` 前缀已覆盖该端点，不新增公网匿名路由。
- 回滚时移除该 handler、Console 卡片和两个 v1 Schema；现有租户、Key、兑换、审计和 MCP 调用不受影响。

## 6. 验收

- 未认证请求返回 401，错误体不泄漏身份或依赖细节。
- 非 management admin 返回 403。
- SQLite/PostgreSQL 结果形状一致，固定五状态缺省计数为 0。
- 最近异常不包含 tenant/client/credential/request hash/JTI。
- Console 同时展示运营汇总、生产门禁、最近异常和 Agent 接入清单。
- `npm run test:access-gateway`、Schema 校验、typecheck、lint、build 和敏感信息扫描通过。
