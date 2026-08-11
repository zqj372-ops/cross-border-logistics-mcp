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
| `quote.canada_final_mile.calculate` | 按邮编/Zone/规则/费表计算加拿大尾程试算 | 读/试算 | `quote:calculate` | 只按已版本化权威规则查表并追踪命中 | 默认地址类型、线性 Zone 外推、改价、发送 |
| `customs.ca.search` | 查询加拿大 HS 候选、税目、措施和缺失问题 | 读 | `tariff:read` | RiskCustoms 候选和来源/有效期映射 | 把候选变正式归类、绕过 ready gate |
| `customs.ca.estimate` | 依据已选候选和版本化官方数据做进口税估算 | 读/试算 | `tariff:estimate` | 税率表达式、估算基数和确认边界可回放 | 正式报关结论、补造税率/SIMA |
| `quote.save_draft` | 保存现有报价系统的报价草稿 | 写（窄） | `quote:draft_write` | 只写明确草稿边界，必须读回 | 发布、发送、覆盖历史报价、改价格/Zone |
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

### `quote.canada_final_mile.calculate`

**输入**

```text
schema_version: string, required
version: string, required
origin: { warehouse_code: string, province: string }, required
destination: { country: const CA, province: string|null, city: string|null, postal_code: string|null, address_type: commercial|residential|unknown, full_address_ref: OpaqueReference|null }, required
cargo: { cargo_result_ref: string|null, billing_pallets: integer|null, weight_kg: Measurement|null, pieces: integer|null, package_types: string[] }, required
services: { appointment: boolean, liftgate: boolean, limited_access: boolean, remote_area: boolean }, required
effective_at: YYYY-MM-DD, required
```

邮编优先级、FSA/城市锚点、托数、基础价、燃油和附加费必须由适配器/确定性引擎执行。`origin + zone + billing_pallets` 的查表结果、规则版本、价格版本和附加费来源必须进入 trace/source refs。输出 `quote-result.schema.json`，Phase 1 强制 `sendable=false`。

**状态**

- `success`：邮编/Zone 唯一、地址类型已确认、价格矩阵覆盖、有效期和费用来源完整。
- `needs_input`：缺邮编、地址类型、始发仓、货物/托数或服务选项。
- `manual_review`：邮编冲突、唯一锚点不足、表无价、供应商确认、重量证据冲突或规则版本不确定；不输出可发送总价。
- `blocked`：试图改价、发布、发送或使用未经审批的 Zone。
- `unavailable`：现有报价系统或权威规则适配器不可用；不回退到地图/聊天/公开参考价。

### `customs.ca.search`

**输入**

```text
schema_version: string, required
version: string, required
rule_date: YYYY-MM-DD, required
query_kind: exact_code|name_search|candidate_selection, required
query_code: string|null, optional
product_description_ref: OpaqueReference|null, optional
product_attributes: { material: string|null, use: string|null, origin_country: string|null, contains_steel_aluminum: boolean|null }, required
selected_hs6: string|null, optional
```

输出 `customs-search-result.schema.json`。返回候选、候选状态、缺失问题、来源、release 和就绪状态；自然语言/AI 只能帮助提出问题，不能把候选标成 confirmed。

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

**状态**

- `success`：只表示可按已发布版本形成估算，不表示正式报关结论。
- `needs_input`：缺原产国、货值、进口日期、候选或计税信息。
- `manual_review`：候选未确认、措施 scope/出口商不完整、税率表达式无法确认或 broker 需审阅。
- `unavailable`：RiskCustoms `ready=false`、release 缺失或官方数据不可读取。
- `blocked`：请求写入归类结论、修改税率或对外出具正式报关结论。

### `quote.save_draft`

这是唯一允许保存报价系统草稿的 Phase 1 工具之一，目标系统必须是现有报价系统的明确草稿/记录边界。

**输入**

```text
schema_version: string, required
version: string, required
quote_result: QuoteResult, required; sendable must be false
target: const { system: existing_quote_system, record_kind: draft }, required
write_context: WriteContext, required; tenant_context由服务端注入并校验
```

`operation_mode=preview` 只生成 `preview_ref` 和请求摘要；`operation_mode=commit` 必须提供同一 preview、幂等键和适用审批状态。服务器不得信任模型提交的 actor/tenant 字段。输出 `write-result.schema.json`，提交成功必须包含 `ReadbackEvidence.verified=true`；`record_id`、observed version 和 readback source ref 不得省略。

**状态**

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
