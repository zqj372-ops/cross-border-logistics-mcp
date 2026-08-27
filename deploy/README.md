# T0 MCP deployment template

这是 `t0-v1` 的单区域候选部署模板，不是已完成的生产部署。服务只在容器网络暴露
`8080`，公网入口必须由企业 TLS/WAF/Edge 提供，并负责受控路由、限流、紧急 denylist
和告警。Compose 不直接发布公网端口。

## 固定生产范围

`MCP_DATA_MODE=production` 与 `MCP_RUNTIME_PROFILE=t0-v1` 必须同时显式提供。该 profile
只注册 3 个工具：

```text
cargo.calculate
container.plan_summary
system.agent_context.get
```

它只发布五个固定 Agent resources，并只装载 `cargo`、`container`、`agent-access` 三个
镜像内静态 T0 模块。正式报价、RiskCustoms/关务、Freightcom、知识/状态、review 和所有
业务写工具在 `t0-v1` 中不注册、不初始化、不读取 secret，也不产生业务出站请求。它们不是
“返回 unavailable 的生产工具”，而是不存在于此 profile 的工具目录。

现有宽 Phase 1、Freightcom 和 Admin module-control 只保留在显式 local/fixture 或后续独立
release 轨道。`deploy/compose.riskcustoms.override.yml.example` 是历史/后续适配器参考，不能
叠加到 `t0-v1` 候选并宣称仍符合本 profile。

## 身份、JWT 与出站

生产 MCP 只接受 `Authorization: Bearer <short-jwt>`。长期 `lmcpk_...` API Key 必须先在
Unified Access Gateway 兑换短期 JWT，不能直接进入 MCP 实例。生产入口使用：

- `MCP_JWKS_URL` 读取 RS256 公钥；
- `MCP_JWT_ISSUER`、`MCP_JWT_AUDIENCE` 和最长 15 分钟策略校验 claims；
- JWT 中服务端签发的 tenant、actor、client、service role、精确 `tool:` scope 和 session；
- `MCP_ALLOWED_OUTBOUND_HOSTS` 只允许 JWKS 主机。T0 Runtime 没有业务 API 出站用途。

JWKS 必须使用 HTTPS，并由部署环境配置实际企业域名。示例中的 `.invalid` 地址只用于
离线 config 检查，不能成为 staging 或 production readback。

## 持久平台状态

`MCP_STATE_DB_PATH=/var/lib/logistics-mcp/platform.sqlite` 保存脱敏的 MCP audit、idempotency
和 session binding。Compose 将 `/var/lib/logistics-mcp` 放入持久 volume，容器根文件系统
保持只读、非 root、无 Linux capabilities。

SQLite 只用于当前单实例 T0 Runtime 的平台状态，不是 Unified Access Gateway 的生产
tenant/client/Key 权威库。多实例、共享 Gateway DB、KMS、IdP 和集中审计仍必须由目标环境
提供并完成独立恢复/故障验证。

## health 与 readiness

- `GET /healthz` 只证明 Node 进程能响应；不用于 Compose 流量门禁。
- `GET /readyz` 聚合 production profile、精确目录、reviewed Agent Pack、JWKS、SQLite
  audit/idempotency/session 和 shutdown 状态。任一全局依赖失败返回非 2xx。
- Compose healthcheck 使用 `/readyz`，使不满足门禁的实例不接收流量。
- fixture mode、fixture token、长期 API Key verifier、缺少 pack/catalog 或目录漂移不能进入
  production ready。
- RiskCustoms `ready=false`、报价接口健康或 Freightcom 测试状态与 T0 Runtime readiness 无关，
  因为这些模块未注册。

## 必填配置

Compose 不为下列 production 设置提供静默默认值：

```text
MCP_DATA_MODE
MCP_RUNTIME_PROFILE
MCP_JWT_ISSUER
MCP_JWT_AUDIENCE
MCP_JWKS_URL
MCP_INSTANCE_ID
MCP_ALLOWED_ORIGINS
MCP_ALLOWED_HOSTS
MCP_ALLOWED_OUTBOUND_HOSTS
MCP_TRUSTED_PROXY_ADDRESSES
```

`MCP_ALLOWED_ORIGINS`、`MCP_ALLOWED_HOSTS` 和可信代理必须精确配置；不得使用 `*`、客户
提交值或默认公网网段。TLS 私钥、JWT、API Key、KMS handle 和数据库凭证不得写入
`deploy/env.example`、Compose、镜像、日志或审计正文。

## 本地静态检查

```bash
docker compose --env-file deploy/env.example -f deploy/compose.yml config
bash deploy/scripts/check-release.sh --fixture-only
```

这些命令不启动容器、不访问真实 URL、不推送镜像，也不证明生产完成。发布候选还必须绑定
当前 Git SHA、镜像 digest、配置版本，并在目标 staging 完成短 JWT、3 工具、5 资源、
tenant 隔离、审计、备份恢复、目标负载、告警和前一镜像回滚演练。

在真实企业 IdP、TLS/Edge、KMS/Secret Manager、Unified Access Gateway、集中吊销和上述
演练没有回执前，状态固定为“待适配验证 / NO-GO”。
