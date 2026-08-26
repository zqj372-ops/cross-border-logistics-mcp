---
standard_id: implementation-plan
version: 2026-08-26.v0
priority: 40
audience: developer,reviewer
rule_ids: PLAN-TRACE-001
---

# Plan: AI 自动报价 + Freightcom LTL + MCP Agent 结合方案

> 状态：规划草案，不代表接口已经发布、MCP 工具已经注册或真实环境已经可生产使用。
>
> 本计划只新增规划文档，不修改 `/Users/autumn/Documents/AI自动报价模块`，不改当前共享契约、
> 业务代码、数据库、生产环境或 Freightcom 凭证。两个仓库当前均有未提交改动，实施必须在
> 明确所有权和干净基线后分阶段进行。

## 1. 目标

让 Agent 能从中文自然语言运输需求出发，经过确定性标准化、实体打托、内部报价和
Freightcom 测试询价，最终只向业务人员展示：

| 服务商 / 服务 | 总价 | 运输时效 |
| --- | --- | --- |
| 承运商与服务名 | 按显示策略展示 USD | 上游返回的天数/小时或“未返回” |

完整链路如下：

```text
自然语言 / 结构化货物资料
        │
        ▼
quote.ltl.prepare
AI 自动报价模块：字段提取、地址标准化、算术复核
实体打托引擎：生成可提交给承运商的 HandlingUnit[]
        │
        ├───────────────┐
        ▼               ▼
quote.canada_final_mile.calculate   quote.freightcom_ltl.preview
内部 Zone 确定性报价                Freightcom POST /rate + GET /rate/{request_id}
        │               │
        └───────┬───────┘
                ▼
Agent / 中文询价页面：并列呈现来源，不自动改价或自动选中最低价
```

## 2. 当前事实与缺口

### 2.1 已确认能力

- AI 自动报价模块能够提取地址、邮编、件数、尺寸、单件重量、包装、地址类型和附加服务字段。
- AI 自动报价模块会从逐件明细重新计算 CBM 和总重量，并记录申报值冲突。
- AI 自动报价模块当前输出 `billing_pallets`，用于内部 Zone 计价。
- 当前物流 MCP 已有统一包络、五种状态、RBAC、静态 Module Runtime v0 和确定性 Cargo 工具。
- 当前仓库已有 Freightcom test client、`POST /rate`、`GET /rate/{request_id}` 轮询、请求/响应
  校验以及本地中文询价页面。
- 当前 Freightcom 结果 Schema 已观察到 `carrier_name`、`service_name`、`total` 和
  `transit_time_days|hours` 等字段。

### 2.2 尚未完成

- `billing_pallets` 是内部计费托数，不是可以提交给承运商的实体托盘明细。
- 当前没有权威的实体打托合同：每托件数、毛重、长宽高、堆叠、超托和托盘自重仍无法确定。
- AI 自动报价模块没有已发布、版本化的 `HandlingUnit[]` 预览 API。
- Freightcom 询价仍是本地 HTTP 工作台能力，没有正式注册为 MCP Tool。
- 当前 Agent profile、RBAC 和模块目录都没有 `quote.ltl.prepare` 或
  `quote.freightcom_ltl.preview`。
- 当前 workstream 所有权没有覆盖 `src/logistics_mcp/modules/**` 和
  `apps/freightcom-quote/**`；实施前必须通过 RFC 明确归属。
- Freightcom 是测试环境；测试报价不能成为可发送、可订舱或生产有效报价。

### 2.3 当前规则冲突

AI 自动报价模块存在必须先解决的超长阈值冲突：

- `reference/canada-final-mile/RULES.yaml`：`long_piece_threshold_cm: 120`；
- `packages/quote_engine/pallet_calculator.py`：`HARD_LONG_PIECE_THRESHOLD_CM = 240`。

160 cm 货物在两套规则中会得到不同结论。没有唯一生效规则版本前，不允许自动生成实体托盘，
也不能把任一阈值写死在 MCP 适配器中。

## 3. 核心设计决策

### 3.1 权威边界

