---
standard_id: credential-exchange-v1
version: 2026-08-27.v1
priority: 93
audience: developer,reviewer,operator,caller
rule_ids: ACCESS-EXCHANGE-001,ACCESS-JWT-001,ACCESS-REVOKE-001,ACCESS-AUDIT-001
---

# RFC：长期 API Key 兑换短期 JWT v1

- 状态：accepted for provider-neutral implementation；真实企业 provider 待适配验证
- 日期：2026-08-27
- 接受依据：用户明确要求按 `2026-08-27-t0-tenant-access-production-service-plan.md` 执行
- 影响范围：`services/access-gateway/**`、`apps/access-console/**`、
  `schemas/access-gateway/**`、`tests/access-gateway/**`、部署和端到端互操作
- 不影响：MCP 工具输入输出、业务权威、现有生产 JWT verifier 的 RS256/claims 边界

## 1. 变更原因

当前 Tenant Access 只在 loopback fixture 中直接验证 `lmcpk_...`，production MCP 只接受
外部短期 JWT。仓库缺少负责长期 Key 校验、精确 entitlement、限流、吊销、审计、JWT
签名和 JWKS 的统一边界。

将长期 Key verifier 直接装进每个 MCP 实例会扩大 secret、吊销和租户状态面，因此新增独立
Unified Access Gateway。MCP Runtime 不感知长期 Key，只复用现有 RS256/JWKS verifier。

## 2. 服务与 provider 边界

Gateway application 负责：

- tenant/client/credential/entitlement 权威服务；
- 长期 Key 一次展示、强哈希、轮换、吊销、暂停和到期；
- token exchange、精确 scope、JWT 签名和 JWKS；
- tenant/client/IP 分层限流；
- 管理操作、exchange 成功/失败和安全事件的持久审计；
- 窄 Access Console API。

生产 provider ports：

```text
AdminIdentityProvider  -> enterprise OIDC/SSO/MFA and role mapping
CredentialRepository   -> managed transactional database
SecretPepperProvider   -> KMS/Secret Manager keyed secret version
JwtSigningProvider     -> non-exportable KMS/HSM asymmetric signer
RateLimitRepository    -> shared atomic counters/policies
RevocationRepository   -> tenant/client/key/jti deny state
AuditRepository        -> durable centralized audit/alert pipeline
Clock/RandomSource     -> injected and testable
```

仓库允许提供 deterministic/local synthetic adapters 做合同测试，但 production profile 缺少任一
真实 provider 必须在监听前失败。不得用 SQLite、进程内 map、环境变量私钥或 fake IdP 作为
生产 fallback。

## 3. Machine token exchange 合同

### 3.1 Endpoint

```text
POST /access/v1/token/exchange
Authorization: ApiKey <lmcpk_...>
Content-Type: application/json
```

只允许 TLS/Edge 转发的固定 Host/Origin 策略和有界请求体。只有精确命中
服务端受信代理地址时才接受单值 `X-Forwarded-Proto=https` 和单一客户端 IP；
拒绝客户端伪造、多跳链或重复转发头。长期 Key 不允许放入 Bearer、URL、cookie、body、
日志、trace、错误或审计正文。

请求是 closed Draft 2020-12 对象：

```json
{
  "schema_version": "2026-08-27.v1",
  "requested_tool_names": [
    "cargo.calculate",
    "container.plan_summary"
  ]
}
```

约束：

- `requested_tool_names` 1–3 个、唯一、排序后规范化；
- 只接受三个 T0 tool name；
- 请求集合必须是 credential entitlement 的子集；
- 客户端不得提交 tenant、actor、role、scope、client、issuer、audience、TTL、session 或 key id；
- exchange 每次签发新 JWT，不使用业务写幂等语义。

成功响应：

