# Phase 1 工具目录与契约

工具名称、字段和状态是共享基线的一部分。工具必须是窄语义业务动作；禁止把多个写动作包进一个通用 `commit_operation`。每个工具都返回 [`envelope.md`](envelope.md) 所定义的统一包络。

## 通用输入约束

- 网关先校验 `schema_version`、tenant/actor context、工具权限、请求大小和敏感输入引用，再调用领域代码或适配器。
- 结构化地址可以包含为计算所需的 country/province/city/postal code/address type；完整街道地址、客户原话、税务材料和附件只通过 `OpaqueReference` 传递，日志不落原文。
- 所有版本字段使用 `version`/`rule_version`/`data_version`/`release_version` 等显式字段；不接受 `latest` 作为唯一版本。
- 计算工具不可调用外部写接口；查询工具不得隐式创建记录；写工具只能执行本表明确列出的一个动作。
- `source_refs` 必须只包含实际读取/计算所用来源；搜索结果未参与计算时只能作为 supporting source。

## 工具总览

| 工具 | 作用 | 读/写 | 权限 | 确定性边界 | Phase 1 禁止 |
| --- | --- | --- | --- | --- | --- |
| `knowledge.search_curated` | 搜索当前精选 SOP、规则说明、模板、异常案例 | 读 | `knowledge:read` | 检索排序和版本过滤确定；AI 可解释 | 搜索 archived 文档、让解释性资料覆盖可执行数据 |
| `system.get_data_status` | 查询现有系统和数据发布就绪状态 | 读 | `system:read` | 直接映射源状态 | 把 `ready=false` 补成可用 |
| `cargo.calculate` | 计算 CBM、体积重、实际重、分泡和计费重 | 读/试算 | `quote:calculate` | 单位换算、合计、分泡公式、互斥重量证据 | 缺证据时猜重量、使用全局除数 |
| `container.plan_summary` | 计算理论容量与可操作目标的装载摘要 | 读/试算 | `container:calculate` | 汇总方数、重量、比率、超方超重和顺序摘要 | 3D 装箱承诺、把物理容量当可操作容量 |
| `quote.canada_final_mile.calculate` | 按明确版本请求经发布且通过合同核验的加拿大尾程报价服务试算 | 读/试算 | `quote:calculate` | v1 历史契约继续可校验；v2 只做严格输入/身份/来源投影，当前 `production_eligible=false` | 本地持有 Zone/价格/规则表、默认货物字段、线性外推、改价、发送 |
| `customs.ca.search` | 查询加拿大 HS 候选、税目、措施和缺失问题 | 读 | `tariff:read` | RiskCustoms 候选和来源/有效期映射 | 把候选变正式归类、绕过 ready gate |
| `customs.ca.estimate` | 预留进口税估算工具；当前无已核验生产 API 合同 | 读/试算 | `tariff:estimate` | 固定 `unavailable`，不拼造税额 | 正式报关结论、补造税率/SIMA |
| `quote.save_draft` | 保存经授权报价系统的报价草稿 | 写（窄） | `quote:draft_write` | 当前固定 `unavailable`；只有生产草稿 API 合同、审批和写后读回齐全后才可启用 | 发布、发送、覆盖历史报价、改价格/Zone |
| `quote.create_pdf` | 从当前权威报价创建不可发送的内部 PDF 草稿 | 写（窄、非破坏） | `quote:pdf_write` | `write`/idempotent/open-world；preview 只形成服务端候选 hash，commit 只投影权威 USD lines 并 exact readback；当前 contract-only/disabled | 下载、发送、发布、删除、覆盖、模板、状态查询、模型提供金额/line items |
| `review.create_task` | 创建一个人工复核任务 | 写（窄） | `review:create_task` | 任务字段、原因码、opaque context、读回可确认 | 自动解决复核、自动上线规则 |

## 逐项契约

### `knowledge.search_curated`

**输入**

