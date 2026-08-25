---
standard_id: admin-control-state-dto-v1
version: 2026-08-22.v1
priority: 86
audience: developer,reviewer,operator
rule_ids: CONTROL-STATE-001,CONTROL-STATE-002,CONTROL-STATE-003
status: accepted
---

# RFC：Admin control-state DTO 合同闭合 v1

- 日期：2026-08-22
- 范围：Admin control envelope 的 `control_state` 响应 DTO、Zod 合同、checked-in Draft 2020-12 Schema 和合同测试。
- 前置关系：本 RFC 是可写模块控制面 Task 3 服务映射的合同前置门槛；不改变请求合同、公共 MCP 工具合同或控制面数据库。
- 当前事实：仅该 DTO 合同已 accepted；Service、UI、runtime 和 production 均未实现。本 RFC 不是实现或生产资格证明。

## 1. 缺口与问题边界

现有 `control_state` 只有 `active_release_id`、`active_revision`、`active_modules` 和
`inventory_module_ids`，且这些字段在运行时合同中并非完整必填快照。它无法为计划中的 Admin
模块表提供模块风险、local-build 证据边界和登记摘要，也无法驱动待审批卡、preview diff/validation、
release history、rollback target、runtime readback 或脱敏审计事件。若继续沿用该稀疏形状，后续
服务或 UI 只能依赖 fixture/假数据，无法忠实表达控制面状态。

本 RFC 只收口响应 DTO。它不把控制面变成业务主数据源，不复制报价、关务、客户或文档记录，
也不把静态已挂载模块变成运行时下载/热插拔代码。

## 2. 旧合同与新合同摘要

旧合同的典型形状为：

```json
{
  "kind": "control_state",
  "active_release_id": null,
  "active_revision": 0,
  "active_modules": [],
  "inventory_module_ids": []
}
```

新合同仍使用同一个根 `kind=control_state`，但把互相矛盾的三个 active 字段收进单一
`activation` closed union，并把其余字段改为全部必填的闭合快照：

```json
{
  "kind": "control_state",
  "activation": {
    "state": "active",
    "release_id": "release_ref",
    "revision": 3,
    "active_modules": [{"module_id":"cargo","version":"1.0.0","descriptor_digest":"sha256:<64 lowercase hex>"}]
  },
  "inventory_modules": [{
    "module_id":"cargo",
    "version":"1.0.0",
    "risk_level":"T0",
    "descriptor_digest":"sha256:<64 lowercase hex>",
    "evidence_level":"local_build",
    "production_eligible":false,
    "tool_names":["cargo.calculate"],
    "standard_ids":["cargo.contract.v1"],
    "registration": {"registered_by_actor_ref":"actor_ref","registered_at":"<RFC3339>"}
  }],
  "latest_preview": null,
  "latest_approval": null,
  "latest_readback": null,
  "release_history": [],
  "events": [],
  "events_truncated": false
}
```

### 2.1 闭合嵌套 DTO

- `activation` 只有两支。未发布态必须精确为 `state=inactive`、`release_id=null`、`revision=0`、
  `active_modules=[]`；已激活态必须为 `state=active`、非空 release ID、positive revision 和至少
  一个 active module。`null + revision=1 + non-empty modules` 不再有可表达空间。
- `inventory_modules` 每项固定为 module ID、version、`risk_level`（`T0`–`T3`）、descriptor
  digest、`evidence_level=local_build`、`production_eligible=false`、有界 `tool_names`、有界
  `standard_ids` 和 `registration`。登记摘要只能是 `null` 或
  `registered_by_actor_ref` + `registered_at`。
- `latest_preview` 是按 `intent` 区分的 change/rollback union。两支都固定包含 preview ref、
  preview canonical hash、base release/revision、desired modules、added/removed/retained diff、
  四项 validation 布尔值及 reason codes、creator、created/expires 时间和 consumed；只有 rollback
  支持 `target_release_id`，change 分支拒绝该字段。
- `latest_approval` 按 decision 闭合：approve 可以处于 consumed true/false；reject 必须
  `consumed=false`，不能伪装成已被 publish 消费。
- `latest_readback` 按 status 闭合。verified 分支不再重复 applied release ID/revision，其形状本身
  表示目标 ID/revision exact；`ModuleControlService.getState` 的 producer 语义断言还必须验证
  target/applied modules 与 active activation 一致。mismatch/unknown 只接受
  `observed_activation={release_id:null,revision:null}` 或二者均非 null 且 revision positive；pending
  固定 `observed_activation=null`。除 inactive activation 的 revision 0 外，release/readback 的
  非 null revision 均为 positive integer。
