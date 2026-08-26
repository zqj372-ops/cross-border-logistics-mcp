# Freightcom 测试 LTL 报价预览 MCP 工具

状态：测试环境候选合同；不具生产资格。

## 变更原因

仓库已有收窄的 Freightcom `POST /rate` → `GET /rate/{request_id}` 适配器和本地询价页面，
但当前主工作区没有正式 MCP Tool 注册。Agent 因此不能通过 `tools/list` 发现或通过
`tools/call` 调用该能力。

本 RFC 新增 `quote.freightcom_ltl.preview`，作为静态可信的 T1 测试报价预览工具。
它不订舱、不保存、不发送、不发布，也不修改任何业务记录。

## 输入合同

版本：`freightcom-ltl-rate-request@2026-08-26.v1`。

输入使用 Draft 2020-12、闭合对象，并包含：

- `schema_version = 2026-08-11.v1`；
- `version = freightcom-ltl-rate-request@2026-08-26.v1`；
- `display_policy = usd_numeric_relabel_test_only`；
- 可选 `services`、`excluded_services`；
- Freightcom `details`，严格限制为 `packaging_type=pallet` 和
  `packaging_properties.pallet_type=ltl`。

Endpoint、环境、Token、tenant、actor 和 Authorization 均不是调用者输入。身份由 MCP
上下文注入，测试 Token 只由服务端 Keychain capability 读取。

本版允许提交已经确认的实体托盘。它不能把内部 `billing_pallets` 静默转换为实体托盘；
自然语言标准化和 `quote.ltl.prepare` 等待 AI 自动报价模块发布正式准备 API 后另行接入。

## 输出合同

版本：`freightcom-ltl-rate-result@2026-08-26.v1`。

完成的 fixture 或 test 响应映射为 `manual_review`，永远不是 `success`，并包含：

- provider、API version、environment 和轮询完成状态；
- 承运商、服务、原始总价和运输时效；
- `sendable=false`、`bookable=false`、`authoritative=false`；
- source refs、assumptions、warnings、blockers 和金额 trace；
- 原始 `total` 保留 Freightcom 源币种；
- `display_total` 使用相同数字和 USD 标签，并明确
  `conversion_method=none_numeric_relabel`；
- `currency_display_policy.conversion_applied=false`。

显示 USD 不表示汇率换算，也不能写回内部报价、财务、草稿或订舱系统。

## 状态映射

| 条件 | MCP 状态 |
| --- | --- |
| 请求字段或 pallet LTL Schema 不合法 | `needs_input` |
| fixture/test 完整响应 | `manual_review` |
| Keychain 凭证缺失或认证拒绝 | `blocked` 或 `unavailable`，不回显凭证 |
| 轮询超时、网络故障、响应 Schema 漂移 | `unavailable` |
| production mode | `unavailable` |
| 客户端注入 Token、URL、tenant 或 actor | `blocked` |

所有非 success 结果必须包含 blocker；任何失败都不能回退到 fixture 假报价。

## 权限、能力和副作用

- permission：`quote:calculate`；
- kind：`read`；
- risk：`T1`；
- capability：`quote.freightcom_ltl.rate_adapter@freightcom-rate-port@2026-08-26.v1`；
- MCP annotation：`readOnlyHint=true`、`idempotentHint=false`、`openWorldHint=true`；
- 网络只允许 `https://customer-external-api.ssd-test.freightcom.com`；
- `POST /rate` 会建立临时 rate lookup，因此尽管不写业务记录，调用仍非幂等。

## 兼容性

这是新增工具，不更改已有工具输入和输出。动态发现工具的客户端会看到一个新增 T1 只读工具；
固定 allowlist 客户端必须显式加入该工具后才能调用。

AI 自动报价模块仍拥有内部 Zone、计费托数和价格权威。Freightcom 测试费率独立展示，不覆盖
内部结果。

## 迁移步骤

1. 加入 provider-specific Zod 合同和 handler；
2. 加入 T1 module 和版本化 capability；
3. 加入 RBAC 及非幂等工具 annotation；
4. fixture composition 注入确定性 adapter；
5. 本地测试 runtime 仅在显式开关下从 Keychain 读取测试 Token；
6. production composition 注入代码级 disabled adapter；
7. 更新 Agent module catalog、运行手册和测试。

## 回归命令

```text
npm test -- --run tests/domains/freightcom-ltl-tool.test.ts
npm test -- --run tests/module-runtime/modules.test.ts
npm test -- --run tests/platform/freightcom-runtime-config.test.ts
npm test -- --run tests/platform/context-rbac.test.ts
npm test -- --run tests/e2e/phase1-tools.test.ts
npm run validate:schemas
npm run validate:agent-standards
npm run typecheck
npm run lint
git diff --check
```

真实测试仅在上述 fixture/Schema/RBAC 测试通过后执行。必须观察 202 submission、受限轮询和
Schema-valid response，并保存脱敏证据；测试成功不等于生产 readiness。

## 回滚

从 composition 移除模块，移除 RBAC policy 和 runtime 测试 capability；现有 Cargo、Container、
AI quote、RiskCustoms 和 JHT 工具保持不变。生产 Freightcom 默认始终禁用。