```text
schema_version: string, required
query: string, required, 1–200 chars; 不携带客户原文时使用 opaque_context_ref
scope: enum [quote, cargo, container, customs, operations, all], required
include_archived: const false, required
version_constraint: string|null, optional
opaque_context_ref: OpaqueReference|null, optional
```

`query` 只用于检索；结果摘要不能成为价格、税率、Zone 或权限依据。输出 `data` 使用 `knowledge-search-result.schema.json`，每条结果必须有 SourceRef 和版本。

**状态**

- `success`：返回精选、非 archived 结果；无命中也可以 success，但 `results=[]` 并给 warning。
- `needs_input`：scope 或可检索关键词缺失。
- `unavailable`：索引/精选目录不可用；不得回退到所有历史文件。
- `blocked`：请求读取无权限或试图检索凭证/密钥资源。

### `system.get_data_status`

**输入**

```text
schema_version: string, required
system: enum [quote, customs, container, knowledge, all], required
rule_date: YYYY-MM-DD|null, optional
```

输出 `data-status.schema.json`。对 RiskCustoms 必须原样保留 `ready`、`test_data`、`reasons` 和 `release_ids`；`test_data=true` 不能被映射为生产可用。

**状态**

- 状态成功读取时为 `success`，无论 `data.ready` 是 true 还是 false；如果 `ready=false`，任何依赖该数据的业务工具仍必须返回 `unavailable` 或 `manual_review`。
- 状态端点不可达、快照校验失败或没有可验证版本时为 `unavailable`。

### `cargo.calculate`

**输入**

```text
schema_version: string, required
version: string, required
cargo_lines: CargoLine[], required, minItems=1
dimensional_divisor: Measurement|null, required when channel rule needs it
bubble_rule: { mode: none|full|half|ratio|fixed_density, ratio: decimal string|null, rule_version: string }, required
channel_code: string, required
source_refs: SourceRef[], required
```

输出 `cargo-result.schema.json`。`CargoLine` 中 `unit_weight`、`piece_weights`、`line_total_weight` 互斥；重量的 `unit` 必须是 `kg`（其他单位先由确定性转换步骤明确记录）。长度/体积必须有单位。输出至少包含：

- `CargoMetrics.total_volume`、`actual_weight`、`volumetric_weight` 和 `weight_evidence`；
- `ChargeableWeight.actual_weight`、`volumetric_weight`、`bubble_weight`、客户/供应商计费重和 `bubble_share_ratio`；
- 计算 trace：每条单位换算、体积相乘、除数、分泡公式和规则版本。

**状态**

- `success`：所有参与计算的行有足够证据，且渠道除数/分泡规则有版本来源。
- `needs_input`：缺尺寸、数量、重量证据、渠道或分泡比例。
- `manual_review`：同一行混用重量证据、单位冲突、客户重与供应商重口径冲突，或无法确认包装/渠道规则。
- `blocked`：非授权 actor 试图提供/覆盖规则或请求写入规则。

### `container.plan_summary`

**输入**

```text
schema_version: string, required
version: string, required
container_type: enum [20GP, 40GP, 40HQ, 45HQ, other], required
physical_capacity: Measurement(unit=cbm), required
operational_target: Measurement(unit=cbm), required
max_payload: Measurement(unit=kg), required
cargo_metrics: CargoMetrics, required
loading_constraints: { sensitive_at_head: boolean, declaration_at_tail: boolean, fifo_for_other: boolean, customer_priority: integer|null }, required
```

输出 `container-plan.schema.json`。必须同时返回理论 `physical_capacity` 和运营 `operational_target`；输出 `theoretical_only=true`，不能声称 3D 坐标、重心或实际装载可执行。`loading_order` 只能是摘要顺序，特殊货物、敏感货、报关件和优先级必须进入 warnings/trace。

**状态**

- `success`：容量、目标、载重和输入版本齐全，得到汇总摘要。
- `needs_input`：缺柜型、货物汇总或容量/载重单位。
- `manual_review`：无运营目标版本、约束冲突、超方/超重或需要现场确认。
- `blocked`：请求生成 3D/坐标承诺或写入仓库装柜记录。