| 数据/动作 | 权威拥有者 | MCP/Agent 可以做什么 | 禁止行为 |
| --- | --- | --- | --- |
| 原始客户输入 | 业务请求及用户确认 | 提取、标准化、请求补充 | 把猜测写成确认事实 |
| CBM、重量复算 | 确定性货物计算 | 调用并传播计算证据 | 由模型心算后覆盖 |
| 内部 Zone、计费托数、内部价格 | AI 自动报价模块的确定性引擎 | 窄 API 调用、原样展示 | 在 MCP 复制价格/Zone 表 |
| 实体打托 | 已批准的 Palletization Policy | 生成版本化 `HandlingUnit[]` | 用 `billing_pallets` 伪造实体托盘 |
| Freight class | 版本化密度建议 + NMFC 人工校验 | 生成建议、保留规则版本 | 把密度建议宣传为所有商品的权威分类 |
| Freightcom 费率 | Freightcom 测试 API 响应 | 校验、轮询、窄投影 | 改写上游金额或伪造时效 |
| 显示币种 | 明确的 UI display policy | 单独生成显示字段 | 覆盖或丢弃原始币种证据 |
| 最终选择/发送/订舱 | 经授权的业务流程 | 本阶段不做 | 自动选最低价、发送或订舱 |

### 3.2 三层分离

1. **准备层**：标准化地址和货物、发现冲突、生成实体托盘；不调用承运商，不产生价格。
2. **报价层**：内部 Zone 和 Freightcom 分别调用各自权威来源；互不覆盖。
3. **呈现层**：Agent/UI 只做排序、说明和三列显示；测试结果始终带人工复核边界。

### 3.3 公开 MCP 工具保持窄接口

建议新增两个只读工具，不新增万能报价入口：

#### `quote.ltl.prepare`

用途：调用 AI 自动报价模块的版本化只读接口，产生可审计运输准备结果。

输入采用互斥的 `oneOf` 证据模式：

- `natural_language`：受长度限制的原始运输描述；或
- `structured`：地址、CargoLine 和服务要求。

两种模式不得同时出现。结构化 CargoLine 必须继续遵守重量证据互斥规则：
`unit_weight`、`piece_weights`、`line_total_weight` 只能出现一种。

关键输入字段：

```text
schema_version
input_mode
origin_warehouse_code: CALGARY | MARKHAM
shipment_text | destination + cargo_lines
service_requirements:
  destination_address_type: commercial | residential | unknown
  tailgate_required: true | false | unknown
  appointment_required: true | false | unknown
  stackable: true | false | unknown
effective_at
```

关键输出字段：

```text
normalized_destination
normalized_cargo_lines
calculated_totals
declared_totals
conflicts[]
billing_pallets                   # 只供内部计价
handling_units[]                  # 只在实体打托证据充分时出现
palletization_policy_version
freight_class_suggestions[]
preparation_ref                   # tenant/actor/input digest 绑定的短期 opaque ref
source_refs / assumptions / warnings / blockers / calculation_trace
```

#### `quote.freightcom_ltl.preview`

用途：只接受准备层生成的 `preparation_ref`，读取服务器端已校验的实体托盘，不接受客户端上传
Token、Base URL、任意请求体或身份字段。

关键输入字段：

```text
schema_version
preparation_ref
expected_ship_date
display_policy: usd_numeric_relabel_test_only
```

关键输出字段：

```text
provider: freightcom
environment: test
request_id_ref
rates[]:
  carrier_name
  service_name
  source_total: { amount: decimal string, currency: ISO 4217 }
  display_total: { amount: same decimal string, currency: USD }
  display_conversion_method: none_numeric_relabel
  transit_time: { value, unit } | null
source_refs / warnings / blockers / calculation_trace
sendable: false
bookable: false
```

`request_id` 对外只提供不可逆引用或受限句柄；原始上游 ID 不进入普通日志。

### 3.4 CAD 数字改标 USD 的诚实边界

业务页面按用户要求只显示 USD 且不换算数字，例如 `100 CAD` 显示为 `100 USD`。实现时必须同时满足：

- `source_total.amount = "100"`、`source_total.currency = "CAD"`；
- `display_total.amount = "100"`、`display_total.currency = "USD"`；
- `display_conversion_method = "none_numeric_relabel"`；
- 包络状态最多为 `manual_review`，`sendable=false`、`bookable=false`；
- UI 主表只显示 `100 USD`，证据区可折叠查看来源币种和显示策略；
- 不能将显示字段写回 Freightcom、内部 Zone 价格、草稿报价或财务记录。

这样满足内部测试展示要求，同时不把 1:1 改标伪装成汇率换算。

## 4. 实体打托合同

### 4.1 严格区分两个概念

```text
billing_pallets  = 内部价格表计费参数
handling_units[] = 实际提交给承运商的物理托盘
```

二者可以数量相同，也可以不同；任何情况下都不得隐式互转。

### 4.2 Palletization Policy 必填内容

每个自动打托结果必须引用不可变规则版本，规则至少包括：

