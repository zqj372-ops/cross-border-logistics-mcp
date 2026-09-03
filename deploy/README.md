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

需要评估报价、关务查询和 Freightcom 测试询价时，使用独立的
`read-preview-staging` 档位和
`deploy/compose.read-preview-staging.override.yml.example`。它精确注册 6 个静态模块、
7 个只读工具和同一组 5 个 Agent resources；三个外部能力通过有界协议的独立子进程执行。
该档位固定为 staging-only / NO-GO，不得替代本页的 T0 生产候选。详细资格与读回步骤见
[Read Preview Staging Runbook](../docs/runbooks/read-preview-staging.md)。
四台云服务器的角色、实测链路、最小 ACL、跨架构镜像和回滚边界见
[四节点 MCP 拓扑、带宽与 ACL Runbook](../docs/runbooks/four-node-mcp-topology.md)。

## 身份、JWT 与出站

生产 MCP 只接受 `Authorization: Bearer <short-jwt>`。长期 `lmcpk_...` API Key 必须先在
Unified Access Gateway 兑换短期 JWT，不能直接进入 MCP 实例。生产入口使用：

- `MCP_JWKS_URL` 读取 RS256 公钥；
- `MCP_JWT_ISSUER`、`MCP_JWT_AUDIENCE` 和最长 15 分钟策略校验 claims；
- JWT 中服务端签发的 tenant、actor、client、service role、精确 `tool:` scope 和 session；
- `MCP_ALLOWED_OUTBOUND_HOSTS` 只允许 JWKS 主机。T0 Runtime 没有业务 API 出站用途。

`read-preview-staging` 允许在全局出站白名单中额外列出已审核的 Quote、RiskCustoms 和固定
Freightcom test 主机，但 JWT verifier 自身仍被锁定到从 `MCP_JWKS_URL` 解析出的唯一主机。
扩展工具不在 Unified Access Gateway v1 的长期 Key entitlement 中；当前只能由受控 IdP
直接签发短期 JWT，不能用长期 Key 绕过这一限制。

JWKS 必须使用 HTTPS，并由部署环境配置实际企业域名。示例中的 `.invalid` 地址只用于
离线 config 检查，不能成为 staging 或 production readback。

### Cloudflare Access 管理员入口

`deploy/nginx/www.freightclaw.net.conf` 只从 Cloudflare Access 注入的
`Cf-Access-Jwt-Assertion` 构造管理 API 的 Bearer 身份；没有该断言时，`/admin/`、
`/access-console/` 和 `/admin/api/v1/access/` 均在边缘代理后的 origin 入口失败闭合。
Gateway 仍会校验 RS256 签名、issuer、application audience、时间窗口和管理员映射，
不把“存在 header”当成身份证明。

适配 Cloudflare Access 时必须成组提供：

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

`cloudflare-access` 不依赖宽泛域名或前端隐藏做授权：必须命中显式 email 映射；
配置 subject 时还必须同时命中精确 `sub`。Gateway 拒绝没有用户 email/sub 的
service token，并用脱敏稳定的 `sub` 作为审计 actor。不依赖 JWT 中可被截断的大型
custom group 列表做唯一授权依据。任一核心 IdP 参数、email 映射或密钥健康检查缺失时，
管理 API 保持 `unavailable`。这只闭合了仓库内的身份适配路径；目标环境的 Access 应用、
MFA、角色 owner 和真实登录回执仍是上线门禁。

## 持久平台状态

`MCP_STATE_DB_PATH=/var/lib/logistics-mcp/platform.sqlite` 保存脱敏的 MCP audit、idempotency
和 session binding。Compose 将 `/var/lib/logistics-mcp` 放入持久 volume，容器根文件系统
保持只读、非 root、无 Linux capabilities。