### `quote.canada_final_mile.calculate` v1（历史兼容）

**输入**

```text
schema_version: string, required
version: string, required
origin: { warehouse_code: string, province: string }, required
destination: { country: const CA, province: string|null, city: string|null, postal_code: string|null, address_type: commercial|residential|unknown, full_address_ref: OpaqueReference|null }, required
cargo: { cargo_result_ref: string|null, billing_pallets: integer|null, weight_kg: Measurement|null, pieces: integer|null, package_types: string[], total_volume: Measurement(unit=m3|cbm)|null, optional }, required
services: { appointment: boolean, liftgate: boolean, limited_access: boolean, remote_area: boolean }, required
effective_at: YYYY-MM-DD, required
```

候选报价预览端点尚未发布为可用上游合同，当前不调用；未来仅在正式合同获批后由适配器按明确端点投影。MCP 不持有 Zone、价格或规则表，也不在本地运行确定性报价引擎。只映射 API 响应和真实来源，输出 `quote-result.schema.json`，Phase 1 强制 `sendable=false`。

v1 的历史输入/输出 Schema 和示例继续保留，可用于兼容校验；`cargo.billing_pallets` 不得在任何迁移中被静默解释为 v2 的 `explicit_pallet_count`。v1 `production_eligible=false`，生产固定返回 `unavailable`。

### `quote.canada_final_mile.calculate` v2（评审契约，未启用）

**输入 Schema：** `quote-request-v2.schema.json`
**版本：** `quote-request@2026-08-13.v2`
**统一包络：** v2 使用独立 `quote-envelope-v2.schema.json`；字段形状和 `schema_version=2026-08-11.v1` 与统一包络一致，旧 `envelope.schema.json` 不引用 v2，不扩展其他工具字段、状态或权限。

```text
schema_version: 2026-08-11.v1, required
version: quote-request@2026-08-13.v2, required
origin: { warehouse_code: string, province: string }, required; warehouse_code 只经租户范围显式映射
destination: { country: const CA, province: string|null, city: string|null, postal_code: string|null, address_type: commercial|residential|unknown, full_address_ref: OpaqueReference|null }, required
cargo: { cargo_result_ref: string|null, explicit_pallet_count: null|integer>=1, longest_side: LengthMeasurement(>0), is_stackable: boolean, weight_kg: WeightMeasurement(>0), pieces: integer>=1, package_types: string[exactly 1], total_volume: VolumeMeasurement(>0) }, required
services: { appointment: boolean, liftgate: boolean, pallet_jack: boolean, detention_minutes: integer>=0, limited_access: boolean, remote_area: boolean }, required
effective_at: YYYY-MM-DD, required
```

v2 不接受公开 `tenant_id` 或 `cargo.billing_pallets`。`explicit_pallet_count` 必须显式出现；未知时只能为 `null`，不能用 `0` 或默认托数。`longest_side`、`weight_kg`、`total_volume` 严格大于 `0`，`package_types` 恰好一个值，adapter 不猜选。`limited_access=true` 或 `remote_area=true` 时必须零调用并进入 `manual_review`；此类零调用门禁使用 `data=null`、空 `source_refs` 和空 `calculation_trace`，不得伪造报价、发布或来源。

**输出 Schema：** `quote-result-v2.schema.json`；v2 envelope Schema：`quote-envelope-v2.schema.json`。v2 data 只允许来自 `ready=true`、`test_data=false` 的 active manifest；`valid_from`/`valid_to` 是必需非空 Date。除现有金额、版本、来源和 `sendable=false` 外，必须保留 `tenant`、`effective_date`、`ready`、`test_data`、canonical `origin`、上游结果 `billing_pallets`、`snapshot_hash`、`service_version`、`contract_version`、`release_id`、`release_hash` 和 `published_at`。`quote.calculate` 只读，不接受 `draft_saved`；金额仍为 decimal string + ISO 4217 三位币种。

