# Tenant 与 API Key 本地演示 Runbook

## 适用范围

本 runbook 只用于 loopback fixture。它会真实写入独立的 Tenant Access SQLite store，创建租户、
签发带有效期的机器凭证、确认一次性交付，并让已确认凭证调用同一 MCP Gateway；它不会连接
生产数据库、生产身份平台或外部业务系统，也不代表已经获得生产资格。

生产环境继续使用企业 IdP/JWKS 签发的短期 JWT。长期 API Key 不能直接长期访问每个 MCP
实例；正式路径必须由统一凭证网关校验 Key，经 TLS 网关、KMS/Secret Manager、限流、审计和
集中吊销后换取短期 JWT，再调用现有 MCP 生产 JWT 入口。Tenant Access 的生产管理 POST 和
MCP 实例内 API Key 验证器均为代码级关闭。

## 初始化并启动

新 checkout 依次执行：

```bash
npm ci
npm run init:control-fixture
npm run start:fixture
```

`init:control-fixture` 会显式创建三个互不混用的状态目录：

```text
.runtime/mcp-instance-state/   模块控制面
.runtime/mcp-tenant-access/    租户与客户端凭证
.runtime/mcp-plugin-config/    内置插件配置与发布读回
```

startup 不会隐式创建、替换或修复它们。如果 checkout 已经存在旧的 control state，但尚未建立
Tenant Access state 或 Plugin Config state，分别只运行一次缺少的 initializer：

```bash
npm run init:tenant-access-fixture
npm run init:plugin-config-fixture
```

初始化命令不是 reset 命令；状态已经存在时会失败，不会覆盖或删除已有数据。

## 在页面中使用

1. 打开 `http://127.0.0.1:8080/admin/?fixture=1#tenant-access`。
2. 点击“本地演示申请人”或“本地演示审批人”绑定当前页面内存身份。
3. 创建租户。租户只拥有 MCP 接入身份元数据，不会建立客户、订单、报价或关务主数据。
4. 选择启用租户，填写客户端标识和名称，从“可调用插件功能”中按工具名精确选择，并设置
   1/7/30 天有效期。可选工具仅限 `cargo.calculate`、`container.plan_summary`、
   `system.agent_context.get`；正式报价、关务、Freightcom 和业务写操作不开放。
5. 点击“签发并显示一次”。完整 key 只在一次性弹窗显示；立即复制到调用方的安全 secret
   管理位置。此时凭证是 `pending_delivery`，调用 MCP 必须失败。
6. 确认接收方已经安全保存后，点击“确认已安全保存”。页面会提交独立交付确认，并且只有在
   `/state.operations` 精确读回同一 `operation_id` 后才显示完成；凭证随后变为 `active`。
7. 如果未保存就关闭弹窗或刷新，完整 key 不能恢复；该凭证仍不可调用，也不能轮换。先吊销
   待交付凭证，再重新签发。
8. 需要调整功能时，在 active 凭证上点击“调整功能”，勾选替换后的完整工具集合，再点击
   “调整功能并轮换”。服务端会原子吊销旧凭证、生成工具清单精确匹配的新
   `pending_delivery` 凭证，并重新要求安全交付确认。需要停止全部调用时，可暂停整个租户或
   只吊销指定凭证。

页面和状态接口只显示 `key_prefix`、`secret_last_four`、`tool_names`、有效期、`delivery_status`、
`effective_status`、服务端 `allowed_actions` 与最近 operation；不会返回完整 key、salt 或派生
hash。完整 key 不应放入 URL、聊天、工单、日志、Git、浏览器 storage 或截图。

操作状态轨道固定为：输入与权限校验 → 服务端事务落库 → `operation_id` 精确读回 → 一次性 Key
安全交付。HTTP 200、对象数量变化或任意一次成功 GET 都不能替代同一 operation 的精确读回。

## Loopback fixture Agent 调用方式

