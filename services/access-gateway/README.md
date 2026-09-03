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
- 受管理管理员保护的 `/admin/api/v1/access/overview`，从 SQLite/PostgreSQL 读取固定 24 小时
  五状态计数、最多 20 条脱敏异常和 Agent 接入清单，不返回租户/Client/credential/request hash/JTI；
- PostgreSQL tenant/client/Key/entitlement、幂等、审计和并发限流适配器；
- OCI SDK `instance-principal` 认证、Virtual Vault 确定性版本 pepper 读取、RSA KMS
  非导出 RS256 签名、当前/前一公钥 JWKS 和启动签名自校验；
- SQLite v3 + operations v1 到 PostgreSQL 的显式事务迁移、全表计数、逻辑指纹读回和
  幂等重跑；旧 SQLite 只保留为切换回滚源，不作为 PostgreSQL 运行时 fallback；
- 显式 `synthetic-local-test` fixture 和现有 MCP verifier 互操作测试。

`createProductionAccessGateway` 要求九个 `kind=production` provider 且拒绝 synthetic 或
结构缺失的 provider。这只是启动前的失败闭合组装门，不是真实 provider 的健康
或生产资格证明。

当前 NO-GO 项：目标环境的 Cloudflare Access 应用/MFA 与真实登录回执、OCI Vault/KMS
真实权限和轮换回执、数据库托管资格、集中审计/告警与吊销、Edge denylist、目标负载/告警
演练及三类 Agent staging 读回证据。`single-node-candidate` 默认仍使用文件签名密钥/pepper；
只有显式选择并成功初始化 `oci-vault` 后才移除 KMS readiness blocker。无论选择哪种后端，
进程都固定报告 `production_eligible=false`；PostgreSQL 可用、页面可见或迁移指纹一致都不能
替代剩余门禁。

## OCI Vault 生产加密后端

该后端只允许 Compute 实例主体认证，不读取 OCI 用户 API Key，不导出 JWT 私钥，也不允许
与文件密钥配置混用。启动时先从 KMS Management Endpoint 读取指定 key version 的 RSA 公钥，
再通过 Crypto Endpoint 对固定消息做一次签名并在进程内验签；任何 key/key version/算法或签名
不一致都会失败闭合。pepper 按数据库中实际引用的版本选择器从 Secret Retrieval API 精确读取，
当前版本还必须带 `CURRENT` stage。

必须同时设置：

```text
ACCESS_GATEWAY_CRYPTO_BACKEND=oci-vault
ACCESS_GATEWAY_OCI_AUTH_MODE=instance-principal
ACCESS_GATEWAY_OCI_REGION=<region>
ACCESS_GATEWAY_OCI_KMS_KEY_ID=<RSA signing key OCID>
ACCESS_GATEWAY_OCI_KMS_CURRENT_KEY_VERSION_ID=<current key version OCID>
ACCESS_GATEWAY_OCI_KMS_PREVIOUS_KEY_VERSION_ID=<optional previous version OCID>
ACCESS_GATEWAY_OCI_KMS_CRYPTO_ENDPOINT=<vault crypto endpoint>
ACCESS_GATEWAY_OCI_KMS_MANAGEMENT_ENDPOINT=<vault management endpoint>
ACCESS_GATEWAY_OCI_PEPPER_SECRET_ID=<pepper secret OCID>
```

手工内容 Secret 可令 `ACCESS_GATEWAY_PEPPER_VERSION` 直接等于当前 `versionName`。OCI
自动生成型 Secret 的 `versionName` 为空时，必须使用保留格式
`oci-number-<positive-versionNumber>`，例如 `oci-number-1`；Gateway 会按精确
`versionNumber` 读取，并同时校验返回版本号与 `CURRENT` stage。该前缀不得用作普通命名版本。
数据库中仍引用旧 pepper 时，对应命名版本或数字版本必须继续保留。OCI 侧至少需要一个默认
Virtual Vault、一枚 RSA 2048 位或更强的签名 key，以及一枚用于创建 Secret 的对称加密 key。
不要为本服务创建按小时计费的 Private Vault。

实例动态组应精确匹配部署实例 OCID。应用运行时的最小 IAM 策略模板是：

```text
Allow dynamic-group <gateway-dynamic-group> to use keys in compartment id <compartment-ocid>
  where target.key.id = '<signing-key-ocid>'
Allow dynamic-group <gateway-dynamic-group> to read secret-bundles in compartment id <compartment-ocid>
  where target.secret.id = '<pepper-secret-ocid>'
```

这两条策略只授权签名和读取单个 pepper Secret；创建、更新、轮换或删除 Vault/Key/Secret
仍由独立管理员完成。数据库托管资格、Cloudflare Access 和生产演练是独立门禁，不能因为
OCI 加密后端启动成功而自动通过。

分阶段产品计划见 [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md)。
