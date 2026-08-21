# RFC：AI 报价 API 接入契约 v2

**日期：** 2026-08-13
**状态：** 本分支接受，待主会话复审；不代表上游发布、生产启用或部署完成
**影响范围：** `quote.canada_final_mile.calculate` 的未来 v2 契约
**不变范围：** 统一包络字段、其他工具、HTTP adapter、平台和适配器业务源码

## 1. 变更原因

现有 MCP quote v1 的输入和待接入的上游报价预览合同不一致。候选 `/quotes/zone-preview` 需要显式最长边、可堆叠、托盘数、手叉车和滞留分钟；这些字段会影响计费托数或附加费，缺失时不能用默认值。v1 的 `cargo.billing_pallets` 还是上游计算结果语义，不能当作输入的 `explicit_pallet_count`。

本 RFC 只定义兼容的字段边界、证据投影和迁移规则。候选端点尚未作为已发布上游合同，不能由本 RFC 推断可用；本次不实现 HTTP adapter、不连接上游、不改变生产资格。

## 2. 已核验边界与非目标

- `tenant` 只从服务端 `ExecutionContext` 和租户范围映射获得；公开 v2 输入不接受 `tenant_id`。
- `origin.warehouse_code` 必须经服务端租户范围内的显式映射得到上游 `origin`；不能从省份猜测。
- `limited_access=true` 或 `remote_area=true` 时，上游没有已核验合同，必须零调用并返回 `manual_review`；此时使用 `data=null`、空 `source_refs` 和空 `calculation_trace`，不得伪造报价、发布或来源证据。
- `effective_at` 是明确的 `YYYY-MM-DD`；上游 `valid_from`/`valid_to` 也是 Date，不能把日期伪造成 DateTime。
- MCP 只负责 Schema 校验、单位换算、租户/来源投影和失败闭合；Zone、计费托数、燃油、附加费和总价仍由上游权威系统计算。
- v2 输出的 `billing_pallets` 是上游结果回显，不是 v2 输入字段。

非目标：不新增报价规则表、价格缓存、通用报价框架、公开租户字段、发送/发布能力或本地价格计算；不改变旧统一包络字段或 v1 行为，v2 另用独立 envelope Schema，不把候选上游写成已可用。

## 3. 影响工具与版本

| 工具 | 变化 | 当前资格 |
| --- | --- | --- |
| `quote.canada_final_mile.calculate` | 增加独立 v2 输入/输出 Schema；`version` 分别为 `quote-request@2026-08-13.v2` 和 `quote-result@2026-08-13.v2` | 未发布上游合同，固定 `unavailable`；本 RFC 不授权 HTTP 调用 |
| `quote.save_draft` | 不改变既有写契约；不会因为 quote v2 自动获得写入能力 | 继续按现有契约和写后读回门禁执行 |
| 其他工具 | 无字段、状态或权限变化 | 保持现状 |

旧统一包络仍是 `2026-08-11.v1`，旧 `envelope.schema.json` 和 v1 行为保持不变；v2 使用独立 `quote-envelope-v2.schema.json`，字段形状相同但只接收 `quote-result-v2` 并执行 v2 外层状态绑定。v2 未绑定可用的生产 handler 前，不得以 v2 envelope 中出现数据为生产成功证据。

## 4. 旧契约 JSON（v1，继续保留）

以下是现有 v1 的代表性合法结构；`billing_pallets` 的语义在 v1 中继续保持历史兼容，不在 v2 中重命名迁移。v1 的生产资格固定为 `unavailable`。

### 4.1 v1 请求

```json
{
  "schema_version": "2026-08-11.v1",
  "version": "quote-request@fixture-1",
  "origin": {
    "warehouse_code": "fixture-warehouse",
    "province": "ON"
  },
  "destination": {
    "country": "CA",
    "province": "ON",
    "city": "Fixture City",
    "postal_code": "A0A 0A0",
    "address_type": "commercial",
    "full_address_ref": null
  },
  "cargo": {
    "cargo_result_ref": null,
    "billing_pallets": 2,
    "weight_kg": { "value": "100", "unit": "kg" },
    "pieces": 2,
    "package_types": ["pallet"],
    "total_volume": { "value": "1.25", "unit": "cbm" }
  },
  "services": {
    "appointment": true,
    "liftgate": false,
    "limited_access": false,
    "remote_area": false
  },
  "effective_at": "2026-08-13"
}
```

### 4.2 v1 输出数据

