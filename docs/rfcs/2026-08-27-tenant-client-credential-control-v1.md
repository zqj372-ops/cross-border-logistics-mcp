# Tenant Access 与客户端凭证控制面 v1

- 状态：已实施并通过本地 fixture 门禁，待代码审核与合并
- 日期：2026-08-27
- 影响范围：`src/logistics_mcp/control-plane/**`、`src/logistics_mcp/server/**`、
  `apps/admin/**`、`schemas/admin-control/**`、对应测试与 runbook
- 不影响：Phase 1 MCP 工具名称、业务工具输入输出、报价/关务/客户主数据权威

## 1. 变更原因

当前 Gateway 已经把 `tenant_id`、actor、role、scope、client 和 session 绑定到服务端验证的
认证声明，但仓库没有租户目录、机器客户端凭证生命周期或面向管理员的签发界面。fixture
仅有两个固定管理身份，生产仅接受 RS256 短期 JWT。

因此“给租户分发 API Key”不能实现为可反复查看的共享明文，也不能让客户端提交
`tenant_id`。本 RFC 的本地实现只证明租户、Key metadata、一次性交付和精确工具授权状态机；
生产调用路径必须由统一凭证网关把长期 API Key 换成短期 JWT，再进入现有生产 JWT verifier。

v1 增加 Tenant Access 控制面，用于：

1. 建立租户目录；
2. 为某个租户签发受限的机器客户端凭证；
3. 只在签发或轮换响应中展示一次完整凭证；
4. 只保存带盐哈希、前缀和末四位；
5. 支持待交付确认、到期、租户暂停、轮换、吊销和不可删除操作事件；
6. 在 loopback fixture 中将通过验证的凭证投影为现有 `AuthClaims`，继续使用同一 RBAC、
   session 和 `ExecutionContext`，作为本地诊断证据而非生产认证路径。

### 1.1 生产硬边界

1. 运行时只加载镜像内置静态模块；Tenant Access 页面不是模块市场、远程安装器或 hot-plug
   入口。
2. 页面只配置租户、客户端 Key metadata 和已内置工具的权限；不配置报价规则、关务规则、
   Freightcom、业务写入或外部系统连接。
3. 当前不开放正式报价、关务、Freightcom 和任何业务写操作给 Tenant API Key。
4. 长期 API Key 不直接长期访问每个 MCP 实例；生产优先使用统一凭证网关校验 Key，并签发
   短期 JWT 调用现有 `/mcp` 生产 JWT 入口。
5. 生产必须接入企业 IdP、TLS 网关、KMS/Secret Manager、限流、审计和集中吊销。
6. 单区域上线前必须完成备份恢复、负载、告警和回滚演练；未完成时只能标记为本地 fixture
   已验证。

## 2. 明确边界

### 2.1 v1 会实现

- 独立且持久的 Tenant Access SQLite store，位于同一受管 application root 的 runtime
  state 目录，由显式 initializer 创建；Gateway startup 不隐式创建或修复。
- 本机 loopback fixture Admin API 和 UI 的完整租户/凭证演示。
- 仅在 loopback fixture 诊断路径中，机器凭证可用 `Authorization: Bearer <api-key>` 调用同一
  MCP 进程；不增加 query、cookie 或客户端 `tenant_id` 通道。
- 凭证固定映射到 `actor_role=service`；管理员只能从服务端工具 allowlist 选择精确
  `tool_names`，内部投影规则见 `2026-08-27-tenant-client-tool-entitlements-v1.md`。
- 签发或轮换后先进入 `pending_delivery`；在管理员确认完整 Key 已安全保存前，认证固定失败。
- 每个成功写操作返回唯一 `operation_id`；管理端必须从随后读取的 `/state.operations` 精确
  找到同一 ID，不能用 HTTP 200 或对象看似变化代替写后读回。
- 生产 Tenant Access 管理 POST 固定 blocked；现有生产 JWT verifier 保持默认且不降级。生产
  API Key 只允许先经过统一凭证网关换取短期 JWT，再调用 MCP。

### 2.2 v1 不会实现