```json
{
  "schema_version": "2026-08-27.v1",
  "status": "success",
  "data": {
    "access_token": "<short-jwt>",
    "token_type": "Bearer",
    "expires_in": 300,
    "tool_names": [
      "cargo.calculate",
      "container.plan_summary"
    ],
    "session_ref": "auth_<opaque>",
    "request_id": "req_<opaque>"
  },
  "warnings": [],
  "blockers": []
}
```

`access_token` 是一次响应 secret，不进入 state/readback、日志或审计。`session_ref` 不是 MCP
`Mcp-Session-Id`，只是 JWT 中不可由客户端选择的 `session_id` 脱敏引用。

### 3.2 JWT claims

签名固定 RS256，与现有 verifier 对齐：

```json
{
  "iss": "<configured-gateway-issuer>",
  "aud": "<configured-mcp-audience>",
  "sub": "<credential-id>",
  "iat": 1787760000,
  "exp": 1787760300,
  "jti": "jwt_<opaque>",
  "tenant_id": "<server-owned-tenant>",
  "actor_id": "<credential-id>",
  "actor_role": "service",
  "roles": ["service"],
  "scopes": ["tool:cargo.calculate", "tool:container.plan_summary"],
  "client_id": "<server-owned-client>",
  "session_id": "auth_<opaque>"
}
```

- 目标 TTL 300 秒，配置范围 60–900 秒，硬上限 900 秒；
- `kid` 必须引用当前 active signing key；私钥不可导出；
- scopes 只由请求工具与服务端 entitlement 求交后生成；
- 禁止 `platform:admin`、旧 broad scope、管理角色和非 T0 scope；
- `jti`、`session_id` 每次 exchange 使用 CSPRNG 新生成；
- 时钟偏差默认 30 秒，不能扩大硬 TTL。

### 3.3 JWKS

```text
GET /.well-known/jwks.json
```

只返回 RSA 公钥、`kid`、`alg=RS256`、`use=sig`。轮换至少保持当前 key 和仍可能验证未过期
JWT 的前一 key；删除前一 key 前必须超过最大 TTL、clock skew 和缓存窗口。JWKS 响应有界、
可缓存，不返回私钥、KMS handle、tenant 或内部审计信息。

## 4. Exchange 状态和失败闭合

```text
received
  -> format_verified
  -> credential_verified
  -> tenant_client_active
  -> entitlement_verified
  -> rate_limit_reserved
  -> jwt_signed
  -> audit_committed
  -> issued
```

只有 `audit_committed` 成功后才能返回 token。签名成功但审计事务失败时 token 必须丢弃并返回
`unavailable`；不得把未审计 token 交给调用方。

外部错误面：

| HTTP | envelope status | stable code | 使用场景 |
| --- | --- | --- | --- |
| 400 | `needs_input` | `invalid_request` | Schema、媒体类型、未知工具 |
| 401 | `blocked` | `authentication_failed` | Key 格式/ID/secret/状态统一错误面 |
| 403 | `blocked` | `tool_entitlement_denied` | 已认证但请求工具越界；不返回完整 entitlement |
| 429 | `blocked` | `rate_limited` | tenant/client/IP 策略 |
| 503 | `unavailable` | `access_gateway_unavailable` | KMS/DB/audit/revocation/provider 不健康 |

错误不区分 Key 不存在、secret 错误、待交付、过期、吊销或 tenant 暂停。响应和时延策略避免
成为凭证枚举 oracle。

## 5. 长期 Key、存储和状态

- Key 格式沿用 `lmcpk_<credential_id>_<43-char-base64url-secret>`；
- 只在签发/轮换成功响应显示一次；数据库保存版本化 memory-hard hash、salt、KMS pepper
  version reference、prefix/last-four 和生命周期字段；
- 明文 Key、JWT、私钥、pepper 和完整 claims 不进入数据库普通列、state、日志或审计；
- 状态权威使用 tenant/client/credential 字段和事务性 projection，不从最近 N 条事件反推；
- 事件是不可变审计，不得因分页改变认证或页面状态；
- tenant/client/key/entitlement 写入、idempotency record 和 audit event 在同一事务提交；
- 管理写请求使用版本化 canonical JSON hash，同 key 不同 hash 冲突。