SQLite 只用于当前单实例 T0 Runtime 的平台状态，不是 Unified Access Gateway 的生产
tenant/client/Key 权威库。Gateway 候选必须显式设置
`ACCESS_GATEWAY_STORE_BACKEND=postgresql`，并从只读文件 Secret 读取数据库密码；连接失败、
schema/instance/management tenant 不匹配或迁移指纹漂移时直接失败，不回退到 SQLite。

从现有 Gateway SQLite 切换 PostgreSQL 时，先停止 Gateway 写入并保留原卷，再运行：

```bash
npm run migrate:access-gateway-postgres
```

迁移器只接受私有的 SQLite v3 tenant store 和 operations v1 store，在一个 PostgreSQL 事务中
写入 tenant/client/credential/entitlement、幂等绑定、审计和限流窗口，再用全表计数与规范化
SHA-256 逻辑指纹读回。相同源可以幂等重跑；已存在但不匹配的目标 schema 会失败闭合。
切换与回滚步骤见
[Access Gateway PostgreSQL 切换 Runbook](../docs/runbooks/access-gateway-postgres-cutover.md)。

当前同宿主私有容器网络可以显式使用 `ACCESS_GATEWAY_POSTGRES_SSL_MODE=disable`；任何跨宿主或
托管数据库必须改为 `verify-full` 并挂载获批 CA。自托管 PostgreSQL 仍不等于托管数据库资格，
多实例、KMS、IdP、集中审计/吊销和目标环境恢复/故障验证仍须独立完成。

当前单节点 Gateway 候选会把每个 credential 的 pepper 版本写入受保护的 SQLite 状态，并在
同一持久卷的 `.secrets/credential-pepper-history.json` 中保留对应验证材料。轮换时必须同时更换
pepper bytes 和递增 `ACCESS_GATEWAY_PEPPER_VERSION`；禁止复用版本名，也不得在仍有 credential
引用时删除历史版本。该本地 keyring 只解决候选环境的轮换连续性，不替代 KMS/Secret Manager，
因此不会改变 `production_eligible=false`。

OCI 自动生成型 Secret 没有 `versionName`，此时使用
`ACCESS_GATEWAY_PEPPER_VERSION=oci-number-<positive-versionNumber>` 选择精确版本；命名型
Secret 仍直接使用其 `versionName`。两种形式都会写入 credential 记录，轮换后必须保留仍被
引用的旧版本，并且当前版本仍须带 `CURRENT` stage。

从 v1/v2 SQLite 首次迁移到 v3 时，必须临时显式提供
`ACCESS_GATEWAY_LEGACY_PEPPER_VERSION`，其值必须是旧 credential 实际使用的版本，且对应材料
必须已存在于 keyring。迁移不会用新的 current version 猜测或重新标记旧 hash；任一条件不满足
就拒绝启动。完成迁移、备份和旧 Key exchange 回读后，该迁移参数才可移除。

## health 与 readiness

- `GET /healthz` 只证明 Node 进程能响应；不用于 Compose 流量门禁。
- `GET /readyz` 聚合 production profile、精确目录、reviewed Agent Pack、JWKS、所选 Gateway
  数据库的 audit/idempotency/session 和 shutdown 状态，并显式返回 `database_backend`。任一
  全局依赖失败返回非 2xx。
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

仓库内 smoke/load runner 会创建并随后停用合成 tenant/Key，所以只能在候选 staging 执行。
除原有确认短语外，还必须分别显式设置 `DEPLOYMENT_SMOKE_ENVIRONMENT=staging` 或
`DEPLOYMENT_LOAD_ENVIRONMENT=staging`；runner 会在打开显式配置的 Gateway Store 前回读目标
`/readyz`，只有
`profile=single-node-candidate`、`operational_ready=true` 且 `production_eligible=false` 才继续。

在真实企业 IdP、TLS/Edge、KMS/Secret Manager、Unified Access Gateway、集中吊销和上述
演练没有回执前，状态固定为“待适配验证 / NO-GO”。
