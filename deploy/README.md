# MCP deployment template

这是 Node 22 网关的非部署模板。服务只在容器网络暴露 `8080`，不通过 Compose
直接发布公网；公网访问必须经过已批准的 HTTPS 反向代理或企业网关，负责 TLS、身份
验证、Origin/Host、限流和 WAF 策略。

## 模式与配置

`MCP_DATA_MODE` 必须显式设置为 `production` 或 `fixtures`。fixture 只能用于隔离的
本地验证；生产组合不会创建 fixture adapter。真实 endpoint、tenant mapping、认证和
RiskCustoms readiness 未核验前，生产 adapter 默认 disabled/fail-closed，结果为
`unavailable` 或 `manual_review`，不能用 fixture 冒充 ready。

当前交付没有内置 JWT 签名验证器。`start.ts` 会从 `MCP_JWT_ISSUER` 和
`MCP_JWT_AUDIENCE` 接线短时 claims policy，但签名验证必须由批准的前置身份网关注入；
当前生产 authenticate 仍故意 fail-closed。因此进程可以运行并回答 `/healthz`，但生产
`/mcp` 请求在验证器接入前会被拒绝，不能视为已配置认证或可用生产服务。

## health 与 readiness

- `GET /healthz` 只证明 Node 进程能响应，不代表适配器、数据发布或写端点可用。
- `GET /readyz` 反映配置和适配器发布状态。当前生产适配器仍 disabled，故 readiness
  必须是 `503`/`not_ready`，直到有经批准的 staging evidence；RiskCustoms
  `ready=false` 绝不能被映射成 ready。
- `/mcp` 只通过前置 HTTPS 边界访问；容器不会暴露数据库、SSH 或用户凭证。

## 本地静态检查

```bash
docker compose -f deploy/compose.yml config
bash deploy/scripts/check-release.sh --fixture-only
```

这两个命令只做配置/隔离验证，不启动容器、不推送镜像、不访问真实 URL。示例中的
issuer、host、tenant、client 和 token 都是假值，`CHANGE_ME_IN_SECRET_STORE` 必须由
部署管理员在 secret store 中替换。