- 允许的托盘底面规格；
- 每种托盘的最大毛重和最大高度；
- 托盘自重；
- 允许的货物旋转方向；
- 是否允许超托，以及各方向最大超出值；
- 堆叠规则和不可堆叠条件；
- 超长阈值及其业务含义；
- 危险品、易碎品、木箱和特殊商品的人工复核门禁；
- 体积/重量分托不能替代几何装载验证；
- 规则生效日期、版本、来源和审批记录。

### 4.3 `HandlingUnit` 最小 Schema

```text
handling_unit_id
type: pallet
profile_code
piece_allocations[]: { cargo_line_id, quantity }
gross_weight: { value: decimal string, unit: kg }
dimensions: {
  length: { value: decimal string, unit: cm }
  width:  { value: decimal string, unit: cm }
  height: { value: decimal string, unit: cm }
}
stackable: boolean
overhang: { length_each_side, width_each_side, unit } | null
description
freight_class: { value, basis, rule_version, review_required }
rule_version
source_ref_ids[]
```

所有托盘的 `piece_allocations` 合计必须与 CargoLine 件数精确一致；所有托盘货物净重加托盘自重必须
与输出毛重 trace 对齐。任何件数丢失、重复分配、超高、超重或不允许的旋转都返回非 success。

### 4.4 Freight class

现有页面中的密度建议逻辑可以迁移为版本化确定性规则，但只能标注为建议：

- 使用每个实体托盘的毛重和外廓尺寸计算 lb/ft³；
- 金额、重量和密度计算不得用二进制 float；
- 输出密度、建议 class 和规则版本；
- 有 NMFC、特殊商品或承运商例外时进入人工复核；
- 没有可信商品信息时不能声称“自动算出的 class 一定正确”。

## 5. 状态机与失败闭合

| 场景 | 状态 | 是否调用 Freightcom | 数据要求 |
| --- | --- | --- | --- |
| 缺邮编、街道、货物尺寸/重量证据 | `needs_input` | 否 | 列出精确缺失字段 |
| 单件重量与申报总重冲突 | `needs_input` | 否 | 保留两套证据，不擅自选择 |
| 体积申报值与尺寸复算冲突 | `needs_input` | 否 | 返回差异和计算 trace |
| 地址类型、尾板、堆叠状态未知且影响价格 | `needs_input` | 否 | Agent 只追问影响结果的最少字段 |
| 打托规则不存在、版本冲突或无法几何装载 | `manual_review` | 否 | `handling_units=[]` |
| Freightcom Token/Endpoint/网络不可用 | `unavailable` | 是/尝试前失败 | 不返回 fixture 假报价 |
| 401/403 | `unavailable` | 是 | 不回显 Token，提示重新通过浏览器录入 |
| 请求被 400/409/422 拒绝 | `needs_input` | 是 | 映射为可理解字段错误 |
| 上游响应不符合 Schema | `manual_review` | 是 | 不把未知字段拼成报价 |
| 测试费率完整返回 | `manual_review` | 是 | 可显示费率，但 `sendable=false` |
| 生产合同和 readiness 未批准 | `unavailable` | 否 | 不因测试成功升级为 production |
| 客户端传 Token、URL、tenant 或 actor | `blocked` | 否 | 记录脱敏审计事件 |

## 6. 最少输入体验

页面和 Agent 不再要求用户手工填写可由邮编可靠带出的城市、省/州和国家：

1. 用户从 Calgary 或 Markham 两个固定发货地址中选择；服务端映射完整地址，客户端不上传任意起运地址。
2. 用户输入加拿大 Postal Code 或美国 ZIP Code，系统带出候选城市、省/州和国家并要求核对。
3. 用户填写街道地址；邮编不能证明商业/住宅属性，所以地址类型仍需确认。
4. 用户输入货物明细或直接粘贴自然语言描述。
5. 系统只在结果会变化时追问：重量冲突、地址类型、尾板、堆叠、实体托盘规则或特殊商品。
6. 查询结果主表只保留服务商/服务、总价和运输时效；来源、警告和测试边界放到折叠证据区。

## 7. 分阶段实施

### Phase 0：合同和所有权门禁

交付：

- 新建 dated RFC，明确两个新工具、状态映射、兼容策略、权限、网络出口、测试环境边界和回滚。
- 由 baseline workstream 更新 `docs/contracts/**`；其他 workstream 不直接改共享契约。
- 在 `docs/agent/workstreams/current.json` 明确：
  - `src/logistics_mcp/modules/quote-ltl/**` 的所有者；
  - `apps/freightcom-quote/**` 的所有者。