`origin` 是引擎实际返回的 canonical origin，不是 `origin.warehouse_code`；二者必须通过服务端显式映射关联。adapter 必须验证 active manifest、有效期覆盖 `effective_date`、`release_hash === snapshot_hash`，并拒绝不一致或缺失的发布证据。v2 外层状态精确映射为：`success` ↔ `quote_status=calculated`；带 quote data 的 `manual_review` ↔ `quote_status=manual_review|not_calculable`；零调用门禁的 `manual_review` ↔ `data=null`、空 `source_refs`、空 `calculation_trace`；`unavailable|blocked|needs_input` ↔ `data=null`。带 v2 `data` 的 `success`/`manual_review` envelope 必须有至少一项 `source_refs`，且 data、所有 line items、calculation trace 的 `source_ref_ids` union 与外层 `source_refs` IDs 是同一精确集合；`success` 还必须有至少一项 `calculation_trace`。`ready=false` 必须返回 v2 envelope `status=unavailable` 且 `data=null`；旧 envelope 继续按 v1 Schema 校验。

**v2 当前状态**

- `production_eligible=false`；候选 `/quotes/zone-preview` 尚未发布为可用上游合同，本次不调用、不实现 HTTP adapter。
- MCP 只做严格校验、单位换算、字段投影和证据传播，不计算 Zone、计费托数、燃油、附加费或总价。
- v2 `success` 仅在来源 `ready=true`、`test_data=false`、身份字段一致、金额/日期/发布证据完整时才可评估；本分支不提供生产成功证明。

**v2 状态**

- `needs_input`：缺 v2 必填字段、`explicit_pallet_count` 未知且不能明确为 `null`、单位/日期/金额格式错误；零上游调用。
- `manual_review`：上游响应冲突、服务合同缺失或需要人工确认；若有 `data`，来源必须 ready 且非测试并保留完整 `quote-result-v2`/`source_refs`；`limited_access`/`remote_area` 零调用时必须使用 `data=null`、空 `source_refs` 和空 `calculation_trace`。
- `unavailable`：上游未发布、`ready=false`、`test_data=true`、release/snapshot 证据缺失或适配器未获资格；`ready=false` 不带 quote data。
- `blocked`：越权、跨租户、试图改价/发送/发布或覆盖服务端身份。

**v1 历史适配状态**

- HTTP adapter 已实现并通过 fake-HTTP/local 组合测试，但经 10A 审查发现生产合同阻塞，未获生产启用资格，当前工具路径保持 `unavailable`/fail-closed。
- 三项未决合同问题：上游端点存在非零业务写副作用；正式输入到 `cbm`/`origin` 的映射不成立；真实响应缺业务版本/有效期证据。不以本地 Zone/价格/规则表或 fixture 代替上游合同。

**合同核验后的候选状态语义**

- `success`：API 返回必要字段、地址/服务映射和上游来源/有效期证据完整。
- `needs_input`：缺 API 合同要求的 origin、CBM、地址类型、货物/托数或服务选项。
- `manual_review`：API 响应冲突、上游来源/版本证据不完整或需要供应商确认；不输出可发送总价。
- `blocked`：试图改价、发布、发送或覆盖 API 结果。
- `unavailable`：现有报价系统或权威规则适配器不可用；不回退到地图/聊天/公开参考价。

### `customs.ca.search`

**输入**

```text
schema_version: string, required
version: string, required
rule_date: YYYY-MM-DD, required
query_kind: exact_code|name_search|candidate_selection, required
query: string, optional; trim 后 1–200 字
query_code: string|null, optional
product_description_ref: OpaqueReference|null, optional
product_attributes: { material: string|null, use: string|null, origin_country: string|null, contains_steel_aluminum: boolean|null }, required
selected_hs6: string|null, optional
```

输出 `customs-search-result.schema.json`。返回候选、候选状态、缺失问题、来源、release 和就绪状态；自然语言/AI 只能帮助提出问题，不能把候选标成 confirmed。

每次搜索先 GET `/api/status`；只有响应 `ready=true` 才 POST `/api/query`。`release`、`testData` 和来源版本只取自 status/query 响应，不由 MCP 生成或补造。

**状态**