```json
{
  "version": "quote-result@2026-08-11.v1",
  "quote_id": "quote_demo_review_001",
  "quote_status": "manual_review",
  "currency": "USD",
  "total": null,
  "line_items": [],
  "rule_version": "quote-rule@2026-08-11",
  "data_version": "zone-price@2026-08-11",
  "sendable": false,
  "valid_from": null,
  "valid_to": null,
  "source_ref_ids": ["src:quote:postal-conflict"]
}
```

## 5. 新契约 JSON（v2）

### 5.1 v2 请求

```json
{
  "schema_version": "2026-08-11.v1",
  "version": "quote-request@2026-08-13.v2",
  "origin": {
    "warehouse_code": "tenant-warehouse-ont-01",
    "province": "ON"
  },
  "destination": {
    "country": "CA",
    "province": "ON",
    "city": "Fixture City",
    "postal_code": "A0A 0A0",
    "address_type": "commercial",
    "full_address_ref": null
  },
  "cargo": {
    "cargo_result_ref": null,
    "explicit_pallet_count": 2,
    "longest_side": { "value": "1.20", "unit": "m" },
    "is_stackable": false,
    "weight_kg": { "value": "100", "unit": "kg" },
    "pieces": 2,
    "package_types": ["pallet"],
    "total_volume": { "value": "1.25", "unit": "cbm" }
  },
  "services": {
    "appointment": true,
    "liftgate": false,
    "pallet_jack": true,
    "detention_minutes": 0,
    "limited_access": false,
    "remote_area": false
  },
  "effective_at": "2026-08-13"
}
```

`explicit_pallet_count`、`longest_side`、`is_stackable`、`pallet_jack` 和 `detention_minutes` 均为必填；`explicit_pallet_count` 的值只能是 `null` 或 `integer>=1`，不能用 `0` 表示未知。`longest_side`、`weight_kg`、`total_volume` 的 decimal string 必须严格大于 `0`，包括 `0`、`0.0`、`0.000` 在内的零表示均拒绝。`package_types` 当前只能有一个值；adapter 不猜选包装类型。v2 不接受 `cargo.billing_pallets`，也不接受 `tenant_id`。所有测量值带单位，金额若出现只能是 decimal string + ISO 4217 三位币种。

### 5.2 v2 输出数据

```json
{
  "version": "quote-result@2026-08-13.v2",
  "quote_id": "quote_preview_demo_001",
  "quote_status": "manual_review",
  "currency": "USD",
  "total": null,
  "line_items": [],
  "rule_version": "quote-preview-rule@pending",
  "data_version": "quote-preview-data@pending",
  "sendable": false,
  "valid_from": "2026-08-13",
  "valid_to": "2026-08-13",
  "source_ref_ids": ["src:quote:preview:demo-001"],
  "tenant": "tenant-demo",
  "effective_date": "2026-08-13",
  "ready": true,
  "test_data": false,
  "origin": "toronto",
  "billing_pallets": null,
  "snapshot_hash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "service_version": "quote-service@pending",
  "contract_version": "quote-preview-contract@2026-08-13",
  "release_id": "quote-release-pending-review",
  "release_hash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "published_at": "2026-08-13T00:00:00Z"
}
```

`tenant`、`effective_date`、`ready`、`test_data`、`origin`、`billing_pallets`、`snapshot_hash`、`service_version`、`contract_version`、`release_id`、`release_hash` 和 `published_at` 是上游身份/结果发布校验字段。只有 `ready=true`、`test_data=false` 的 active manifest 才能进入 v2 data；adapter 还必须确认 active manifest 的有效期覆盖 `effective_date`。`tenant` 和 canonical `origin` 必须与服务端映射及请求上下文一致；输出 `origin` 是引擎 canonical origin，不是输入 `warehouse_code`；`billing_pallets` 只能来自上游结果。adapter 必须校验 `release_hash === snapshot_hash`，不一致即拒绝结果。带 data 的 `manual_review` 必须是 `ready=true`、`test_data=false` 并保留完整 quote-result-v2 与至少一个 source ref；`limited_access`/`remote_area` 的零调用门禁才允许 `manual_review + data=null`，且 source refs 与 calculation trace 必须为空。`ready=false` 必须在统一包络中返回 `status=unavailable` 且 `data=null`。`valid_from`、`valid_to` 和 `effective_date` 是必需非空 Date，`published_at` 是 DateTime；不能互相伪造。

## 6. Schema 与状态规则

