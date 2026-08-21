# RiskCustoms M2M 插件候选版本说明

版本标识：`riskcustoms-m2m-plugin v0.1.0-rc.1`。

这是 MCP 仓库的候选集成版本说明，不是 RiskCustoms 上游服务的发布证明；本仓库的
`package.json` 版本仍为 `0.1.0`。本版本不修改 MCP 工具目录、Schema、响应包络或
外部 RiskCustoms 仓库，不自动启用生产连接。

## 版本目标

将已经实现的 RiskCustoms M2M 窄适配器接入 MCP 生产组合的服务端注入点，同时保持：

- 默认关闭、配置缺失时 `unavailable`/fail-closed；
- 不复制 RiskCustoms 关务规则、税率或来源为 MCP 权威表；
- `ready=false`、`testData=true`、发布身份冲突、来源缺失和上游错误不被 AI 或 fixture 补成成功；
- 客户端不能提交上游 endpoint、token 或跨租户 tenant；
- 外部 endpoint、凭证、tenant mapping、非测试 release 和 staging readiness 仍需独立验收。

## MCP 插件要素

这里的“插件”是 MCP 服务端内的生产 API adapter 注入，不是另一个独立的 MCP server，也
不是要求 ChatGPT/Codex 单独安装的客户端包。

| 要素 | 本版本定义 |
| --- | --- |
| MCP 传输 | 沿用当前 MCP 网关、RS256/JWKS 入站认证、session binding、RBAC、审计和幂等边界；不新增 transport |
| 上游传输 | 仅允许 HTTPS；先 `GET /api/m2m/status?ruleDate=YYYY-MM-DD`，通过状态门后再 `POST /api/m2m/query` |
| 认证注入 | 服务端从 `MCP_RISK_CUSTOMS_AUTH_SECRET_FILE` 引用的 secret 文件读取 M2M token；不接受客户端 token，不写入日志或仓库 |
| tenant 注入 | 从已验证的 `ExecutionContext.tenantId` 发送 `X-Tenant-Id`；客户端不能覆盖；token 与 tenant 的授权映射由 RiskCustoms 上游负责 |
| endpoint 边界 | `MCP_RISK_CUSTOMS_BASE_URL` 必须是 HTTPS；主机必须同时出现在 RiskCustoms 专用白名单和 `MCP_ALLOWED_OUTBOUND_HOSTS` |
| 会话要求 | 沿用 MCP 当前认证 claims、session owner 和 durable session binding；上游不使用浏览器 Cookie、Turnstile 或匿名浏览器状态 |
| 工具范围 | 复用既有 `customs.ca.search`；`system.get_data_status` 继续暴露状态；不新增工具名、不新增写工具 |
| 权限/审批 | `customs.ca.search` 仍是受 `tariff:read` 保护的读操作；本版本不新增写入、审批或发送能力 |
| 资源发现 | 不新增 MCP resource；沿用现有工具目录、Agent Standard Pack 和客户端资源 allowlist |
| 未覆盖能力 | `customs.ca.estimate` 继续 `unavailable`；没有正式税额估算合同就不拼造税额 |
| 失败状态 | 未配置、endpoint 不允许、凭证无效、上游不可达、`ready=false` 或 test data 均保持结构化不可用/阻断/人工复核 |

## 配置契约

默认配置不启用 adapter。只有以下配置同时成立才会注入：

```text
MCP_RISK_CUSTOMS_ENABLED=true
MCP_RISK_CUSTOMS_BASE_URL=https://<approved-riskcustoms-host>
MCP_RISK_CUSTOMS_ALLOWED_HOSTS=<approved-riskcustoms-host>
MCP_ALLOWED_OUTBOUND_HOSTS=<jwks-host>,<approved-riskcustoms-host>
MCP_RISK_CUSTOMS_AUTH_SECRET_FILE=/run/secrets/riskcustoms_m2m_token
```

Compose secret 挂载示例见 [`deploy/compose.riskcustoms.override.yml.example`](../../deploy/compose.riskcustoms.override.yml.example)。
真实 token 文件必须位于仓库外部，并由部署系统挂载；不能把 token 写入 `.env.example`、
Compose 文件、客户端配置或 PR。

## 兼容性与回滚

- 未设置 `MCP_RISK_CUSTOMS_ENABLED=true` 时，现有默认 `RiskCustomsAdapter` 行为不变，
  业务工具保持 disabled/unavailable。
- 本版本没有 Schema、工具名、数据库 migration 或客户端配置 breaking change。
- 回滚时移除 RiskCustoms 专用环境变量/override 并重启 MCP；服务会恢复默认 disabled，
  不删除 SQLite、审计、幂等或 session 数据。
- 是否可以进入 staging/production，仍须通过外部服务的非测试 release、身份映射、
  `/healthz`、`/readyz`、`system.get_data_status` 和实际脱敏工具 readback 验收。

## 本版本证据

本仓库验证的是 MCP 侧的配置工厂、M2M 请求头、主机白名单、status→query 门控和失败闭合。
它不证明真实 RiskCustoms endpoint 已经部署、token 已经生效、tenant mapping 已经发布，
也不证明本地 Docker Compose 已经启动。当前工作区没有执行生产连接或部署操作。