- `success`：RiskCustoms 数据 `ready=true` 且候选/来源版本完整。
- `needs_input`：缺材料、用途、原产国等影响候选的问题。
- `manual_review`：候选冲突、法规属性未定、贸易措施 scope 不足或 broker 必须确认。
- `unavailable`：`ready=false`、release/snapshot 不可用、数据为 test fixture 或源校验失败。

### `customs.ca.estimate`

**输入**

```text
schema_version: string, required
version: string, required
rule_date: YYYY-MM-DD, required
classification: { hs_code: string, status: candidate|confirmed, source_ref_ids: string[] }, required
origin_country: string, required
value_for_duty: Money, required
import_date: YYYY-MM-DD, required
trade_treatment: string|null, required
```

输出 `customs-assessment.schema.json`。每条税率/附加税/SIMA 项必须保留原始表达式、确认布尔值、版本和 source refs。总额只能是估算，`requires_broker_confirmation` 默认 true，除非后续批准的适配器契约明确允许改变。

**当前状态**

- 当前无已核验生产 API 合同，工具固定返回 `unavailable` 且零 HTTP 请求；Schema 与注册保留，不拼造税额。
- 后续只有在生产 estimate API 合同、认证、来源版本和失败映射核验完成后，才评估 `needs_input`、`manual_review` 或 `success` 的实际映射。

### `quote.create_pdf`（契约已定义，当前未注册）

这是唯一的 PDF 创建工具；不新增 `pdf.download`、`pdf.send`、`pdf.template` 或 `pdf.status`。它是 `write`、non-destructive、idempotent、open-world 工具，权限为 `quote:pdf_write`，允许角色为 `admin`、`sales`、`operator`。当前只完成共享契约，runtime 不注册、不调用。

**输入 Schema：** `quote-create-pdf-request.schema.json`

```text
schema_version: 2026-08-11.v1, required
quote_request: quote-request-v2.schema.json, required
presentation: { customer_display_name: string, 1–200 }, required
write_context: common.schema.json#/$defs/WriteContext, required
```

根、`presentation` 和所有新增 object 均为 `additionalProperties=false`。`quote_request` 直接引用现有 quote v2 请求，模型不能传 `total`、`line_items`、金额、logo、path、html、url、公开 `tenant_id` 或其他未声明字段；完整地址、附件和敏感正文只能使用既有 opaque reference。网关请求体上限为 32 KiB。

**输出 Schema：** `write-result-v2.schema.json`（`$id` 为 `2026-08-13`，`version=write-result@2026-08-13.v2`，operation 固定为 `quote.create_pdf`）；外层使用 `quote-create-pdf-envelope.schema.json`。旧 `write-result.schema.json` 的 `$id`、字节和 operation 接受集合不变，不建立 PDF 结果大 Schema。preview 返回 `operation_status=previewed`、opaque `preview_ref`、`record_id=null` 和无 readback；commit success 返回 `operation_status=committed` 或已知重放的 `already_committed`，`record_id` 为 PDF document reference，`readback_evidence.verified=true`。

**Preview → commit：** preview 只调用 AI Quote `/quotes/zone-preview` v2，形成服务端 candidate hash，零 PDF POST，不把金额/line items 回显模型。commit 必须同 tenant、request、presentation、`preview_ref` 且 approval 为 approved；服务端重新调用 AI Quote，候选或发布 evidence 漂移为 `manual_review`。只有重新得到权威 quote success 后，服务端才投影权威 USD line items，并固定内部 `sendable=false`。

Preview 和 commit 必须使用不同的平台幂等键：preview 用 `P`，commit 用 `C`，`P ≠ C`；只有 commit 的 `C` 原样转发为 PDF `Idempotency-Key`，同一 commit retry 复用 `C` 和同一 body。201/200 后必须 GET metadata 并精确核对 tenant、request/presentation、candidate/quote hash、version、`sendable=false` 和 document reference；只有 exact readback 才 success。dispatch 前连接失败为 `unavailable`；已 dispatch 后 response timeout/unknown、POST 丢响应、GET 404 或 identity/hash/version mismatch 为 `manual_review`，不能盲目重复未知写入。