- `release_history` 是有界、newest-first 的 producer projection。每项同时按 release status 和
  intent 闭合：change 禁止 `rollback_target_release_id`，rollback 必须携带该字段；
  active/manual-review/superseded 的 `published_at` 不得为 null，pending 的 `published_at` 可为 null
  且 `readback_ref` 必须为 null，与 repository `ModulePendingReleaseRecord.readbackRef=null`
  一致；所有 release revision positive。DTO parser 为旧 fixture/migration diagnostic 保留
  `latest_readback.status=pending` 结构分支，但 v1 repository/Service producer 不得生成该分支：claim
  不写 `module_readbacks` row，pending release 的 latest readback 只能是 null、旧 active release 的
  terminal verified readback，或同一 unresolved release 上一次 finalized attempt 的 terminal
  mismatch/unknown 投影。不得把 attempt ref 伪造到 pending history 上。
- `events` 只包含 sequence、event ID、actor ref、action、object ref、kind、status、reason codes 和
  occurred_at；action + kind + status 是 registration、preview、approval、release、publish/readback
  reconciliation、operator reconciliation、idempotency 七类 closed union，而不是三个独立 enum。
  不包含 detail、raw payload 或任意扩展 map。

根 envelope 继续 closed，`data` 继续是 `null` 或 `kind` discriminated union，五种状态仍严格为
`success`、`needs_input`、`manual_review`、`blocked`、`unavailable`。实现不得使用 `z.record`、
`unknown` 或 generic map 作为 DTO 承载。

## 3. 有界性、词法和脱敏边界

v1 固定上限如下，超过即拒绝而不是静默截断：

| 集合 | 上限 |
| --- | ---: |
| active/inventory/desired/applied/diff module refs | 64 |
| 每个 inventory module 的 tool names | 128 |
| 每个 inventory module 的 standard IDs | 64 |
| release history | 128 |
| events | 256 |
| 每个 reason-code 数组（包含根 envelope） | 32 |

所有 module-ref 数组、`tool_names`、`standard_ids` 和 inventory item 数组拒绝 exact duplicate；
JSON Schema 使用 `uniqueItems=true`。module ref 与 inventory 的业务重复键不是完整对象，而是
`module_id + version`：Zod 在能表达的数组内直接按该 logical key 拒绝，即使两个对象的 digest 或
其他安全摘要不同。Draft 2020-12 的标准 `uniqueItems` 只能比较完整 JSON 值，无法声明“任意两项
的两个子字段不得相同”，所以 checked-in Schema 对这类跨 digest logical duplicate 只能做到 exact
duplicate 拒绝；所有 service producer 仍必须再调用本 RFC 的语义断言，使 Ajv 接受但 logical key
冲突的输入在输出前 fail closed。该受限差异必须保留在测试和文档中，不得伪称纯 JSON Schema 已
验证跨项 logical identity。

标识符继续使用现有严格 identifier pattern，version 使用现有 version pattern，descriptor digest
继续为 `sha256:<64 lowercase hex>`；preview canonical hash 使用现有
`mcp-control-hash/v1/preview/sha256:<64 lowercase hex>` 形状。所有时间使用现有严格 RFC3339
子集，包含 `Z`/`+HH:MM`/`-HH:MM`、公历闰日和 1–9 位小数秒；不得为适配
JavaScript 毫秒时间而收窄到 3 位。所有权威时间先后关系先将公历日、时分秒、
offset 和右补零到 9 位的小数秒精确转为 `bigint` 纳秒 instant，不使用会折叠
亚毫秒精度的 `Date.parse`/浮点比较；无法解析时 fail closed。整数限制在 JavaScript
safe integer 范围。

应用层的严格 pattern、epoch 纳秒 parse/compare、UTC format 与固定毫秒加法以
`control-plane/rfc3339-instant.ts` 为唯一公共实现；`contracts.ts` 兼容 re-export pattern，
DTO producer 语义、repository record assertion 和 Fake repository 的 24 小时 idempotency TTL、
expiry gate、latest projection 均复用该实现。当前 SQLite store 仍保留其私有的等价纳秒实现；
本轮不修改正在复审的 SQLite 文件，只用 Fake/SQLite parity 回归约束两者结果。该边界不代表
SQLite 去重已经完成。

