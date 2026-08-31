# RFC: Tenant API Key 精确工具授权 v1

- 状态：用户确认实施，已进入本地验证
- 日期：2026-08-27
- 依赖：`2026-08-27-tenant-client-credential-control-v1.md`
- 影响范围：Tenant Access 请求/状态 DTO、API Key RBAC 投影、MCP `tools/list`、Admin 租户接入页
- 不改变：Phase 1 工具输入输出、模块发布合同、报价/关务/客户主数据权威、生产资格

## 1. 变更原因

原凭证请求直接选择 `quote:calculate` 等粗粒度 scope。一个 scope 可能对应多个 MCP 工具：
例如 `quote:calculate` 同时满足 `cargo.calculate`、
`quote.canada_final_mile.calculate` 和 `quote.freightcom_ltl.preview` 的 RBAC 条件。
因此管理员无法只给某个客户端开放其中一个功能，也无法在页面准确说明 Key 实际能看到哪些工具。

本 RFC 把 Tenant Access 的授权单位改为 canonical MCP tool name。它不是任意插件配置中心：
管理员只能从服务端固定 allowlist 选择镜像内置、当前 T0 允许的只读工具；它不是插件市场，
也不是模块加载入口。整模块是否挂载和激活仍由镜像构建与受控发布流程决定。

## 2. 决策

1. 签发与轮换请求使用非空、去重、闭合集合 `tool_names`，不再接收客户端提交的粗粒度
   `scopes`。
2. Tenant Access 服务端把每个工具转换为内部 exact scope：`tool:<canonical-tool-name>`。
   这些 scope 只用于已验证的 `AuthClaims` 和现有 RBAC，不在管理页展示。
3. 只允许以下三个 T0 内置只读工具：`cargo.calculate`、
   `container.plan_summary`、`system.agent_context.get`。正式报价、关务、Freightcom、
   业务写工具、未知工具和继承属性名固定拒绝。
4. 只要认证上下文包含任一 `tool:` exact scope，RBAC 就进入精确授权模式：不能再通过同一
   broad permission 继承兄弟工具。MCP session 的 `tools/list` 同样只注册被授权工具。
5. 状态 DTO 返回服务端 `available_tools` 与每个凭证的 `tool_names`。完整 Key、secret hash、
   salt 和内部 exact scope 不进入状态接口。
6. 已确认交付的 active Key 不能原地改权限。页面“调整功能”调用现有轮换事务：旧 Key 原子
   进入 `revoked`，带新工具清单的新 Key 进入 `pending_delivery`；确认安全保存后才进入
   `active`。
7. 页面只有同时精确读回同一 `operation_id`、新 `credential_id` 和相同 `tool_names` 时，
   才把调整显示为已写入。任一不一致保留 `manual_review`。
8. 工具授权不等于模块激活、依赖 ready 或生产资格。已授权但未发布/未就绪的工具仍按现有
   envelope 返回 `unavailable`、`manual_review` 或其他真实状态。

## 3. 合同变化

旧签发请求：

```json
{
  "schema_version": "2026-08-27.v1",
  "tenant_id": "tenant_demo_a",
  "client_id": "codex_ops",
  "label": "运营 Codex",
  "scopes": ["quote:calculate"],
  "expires_in_seconds": 86400
}
```

新签发请求：

```json
{
  "schema_version": "2026-08-27.v1",
  "tenant_id": "tenant_demo_a",
  "client_id": "codex_ops",
  "label": "运营 Codex",
  "tool_names": ["cargo.calculate"],
  "expires_in_seconds": 86400
}
```

新轮换请求必须同时给出替换后的完整工具集合：

```json
{
  "schema_version": "2026-08-27.v1",
  "tool_names": ["cargo.calculate", "container.plan_summary"],
  "expires_in_seconds": 2592000,
  "reason_code": "operator_function_profile_changed"
}
```

状态读回新增：

```json
{
  "available_tools": [
    {"tool_name": "cargo.calculate", "kind": "read"}
  ],
  "credentials": [
    {
      "credential_id": "key_0123456789abcdef",
      "tool_names": ["cargo.calculate"]
    }
  ]
}
```

上例只展示相关字段；正式 DTO 仍由 Draft 2020-12 Schema 严格关闭额外属性。

## 4. 兼容与迁移

- 本变更与 Tenant Access v1 尚未合并的实现一起交付，因此外部 API 不提供双写窗口；新请求
  只接受 `tool_names`。
- 已存在的本地 fixture SQLite 行若保存旧 broad scopes，读取器按存储损坏失败闭合；不再把
  `quote:calculate`、`system:read`、`tariff:*` 等 broad scope 展开为 exact tool scopes。
- 新签发和新轮换只写 T0 exact tool scopes，不扩大旧凭证权限。需要保留旧演示数据时使用新
  application root 重新初始化，不手工编辑 SQLite。
- 生产 Tenant Access POST 继续固定 `blocked`；本迁移不开放生产 API Key。

## 5. 状态、权限与安全影响

- 凭证生命周期不新增状态，继续使用
  `pending_delivery → active → revoked|expired`，租户暂停投影为 `tenant_suspended`。
- 调整功能必须走 `active → revoked`（旧凭证）以及
  `absent → pending_delivery → active`（新凭证），不允许原地变更。
- 管理调用仍要求管理 tenant、admin role、`platform:admin` 和 `tenant:admin`；机器 Key 永不获得
  管理 scope、写 scope 或跨租户能力。
- `tools/list` 的收窄只影响 exact-entitlement session；现有企业 JWT 的 broad scope 行为保持
  不变，除非其签发方主动混入 `tool:` scope。混入后按精确模式失败闭合。

## 6. 回归测试

```bash
npm test -- --run \
  tests/control-plane/tenant-access-contracts.test.ts \
  tests/control-plane/tenant-access.test.ts \
  tests/platform/context-rbac.test.ts \
  tests/platform/admin-tenant-access-api.test.ts \
  tests/platform/admin-tenant-access-ui.test.ts \
  tests/e2e/tenant-api-key-runtime.test.ts
npm run typecheck
npm run lint
npm run validate:schemas
npm run build
```

端到端测试必须证明：只授权 `cargo.calculate` 时，`tools/list` 只返回该工具且 cargo 调用成功；
调用未授权 `system.get_data_status` 返回 MCP tool-not-found 错误；轮换后旧 Key 失败、新 Key 在
交付确认前失败，确认后只获得新的 T0 工具清单。

## 7. 回滚

1. 停止本地 fixture runtime，保留 Tenant Access SQLite 和 marker，不删除审计事件。
2. 回滚本 RFC 的代码与 Admin Schema/UI；不要把已写入 exact scope 的 DB 交给旧二进制打开，
   旧读取器会按设计失败闭合。
3. 若必须恢复旧本地演示，使用新的 application root 显式初始化旧 fixture，不覆盖或删除现有
   state。
4. 回滚不恢复已吊销 Key，也不重新显示任何完整 secret。