- 不建立客户、报价、关务、订单或计费主表。
- 不向人类用户发长期 API Key，不替代企业 IdP、JWKS、SSO 或短期 JWT。
- 不把 API Key verifier 装进生产 MCP 实例作为长期直连入口。
- 不开放正式报价、关务、Freightcom 或任何业务写工具给 Tenant API Key。
- 不允许 API Key 获得 `platform:admin`、`tenant:admin`、任意 scope、任意工具或跨租户访问。
- 不通过邮件、聊天、日志、URL、浏览器 storage 或审计正文分发完整凭证。
- 不提供凭证恢复或再次查看；丢失只能轮换。
- 不开放生产签发，不宣称多实例 fencing、HSM/KMS、企业身份审批或生产资格已经完成。

## 3. 权威与数据模型

Tenant Access store 只拥有 MCP 接入身份元数据，不拥有业务数据。

### 3.1 Tenant

```json
{
  "tenant_id": "tenant_demo_a",
  "display_name": "北美演示租户",
  "status": "active",
  "created_at": "2026-08-27T00:00:00.000Z",
  "updated_at": "2026-08-27T00:00:00.000Z",
  "allowed_actions": ["suspend"]
}
```

状态只允许 `active`、`suspended`。不提供删除；暂停后该租户全部机器凭证立即认证失败。
`allowed_actions` 是服务端对当前状态的唯一动作授权，页面不得自行推导可点击操作。

### 3.2 Client credential metadata

```json
{
  "credential_id": "key_0123456789abcdef",
  "tenant_id": "tenant_demo_a",
  "client_id": "codex_ops",
  "label": "运营 Codex",
  "actor_role": "service",
  "roles": ["service"],
  "tool_names": ["cargo.calculate", "container.plan_summary"],
  "status": "active",
  "delivery_status": "pending",
  "delivery_acknowledged_at": null,
  "effective_status": "pending_delivery",
  "allowed_actions": ["acknowledge_delivery", "revoke"],
  "key_prefix": "lmcpk_key_01234567",
  "secret_last_four": "Ab9_",
  "created_at": "2026-08-27T00:00:00.000Z",
  "expires_at": 1787788800,
  "last_used_at": null,
  "revoked_at": null,
  "rotated_from_id": null
}
```

持久层额外保存随机 salt 和 scrypt 派生值；Admin state、日志和审计不得返回这些字段。
`status` 是凭证记录生命周期，`effective_status` 是结合交付确认、到期和租户状态后的实时可调用
状态。调用方必须按 `effective_status` 和服务端 `allowed_actions` 展示，不能把数据库中的
`status=active` 直接解释为凭证可用。

### 3.3 一次性签发响应

```json
{
  "schema_version": "2026-08-27.v1",
  "status": "success",
  "data": {
    "credential": {
      "credential_id": "key_0123456789abcdef",
      "tenant_id": "tenant_demo_a",
      "client_id": "codex_ops",
      "label": "运营 Codex",
      "actor_role": "service",
      "roles": ["service"],
      "tool_names": ["cargo.calculate"],
      "status": "active",
      "delivery_status": "pending",
      "delivery_acknowledged_at": null,
      "effective_status": "pending_delivery",
      "allowed_actions": ["acknowledge_delivery", "revoke"],
      "key_prefix": "lmcpk_key_0123456789abcdef",
      "secret_last_four": "Ab9_",
      "created_at": "2026-08-27T00:00:00.000Z",
      "expires_at": 1787788800,
      "last_used_at": null,
      "revoked_at": null,
      "rotated_from_id": null
    },
    "api_key": "lmcpk_key_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "operation": {
      "operation_id": "event_0123456789abcdef",
      "tenant_id": "tenant_demo_a",
      "credential_id": "key_0123456789abcdef",
      "actor_ref": "actor_admin:admin_console",
      "action": "credential.issue",
      "from_status": "absent",
      "to_status": "pending_delivery",
      "status": "success",
      "reason_code": "operator_issued",
      "created_at": "2026-08-27T00:00:00.000Z"
    }
  },
  "secret_delivery": {
    "status": "one_time",
    "credential_id": "key_0123456789abcdef"
  }
}
```

同一幂等键重放时不得恢复完整凭证；返回 `manual_review`、凭证 metadata 和
`secret_delivery.status=withheld`。调用者只能使用首次响应；若在确认交付前丢失 Key，必须吊销
待交付凭证并重新签发，不能轮换一个尚未确认交付的凭证。

## 4. API