现有 version pattern 可能接受外观类似 URL 的字符串；这是既有 trusted server inventory 词法，
本 DTO 不私自改变。该值只能来自 server-owned inventory，Admin UI 必须用 `textContent` 或等价
escaping 当普通文本渲染，禁止把 version 解释为链接、HTML、资源地址或可导航 URL。

DTO 不允许 evidence refs、source refs、URL、路径、源码位置、email、token、secret、客户原文、
凭证正文、事件 detail 或 raw payload。`registration` 只保留脱敏 actor ref 和时间；控制事件只保留
受控对象引用和 reason/status 摘要。`local_build` 和 `production_eligible=false` 是证据边界，不能
被解释为 artifact signature、source attestation 或生产资格。

## 4. 兼容策略与权限/状态不变

- Admin 请求 `schema_version=2026-08-22.v1` 不变；请求 canonical hash、preview canonical hash、
  JCS/NUL framing 和 RFC golden hash 不变。
- 通用 envelope 的 `registration`、`preview`、`approval`、`release`、`reconciliation` 数据字段仍
  保留 legacy optional 形状，避免在本前置任务中强迫修改 repository/SQLite/fake/service；preview
  的 canonical hash、diff、validation、creator、created_at、consumed 仍为可选闭合字段。
- 这不等于完全 fixture-compatible。未发布 v1 在本轮受控收紧了根 `reason_codes`（最多 32）、
  preview request/legacy preview `desired_modules`（最多 64；Zod/producer 按 module ID/version
  logical unique，JSON Schema 至少 exact unique）、legacy release `active_modules`（同一上限与
  uniqueness 边界）、pending history 的 `readback_ref=null` repository 真实形状，以及非 null
  release/readback revision（positive）。越界、重复、给 pending 伪造 readback ref 或 revision 0 的
  现有 fixture 必须迁移；不得通过放宽 producer 硬门保留。
- `control_state` 从旧的三个 active 字段重构为 required `activation` union，并增加完整 required
  snapshot。由于 v1 尚未发布，这是响应合同的受控收口，不改变请求 schema version 或 golden
  hash，但所有旧 control-state fixture/producer 都必须迁移。
- 通用 envelope 只承担旧 fixture 的解析兼容；HTTP/service producer 必须额外通过导出的
  `controlProducerEnvelopeSchema`/`assertControlProducerEnvelope`。因此 `{kind:"release"}` 仍可被
  legacy parser 读取，但绝不能作为 publish success 从服务返回。
- `assertControlProducerEnvelope` 与 `assertControlStateProducerSemantics` 不再以 TypeScript
  `asserts` 声称传入的可变对象安全。它们先取得一次 plain-data snapshot、执行 Zod/producer 语义
  校验，再返回 detached、递归 `Object.freeze` 的解析结果；Task 3 调用者必须使用返回值，不能继续
  返回或缓存原对象。所有 Proxy（包含透明转发 Proxy）都必须在任何
  `Reflect.getPrototypeOf`/property-descriptor 操作前用 `node:util` `types.isProxy` 拒绝，不得
  触发其 trap 或 target getter。ordinary object 只接受精确 `Object.prototype`；null/custom
  prototype、accessor/getter、循环或其他非 plain JSON 对象均以稳定脱敏
  `ControlContractError` 失败，不回显原始异常或输入值。
- 权限、tenant/actor 服务端注入、四眼审批、幂等、发布/readback 状态机和五状态语义不变。DTO
  只展示它们的脱敏结果，不授予任何写权限，也不改变 `active_verified`/`verified` 只代表当前
  runtime exact readback 的含义。
- `ready=false`、readback mismatch/unknown 和其他失败门禁仍不能被 AI、fixture 或 DTO 映射成
  `success`；服务映射必须保留 `manual_review`/`unavailable` 等真实状态。

## 5. 服务映射边界

后续 `ModuleControlService.getState`/repository adapter 负责把内部记录映射为该 DTO：

1. 从当前构建 inventory 生成完整 `inventory_modules`，仅投影 local-build evidence 和登记摘要，
   以及 inspector 所需的 bounded tool names/standard IDs；丢弃 evidence refs 与内部数据库 tenant
   字段。
