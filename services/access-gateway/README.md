# Unified Access Gateway

本目录包含长期机器 API Key 换取短期 RS256 JWT 的 provider-neutral 服务内核、既有窄 Access Gateway，以及 `portal/` 下的企业门户、统一 Key 和业务 REST 服务。MCP Runtime 本身不接受长期 Key，只复用 Bearer JWT/JWKS 验证入口。

2026-09-06 已有 Portal 与 MCP Runtime 的生产发布回执。当前统一 Key、真实企业状态和业务缺口见 [状态台账](../../docs/product/2026-09-05-mcp-product-redesign/18-current-status-and-gaps.md)。下面的 T0 v1/`single-node-candidate` 说明只适用于对应装配模式，不能将其未通过门禁推断为整个 Portal 未实现或未发布。

已实现的仓库边界：

- closed Draft 2020-12 exchange/error/JWKS Schema；
- 三个 T0 工具的精确 entitlement 与 scope；
- 60–900 秒 RS256 JWT，以及当前/前一枚公钥的 JWKS 合同；
- 受信代理、固定 Host/Origin、单一转发客户端 IP 和有界 JSON 请求；
- 未知 Key 的等时假验证、稳定错误面、限流/吊销、成功/失败审计和审计失败闭合；
- 对 signer 返回的 JWT 重新校验 `alg=RS256`、`kid` 和精确 claims，拒绝 provider 漂移；
- Cloudflare Access `Cf-Access-Jwt-Assertion` 的 RS256/issuer/AUD/时效校验，以及
  精确 email 和可选 `sub` 双重管理员映射；
- 可部署的 `single-node-candidate` 进程、窄管理 API、Access Console、
  `/admin/` 标准入口和依赖聚合 readiness；
- 受管理管理员保护的 `/admin/api/v1/access/overview`，从 SQLite/PostgreSQL 读取固定 24 小时
  五状态计数、最多 20 条脱敏异常和 Agent 接入清单，不返回租户/Client/credential/request hash/JTI；
- PostgreSQL tenant/client/Key/entitlement、幂等、审计和并发限流适配器；
- SQLite v3 + operations v1 到 PostgreSQL 的显式事务迁移、全表计数、逻辑指纹读回和
  幂等重跑；旧 SQLite 只保留为切换回滚源，不作为 PostgreSQL 运行时 fallback；
- 显式 `synthetic-local-test` fixture 和现有 MCP verifier 互操作测试。

`createProductionAccessGateway` 要求九个 `kind=production` provider 且拒绝 synthetic 或
结构缺失的 provider。这只是启动前的失败闭合组装门，不是真实 provider 的健康
或生产资格证明。

`single-node-candidate` 模式的 NO-GO 项：目标环境的 Cloudflare Access 应用/MFA 与真实登录回执、
非导出 KMS/HSM 签名和 Secret Manager pepper、数据库托管资格、集中审计/告警与
吊销、Edge denylist、目标负载/告警演练及三类 Agent staging 读回证据。
`single-node-candidate` 即使切到 PostgreSQL，仍使用文件签名密钥/pepper，并固定报告
`production_eligible=false`；PostgreSQL 可用、页面可见或迁移指纹一致都不能替代剩余门禁。

分阶段产品计划见 [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md)。
