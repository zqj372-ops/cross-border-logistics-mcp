# MCP deployment template

这是 Node 22 网关的非部署模板。服务只在容器网络暴露 `8080`，不通过 Compose
直接发布公网；公网访问必须经过已批准的 HTTPS 反向代理或企业网关，负责 TLS、身份
验证、Origin/Host、限流和 WAF 策略。

## 模式与配置

`MCP_DATA_MODE` 必须显式设置为 `production` 或 `fixtures`。fixture 只能用于隔离的
本地验证；生产组合不会创建 fixture adapter。真实 endpoint、tenant mapping、认证和
RiskCustoms readiness 未核验前，生产 adapter 默认 disabled/fail-closed，结果为
`unavailable` 或 `manual_review`，不能用 fixture 冒充 ready。

Compose 不会为 production、JWT、Origin/Host 或出站 allowlist 配置静默填入示例默认值；
这些变量必须由调用环境显式提供。只有本地只读 config 检查可以使用
`--env-file deploy/env.example`，其中的值全部是假值。

### Quote PDF 可选接线（默认关闭）

`quote.create_pdf` 的 `MCP_QUOTE_PDF_ENABLED` 默认是 `false`。Compose 对以下五项只做
透传，不在 disabled 时强制要求后四项；当它被显式设为 `true` 时，`start.ts` 才会严格校验：

- `MCP_QUOTE_PDF_ENABLED`：只有精确值 `true` 才尝试启用，其他值保持关闭。
- `MCP_QUOTE_PDF_BASE_URL`：必须是 HTTPS、非 loopback，并且主机命中精确 allowlist。
- `MCP_QUOTE_PDF_ALLOWED_HOSTS`：PDF 上游主机精确白名单，不使用模糊匹配。
- `MCP_QUOTE_PDF_TENANT_ID`：单公司服务端租户映射；请求租户仍只来自服务端
  `ExecutionContext`，客户端不得提供或覆盖。
- `MCP_QUOTE_PDF_BEARER_TOKEN`：只从运行时 secret injection 提供；不写入 Git、Compose
  command/label、日志或客户端配置。`deploy/env.example` 保持空值。

适配器固定请求 `/v2/quote-pdfs` 和 `/v2/quote-pdfs/{document_ref}`。base URL 中的 path/query
会被固定请求路径覆盖，合同允许但部署建议只填写 origin 形式。应用只做 URL/主机检查；不虚构
DNS pinning，解析后目的 IP 的 allow/deny 与 rebinding 防护交给 egress proxy/firewall。
配置不完整或结构无效时启动就绪失败，工具返回 `unavailable` 且不发起 Quote/PDF 请求；
disabled 的可选来源不拖垮全局 readiness。

启用前必须在隔离 staging 完成：Quote preview → PDF POST `201/200` → 同 key replay
（如需要）→ GET exact readback，并验证 `sendable=false`、同租户、跨租户零请求、当前
admin 只显示中文不可用/待验证状态。没有这些证据不得把 `MCP_QUOTE_PDF_ENABLED` 改为 `true`。

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
- `GET /readyz` 只反映身份、SQLite 和生产组合的全局可用性。报价、报价单、关务等未启用的
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