2. 从最新 preview/approval/readback/release 记录按对应闭合 union 投影；状态不一致时在服务层
   返回适当失败状态或 `manual_review`，不能借 DTO 结构掩盖冲突。
3. `ModuleControlState` 已包含 `releaseHistory` 和权威 `eventsTruncated` 字段；现有 Fake
   repository 与 SQLite repository 已提供这两个 projection：release history 最多 128 项并按
   revision/release ID 保持 newest-first，events 窗口有界且由 `eventsTruncated` 明确是否发生截断。
   因此“当前 repository state 合同没有这两个 projection”的旧前置事实已过时。Task 3 的 service
   mapping 必须直接消费这两个字段，禁止只看返回的 event 数组长度猜 truncation，也禁止从 events
   反推 release history。
4. repository 提供的 events 必须按 sequence 严格升序；service 只投影最多 256 条允许的 summary，
   不得把数据库 JSON detail/raw payload 透传。
5. 保留 activation release/revision/module refs 的精确 readback 关系；不得从 inventory 推导 active
   set，也不得用 verified 文案掩盖 mismatch/unknown。

### 5.1 getState producer 语义硬门

纯 Draft 2020-12 无法完整表达跨对象 digest 一致、history 索引、event 窗口顺序及多个 latest
projection 的相等关系。因此 Task 3 的 `getState` 必须把显式映射结果交给导出的
`assertControlStateProducerSemantics`，并且只返回该函数返回的 detached deep-frozen snapshot。
不得调用后继续使用原始 mutable DTO。

断言固定执行以下 producer 索引：

- inventory 的 logical key（module ID/version）唯一。inventory、activation、preview/diff、release
  history 和 verified applied modules 中同一 logical key 的 digest 必须一致；mismatch/unknown 的
  observed applied modules 是 evidence，可忠实表达同 ID/version 但不同 digest 的
  descriptor drift。producer 不得静默改写 observed digest，但该差异使 observation 不再 exact，
  因而绝不能被判为 verified/success 或伪装 active。
- current inventory 只约束当前 activation、未消费 preview 的 desired/diff、当前
  `active_verified` release，以及 newest unresolved（pending/manual-review，即 reconcile target）
  的 desired modules。superseded 历史 release 或已消费 preview 中已不在当前 build inventory 的旧
  module ref 仍可原样展示；否则应用升级会破坏真实 release trail。旧 ref 不能因此直接重新激活：
  以它生成的未消费 rollback preview 仍因 current inventory 缺失而 fail closed。若旧历史复用了
  当前相同 logical key 但 digest 不同，仍属于跨投影冲突。
- history 的 release ID/revision 各自唯一，revision strictly descending 且相邻窗口连续，newer 的
  `previous_release_id` 指向 adjacent older；最多一个 active、最多一个 pending/manual unresolved，
  unresolved 若存在必须 newest。active/older superseded 链及 `superseded_by_release_id` 必须一致；
  rollback 不能指向自身，bounded window 内的 target 必须是更旧 revision。
- inactive activation 不得有 active history 或 verified latest readback。active activation 必须精确
  对应唯一 active history 的 ID/revision/modules；verified readback 再与二者 exact。
- latest readback 若为 mismatch/unknown，必须对应 newest manual-review release 的
  ID/revision/readback ref/reasons；observed pair 与 applied modules 若已经完全等于 target，状态必须是
  verified，继续标成 mismatch/unknown 即拒绝。newest manual-review 不允许 `latest_readback=null` 或
  只保留旧 active verified；newest active（且无更晚 unresolved）不允许 null，必须有对应 verified。
- repository-shaped newest pending release 的 history `readback_ref` 固定 null。`latest_readback`
  可以是 null（claim 尚未终结）、旧 active release 的 verified readback，或同一 unresolved release
  上一次 finalized attempt 的 terminal mismatch/unknown 投影；claim 本身不创建 pending projection。
  DTO parser 可读取旧 `status=pending` fixture，但 `assertControlStateProducerSemantics` 必须拒绝它，
  因此 Service 不得输出该形状。verified/mismatch/unknown 必须与对应 terminal release row 的非 null
  `readback_ref` exact。pending release 的 desired modules 仍作为 newest unresolved/reconcile target
  接受 current inventory 约束。