- v2 输入 Schema：`quote-request-v2.schema.json`。
- v2 输出 Schema：`quote-result-v2.schema.json`。
- v2 envelope Schema：`quote-envelope-v2.schema.json`；旧 `envelope.schema.json` 不引用 v2。
- 3 个根 Schema 及所有可实例化对象均关闭未知字段；refinement overlay 仅参与约束，不单独作为实例契约。
- v2 输出必须包含 `test_data`、`service_version`、`contract_version`、`release_id`、`release_hash` 和 `published_at`；release hash 与 snapshot hash 的等值由 adapter 校验。
- v2 `quote.calculate` 是只读，`quote_status` 不接受 `draft_saved`；保存草稿必须走既有独立写工具和写后读回门禁。
- v2 输入的 `longest_side`、`weight_kg`、`total_volume` 必须严格大于 `0`；`package_types` 必须恰好一个值，不能让 adapter 猜选。
- v2 data 只允许 `ready=true`、`test_data=false` 的 active manifest，`valid_from`/`valid_to` 必须是非空 Date。
- 对 `calculated`，Schema 用最小 `if/then` 约束 `ready=true`、`test_data=false`、`total` 非空、`line_items` 至少一条、`billing_pallets>=1`、snapshot/release hash 非空；`manual_review` 和 `not_calculable` 的 `total` 必须为 `null`。
- v2 data 进入独立 v2 envelope 时，外层 `success` 只允许 `quote_status=calculated`；带 data 的外层 `manual_review` 只允许 `quote_status=manual_review|not_calculable`；仅零调用业务门禁允许外层 `manual_review + data=null`，并要求空 `source_refs`/`calculation_trace`；外层 `unavailable`、`blocked`、`needs_input` 必须 `data=null`。v1 envelope 不受这些 v2 条件影响。
- v2 data 为 `success` 或 `manual_review` 时，独立 envelope Schema 要求外层 `source_refs` 至少一项；`success` 的 `calculation_trace` 至少一项。`unavailable`、`blocked`、`needs_input` 的 v2 结果必须是 `data=null`，可保留空 source refs/trace。`source_ref_ids`、所有 line item 的 `source_ref_ids` 与 envelope calculation trace 的 `source_ref_ids` 的 union，必须与外层 `source_refs` IDs 是同一精确集合；该跨数组关系由 adapter/envelope validator 和契约测试显式核验，Schema 不引入复杂跨数组引用表达式。v2 状态 refinement 的 `additionalProperties=true` 仅作为独立 Schema 同一 `allOf` 中的 overlay，关闭性仍由 quote-result-v2 `$ref` 提供。
- v1 的现有 Schema 和历史 envelope 示例保留，继续可校验；可校验不代表生产资格。
- 外层状态仍只使用 `success`、`needs_input`、`manual_review`、`blocked`、`unavailable`。

| 情况 | 状态 | 上游调用 |
| --- | --- | --- |
| v2 必填字段缺失、单位不合法、金额为 JSON number、DateTime 冒充 Date | `needs_input` | 零调用 |
| `limited_access=true`、`remote_area=true` | `manual_review + data=null` | 零调用 |
| 租户/来源/版本/快照冲突 | `manual_review`（带 data 时必须完整 quote-result-v2/source_refs）或按权限策略 `blocked` | 零调用或按门禁 |
| 上游未发布、`ready=false`、`test_data=true`、身份回显缺失、snapshot 不可比或服务不可用 | `unavailable`，`data=null` | 不调用未获资格的端点 |
| 全部输入、权限和上游证据满足后 | 才可评估 `success`/`manual_review` | 仅未来获批准 adapter |

## 7. 权限、租户与权威边界

- 权限仍是 `quote:calculate`；服务端在调用前注入 `ExecutionContext`，不信任客户端传入的 actor、tenant 或上游身份。
- `origin.warehouse_code` 只作为租户范围内映射键；没有显式映射时返回 `needs_input`/`manual_review`，不能用 `province` 推断。
- `quote.canada_final_mile.calculate` 不产生写入；若未来上游预览端点仍有副作用，必须先获得独立合同和审计确认，不能仅靠通知开关声称只读。
- MCP 不计算 Zone、计费托数、燃油、附加费或总价；它只做严格输入校验、必要的单位换算、字段投影和证据/状态传播。
- 结果必须保留规则/数据版本、source refs、assumptions、warnings、blockers 和 calculation trace；`sendable` 继续固定为 `false`。

## 8. 兼容策略

1. v1 文件、历史示例、运行时 v1 校验和其他工具 envelope 不删除、不改字段语义。
2. v1 `quote.canada_final_mile.calculate` 生产资格固定为 `unavailable`，不会把旧 `billing_pallets` 静默解释成 v2 `explicit_pallet_count`。
3. v2 使用独立 Schema 和版本标识；客户端必须一次性补齐新字段，不能由服务端默认最长边、堆叠、手叉车、滞留或托盘数。
4. v2 的 Schema/示例/目录更新不授权 adapter；只有后续 RFC 或主会话接受上游正式合同、租户映射、身份回显、版本/有效期、ready 和 snapshot 证据后，才可单独实现接入。
5. `quote.save_draft` 暂不接受 v2 写入结果；如需支持，另行提交写契约 RFC，完成 preview→approval→commit→readback。