固定前缀：`/admin/api/v1/access`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/state` | 返回租户、脱敏凭证 metadata 和最近 256 条 operation |
| POST | `/tenants` | 创建租户 |
| POST | `/tenants/{tenant_id}/status` | `active`/`suspended` 状态切换 |
| POST | `/credentials` | 一次性签发机器凭证 |
| POST | `/credentials/{credential_id}/acknowledge-delivery` | 确认完整 Key 已安全保存，使凭证可认证 |
| POST | `/credentials/{credential_id}/rotate` | 原子吊销旧凭证并一次性签发新凭证 |
| POST | `/credentials/{credential_id}/revoke` | 吊销凭证，不删除历史 |

所有 POST 必须：

- loopback fixture；
- `Origin`、`Host`、JSON content type、body size 门禁；
- 管理身份同时拥有 `admin`、`platform:admin` 和 `tenant:admin`；
- `Idempotency-Key` 16–200 字符；
- closed Draft 2020-12 Schema；
- production 在认证、service 和数据库之前固定 blocked。

## 5. 凭证格式与认证

凭证格式为：

```text
lmcpk_<credential_id>_<43-char-base64url-secret>
```

### 5.1 Loopback fixture 验证顺序

本节只适用于本地 fixture 诊断路径，用来证明一次性交付、状态流转和 exact entitlement。
它不是生产 MCP 实例的认证路径。

1. 有界解析格式和长度；
2. 只按 token 中的 `credential_id` 精确查询一条记录；
3. 检查 credential active、未到期、tenant active，并存在持久化的安全交付确认事件；
4. 使用记录中的 salt 做 scrypt 并 constant-time 比较；
5. 从记录生成 `AuthClaims`，tenant/actor/client/role 与 exact tool scopes 均不可由请求覆盖；
6. 进入现有 RBAC 和 MCP session binding。

API Key 最大寿命 30 天，最小 15 分钟。它仍受现有 MCP session 最大寿命限制；
`expires_at` 使用凭证本身到期时间。v1 不允许机器凭证包含管理/写入 scope 或未列入
allowlist 的工具。

### 5.2 生产交换路径

生产调用固定为：

```text
Client API Key
  -> TLS/IdP 保护的统一凭证网关
  -> KMS/Secret Manager 中的哈希、pepper 与吊销状态校验
  -> 限流、审计、租户/客户端/工具 entitlement 判定
  -> 短期 JWT
  -> 现有 MCP /mcp 生产 JWT verifier