- 扩展 Agent profile allowlist 前先完成契约评审。
- 冻结两个仓库的实施基线 SHA；不以当前未提交修改作为跨仓库合同。

验收：RFC 包含旧/新 JSON、版本兼容、状态/权限、迁移、回归命令和回滚方式，并获得 baseline 接受。

### Phase 1：AI 自动报价模块提供准备 API

实施位置：`/Users/autumn/Documents/AI自动报价模块` 的独立授权 worktree；本计划不直接修改。

交付：

- `POST /quotes/ltl-preparation/preview` 只读版本化接口；
- `NaturalLanguageInput | StructuredInput` 闭合 Schema；
- 地址、CargoLine、算术冲突和最少补字段输出；
- 版本化 Palletization Policy 和 `HandlingUnit[]`；
- `preparation_ref` 的 tenant/actor/input-digest 绑定和短期 TTL；
- 解决 120 cm 与 240 cm 的超长阈值冲突；
- 禁止接口发送通知、保存报价、写学习数据或改变规则。

测试：

- 自然语言解析和结构化输入等价性；
- 单件/逐件/行总重证据互斥；
- CBM、总重冲突；
- 件数分配守恒、重量守恒、几何边界、旋转、超托、堆叠、超高和超重；
- 规则版本缺失、冲突或未生效时失败闭合；
- API RBAC、tenant 隔离、无通知/无写副作用；
- 响应中不包含价格、Zone 表或凭证。

### Phase 2：MCP Freightcom LTL 模块

交付：

- `quote.ltl.prepare` 模块 Tool Contract；
- `quote.freightcom_ltl.preview` 模块 Tool Contract；
- 由平台注入的 `ai_quote_preparation@v1` 和 `freightcom_test_rate@v1` capability；
- Freightcom 请求映射、提交、轮询、超时、取消和响应窄投影；
- Keychain/secret handle 读取只发生在 capability/provider 层；
- 固定 HTTPS host allowlist，不接受客户端 URL；
- RBAC 使用只读 `quote:calculate` 或 RFC 批准的新权限；
- Module Runtime v0 静态挂载和 catalog readback。

测试：

- 模块缺 capability 时不挂载或固定 `unavailable`；
- 重复 Tool 名、Schema 不闭合和 output envelope 不合规时启动失败；
- fixture 覆盖 202、轮询中、完成、401/403、400/409/422、429、5xx、超时、取消和 Schema drift；
- 确认 Token、地址原文和 raw upstream response 不进入日志；
- 确认 `billing_pallets` 永远不被映射到 Freightcom `pallets[]`；
- 测试结果固定 `manual_review`、`sendable=false`、`bookable=false`。

### Phase 3：Agent 编排和中文页面

固定 Agent 顺序：

```text
1. quote.ltl.prepare
2. 若 needs_input：只追问 blockers 指定的字段
3. preparation 可用后，并行调用：
   - quote.canada_final_mile.calculate（内部）
   - quote.freightcom_ltl.preview（承运商测试）
4. 不自动合并金额，不自动选最低价
5. 页面主表只显示三列，证据和警告折叠
```

页面交付：

- 中文界面；
- Calgary/Markham 固定发货地址下拉；
- 加拿大/美国邮编自动带出地址候选；
- 默认公制；
- Freight class 自动建议并显示复核提示；
- 结果只显示服务商/服务、总价、运输时效；
- 轮询可取消，页面刷新后不无限卡住；
- Key 缺失时打开本地安全录入页，由用户在浏览器输入，不在聊天或终端粘贴。

### Phase 4：端到端测试环境验收

顺序：

1. 所有 fixture、Schema、RBAC、模块挂载和日志脱敏测试通过；
2. 通过浏览器录入/更新测试 Key，只验证 Keychain presence；
3. 使用脱敏测试货物执行一次真实 Freightcom test 调用；
4. 保存经过清洗的请求/响应 fixture，不保留 Token、客户身份或不必要地址原文；
5. 从 Agent 客户端重新发现工具并执行完整链路；
6. 从浏览器验证三列表格、轮询、错误提示和折叠证据；
7. 重启 MCP 后再次进行 catalog 和 readiness readback；
8. 结果仍只标记测试可用，不声明生产 readiness。

### Phase 5：生产资格（不在本计划实施范围）

生产 Token、正式合同、限流、SLA、数据处理、发布审批、可比快照、监控和回滚均需要独立 RFC 与
staging 证据。测试 Token 成功不能自动启用 production mode。

## 8. 样例票验收路径

输入：