## 9. 迁移步骤

### 客户端

1. 将请求版本切换为 `quote-request@2026-08-13.v2`。
2. 从业务输入或已授权货物记录取得 `explicit_pallet_count`；不得把旧 `billing_pallets` 机械改名。
3. 补齐 `longest_side`（含单位）、`is_stackable`、`pallet_jack` 和 `detention_minutes`，并继续提供完整 CBM、重量、件数、包装和服务字段；未知托盘数明确传 `null`，不传 `0`。
4. 将日期字段规范化为 `YYYY-MM-DD`；拒绝本地时区拼接的 DateTime。
5. 处理 `ready`、`test_data`、`tenant`、canonical `origin`、`effective_date`、`billing_pallets`、`release_id`、`release_hash`、`snapshot_hash`、版本和 `published_at` 的一致性；必须验证 `release_hash===snapshot_hash`；`ready=false` 或证据缺失不能显示为可用报价。

### 服务端/适配器（后续，不在本次）

1. 由服务端完成租户范围 `warehouse_code -> origin` 映射和上游身份注入。
2. 通过 fake HTTP/隔离服务验证请求投影、零调用门禁、响应身份和日期/金额解析。
3. 只有正式上游合同发布并通过 staging readback 后，才评估启用 v2；不以 fixture、未提交分支或本 RFC 作为生产证据。

## 10. 回归验证

本分支必须验证：

- Draft 2020-12 Schema 可编译，所有对象显式 `additionalProperties: false`；
- v2 必填字段缺失失败；未知字段失败；输入 `billing_pallets` 失败；`tenant_id` 输入失败；
- `explicit_pallet_count` 缺失或为 `0` 失败，显式 `null` 和 `>=1` 通过；输出缺少发布/身份字段失败；
- 金额为 JSON number 失败；DateTime 冒充 Date 失败；
- `valid_from`/`valid_to` 为 null 失败；`calculated` 缺 ready/test_data/total/line_items/billing/hash 门禁失败；`manual_review`/`not_calculable` 带非空 total 失败；ready=false 的数据失败，且对应 unavailable envelope 的 data 为 null；
- manual_review data 的 `ready=true`、`test_data=false`、canonical origin 与 warehouse code 分离，并且 release_hash 与 snapshot_hash 相等；
- v2 envelope 的 `success+manual_review`、`manual_review+calculated`、`unavailable/blocked/needs_input+v2 data` 失败；合法 calculated/manual_review/not_calculable envelope 和零调用 `manual_review + data=null`/空 source_refs/空 calculation_trace 通过；带 source_refs 或 calculation_trace 的零调用 manual_review 失败；空 source_refs 的带 data manual_review、source_refs 集合不匹配、success 空 calculation_trace 失败；v1 envelope（含历史 draft）继续通过；
- v1 现有 Schema 可校验历史 quote 示例，但工具目录标明其 `production_eligible=false`/固定 `unavailable`；
- 旧统一包络字段和 v1 行为不变；v2 使用独立 `quote-envelope-v2.schema.json`，v2 manual_review/calculated/unavailable 的完整 envelope 正反例和 v1 历史 envelope 均继续通过相应校验；
- 本任务分支不修改 `package.json` 或其他任务的测试目录；当前 v2 独立契约门禁手工执行 `node docs/contracts/quote-v2-contract.test.mjs`。请主会话在有权修改门禁的 02/06 合法分支或主分支中，将该命令接入 `npm run validate:schemas`，不新增依赖，并重新运行正式发布门禁；
- 运行独立契约测试、Schema 校验、相关现有测试、typecheck、lint 和 `git diff --check`；不访问真实 URL、token、数据库或生产网络。

## 11. 回滚方式

本次没有数据迁移、生产配置或上游发布。若主会话拒绝 v2，只需回滚本 RFC、v2 Schema、v2 示例和目录/矩阵文档更新；保留现有 v1 Schema 与历史示例，quote 生产仍固定 `unavailable`。若未来 v2 已实现但验收失败，撤销 v2 工具注册/启用标志即可，不删除 v1 文件，不把 v2 请求降级解释成 v1。

## 12. 发布结论

本 RFC 和本分支文档只完成“契约可评审”状态。候选 `/quotes/zone-preview` 仍是未发布/未授权上游；没有 HTTP adapter、生产 endpoint、认证、租户映射或部署 readback。任何生产连接、报价成功、价格可发送或上游已可用的表述均不在本变更范围内。