## 6. 吊销与 session 边界

1. tenant suspend、client disable、Key revoke/rotate 立即阻止新的 exchange；
2. 已签 JWT 在离线 verifier 中最多存活至 `exp`，正常收敛目标 5 分钟；
3. Edge 紧急 denylist 支持 tenant、client 和 `jti`，并阻止绕过 Edge 直连 MCP；
4. entitlement、tenant/client 状态或 Key 变化后，客户端必须重新 exchange 并创建新 MCP
   session；
5. 未实现 Edge denylist 时只能宣称“新 token 即时阻断 + 最长 TTL 收敛”，不能宣称即时
   撤销已有 JWT/session。

## 7. Admin 与 Access Console

管理员只通过企业 IdP 进入管理 API。页面只显示：

- tenant 创建/查看/暂停/恢复；
- client 创建/查看/停用；
- Key 签发/一次性交付确认/轮换/吊销；
- 三个 T0 工具 entitlement；
- `operation_id` 状态和脱敏审计摘要。

生产 Console 不包含模块中心、adapter 配置、报价、关务、Freightcom、审批发布、任意 JSON
或业务写入口。服务端 closed Schema 和权限是权威，前端隐藏不是安全门禁。

## 8. 兼容性与迁移

- MCP `/mcp`、RS256/JWKS verifier 和工具合同不变；
- loopback fixture 的长期 Key 直连只保留为明显标记的诊断 profile；
- production 客户端先调用 exchange，取得短 JWT 后按现有 Bearer 流程建立 MCP session；
- 旧 JWT 客户端如已由受认可企业 IdP 签发，可在迁移期继续使用，但进入 `t0-v1` 时也受精确
  目录限制；
- 不将 Tenant Access SQLite 数据自动升级为生产权威；迁移需独立导出、审核、导入和读回。

## 9. 测试

至少覆盖：

- closed request/response Schema 和三工具子集；
- Key 一次展示、hash+pepper、constant-time compare、待交付/过期/吊销/暂停统一错误面；
- JWT RS256、`kid`、claims、精确 scopes、60–900 秒 TTL；
- signer 返回值的 protected header、`kid` 和 payload 必须与服务端生成的 RS256 claims 精确一致；
- 受信代理、Host/Origin、转发协议和单一客户端 IP 的正反测试；
- JWKS 当前/前一 key 轮换及缓存窗口；
- tenant/client/IP 限流和并发原子计数；
- DB/KMS/audit/revocation/clock 失败闭合，签名后审计失败不返回 token；
- canonical idempotency hash、同事务 state/audit、事件超过 256 条后状态一致；
- 长期 Key 被 MCP 拒绝，短 JWT 被现有 verifier 接受；
- rotate/revoke/suspend 阻止新 exchange，Edge denylist 与 TTL 边界有明确测试；
- Console 无非 T0 字段/导航，服务端拒绝未知工具和未知字段；
- secret/token/claims 不进入日志、fixture snapshot 或错误。

## 10. 回滚

- Gateway 回滚到上一已验证镜像和 schema-compatible 数据版本；
- signing key 不因应用回滚提前删除，JWKS 保持验证在途 JWT；
- 回滚不恢复已吊销 Key，不回退 tenant/client/entitlement 版本；
- MCP Runtime 继续只接受短 JWT，不启用长期 Key fallback；
- 无法证明数据、JWKS、审计和吊销读回一致时停止 exchange，保持 MCP T0 Runtime not ready
  或无新租户流量。

## 11. 外部依赖和生产资格

本 RFC 只冻结 provider ports 和协议。真实企业 IdP、TLS/WAF/Edge、KMS/HSM、托管数据库、
共享限流、集中审计/告警、denylist、备份恢复、负载和回滚演练仍需目标环境 owner 和回执。
provider-neutral/local fixture 测试通过不等于生产完成。