- preview base pair 必须是 null/0 或 ID/positive revision，created 必须早于 expires，diff 三组按
  logical key 互斥，desired 必须等于 added+retained exact set；四项 validation 全 true 当且仅当
  reasons 为空。未消费 preview base 必须等于 current activation；已消费 preview 保留上一 release
  base，不强行改写为当前值。created/expires 用纳秒 instant 严格比较：1ns 递增
  接受，相等、逆序或不同 offset 表示的等价 instant 拒绝。已消费 preview 还必须四项
  validation 全 true 且 reasons 为空，不允许把曾经失败的 validation 作为已发布快照。
- `latest_approval` 非 null 时 `latest_preview` 必须存在且 preview ref 一致；两者 consumed 原子一致。
  approve 发布消费时两者均 true，未发布均 false；reject 的 approval 固定 false，因而不能搭配已
  consumed preview。反向也必须成立：`latest_preview.consumed=true` 时
  `latest_approval` 不得为 null，且必须显式为 `decision=approve`/`consumed=true`，因为真实
  publish 原子消费两条记录且 approval 不会被删除；
  unconsumed preview + null approval 仍合法。两者均 consumed 时 history 必须存在相同 preview
  ref/approval ID。
- events 的 event ID 唯一、sequence strictly increasing 且窗口内连续、occurred_at 按
  同一纳秒 instant comparator 非递减；不同 offset 的等价 instant 可接受，1ns 逆序拒绝。
  `events_truncated=true` 必须恰有 256 条且 first sequence > 1；false 的非空窗口必须从 1
  开始。断言不从有限 events 猜 lifecycle 或 release history。

断言失败必须 fail closed，不得删除 superseded 历史、补造未持久的 pending
readback、把 pending readback ref 写进 release history、重排后静默放行或降级成 generic map。

### 5.2 action × status producer 硬门

Task 3 每个 action 的 service/HTTP 输出必须调用 `assertControlProducerEnvelope(action, envelope)`，
且矩阵覆盖所有状态，不存在“非 success 直接放行”：

| action | success | needs_input | manual_review | blocked / unavailable |
| --- | --- | --- | --- | --- |
| `packages.register` | 完整 registration；根 reasons 空；readback not_applicable | 拒绝 | 拒绝 | `data=null`；根 reasons 非空；readback not_applicable |
| `deployments.preview` | 完整 preview；四项 validation 全 true 且 validation/root reasons 均空；diff 三组 logical-key 互斥；desired exact 等于 added+retained；created < expires；consumed=false；readback not_applicable | 完整 preview；至少一项 validation=false；validation reasons 非空并与根 reasons exact set 相等；其余 diff/time/consumed/readback 关系同 success | 拒绝 | `data=null`；根 reasons 非空；readback not_applicable |
| `approvals.decide` | 完整 approval；approve/reject 决定本身都可 success；根 reasons 空；readback not_applicable | 拒绝 | 拒绝 | `data=null`；根 reasons 非空；readback not_applicable |
| `deployments.publish` | 完整 release ID/positive revision/non-empty modules；根 reasons 空；verified readback 与 release ID/revision exact | 拒绝 | 仅 durable publish 后 readback mismatch/unknown；仍须完整 release，根 reasons 非空，readback ID/revision exact | `data=null`；根 reasons 非空；readback not_applicable |
| `deployments.reconcile` | 完整 reconciliation status=verified；根 reasons 空；根 verified readback ID/revision exact | 拒绝 | 仅 durable release readback uncertainty；data/root status 同为 mismatch 或同为 unknown，ID/revision exact，根 reasons 非空 | `data=null`；根 reasons 非空；readback not_applicable |

因此 `manual_review` 只用于 durable publish/readback uncertainty；register、preview、approval 的
manual review 一律拒绝。blocked/unavailable 不能携带 operation data 或 verified readback，任意错误
`data.kind`、空 reason、状态/ID/revision 不对应也拒绝。通用 envelope 的 optional legacy branch 仅为
旧 fixture parser 兼容，不能代替该 producer 矩阵。

### 5.3 安全返回值

`assertControlProducerEnvelope` 返回 Zod 解析后的 deep-frozen `ControlEnvelope`；
`assertControlStateProducerSemantics` 返回解析并验证后的 deep-frozen `ControlStateData`。两者均不
返回传入对象。Task 3 必须写成“接收返回值并返回该 snapshot”，不能把函数当作 void assertion。
输入 accessor 直接拒绝；任何层级的 Proxy 也直接拒绝，包含 transparent、value-switching
或自定义 prototype/descriptor trap 的 Proxy。Proxy 判定必须先于所有可观察 reflection，所以
trap 与 target getter 调用数均为 0。ordinary input object 只能使用 `Object.prototype`，但
Zod parse 后返回的 detached snapshot 仍是普通 `Object.prototype` object/标准 array。所有
输入边界失败统一转换成稳定脱敏 contract error；错误不得包含原始值、Proxy/getter
message、secret 或 raw payload。