```text
起运：Calgary 固定仓
目的地：919 Ironwood Street, Campbell River, BC V9W 3E5, Canada
尺寸：160 × 30 × 30 cm
数量：21 件
单件重量：28 kg
申报总重：586 kg
申报体积：3.1 m³
```

准备层必须先返回：

```text
尺寸复算体积：3.024 m³
单件重量复算总重：588 kg
冲突：588 kg vs 586 kg；3.024 m³ vs 3.1 m³
```

第一轮状态应为 `needs_input`，要求确认使用逐件复算值还是修正逐件数据。不得直接调用 Freightcom。

确认数据后，若 Palletization Policy 仍未明确 160 cm 货物的托盘底面、超托、旋转、堆叠、最大高度/
重量和托盘自重，则返回 `manual_review` 且 `handling_units=[]`。只有规则完整并生成通过守恒校验的
实体托盘后，才允许创建 Freightcom 请求。

最终测试结果验收：

- 每条费率都能追溯到 preparation ref、规则版本和 Freightcom test source ref；
- 只显示字段完整的服务商/服务、总价和运输时效；
- 缺总价的 rate 不伪造金额，缺时效时显示“未返回”；
- 源金额为 CAD 时，页面按策略显示相同数字的 USD，后端仍保留源 CAD 和无换算标识；
- 整体状态为 `manual_review`，不能保存为可发送报价或进入订舱。

## 9. 实施前需要业务批准的规则

以下内容不由开发人员或 Agent 猜测，必须形成版本化业务规则：

1. 超长阈值最终采用 120 cm、240 cm 或分承运商规则；
2. 标准托盘底面规格，以及是否允许自定义长托；
3. 单托最大毛重和最大高度；
4. 160 cm 货物是否允许超托、侧放、旋转和堆叠；
5. 托盘自重；
6. 地址类型未知时是否必须追问；
7. 尾板需求未知时是否必须追问；
8. Freight class 密度建议的适用范围和 NMFC 复核责任人；
9. CAD 数字改标 USD 仅限测试 UI，还是允许进入内部草稿；本计划建议严格限制在测试 UI。

## 10. 发布门禁与回滚

### 发布门禁

- Draft 2020-12 Schema，闭合对象且 `additionalProperties: false`；
- 金额为 decimal string + ISO 4217，重量/尺寸/体积带单位；
- 所有计算包含规则版本、source refs、assumptions、warnings、blockers 和 trace；
- capability、RBAC、tenant/actor、host allowlist 和 secret handle 均由服务端注入；
- fixture 通过不等于真实 test readiness；真实 test 通过不等于 production readiness；
- Agent、HTTP 和浏览器三条路径分别验证，不用 curl 200 代替浏览器合同；
- `npm run validate:agent-standards`、`npm run build:agent-pack`、相关 focused tests、全量相关测试、
  typecheck、lint 和 `git diff --check` 必须记录真实输出；
- AI 自动报价模块同时运行 focused pytest、相关全量 pytest、类型/格式检查和 API readback。

### 回滚

- 两个新工具由独立 module/capability feature gate 控制，可同时下线而不影响 Cargo、Container、JHT；
- 保留现有本地 Freightcom 工作台作为测试回退，不把它冒充 MCP；
- `preparation_ref` 使用短期临时存储，不引入价格或客户主数据迁移；
- 若 Schema 或 provider 响应漂移，工具返回 `unavailable|manual_review`，不回退到 fixture；
- 生产模式默认不存在，不能因配置缺失自动回退到测试或反向回退。

## 11. 完成定义

只有同时满足以下条件，才能说“Agent 可以直接通过 MCP 获取 Freightcom 测试报价”：

1. `quote.ltl.prepare` 和 `quote.freightcom_ltl.preview` 出现在当前 catalog readback；
2. Agent profile 和 RBAC 对当前角色授权成功，跨租户和凭证字段被拒绝；
3. 样例票能正确发现 588/586 kg 与 3.024/3.1 m³ 冲突；
4. 实体托盘由已批准规则生成并通过件数、重量和几何守恒校验；
5. Freightcom test POST、GET 轮询和响应 Schema 经过一次新鲜真实验证；
6. UI 只展示服务商/服务、总价和运输时效，并保留测试/币种证据；
7. 重启后 catalog、capability 和 readiness readback 仍一致；
8. 没有 Token、客户原始地址、raw response 或测试报价泄漏到普通日志、fixture 或 Git；
9. 结果保持 `manual_review`、`sendable=false`、`bookable=false`；
10. 未声称生产可用、未发送客户报价、未订舱。