```

MCP 生产实例不得长期保存完整 API Key，也不得直接接受 `lmcpk_...` 作为生产 Bearer。集中吊销
必须在凭证网关生效；MCP 只消费短期 JWT 中服务端签发的 tenant、actor、client、role、scope 和
过期时间。

## 6. 兼容性与迁移

- Phase 1 MCP 合同不变；旧 JWT 客户端无须迁移。
- fixture initializer 增加 Tenant Access store 的显式初始化；已有 control DB 不迁移、不加表。
- Tenant Access 使用独立 DB，避免改变 control-plane exact-schema/fingerprint。
- startup 缺少、损坏、权限错误或 schema 不匹配时，Tenant Access 管理面和 API Key 认证
  fail closed；不影响固定 JWT verifier 的代码合同。
- 生产默认继续只装配 JWT verifier；API Key 生产组合必须由独立统一凭证网关、企业身份、
  KMS/Secret Manager、限流、审计、集中吊销和上线演练完成后再进入生产门禁。

## 7. 操作与对象状态流转

租户状态机只有一条可逆边：

```text
absent --tenant.create--> active
active --tenant.suspend--> suspended
suspended --tenant.activate--> active
```

- `active` 只允许 `suspend`；`suspended` 只允许 `activate`。
- 同状态写入不是幂等替代品，使用新幂等键执行 `active → active` 或
  `suspended → suspended` 必须拒绝。

凭证对象分为持久 `status`、交付 `delivery_status` 和组合后的 `effective_status`：

```text
absent --issue--> pending_delivery --acknowledge_delivery--> active
active --rotate--> revoked(old) + pending_delivery(new)
pending_delivery|active --revoke--> revoked
pending_delivery|active --time--> expired
active + tenant.suspended --> tenant_suspended
```

- `pending_delivery`：只允许确认交付或吊销，认证固定失败，不能轮换。
- `active`：允许轮换或吊销；轮换会原子吊销旧 Key，新 Key 重新进入
  `pending_delivery`。
- `tenant_suspended`：凭证记录不被篡改，但认证失败；只保留吊销动作，恢复租户后回到其原
  `active` 有效态。
- `expired`、`revoked`：终态，没有后续动作。

每个成功写事务同时落一条 immutable operation。对外 operation 只允许上述七种 action，
`status` 固定为 `success`；失败通过五状态 envelope 返回，不伪造成功 operation。UI 完成条件为：

1. 写响应通过 closed Schema 校验；
2. 响应包含 `operation_id`；
3. 随后的 `/state` 返回同一个 `operation_id` 且 `operation.status=success`；
4. 对签发/轮换，还必须完成独立 `credential.delivery_acknowledge` 并再次精确读回，凭证才可调用。

任一步缺失或不一致都进入 `manual_review`。页面不乐观更新，也不从旧对象状态猜测操作成功。

## 8. 权限和状态影响

- 新增管理 scope：`tenant:admin`，只属于管理身份，不进入机器凭证 allowlist。
- 机器凭证角色固定 `service`；v1 allowlist 只包含 T0 内置只读工具
  `cargo.calculate`、`container.plan_summary`、`system.agent_context.get`，并投影为内部
  `tool:<canonical-name>` exact scope。正式报价、关务、Freightcom 和业务写工具不进入
  Tenant API Key allowlist。
- 认证失败统一使用既有 `authentication_failed`，不暴露租户、credential ID、暂停、过期或
  hash 是否存在。
- Admin API 使用五状态包络；成功签发不代表生产资格。

## 9. 测试与安全门禁

至少覆盖：

- DB 文件/目录权限、strict schema、WAL/FULL、显式初始化、损坏/未来 schema fail closed；
- 租户创建幂等与冲突；暂停后立即拒绝；
- 完整 secret 不在 DB、state、日志或审计中；
- 一次性展示、未确认时认证失败、交付确认、重放 withheld、轮换、吊销、到期；
- 租户和凭证非法状态跳转、服务端 `allowed_actions`、写响应 operation 与 state 精确 ID 读回；
- 错误 key ID、错误 secret 和有效 key 的外部认证错误面一致；
- 精确工具 allowlist、管理 scope/写工具拒绝、跨租户拒绝；
- Admin loopback/origin/host/body/auth/role/scope/tenant/idempotency 门禁；
- production POST 在 authenticate/service/store 前 blocked；
- 真实 fixture runtime 的 key 在交付确认前被拒绝，确认后可完成 MCP initialize/tools list，
  并且 `ExecutionContext.tenantId` 来自 store；
- UI 不写 localStorage/sessionStorage/cookie/URL，不在再次读取后显示完整 key。

回归命令：

```bash
npx vitest run tests/control-plane/tenant-access*.test.ts tests/platform/admin-tenant-access-api.test.ts tests/e2e/tenant-api-key-runtime.test.ts --pool=forks --no-file-parallelism --maxWorkers=1
npm test
npm run typecheck
npm run lint
npm run validate:schemas
npm run validate:agent-standards
npm run validate:agent-adapters
npm run build
git diff --check
```

## 10. 回滚

- 代码回滚时先停止签发，再吊销新签发凭证并保留审计导出；不删除 Tenant Access DB。
- 旧 JWT 路径不依赖 Tenant Access DB，可保持服务。
- v1 不允许使用不了解 tenant/key 状态的镜像继续接受 fixture API Key；生产实例无论回滚到哪个
  镜像，都只能接受现有短期 JWT verifier。
- 完整 secret 不可恢复；待交付 Key 丢失时吊销并重新签发，已确认 Key 才能通过轮换替换。

## 11. 生产准入门禁

以下未完成前只能写“本地 fixture 已验证”，不能写生产可用：

- 企业管理员身份、审批和租户 owner；
- 企业 IdP/JWKS、TLS 网关、统一凭证网关和短期 JWT 交换；
- KMS/HSM 或企业 Secret Manager、pepper/密钥轮换；
- 多实例缓存失效、集中吊销和短期 JWT 最大存活窗口；
- 限流、配额、IP/网络策略和异常使用检测；
- 企业安全分发渠道、接收方强身份确认和客户侧 secret 保管；本地“确认已安全保存”只验证状态
  机，不构成生产级接收证明；
- 生产备份、恢复演练、负载测试、告警演练、回滚演练、合规保留期和事件响应。