本任务不实现上述 `ModuleControlService` DTO mapping 或 producer assertion wiring；在这些接线
完成并有运行时读回证据前，UI、runtime 和 production 能力仍未实现或未被证明，服务能力仍是
“待适配验证”，Admin UI 不能以本 RFC 作为真实 API 已上线的证明。

## 6. 测试与验证要求

合同测试必须以完整 state fixture 同时验证 Zod 与 checked-in Draft 2020-12 parity，至少覆盖：

- root/data/每个嵌套 object 的 unknown field 拒绝；
- URL、path、source、email、token、secret、evidence ref 和 raw payload 拒绝；
- module/tool/standard/history/event/reason-code 数组超限以及 exact duplicate 拒绝；
- inactive/active activation 矛盾、所有 release/readback revision 0、approval reject consumed=true、
  release status/published_at 矛盾拒绝；
- change/rollback `target_release_id` 交叉泄漏拒绝，合法 rollback 接受；
- release-history change/rollback intent/target 交叉泄漏拒绝；
- pending/verified/mismatch/unknown readback 的 observed pair/字段形状和 reason-code 关系；
- 31 个允许的 event action/kind/status tuple 接受，错误组合双栈拒绝；
- Zod 按 module ID/version 拒绝 logical duplicate；Ajv 用 `uniqueItems` 拒绝 exact duplicate，并以
  “Ajv 结构接受、producer 拒绝”回归其无法表达的 cross-digest logical-key 边界；
- producer 断言覆盖 history ID/revision 唯一、连续降序、previous/superseded 链、active/unresolved
  数量与位置、rollback target、preview diff/time/base/validation、approval/preview ref 与 consumed 原子
  关系（包含 consumed preview 只接受 validation 全绿 + approve/consumed，失败 validation、reject
  或 null approval 拒绝，unconsumed + null 接受）、
  readback/history/activation exact 关系，以及 event ID/sequence/time/truncation 窗口；
- preview action/state TTL 均以 RFC3339 纳秒 instant 比较，覆盖 Z/offset 下 1ns 递增、
  相等、逆序、offset 等价和闰日边界；event occurred_at 覆盖不同 offset 等价/递增
  接受以及同 offset/跨 offset 1ns 逆序拒绝；
- mismatch/unknown observed applied module 与权威投影同 logical key 但 digest drift 时保留原值并
  维持 manual_review；verified 的同样 drift 拒绝；
- repository-shaped pending history `readback_ref=null` 双栈接受；newest pending + null latest readback、
  newest pending + old active verified 接受；legacy pending latest-readback 结构由 parser 接受但
  producer 必须拒绝；newest pending + 上一次 finalized mismatch/unknown terminal 投影按 exact
  attempt/release 关系接受；newest manual/active 用 null 或错误旧 readback 绕过拒绝；
- superseded old module 已不在 current inventory 时仍接受展示；同一 old ref 用于 active、newest
  unresolved/reconcile target 或未消费 rollback preview 时拒绝，跨投影同 logical key 不同 digest
  仍拒绝；
- 五个 action 的完整 status 矩阵表驱动验证；五类 legacy shell success 仅由通用 parser 兼容、被
  producer schema/assertion 拒绝；
- 两个 producer assertion 返回 detached deep-frozen snapshot；原对象后续 mutation 不影响返回值，
  对返回值 mutation 失败；transparent/root/nested/state/value-switching/trapped Proxy 均以稳定
  `ControlContractError` 拒绝，且 trap/target getter 调用数为 0；null/custom-prototype ordinary
  object 拒绝，Zod 返回值的 object/array prototype 为标准 prototype；
- identifier、version、digest、RFC3339 和 safe-integer 边界；
- shared RFC3339 helper 覆盖 year 0000/9999、闰年、负 epoch、±14:00、offset 等价、跨日/年、
  1–9 位小数、负 instant floor、UTC 小数尾零裁剪及精确保留纳秒的固定 24 小时加法；repository
  preview/idempotency assertion 覆盖 1ns 递增接受与等价/逆序拒绝；Fake/SQLite parity 覆盖
  offset 纳秒 TTL、1ns-before 与 offset-equivalent expiry gate，Fake latest projection 覆盖同毫秒内
  先按纳秒 instant、仅 exact tie 后按稳定 identifier 排序；
