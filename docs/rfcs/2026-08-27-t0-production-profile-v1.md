---
standard_id: t0-production-profile-v1
version: 2026-08-27.v1
priority: 92
audience: developer,reviewer,operator,caller
rule_ids: T0-PROFILE-001,T0-CATALOG-001,T0-READINESS-001,T0-AUTH-001
---

# RFC：T0 Production Profile v1

- 状态：accepted for implementation；生产资格仍需目标环境证据
- 日期：2026-08-27
- 接受依据：用户明确要求按 `2026-08-27-t0-tenant-access-production-service-plan.md` 执行
- 影响范围：生产 composition、Module Runtime、Agent Standard Pack、客户端示例、部署与测试
- 不影响：现有 Phase 1 业务工具合同、报价/关务/Freightcom 实现、业务权威系统

## 1. 变更原因

当前 production composition 会构造完整 Phase 1、Freightcom 和 Agent Access。即使 Tenant
API Key 只含三个 `tool:` scope，旧 broad JWT 或 `platform:admin` 仍可看到更宽目录；把
adapter 标为 disabled/unavailable 也不等于该工具没有进入生产调用面。

首个生产版本需要一个 deny-by-construction profile：在注册、handler 建立、adapter 构造和
出站配置之前，目录就固定为三个 T0 工具和五个 Agent 资源。

## 2. 决策

### 2.1 Profile

新增两个同目录、不同环境证据的 profile：

```text
t0-staging
t0-v1
```

生产 assembly 只接受这两个值。未设置时可由 production entrypoint 显式传入 `t0-v1`；
调用方显式传入空字符串、未知值或 fixture profile 必须在监听前失败。local/fixture 继续使用
既有 composition，不把宽 Phase 1 目录描述为 T0 生产。

### 2.2 精确模块、工具和资源

允许的镜像内静态模块集合：

```json
["cargo", "container", "agent-access"]
```

允许的工具集合：

```json
[
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get"
]
```

允许的资源集合：

```json
[
  "logistics://agent/bootstrap",
  "logistics://standards/index",
  "logistics://contracts/envelope/current",
  "logistics://modules/catalog",
  "logistics://agent/profiles"
]
```

所有集合执行排序后的集合相等校验，不接受“至少包含”。Quote、RiskCustoms、Freightcom、
Knowledge、Status、Review 和任何写工具不得注册、不得创建 handler、不得构造 adapter、不得
读取其 secret/endpoint，也不得做健康探测。

### 2.3 静态模块完整性

每个允许模块必须有 reviewed descriptor，至少绑定：

```text
module_id
version
risk_level=T0
tool_names
required_capabilities
manifest_digest=sha256:<64-hex>
```

`manifest_digest` 是规范化 descriptor 和所引用工具合同 fingerprint 的构建时 SHA-256；生产
镜像 digest 继续负责绑定实际编译代码。Runtime 同时校验 module ID、版本、风险等级、工具、
capability 和 manifest digest，不把 ID/version 当作代码完整性证明。

缺少构建 descriptor、digest 不匹配、重复工具、未知 capability 或 profile/catalog 漂移均在
监听前失败。运行时不从 cwd、远程 URL 或任意路径加载替代 descriptor。

### 2.4 身份与 RBAC

T0 客户 JWT 只能包含：

```text
tool:cargo.calculate
tool:container.plan_summary
tool:system.agent_context.get
```

不得包含 `platform:admin`、旧 broad scope 或非 T0 `tool:` scope。管理员身份只作用于
Unified Access Gateway 管理 API；不能自动获得 MCP Runtime 工具权限。Runtime 的三工具
结构性目录是最后一道边界，即使上游错误签发宽 scope，也不存在额外 handler 可调用。

生产 MCP 只接受 `Authorization: Bearer <short-jwt>`。`lmcpk_...` 长期 Key、fixture token、
query/cookie token 或客户端提交 tenant/actor 一律拒绝。

### 2.5 Agent Standard Access

