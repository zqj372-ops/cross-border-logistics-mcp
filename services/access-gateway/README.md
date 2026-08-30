# Unified Access Gateway

本目录是长期机器 API Key 换取短期 RS256 JWT 的 provider-neutral 服务内核候选，
不是已可部署的生产 Gateway。MCP Runtime 本身不接受长期 Key，只复用现有
Bearer JWT/JWKS 验证入口。

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
- PostgreSQL tenant/client/Key/entitlement、幂等、审计和并发限流适配器；
- SQLite v3 + operations v1 到 PostgreSQL 的显式事务迁移、全表计数、逻辑指纹读回和
  幂等重跑；旧 SQLite 只保留为切换回滚源，不作为 PostgreSQL 运行时 fallback；
- 显式 `synthetic-local-test` fixture 和现有 MCP verifier 互操作测试。

`createProductionAccessGateway` 要求九个 `kind=production` provider 且拒绝 synthetic 或
结构缺失的 provider。这只是启动前的失败闭合组装门，不是真实 provider 的健康
或生产资格证明。

当前 NO-GO 项：目标环境的 Cloudflare Access 应用/MFA 与真实登录回执、
非导出 KMS/HSM 签名和 Secret Manager pepper、数据库托管资格、集中审计/告警与
吊销、Edge denylist、目标负载/告警演练及三类 Agent staging 读回证据。
`single-node-candidate` 即使切到 PostgreSQL，仍使用文件签名密钥/pepper，并固定报告
`production_eligible=false`；PostgreSQL 可用、页面可见或迁移指纹一致都不能替代剩余门禁。