- 既有五状态与其他 response branches 的兼容样例。

本前置任务的最小验证命令为：

```bash
npx vitest run tests/control-plane/rfc3339-instant.test.ts --pool=forks --no-file-parallelism --maxWorkers=1
npx vitest run tests/control-plane/contracts.test.ts --pool=forks --no-file-parallelism --maxWorkers=1
npx vitest run tests/control-plane/repository-contracts.test.ts tests/control-plane/fake-control-repository.test.ts --pool=forks --no-file-parallelism --maxWorkers=1
npm run validate:schemas
npm run typecheck
npx eslint src/logistics_mcp/control-plane/rfc3339-instant.ts src/logistics_mcp/control-plane/contracts.ts src/logistics_mcp/control-plane/repository.ts tests/control-plane/rfc3339-instant.test.ts tests/control-plane/contracts.test.ts tests/control-plane/repository-contracts.test.ts tests/control-plane/fake-control-repository.ts tests/control-plane/fake-control-repository.test.ts
git diff --check
```

这些命令只证明当前 checkout 的合同/Schema/类型/静态检查；不证明服务、UI、数据库、生产认证、
生产发布或生产 readback 已实现。

## 7. 迁移与回滚

本前置任务没有 persistence schema、repository state projection、SQLite 或 service 迁移，也不改请求
或 hash golden vectors。`ModuleControlState`、现有 Fake repository 与 SQLite repository 已权威提供
bounded、newest-first 的 `releaseHistory` 和 `eventsTruncated`，因此不再存在“Task 3 接线前必须扩展
repository state projection”这一前置缺口。仍未实现或未被证明的是 `ModuleControlService` DTO
mapping、state/action producer assertion wiring，以及 UI、runtime、production；Task 3 必须直接
消费现有 repository projection，填充所有 required DTO 字段并依次执行断言。
历史记录缺少所需摘要时只能进入既有 `manual_review`/`unavailable` 门禁，不能用 events 猜 history、
用数组长度猜 truncation 或用 inventory 猜 activation。repository 必须保留 superseded 历史；service
不能因旧 module 已退出 current inventory 而删除 release row。current inventory 缺失只阻止该 ref
成为 active/newest unresolved/未消费 preview，不阻止历史展示。

现有未发布 fixture 的迁移清单包括：旧 active 三字段改为 activation union；inventory 增加
tool/standard arrays；readback 改 observed shape；release history 增加 intent；event tuple 改为合法
组合；根 reason codes、preview desired modules、release active modules 适配新上限/uniqueItems；所有
非 null release/readback revision 改为 positive；pending history 使用 repository 真实的
`readback_ref=null`；删除/迁移会被 Service producer 拒绝的旧 pending latest-readback fixture，claim
不持久化 public pending projection，也不把 attempt ref 回写到 pending release history；approval/
preview consumed 与 newest release/readback fixture 改为原子一致；shell success fixture 改为
action-specific 完整矩阵。Task 3
还必须把两个 assertion 的返回类型迁移为实际返回值使用，不能依赖旧的 void/TypeScript narrowing。

若本合同在服务接线前被否决，回滚方式是恢复旧 `control_state` response schema 和对应合同测试，
移除本 RFC 新增的 producer 硬门，并把尚未发布 fixture 恢复到同一旧合同基线；请求
schema_version/golden hashes、数据库数据、release/event 历史和权限/状态机保持不变。若 Task 3
已经依赖新 DTO，必须先回滚 service producer 映射和 assertion wiring；只有另有独立 repository
projection 变更时才回滚该变更，并重新运行合同
与 service 测试；不得直接编辑数据库补字段，也不得通过 generic map 绕过 closed contract。任何
面向已发布客户端的破坏性回滚都需要另行 RFC，本 RFC 不授权该操作。

## 8. 当前状态声明

本 RFC 仅表示 control-state DTO 合同已 accepted；Service、UI、runtime 和 production 均未实现、
未发布或未验收。它不宣称可写控制面服务、Admin UI、运行时恢复、生产 Admin POST、模块 hot-plug
或生产资格已经实现、发布或验收。
