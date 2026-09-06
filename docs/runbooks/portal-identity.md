# Portal 生产 OIDC 身份接入

本 runbook 说明 `/console/` 的人员登录如何接入生产 OIDC provider。它不配置业务 API 的机器凭证，不用管理员会话代替客户 Key，也不把本地 fixture 身份带入生产。

## 当前 Authentik 边界

`deploy/self-hosted-authentik/blueprints/freightclaw-admin.yaml` 当前定义的是保护旧 Access Console 的 Authentik `proxyprovider`。它没有定义 Portal 所需的 OAuth2/OpenID provider、confidential client、精确 redirect URI 或 Portal 群组 claim。因此，该 blueprint 不是 `/console/` 生产 OIDC 已可用的证据。

本轮已通过 `deploy/portal/configure-authentik-portal.py` 配置专用 `freightclaw-portal` OAuth2/OpenID provider/application，issuer 为 `https://www.freightclaw.net/application/o/freightclaw-portal/`，精确 callback 为 `https://www.freightclaw.net/console/auth/callback`。它与上述旧 proxy provider 分开。邮箱流程由 `configure-authentik-cn.py` 配置，QQ SMTP 经用户重新填写后实际认证通过并保存。真实账号已完成密码找回、邮件验证和身份服务登录；工作台回调的 issuer 尾斜杠缺陷已修复并发布。2026-09-05 15:03 UTC 后从工作台新发起的登录成功建立平台管理员会话，刷新后仍有效。未重放旧授权码，未修改人员密码或绕过邮箱验证。

部署方必须维持以下配置：

- Authorization Code flow，强制 PKCE `S256`；
- ID Token 只签发 `RS256`，并通过该 issuer 的 JWKS 发布验签公钥；
- confidential client 使用 `client_secret_basic`；本地公开客户端验证可使用 `none`，但生产默认应使用 confidential client；
- redirect URI 与对外 Console 地址精确一致，形如 `https://console.example.com/console/auth/callback`；
- scopes 包含 `openid email profile`，ID Token 包含稳定 `sub`、`email`、布尔值 `email_verified`、`name` 和可选 `groups`；
- 审核员和运维管理员使用两个明确 Authentik 群组，经配置映射为 `reviewer` 或 `operator`。普通企业用户不映射 platform role。

同一身份若同时命中 reviewer 和 operator 映射，Gateway 拒绝登录，不自动选择更高权限。未验证邮箱也直接拒绝。组织 Membership 仍来自 Portal 自身数据，不从 OIDC 群组自动推导客户企业权限。

## Gateway 配置合同

`createProductionPortalIdentityProvider` 和 `OidcPortalIdentityProvider` 接收以下配置：

| 字段 | 用途 | 生产要求 |
| --- | --- | --- |
| `issuer` | Authentik OIDC issuer | HTTPS；与 discovery 及 ID Token 的 `iss` 逐字符一致，包括末尾 `/`。仅拼接 discovery URL 时去掉末尾 `/` |
| `clientId` | Portal OIDC client | 必填，不由浏览器提交 |
| `clientSecret` | confidential client secret | 由受控 secret file/provider 解析后注入，不写入仓库、参数、日志或错误响应 |
| `callbackUrl` | OIDC callback | 精确 HTTPS URL，无 userinfo/query/hash |
| `roleClaimMap` | Authentik group 到 platform role | 只允许 `reviewer` / `operator`，未命中时为普通人员 |
| `groupsClaim` | 群组 claim 名 | 默认 `groups`；如果 Authentik mapping 使用其他名称，需显式配置 |
| `timeoutMs` | discovery/token/JWKS 超时 | 默认 5 秒，允许 100 ms–30 s |
| `maxDiscoveryBytes` / `maxTokenBytes` / `maxJwksBytes` | 响应大小上限 | 默认 64 KiB / 64 KiB / 256 KiB |

`allowInsecureLoopback` 只为本地合成测试提供 HTTP loopback，生产组装不得打开。生产启动必须显式提供 OIDC provider，没有 fixture 默认回退。

## 运行时校验

Gateway 对 discovery、token 和 JWKS 请求统一执行：

- 禁止 HTTP redirect，并为每个请求设定超时；
- 只读取 JSON/JWK JSON，先校验 `Content-Length`，再对流式响应执行实际字节上限；
- discovery 返回的 authorization/token/JWKS endpoint 必须与 issuer 同 origin，不跟随可配置或返回内容指向的其他主机；
- discovery 必须显式宣告 `code`、`S256`、`RS256` 和当前 client authentication method；
- callback 同时校验持久化 pending transaction 中的 state、nonce 和 PKCE verifier；
- ID Token 只接受精确 issuer、client audience、`RS256`、单一匹配 `kid`，并校验 `iat`/`exp` 和默认 10 分钟最大 token age；
- 多 audience token 必须带与 client ID 相同的 `azp`。

OIDC pending transaction 和登录后 session 的持久化、过期、一次消费和 Cookie 属性由 Portal session 存储负责。`codeVerifier`、client secret、authorization code 和 ID Token 不得进入普通日志、审计对象或前端状态。

## 本地验证

不连接生产 IdP，使用本地临时 issuer 执行：

```bash
npx vitest run tests/access-gateway/portal-identity.test.ts tests/access-gateway/portal-production-identity.test.ts
npx eslint services/access-gateway/portal/identity.ts services/access-gateway/portal/production-identity.ts tests/access-gateway/portal-identity.test.ts tests/access-gateway/portal-production-identity.test.ts
npm run typecheck -- --pretty false
```

身份适配验收必须在获准目标环境读回 discovery issuer/endpoints/algorithms、JWKS 当前 key ID、redirect URI、群组 claim 和登录后角色，并证明未验证邮箱、群组冲突、错误 audience/nonce/state 均被拒绝。本地测试通过只证明适配器合同。生产装配和真实登录的历史证据见[登录验收](portal-production-acceptance.md)，后续有效企业所有者状态见[2026-09-06 交付](../product/2026-09-05-mcp-product-redesign/17-market-manual-production-delivery.md)；不能仅凭本地测试或文档更新认定当前线上身份配置仍然有效。