只有本地页面完成“确认已安全保存”后，才在 loopback fixture 诊断路径中把一次性 key 作为
MCP Streamable HTTP 的 Bearer 凭证：

```http
Authorization: Bearer lmcpk_<credential_id>_<one-time-secret>
```

客户端不提交 `tenant_id`。本地 Gateway 验证 key 后，从服务端记录生成固定声明：

- `tenant_id`：签发时绑定的租户；
- `actor_role` / `roles`：固定为 `service`；
- `client_id`：签发时绑定的机器客户端；
- `scopes`：服务端根据 `tool_names` 生成的 `tool:<canonical-name>` exact scope，调用方不能提交；
- `expires_at`：凭证自身到期时间。

可配置的插件功能仅包括：

```text
cargo.calculate
container.plan_summary
system.agent_context.get
```

不能签发 `platform:admin`、`tenant:admin`、任意 scope、未知工具或写工具。API Key 的
`tools/list` 只返回所选工具；工具调用仍由现有 RBAC、模块激活、依赖 ready、Schema、session
绑定、审计和跨租户检查共同约束。

## 生产 Agent 调用方式

生产客户端不把 `lmcpk_...` 直接交给每个 MCP 实例。固定流程为：

```text
API Key -> 统一凭证网关 -> 短期 JWT -> MCP /mcp
```

凭证网关负责企业 IdP/TLS 入口、Key 哈希与 pepper/KMS 校验、租户/客户端/工具 entitlement、
限流、审计和集中吊销。MCP 生产实例只接受网关或企业身份平台签发的短期 JWT；JWT 中的
tenant、actor、client、role、scope 和过期时间仍由服务端签发，客户端不能提交或覆盖。

单区域上线前必须完成备份恢复、负载、告警和回滚演练；未完成前只能使用本 runbook 的
loopback fixture 证明状态机，不得声明生产可用。

## 失败处理

- 同一个签发/轮换幂等键重放：返回 `manual_review` 和 `withheld`，不恢复完整 key；若原 Key 未
  确认交付，吊销后重新签发。
- Key 在交付确认前丢失：不能找回，也不能轮换；吊销待交付凭证后重新签发。
- 已确认 Key 丢失或需要替换：轮换后更新调用方 secret，并再次完成交付确认。
- 写响应成功但 `/state` 没有同一 `operation_id`、新 `credential_id` 或相同 `tool_names`：保持
  `manual_review`，不要把对象状态人工改成成功，也不要确认交付。
- 租户暂停、凭证吊销或到期：外部统一返回认证失败，不泄露具体原因。
- Tenant Access state 缺失：固定管理员 token 和旧 fixture MCP 路径仍可启动，但租户管理与 Key
  认证保持不可用；运行显式 initializer 后重启。
- Plugin Config state 缺失：runtime 在监听前失败闭合；运行显式 Plugin Config initializer 后再启动，
  不得以默认值或内存状态绕过持久化配置读回。
- state marker、身份、权限或 schema 漂移：startup fail closed；不要手工编辑 SQLite/marker，先
  保留证据并按受控迁移或回滚处理。

## 验收

```bash
npx vitest run tests/control-plane/tenant-access-contracts.test.ts tests/control-plane/tenant-access.test.ts tests/platform/context-rbac.test.ts tests/platform/admin-tenant-access-api.test.ts tests/platform/admin-tenant-access-ui.test.ts tests/e2e/tenant-api-key-runtime.test.ts --pool=forks --no-file-parallelism --maxWorkers=1
npm run typecheck
npm run lint
npm run build
git diff --check
```

真实 fixture 端到端测试覆盖：一次性签发、确认前认证失败、交付确认、精确 operation 读回、
幂等重放不泄露、脱敏 state、确认后的 loopback API Key 完成 MCP initialize、`tools/list` 只返回精确
授权工具、未授权工具不可调用、吊销后新连接认证失败。
