# 部署目录

[文档中心](../docs/README.md) / [发布与维护](../docs/guides/maintenance.md)

**先选部署对象。** Portal、MCP T0 和 Gateway 候选有不同的运行与安全边界。

| 对象 | 位置 / 手册 |
| --- | --- |
| 客户、运营与业务 API | `deploy/portal/` · [Business API v2](../docs/runbooks/business-api-v2.md) |
| 个人整柜切换 | [FCL 切换手册](../docs/runbooks/2026-09-21-fcl-production-cutover.md) |
| 人员身份 | [Authentik 候选配置](self-hosted-authentik/README.md) |
| MCP T0 | 本页下方 · [发布](../docs/runbooks/t0-release.md) · [回滚](../docs/runbooks/t0-rollback.md) |
| Gateway 存储 | [PostgreSQL 切换](../docs/runbooks/access-gateway-postgres-cutover.md) |
| CLI | [构建与交付](../docs/runbooks/freightclaw-cli.md) |

历史回执只证明对应日期的发布，不是当前环境探测。Compose 模板也不是上线证据。

## MCP T0：固定范围

必须显式设置 `MCP_DATA_MODE=production` 和 `MCP_RUNTIME_PROFILE=t0-v1`。只注册：

```text
cargo.calculate
container.plan_summary
system.agent_context.get
```

该 profile 只发布五个固定 Agent resources，装载 cargo、container、agent-access 三个镜像内静态模块。报价、关务、Freightcom、知识/状态、review 和业务写工具不注册、不初始化、不读密钥、不出站。其他 release 轨道不能叠加后仍声称属于 T0。

Compose 仅在容器网络暴露 8080，不直接发布公网端口。公网 TLS/WAF/Edge 负责受控路由、限流、紧急 denylist 和告警。历史 RiskCustoms override 不是 T0 配置。

## 身份与网络

MCP 只接受短期 `Authorization: Bearer <jwt>`。长期应用 Key 先经对应 Portal/Gateway 换票，不直接传给 MCP。

| 配置 | 用途 |
| --- | --- |
| MCP_JWKS_URL | HTTPS RS256 公钥来源 |
| MCP_JWT_ISSUER / MCP_JWT_AUDIENCE | 精确 claims 与最长 15 分钟令牌校验 |
| MCP_ALLOWED_OUTBOUND_HOSTS | JWKS 等获准主机 |
| MCP_APPLICATION_AUTHORITY_URL / MCP_APPLICATION_AUTHORITY_ALLOWED_HOSTS | 统一 Key JWT 的当前授权复核，不是业务查询出口 |

tenant、actor、client、role、精确工具 scope 和 session 来自服务端签发。示例 .invalid 域名只用于离线检查，不能作为实际读回证据。

生产配置不得静默默认：

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

Host、Origin、代理必须精确配置，不用通配符或客户输入。TLS 私钥、JWT、API Key、KMS handle 和数据库凭证不得进入示例文件、镜像、日志或审计正文。

## Cloudflare Access 管理路径

对应 Nginx 配置只从 Cf-Access-Jwt-Assertion 构造管理员身份；缺失时 `/admin/`、`/access-console/` 和 `/admin/api/v1/access/` 拒绝访问。Gateway 继续验证签名、issuer、audience、时间和管理员映射，不能只检查 header 存在。

```text
ACCESS_GATEWAY_ADMIN_JWKS_URL=https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
ACCESS_GATEWAY_ADMIN_JWKS_HOST=<team>.cloudflareaccess.com
ACCESS_GATEWAY_ADMIN_ISSUER=https://<team>.cloudflareaccess.com
ACCESS_GATEWAY_ADMIN_AUDIENCE=<exact-application-aud-tag>
ACCESS_GATEWAY_ADMIN_IDENTITY_MODE=cloudflare-access
ACCESS_GATEWAY_ADMIN_ALLOWED_EMAILS=<exact-admin-email>[,<exact-admin-email>]
ACCESS_GATEWAY_ADMIN_ALLOWED_SUBJECTS=<optional-exact-sub>[,<optional-exact-sub>]
ACCESS_GATEWAY_ADMIN_MAX_TOKEN_AGE_SECONDS=900
```

必须匹配精确 email；配置 sub 时两者都匹配。拒绝没有用户 email/sub 的 service token；不依赖可能截断的 group 列表作为唯一授权。缺 IdP 参数、映射或密钥健康检查时不可用。目标 Access 应用、MFA、角色归属和真实登录仍须验收。

## 状态与数据库

MCP_STATE_DB_PATH 通常为 `/var/lib/logistics-mcp/platform.sqlite`，存储脱敏审计、幂等和会话绑定。目录挂持久卷；根文件系统只读、非 root、无 Linux capabilities。

T0 Runtime 的 SQLite 不等于 Gateway 生产凭证权威库。Gateway 候选显式设置 `ACCESS_GATEWAY_STORE_BACKEND=postgresql`，密码来自只读 Secret 文件。连接、schema、instance、management tenant 或迁移指纹不符即失败，不回退 SQLite。

迁移先停写、备份、保留原卷，再按手册执行 `npm run migrate:access-gateway-postgres`。迁移器接受私有 SQLite v3 + operations v1，以事务、全表计数和 SHA-256 逻辑指纹验证；相同源可幂等重跑，目标不符拒绝。

同宿主私有容器网络才可显式 SSL_MODE=disable；跨宿主或托管库必须 verify-full 并挂获批 CA。自托管 PostgreSQL 不代表已完成托管资格或多实例验收。

### Pepper 轮换

单节点候选在受保护状态中记录 credential pepper 版本，并在持久卷 `.secrets/credential-pepper-history.json` 保留验证材料。轮换同时更换 bytes 和递增 ACCESS_GATEWAY_PEPPER_VERSION，禁止复用版本或删除仍被引用的历史材料。

v1/v2 首次迁移 v3 时，显式提供真实旧版本 ACCESS_GATEWAY_LEGACY_PEPPER_VERSION，且 keyring 已有对应材料；不猜测、不重标旧 hash。迁移、备份、旧 Key exchange 读回后才能移除参数。本地 keyring 不替代 KMS/Secret Manager，production_eligible 仍为 false。

## 就绪与发布检查

| 检查 | 能证明什么 |
| --- | --- |
| `/healthz` | Node 进程响应，不作为流量门禁 |
| `/readyz` | profile、目录、Agent Pack、JWKS、数据库审计/幂等/会话及关闭状态；失败返回非 2xx |
| 业务来源查询 | 该来源的状态，不能从 T0 就绪推断 |
| 用户验收 | 实际身份下的业务操作及读回 |

Compose 使用 readyz；fixture token、长期 Key verifier、缺标准包或目录漂移不能进入 production ready。

```bash
docker compose --env-file deploy/env.example -f deploy/compose.yml config
bash deploy/scripts/check-release.sh --fixture-only
```

以上不启动容器、不访问真实 URL、不推送镜像。候选需绑定 Git SHA、镜像 digest 和配置版本，并在获准 staging 验证短 JWT、三工具、五资源、隔离、审计、恢复、负载、告警和回滚。

smoke/load 会创建并停用合成 tenant/Key，只能用于 staging，分别要求 DEPLOYMENT_SMOKE_ENVIRONMENT 或 DEPLOYMENT_LOAD_ENVIRONMENT=staging 及原确认短语。读回需为 single-node-candidate、operational_ready=true、production_eligible=false 才继续。真实 IdP、Edge、KMS、集中吊销等未取得回执前，候选保持 NO-GO。