**状态：** 输入错误为 `needs_input`；权限/审批/tenant/credential/409 为 `blocked`；Quote 的 `needs_input`/`manual_review`/`unavailable` 原样保留；PDF 400/413 为 `unavailable`，401/403 为 `blocked`，503 或 dispatch 前连接失败为 `unavailable`，已 dispatch 后 response timeout/unknown 为 `manual_review`。outer source refs/trace 必须同时闭合 AI Quote 权威证据和 PDF GET readback 证据。

**生产资格：** 当前只核验到 loopback HTTP，production 默认 disabled。当前 composition 实际为 10s，start 的 15s 未传入 composition；后续 task02 必须让 start 显式传入单一约 30s absolute deadline，composition/adapter 各阶段共享 remaining、不能每阶段重置，task06 再用 re-quote、renderer 8s、一次恢复和 GET 验收它。只有 AI Quote 正式 API、PDF HTTPS+allowlist、tenant credential、staging POST/replay/GET exact readback、该 deadline 和平台失败闭合全部验收后，才可由后续适配任务实现和注册。不在 MCP 本地生成或保存 PDF 权威记录。

### `quote.save_draft`

这是唯一允许保存报价系统草稿的 Phase 1 工具之一，目标系统必须是经发布且通过合同核验的报价系统草稿/记录边界；当前没有已核验的生产写端点。

**当前状态**

- 当前固定返回 `unavailable`。生产写 API、租户认证、幂等、preview/approval/commit 和写后读回合同尚未齐全；Schema 与注册不删除。
- 只有上述合同全部由已发布且通过合同核验的 API 覆盖后，才可启用生产路径。

**输入**

```text
schema_version: string, required
version: string, required
quote_result: QuoteResult, required; sendable must be false
target: const { system: existing_quote_system, record_kind: draft }, required
write_context: WriteContext, required; tenant_context由服务端注入并校验
```

`operation_mode=preview` 只生成 `preview_ref` 和请求摘要；`operation_mode=commit` 必须提供同一 preview、幂等键和适用审批状态。服务器不得信任模型提交的 actor/tenant 字段。输出 `write-result.schema.json`，提交成功必须包含 `ReadbackEvidence.verified=true`；`record_id`、observed version 和 readback source ref 不得省略。

**启用后的状态语义**

- `success`：预览成功或草稿写入并完成写后读回；重复幂等请求返回同一 record/readback 证据。
- `manual_review`：审批/预览不一致、写后读回不一致、目标系统返回不确定结果。
- `blocked`：企图发布/发送/覆盖历史/改价/改 Zone，权限不足或跨租户。
- `unavailable`：目标适配器不可用；不在 MCP 本地另存一份权威草稿。

### `review.create_task`

**输入**

```text
schema_version: string, required
version: string, required
task_type: quote|customs|container|data_conflict|source_unavailable, required
priority: low|normal|high|critical, required
reason_codes: string[], required, minItems=1
opaque_context_refs: OpaqueReference[], required, minItems=1
write_context: WriteContext, required
```

只创建人工复核任务，不把原始客户地址、税务材料或凭证放入任务正文。输出 `write-result.schema.json`，`operation` 固定为 `review.create_task`，读回证据指向现有复核任务记录。

**状态**

- `success`：任务已创建并读回；`review_status=pending`。
- `manual_review`：任务已创建但目标系统读回不完整，或需要人工确认幂等冲突。
- `blocked`：非授权 actor、跨租户 context、试图自动 resolve/上线规则。
- `unavailable`：现有人工任务系统不可用。

## 工具返回的最小审计字段

每次调用均生成服务端 `audit_id`，并保存：tenant/actor/client（脱敏 ID）、tool、request_id、schema/version、status、source IDs、rule/data versions、reason codes、duration、idempotency result 和 readback status。原始输入仅保留 opaque reference 的哈希/生命周期元数据；日志不得落完整地址、客户报价明细、税务材料全文或凭证。
