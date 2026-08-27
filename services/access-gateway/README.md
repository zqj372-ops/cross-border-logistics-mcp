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
- 显式 `synthetic-local-test` fixture 和现有 MCP verifier 互操作测试。

`createProductionAccessGateway` 要求九个 `kind=production` provider 且拒绝 synthetic 或
结构缺失的 provider。这只是启动前的失败闭合组装门，不是真实 provider 的健康
或生产资格证明。

当前 NO-GO 项：目标环境的 Cloudflare Access 应用/MFA 与真实登录回执、
非导出 KMS/HSM 签名和 Secret Manager pepper、托管事务数据库、共享限流、集中审计/告警与
吊销、Edge denylist、备份恢复、负载/告警/回滚演练及 staging 读回证据。
`single-node-candidate` 仍使用本地 SQLite 与文件密钥，固定报告
`production_eligible=false`；不得因为页面、API 或本地测试可用就声明为生产完成。
