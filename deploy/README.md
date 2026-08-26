# MCP deployment template

这是 Node 22 网关的非部署模板。服务只在容器网络暴露 `8080`，不通过 Compose
直接发布公网；公网访问必须经过已批准的 HTTPS 反向代理或企业网关，负责 TLS、身份
验证、Origin/Host、限流和 WAF 策略。

## 模式与配置

`MCP_DATA_MODE` 必须显式设置为 `production` 或 `fixtures`。fixture 只能用于隔离的
本地验证；生产组合不会创建 fixture adapter。真实 endpoint、tenant mapping、认证和
RiskCustoms readiness 未核验前，生产 adapter 默认 disabled/fail-closed，结果为
`unavailable` 或 `manual_review`，不能用 fixture 冒充 ready。

RiskCustoms 的生产 M2M 适配器只有在服务端同时收到以下配置时才会注入：
`MCP_RISK_CUSTOMS_ENABLED=true`、HTTPS 的 `MCP_RISK_CUSTOMS_BASE_URL`、包含该主机的
`MCP_RISK_CUSTOMS_ALLOWED_HOSTS`、至少一个明确的 `MCP_RISK_CUSTOMS_ALLOWED_TENANTS`，以及
`MCP_RISK_CUSTOMS_AUTH_SECRET_FILE`。该主机还必须同时出现在 `MCP_ALLOWED_OUTBOUND_HOSTS`
中；否则适配器保持 disabled。secret 文件由部署系统挂载到容器，服务端通过拒绝符号链接、
非普通文件和超过 8 KiB 的有界读取按请求获取 token，并发送 `Authorization: Bearer ...`；
token、文件内容和路径不会写入日志、客户端配置或仓库。请求中的 tenant 只取自已认证的
`ExecutionContext.tenantId`，且必须命中本地精确白名单，客户端不能覆盖。

仓库提供 `deploy/compose.riskcustoms.override.yml.example` 作为 secret 文件挂载示例。它要求
部署环境额外提供 `RISK_CUSTOMS_M2M_TOKEN_FILE`，并不包含真实 endpoint、token 或上游
token-to-tenant mapping。本地 tenant allowlist 只是额外收窄调用范围，不替代 RiskCustoms
上游授权。外部服务必须先由其自身发布已批准的非测试 M2M contract；本仓库的本地测试只能
证明 MCP 适配、fail-closed 和请求头映射，不能证明外部部署已上线。

Compose 不会为 production、JWT、Origin/Host 或出站 allowlist 配置静默填入示例默认值；
这些变量必须由调用环境显式提供。只有本地只读 config 检查可以使用
`--env-file deploy/env.example`，其中的值全部是假值。

生产入口使用 `MCP_JWKS_URL` 的 RS256 公钥验证 JWT，再按
`MCP_JWT_ISSUER` 和 `MCP_JWT_AUDIENCE` 校验短时 token。JWKS 必须是 HTTPS，
且主机必须在 `MCP_ALLOWED_OUTBOUND_HOSTS` 中；签名、issuer、audience、时效或租户
claims 任一失败都拒绝请求。

生产组合还必须由调用方显式提供带 durable marker 和 health/close lifecycle 的审计仓库、幂等仓库、
session binding store，以及带 health lifecycle 的 token verifier 和 production adapter source。
这三项持久数据由 `MCP_STATE_DB_PATH` 指定的 SQLite WAL 文件提供；Compose 将其
挂载在 `/var/lib/logistics-mcp`。`MCP_INSTANCE_ID` 用于会话粘性所有者绑定。缺少任一依赖时
`/readyz` 返回 `503/not_ready`，`/mcp` 返回 `503/unavailable`，不会回退到内存存储。

## health 与 readiness

- `GET /healthz` 只证明 Node 进程能响应，不代表适配器、数据发布或写端点可用。
- `GET /readyz` 只反映身份、SQLite 和生产组合的全局可用性。报价、关务等未启用的
  业务 API 按工具返回 `unavailable`，不阻断本地 `cargo`/`container`；RiskCustoms
  `ready=false` 绝不能被映射成工具成功。
- SDK server/transport 只存在当前进程；SQLite 仅保存脱敏 session binding metadata。
  请求命中其他 `MCP_INSTANCE_ID` 时失败闭合，部署层必须保持会话粘性。
- `/mcp` 只通过前置 HTTPS 边界访问；容器不会暴露数据库、SSH 或用户凭证。

## 本地静态检查

```bash
docker compose --env-file deploy/env.example -f deploy/compose.yml config
bash deploy/scripts/check-release.sh --fixture-only
```

这两个命令只做配置/隔离验证，不启动容器、不推送镜像、不访问真实 URL。示例中的
issuer、JWKS 和 host 都是假值；部署管理员必须改为已批准的企业身份源。
`MCP_TRUSTED_PROXY_ADDRESSES` 中的文档示例地址也必须替换为实际 TLS
反向代理的 IP 或 CIDR；不要把任意客户网段加入信任列表。
