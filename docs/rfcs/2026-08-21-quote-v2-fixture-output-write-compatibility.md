# RFC: 既有报价 fixture 到 v2 输出的兼容迁移

- 状态：实现草案，待基线维护者接受
- 日期：2026-08-21
- 影响范围：`ExistingQuoteAdapter`、报价 fixture、`quote.save_draft` 输入兼容

## 动机

报价 fixture 原来直接返回 `quote-result@zone-price-fixture@1` 的 v1 形状，而
`quote.canada_final_mile.calculate` 已经以 `quote-request@2026-08-13.v2` 输入和
`quote-result@2026-08-13.v2` 输出为契约。继续让 fixture 返回旧形状会使测试绕过真实
的 v2 结果校验，也会让后续 `quote.save_draft` 无法接收计算工具的直接输出。

本 RFC 只处理本地 fixture 和适配层迁移，不把 fixture 当作生产数据就绪证据，也不连接
生产报价系统。

## 影响的工具

- `quote.canada_final_mile.calculate`
- `quote.save_draft`

## 旧 / 新 JSON 形状

### 旧计算结果（仍用于 ExistingQuoteAdapter 的 v1 兼容路径）

```json
{
  "version": "quote-result@zone-price-fixture@1",
  "quote_id": "quote-demo-001",
  "quote_status": "calculated",
  "currency": "USD",
  "total": { "amount": "143.80", "currency": "USD" },
  "line_items": [],
  "rule_version": "zone-rule-fixture@1",
  "data_version": "zone-price-fixture@1",
  "sendable": false,
  "valid_from": "2026-08-01T00:00:00Z",
  "valid_to": "2026-08-31T23:59:59Z",
  "source_ref_ids": ["src:quote:fixture:1"]
}
```

### 新计算结果

新路径保留金额、明细和规则版本，但要求结果携带有效日期、租户、快照、发布版本和
计费托盘数。`source_ref_ids` 必须绑定到 `snapshot_hash` 派生的唯一快照源 ID，明细
和计算轨迹也必须重新绑定到该 ID。完整字段以 `quoteV2ResultSchema` 为准。

```json
{
  "version": "quote-result@2026-08-13.v2",
  "quote_id": "quote-demo-001",
  "quote_status": "calculated",
  "currency": "USD",
  "total": { "amount": "143.80", "currency": "USD" },
  "line_items": [
    {
      "line_id": "line:quote:base",
      "label": "Canada final-mile base price",
      "amount": { "amount": "123.45", "currency": "USD" },
      "pricing_basis": "versioned fixture row",
      "source_ref_ids": ["src:quote:snapshot:<sha256-digest>"]
    },
    {
      "line_id": "line:quote:fuel",
      "label": "Fuel surcharge",
      "amount": { "amount": "12.35", "currency": "USD" },
      "pricing_basis": "fuel_percent=10",
      "source_ref_ids": ["src:quote:snapshot:<sha256-digest>"]
    }
  ],
  "rule_version": "zone-rule-fixture@1",
  "data_version": "zone-price-fixture@1",
  "sendable": false,
  "valid_from": "2026-08-01",
  "valid_to": "2026-08-31",
  "source_ref_ids": ["src:quote:snapshot:<sha256-digest>"],
  "tenant": "tenant_fixture",
  "effective_date": "2026-08-11",
  "ready": true,
  "test_data": false,
  "origin": "toronto",
  "billing_pallets": 2,
  "snapshot_hash": "sha256:<64-hex-digest>",
  "service_version": "quote-service@fixture-v2",
  "contract_version": "quote-zone.v2",
  "release_id": "quote-release-fixture-v2",
  "release_hash": "sha256:<64-hex-digest>",
  "published_at": "2026-08-11T00:00:00Z"
}
```

fixture 的 `test_data` 取值继续遵守现有 v2 schema；fixture 本身仍只作为测试替身，不能
据此推断生产数据 readiness。生产适配器若缺少 v2 快照元数据，必须返回
`unavailable`，不能用旧字段猜测或补齐。

## 兼容策略

1. `ExistingQuoteAdapter` 根据请求版本路由：v2 请求走严格输入校验和 v2 投影；旧请求
   继续走原 v1 计算路径，避免无关的旧单元测试和调用方同时破坏。
2. fixture lookup record 增加显式 v2 快照元数据，包括 origin、billing pallets、
   snapshot/release hash、service version、release ID 和 published time。
3. `quote.save_draft` 的 `quote_result` 输入改为 v1 结果或 v2 结果的显式 union。写入
   预览、审批、幂等、目标租户和成功前写后读回规则不变；这不是新增万能写入口。
4. v1 结果不会被静默改写成 v2。缺少 v2 元数据或 v2 投影校验失败时，返回
   `unavailable`，并带有明确 blocker。

## 状态、权限和租户影响

- v2 计算必须有服务端注入的 `ExecutionContext`；缺失时返回 `blocked`。
- 租户来自执行上下文，不来自报价请求字段。
- `limited_access`、`remote_area` 和地址证据不足仍分别保持人工复核或补输入，不访问
  fixture lookup。
- 结果继续 `sendable: false`；本迁移不开放发送或发布能力。
- 写工具仍需原有 `quote:draft_write` 权限、`idempotency_key`、预览/审批约束和写后读回。

## 迁移步骤

1. 将报价 fixture 请求升级为 v2 字段：显式托盘数、最长边、可堆叠性、总体积、托盘车
   和 detention 分钟数。
2. 为 fixture lookup record 提供版本化 v2 元数据。
3. 通过 `quoteV2ResultSchema` 校验投影结果，并校验外层 source refs、line items 和
   calculation trace 的源 ID 一致性。
4. 使用同一个 v2 结果执行 draft preview/commit/readback 回归测试。

## 回归测试

```text
npx vitest run tests/adapters/quote-v2-fixture.test.ts tests/adapters/quote-adapter.test.ts tests/adapters/quote-api-adapter.test.ts --pool=forks --no-file-parallelism --maxWorkers=1 --testTimeout=5000 --hookTimeout=5000
npx vitest run tests/e2e/phase1-tools.test.ts tests/e2e/runtime-smoke.test.ts tests/e2e/composition-mode.test.ts --pool=forks --no-file-parallelism --maxWorkers=1 --testTimeout=5000 --hookTimeout=5000
```

## 回滚方式

回滚本 RFC 对应提交即可恢复旧 fixture 和旧输入兼容行为；不需要回滚生产数据，也不
允许通过回滚绕过线上生产适配器的 v2 元数据校验。