- `runtime-caller` 只允许 `cargo`、`container`、`agent-access`；
- `modules/catalog` 只投影当前 Runtime 实际挂载模块；
- 五个 resource 分别执行 profile、audience 和 `context_scopes` 授权；
- pack、reviewed descriptor、实际工具集合或资源集合不一致时 fail closed；
- ChatGPT、Codex 和企业 Agent 客户端示例只声明三个工具和五个资源。

### 2.6 Readiness

监听前硬门禁：

- profile 合法；
- 三个静态模块 descriptor/digest 合法；
- 工具集合和资源集合精确匹配；
- reviewed Agent Standard Pack 存在且 hash 匹配；
- production token verifier、durable audit/idempotency 和 session binding 已注入；
- fixture API Key verifier 未注入；
- 非 T0 adapter/secret/endpoint 未装配。

运行中 `/readyz` 至少聚合：JWKS、durable audit/idempotency/session store、pack/catalog
一致性和 shutdown/drain 状态。任一失败返回非 2xx，由 Edge 摘流；`/healthz` 只证明进程
存活，不能代替 readiness。

## 3. 旧/新行为

旧 production 概念目录：

```json
{
  "tool_count": 11,
  "includes": ["phase-one", "freightcom-ltl", "agent-access"]
}
```

新 `t0-v1` 目录：

```json
{
  "tool_count": 3,
  "resource_count": 5,
  "modules": ["cargo", "container", "agent-access"]
}
```

这不是删除 Phase 1 合同；宽组合保留为显式 local/fixture 或后续独立 release profile，不能
成为 `t0-v1` 的静默 fallback。

## 4. 兼容性与迁移

1. 先新增红测，要求 production tools/resources 精确集合并证明非 T0 adapter 零构造；
2. 新增显式 T0 composition/profile，不复用 `registerPhaseOneTools`；
3. 收窄 `runtime-caller`、resource catalog 和客户端模板；
4. 生成 reviewed pack/descriptor；
5. 更新 production entrypoint 和 deploy profile；
6. staging 客户端必须重新连接，旧 broad JWT 不迁移到 T0 profile。

工具输入/输出 Schema 不变；Cargo/Container 结果兼容。工具目录收窄是有意的发布边界变化，
必须通过 profile 名和 release notes 显式表达。

## 5. 状态、权限和安全影响

- 目录不一致、pack/digest 错误或平台依赖不可用：全局 not ready，不返回工具 success；
- 单个 T0 调用缺输入：沿用 `needs_input`；规则/证据冲突：`manual_review`；
- 身份、scope、tenant/session 失败：安全层拒绝，不泄露内部目录或凭证状态；
- T0 profile 无任何网络、secret、业务持久化写入或业务 adapter capability。

## 6. 测试

至少覆盖：

- production `tools/list` 精确三项、`resources/list` 精确五项；
- unknown/empty/fixture production profile 在监听前失败；
- 非 T0 module、handler、adapter、secret 和 outbound client 零构造；
- broad JWT/`platform:admin` 无法看到不存在的非 T0 工具；
- module descriptor/digest、pack hash 和 catalog 漂移失败闭合；
- 五个资源逐资源 scope 允许/拒绝；
- JWKS/audit/idempotency/session 不健康使 `/readyz` 失败；
- Cargo、Container、Agent Context 正常调用回归。

回归命令：

```bash
npx vitest run tests/platform tests/module-runtime tests/agent-context tests/e2e/composition-mode.test.ts tests/e2e/production-platform-runtime.test.ts
npm run validate:agent-standards
npm run build:agent-pack
npm run validate:agent-adapters
npm run typecheck
npm test -- --pool=forks --poolOptions.forks.singleFork=true
git diff --check
```

## 7. 回滚

回滚只允许部署上一已验证的 T0 镜像/descriptor/pack。不得在当前进程把 T0 profile 切回宽
Phase 1，不得通过环境变量跳过目录或 digest 校验。回滚后重新读回 3 工具、5 资源、镜像
digest、JWT 和审计链；无法读回则继续 NO-GO。

## 8. 生产资格边界

本 RFC 被接受只授权仓库实现，不证明目标环境已有 IdP、TLS/Edge、KMS、集中吊销、告警、
备份恢复、负载或回滚证据。缺少任一目标环境回执时仍是 NO-GO。
