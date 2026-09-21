# RFC：FCL 询价、成本/售价、审核与正式文件 v1

Status: **Accepted for isolated M1 implementation — 2026-09-20**。用户完成第一阶段审计后明确要求“把 M1 模块完整做完”。本机据此接受本文的 FCL 专用合同作为隔离实施基线，并负责每节点独立审核；K12 在精确 Task Packet 范围内实现。本文不表示 Main 合并、生产发布、真实价格确认或邮件外发已获授权或已完成。

日期：2026-09-20。代码依据：`2c0356adb05987317a9813d4036f9bf2d040424f`。

配套：[14 项审计与方案](../product/2026-09-20-fcl-main-loop-audit.md)、[最小 Schema 草案](2026-09-20-fcl-main-loop.schema.json)。草案位于 docs/rfcs，不被生成器或运行时引用。

## 1. 动机、已确认决定与范围

当前 Case 可以保存需求和追加文字补充；Quote Documents 已有版本、审核和 PDF，但 linked/native_unlinked 绑定住宅尾程请求与价格，不能承载 FCL 人工成本和客户售价。公开询价入口又要求人员登录。因此不能仅以页面更名实现整柜链路。

用户最新明确选择：**公开提交，固定由本人受理，不建公司。** 此决定替代本轮较早的“固定运营企业”答复。服务端显式配置唯一受理个人账号；客户不需登录，受理人使用现有已验证人员账号登录。不得创建占位公司、伪造 organization_id，或把平台 operator 当作个人报价授权。

当前代码尚不支持完整个人受理：Case 可保存 organization_id=null 的个人需求，但普通个人不能管理 Case；NativeAdmin 和 DocumentWorkflow 都要求企业身份。因此本 RFC 必须增加仅供 FCL 使用的个人归属与管理权限，不能只删除三个 organization 检查。

仅做中国→加拿大 FCL：Inquiry → 结构化 Case → Rate 匹配 → 内部 Cost/Sell → 人工审核/退回/重提 → 现有正式 PDF → 简单交接。具体真实港口、城市及当前有效 Rate 尚未核定，使用合成样例完成本地开发不会取得真实价格资格。

不进入 LCL、CBM/KG/托盘/住宅 Zone/Freightcom 定价、船期集成、Booking/SO、Tracking、Actual Cost、结算、CRM、BI、自动定价或完整客户门户。

## 2. 权威与必要存储

| 对象 | 唯一权威与必要变化 |
|---|---|
| Inquiry | `CaseStore` 同一 SQLite 中新 `fcl_inquiries`：原始 payload 不可变；独立 inquiry UUID/no，关联既有 Case UUID。身份/通知元数据不覆盖原件 |
| Case | 复用 `business_cases`；FCL 当前结构化 payload 可更新，原 Inquiry 保留；所有更新同步追加 `business_case_events` |
| FCL Rate | `NativeAdminStore.native_configs/native_releases` 的 `kind=fcl`，归属固定受理人的个人数据集，多条 Rate 候选；不新建第二套价格发布仓库 |
| 内部 FCL Quote | 一张 `fcl_quote_revisions` 追加保存 quote_id/version、Case 绑定、Rate/成本/售价/FX/trace；不保存第二份审核状态 |
| Quote Document | 现有 DocumentWorkflow revision、review、approval、template、PDF 权威；仅保存客户售价投影及内部报价 opaque 绑定引用 |
| Handoff | 既有 Case 的受权事件。pending 从当前已批准文件派生；handed_off 必须有相应事件和版本 |

建议 `fcl_quote_revisions` 与文档 revision 同库，便于报价版本与文件绑定事务；只在文档服务内部授权方法读写，不让公共 HTTP/CLI 直接访问数据库。Case 与 Rate 仍由各自已有存储访问器提供证据，不直接跨表偷读。

Rate 多条记录存在于已版本化 JSON 数据集即可。第一版没有额外供应商、船司、利润、FX、交接表或通用工作流服务。

旧 Native Business Authority RFC 仍为 Draft；本提案只复用其已经存在的存储/发布实现。FCL 的价格权威在本 RFC 接受后明确为本人核验并发布的 FCL 数据集；真实报价不能以 fixture、默认值或历史来源服务的静默副本补齐。

## 3. 公共提交与补充权限

### 3.1 固定归属

- `fcl_receiver_user_id` 只从服务端显式配置读取；启动与每次提交确认账号存在、有效且已验证。请求中任何 tenant/org/owner/reviewer/source/price 字段均拒绝。账号未配置、停用或无法验证：公开入口 unavailable，不保存无法受理的业务单。
- 新 FCL Case 的 `owner_id` 固定为受理人、`organization_id=null`，并有明确 FCL 版本标记；外部提交主体另存于 Inquiry 和类型化事件。旧 Case 的 owner=客户语义不变，旧 reply/列表路径不能把新记录的受理人误认成客户。
- 只有当前登录的固定受理人，在个人上下文中，才可管理自己的 FCL Case、Rate、成本/售价、模板、审核和交接。每次写入、重放及正式导出重新校验账号状态与记录归属；其他个人、企业管理员、平台角色和查询 Key 不自动得到此权限。
- 单人第一版允许本人制单后进入独立 review 页面，再显式 approve；审核 actor 如实记录同一个人，不伪称双人复核，也不能保存即自动批准。
- 受理人变更不能把旧 Inquiry、Rate 或文件静默转给新账号。本版不实现转让；存在业务记录时更换受理配置应阻断启动并要求单独的数据归属迁移方案。

### 3.2 个人隔离如何复用现有存储

- Case 复用已有可空 organization_id 和 owner_id，仅 FCL selector 增加本人管理分支；旧企业/个人 Case 路径保持原权限。
- NativeAdmin 已有通用 `scope` 列。FCL 使用服务端构造的个人命名空间（例如 `fcl-person:<user UUID>`），并在合同中明确其是个人 scope，绝不当作 organization_id 传给旧服务。既有企业 kind 与 scope 原样保留；用户输入不能选择 scope。
- 文档模板、revision/current、审计及来源凭据的归属需支持显式个人分支。候选迁移为现有 org 列允许 null、增加 personal_owner_id，并用 CHECK 保证恰好一项有效；旧记录 org 不变，新增 FCL 个人记录 org=null。所有查询、唯一键、幂等和签名必须同时绑定归属类型和 ID。不是只放宽 NOT NULL，也不能将个人 ID 塞入 org 列冒充公司。
- 个人分支仅接受新的 FCL 工作流合同，不能据此开启个人 Zone、关税或所有旧文档能力。不创建通用账户/团队平台或个人工作区表。
- 复用现有模板配置与 PDF 排版，FCL 新模板合同使用真实出具人名称/联系方式和条款，UI 标为“报价出具人”，允许个人；不要求注册公司或填写虚构 company_name。模板的名称展示与授权主体分别保存。

### 3.3 本票补充

- 公开提交之前由服务端建立匿名提交会话与 CSRF 绑定；浏览器和无界面客户端使用同一明确 bootstrap 合同。不得把客户端提供的邮箱当成已验证账号。
- 保存后签发有期限、仅本票使用的高熵 opaque 凭据。它仅允许查看客户可见摘要及在 needs_input 时追加补充；不能看任何内部成本、来源备注、其他询价或企业数据。
- 建议本地试点期限 30 天，作为明确服务端配置与响应 expires_at。过期后不能静默续期；内部人员仍可记录线下补充，但必须使用 staff 身份标明“代录”，不能伪装 customer event。
- 持久化只保留凭据哈希和绑定元数据；采用服务端私密持久密钥的带用途 HMAC 派生，使同一授权提交会话的幂等重放能重新交付同一凭据。密钥独立于报价内容、业务 Key 和客户输入；缺失/轮换不兼容时 fail closed，不重建成另一把默认密钥。具体密钥保管沿用项目私密持久化约束。
- 客户页面复用 `/inquiry/` 的本票补充模式。凭据不放 query、日志、分析事件或 localStorage；可用 URL fragment 交换仅本票 HttpOnly 会话，随即清除 fragment。分享链接即分享本票补充权，页面需准确说明。
- 匿名网络限流、请求大小、Origin/Host、CSRF、幂等和字段闭合检查由服务端执行。限额独立配置，不挪用关税游客额度；跨票 token 返回无披露错误。

这是 FCL 公共提交和补充的最小对象权限，不扩展为账号注册、团队管理或通用客户权限平台。

### 3.4 邮件边界

新增的后台配置只有 `recipient`、可选 `cc`、`enabled`，服务端受控 transport 注入；不能接受用户指定的 SMTP 主机或任意收件人。固定主题和正文按用户要求生成，头字段拒绝 CR/LF。内部通知链接不能携带客户补充凭据。

提交事务先保存 Inquiry、编号、Case、初始事件与幂等记录，完成读回后才尝试通知。禁用、配置缺失、transport 失败或超时都不回滚保存；返回“需求已保存，通知未确认/失败”，不能报告送达。重复提交不重复发送；进程在 commit 与发送之间退出可留下未确认，不盲目重发。第一版不建通用邮件队列或模板系统。

本阶段所有验收使用 fake mail transport。真实 SMTP 配置及外发需单独明确启用，不能把本地验证当成邮件已送达。

## 4. 版本与旧/新 JSON

保留旧 case v1/v2、document v1/v2/v3 及查询 Key 合同。新公共 FCL 提交使用 `fcl-inquiry@2026-09-20.v1`；FCL Case、报价工作流与响应各有独立显式版本，候选命名如下，不改旧严格 Schema 的含义：

- `fcl-case@2026-09-20.v1`
- `fcl-rate-dataset@2026-09-20.v1`
- `fcl-quote-workflow@2026-09-20.v1`
- 新文档分支 `document_kind:fcl_linked`；沿现有文档 route 按上述 FCL workflow selector 分发。

旧提交（节选）：

```json
{"mode":"shipping","transportMode":"fcl","origin":"Shenzhen","destination":"Vancouver","containerType":"40HQ","containerCount":"2"}
```

新提交完整示例：

```json
{
  "contract_version":"fcl-inquiry@2026-09-20.v1",
  "transport_mode":"FCL",
  "origin_city":"Shenzhen",
  "pol":"Yantian",
  "pod":"Vancouver",
  "final_destination":"Toronto",
  "containers":[{"type":"40HQ","quantity":2}],
  "cargo_name":"Synthetic general cargo",
  "cargo_type":"general",
  "estimated_weight":{"value":"18000","unit":"kg"},
  "cargo_ready_date":"2026-10-08",
  "incoterm":"EXW",
  "incoterm_other":null,
  "selected_services":["pickup","export_customs","ocean_freight","canada_customs","delivery"],
  "contact":{"name":"Synthetic shipper","company":null,"email":"shipper@example.test","phone":null},
  "notes":null,
  "consent":true
}
```

新 Case 写入概念形状：

```json
{
  "contract_version":"fcl-case@2026-09-20.v1",
  "expected_version":3,
  "expected_customer_supplement_ref":"00000000-0000-4000-8000-000000000002",
  "confirmed_fields":{"pol":"Yantian","pod":"Vancouver","containers":[{"type":"40HQ","quantity":2}]},
  "reason":"已核对客户补充"
}
```

`confirmed_fields` 是完整闭合 FCL 字段集的显式子集，不接受任意 JSON Patch 或自由对象；最终 JSON Schema 在接受后由基线生成。每次确认记录实际 staff actor、时间、原值/新值、补充引用、前后 Case version。公众补充使用单独闭合输入，只允许其有权提供的客户字段；未知字段不忽略。

旧 native binding 固定 `zoneInputSchema`。新 FCL 文档绑定示意：

```json
{
  "document_kind":"fcl_linked",
  "fcl_quote_binding_v1":{
    "quote_ref":"00000000-0000-4000-8000-000000000003",
    "quote_version":2,
    "case_ref":"00000000-0000-4000-8000-000000000004",
    "case_version":4,
    "reviewed_customer_event_ref":"00000000-0000-4000-8000-000000000002",
    "cost_snapshot_digest":"<server sha256>",
    "sell_projection_digest":"<server sha256>",
    "source_refs_digest":"<server sha256>",
    "binding_hash":"<server signature>"
  }
}
```

这是字段解释示意，不是可校验实例。Rate 的完整 provenance 留在绑定的内部 Quote revision；此对象用引用和摘要复用既有签名/审核机制，不另建 Provenance 服务。客户 PDF 不打印该内部对象。

所有对象 Draft 2020-12、additionalProperties=false；金额、FX、比例为 decimal string；重量单位显式；柜数为正整数并由柜型语义限定为柜。版本及身份字段不由客户端认定权威。

## 5. Case / Rate / Cost-Sell 语义

### 5.1 原件与当前需求

Inquiry 允许未确认信息；Case 逐步补齐。缺字段时返回 JSON Pointer 缺项和 needs_input，不从 Shenzhen 猜 Yantian，不把 Toronto 自动改成某个 POD。

复用 submitted/in_review/needs_input/closed/cancelled。新的公共补充事件有明确 kind；不再靠 actor_label 或文字内容判断是否客户补充。旧事件派生规则保留用于旧文档，不能追溯重写为新型事件。

FCL 新审核严格绑定当前 Case.version 和补充引用。该版本任何变化均要求刷新 FCL review；既有 linked 的“普通进度不失效”不受影响。终态阻断新报价/正式导出/交接，保留授权历史读取。

### 5.2 精确匹配与服务范围

POL、POD 精确规范值、柜型全部覆盖、Ready Date 在有效期内；不存在显式映射时不做别名、邻港或城市推断。单个 Rate 可含多柜型价，第一版不自动跨来源拼价。

零候选 manual_review；多个候选 manual_review 并列示，人工选择后仍完整校验；未发布/损坏数据 unavailable。显式零费用与缺价是不同值；不得对缺价补零。

Service Scope 只决定应处理的费用范围。每项所选服务必须有明确费用，或有经人员确认的“已包含/明确免费/不在本次范围”说明；存在未定费用时只能是不完整草稿，不称全程总价。EXW/FOB/CIF/DDU/DDP 不能自动产生税费/保险或推定收付责任；尤其 DDP 缺税费依据时必须保留未覆盖项并阻断完整含税承诺。

### 5.3 成本、人工价与汇率

自动生成的 O/F 成本严格来自选中 Rate；staff 可以填写 sell_price。修改已有来源成本必须重新绑定经核验来源，不提供“改成本但继续沿用旧 Rate digest”的入口。

其他人工附费可沿现有模板建立行，但必须明确内部来源 evidence_ref/version 和数量条件。每行 quantity×price 先按既有 Decimal 舍入到两位，再按币种汇总；GP=Revenue−Cost，Margin=GP/Revenue，零收入 Margin=null。

混币种复用既有 USD/CAD 对 CNY 的显式 FX 快照，不自动取行情或填 1。缺必要 FX 时只显示分币种结果，不签发虚构的统一利润结论。

客户售价投影仅输出客户可见名称、分组、数量、单位、sell_price→unit_price、币种和独立客户备注；内部 note 不自动拷贝。已有 hiddenIncluded/hiddenExcluded 是显示规则，不能当作成本保密措施。

## 6. 来源、有效期与审核

每份内部成本快照固定 source_ref/version、rate_id、release_id、digest、有效期、selected_at 和 calculation trace。更新来源不改旧金额，当前性检查发现变化返回 manual_review 并标注“报价来源已更新”。第一版按数据集发布粒度失效，避免依赖图抽象。

Ready 匹配与正式签发分开：Ready 在所用 Rate 窗口内；正式 Quote 日期窗口也受来源有效期约束。提前使用尚未开始有效的 Rate 作成本候选可展示，但正式签发仍须有明确允许的业务语义；本版不默认允许。主 fixture 时钟固定 2026-10-08。

review 签名至少覆盖：个人归属类型与受理人 ID、Case ID/version/latest supplement、内部 Quote id/version/完整内容 digest、全部来源版本/有效期、客户售价与 FX、出具人/条款模板、Quote 日期、reviewer 和期限。approve 再读取当前 Case、来源、报价版本和权限，不接受旧 hash。沿现有文档 n→n+1 批准证据，不另做审批引擎。

来源读回在计算 await 与 PDF render await 之后重查，changed/unavailable 不提交结果。单实例 fixture 中，关联 checkpoint 应在既有串行写入边界完成；各库不能宣称天然具有同一事务。实施必须以竞争测试证明 Case/Rate/Quote 在检查至写入窗口发生变化时失败闭合，并明确统一写入调度或短事务锁顺序；不能靠页面刷新代替。

**退回是纠正性动作。** 当前权限、对象可见性、expected_version、可退回状态与幂等仍必须检查；新的客户补充、来源过期/更新或终态不应让工作人员无法记录拒绝原因。不得调用只适用于新审批/新正式承诺的当前性门禁阻断纠正性退回。

“退回补充”由已有 document reject 和 Case needs_input 两个业务动作组成。复用其窄方法，分别幂等与读回；界面必须展示部分成功并安全续做，不能把两个数据库的非原子写入包装成一次已完成。客户回复之后再次确认、匹配、定价、审核，旧批准不复用。

## 7. API / Web / CLI 及状态

候选端点如下，仅列 FCL 主闭环必须的操作；不扩充公共 MCP 工具目录或业务查询 Key。

| 边界 | 候选入口 | 必要性 |
|---|---|---|
| 公开 | `POST /inquiry/api/v1/session`、`POST /inquiry/api/v1/fcl` | 匿名安全提交与原子建立 Inquiry/Case |
| 本票 | `GET /inquiry/api/v1/fcl/{ref}`、`POST .../{ref}/supplements` | 客户可见摘要与补充，受本票凭据限制 |
| 人员 Case | 原 `/console/api/v1/cases` 路径，显式 FCL selector；新增窄 `confirm-fcl`、`handoff` 动作 | 结构化确认与交接，不制造第二套 Case API |
| 人员 Rate | `/console/api/v1/admin/fcl-rates` 及既有 save/preview/publish/disable/rollback 动词 | 复用 NativeAdmin 发布模型 |
| 人员报价 | 现有文档路由下 FCL selector；补 `fcl-match`、`fcl-save`、`fcl-get` | 匹配、内部 Cost/Sell 工作与版本读回 |
| 人员文档 | 现有 prepare/save/get/list/review/approve/reject/export 动词，FCL selector | 售价投影与正式/历史文件 |

内部报价方法放在现有 quote-native 服务边界，document workflow 仅受控调用；route 名称可以在正式 Schema 接受时收敛，但操作责任不得混成 generic write。

Web/API/CLI 共用服务计算与状态。人员 CLI 继续用 workspace session、CSRF 和 Idempotency-Key；公众 CLI/API 使用公开 bootstrap/本票凭据，不能混用企业或查询 Key。所有新增动作都交付 CLI 操作与 schema/help，双方权限投影一致。

| 结果 | 包络状态 |
|---|---|
| 不完整但结构合法的 Inquiry/草稿已持久化 | success，业务 complete=false |
| 定价缺字段、缺 FX、缺报价费用 | needs_input |
| 没有匹配 Rate、多候选未选、来源/Case 更新 | manual_review |
| 越权、跨票、伪造来源、版本/幂等冲突 | blocked，禁止泄露对象存在性 |
| 运营配置/来源依赖/持久化/PDF renderer 不可用 | unavailable |

只能使用现有五状态。具体 reason enum 与精确 HTTP 映射须随正式闭合响应 Schema 交付；本草案不能直接代替运行合同。客户公共响应不包含内部 Cost/Sell/来源候选。

## 8. 兼容、迁移和回退

1. 在隔离 fixture 完成合同和失败测试后再实现。不得把当前业务表原地解释成 FCL；旧 Case 保持原 payload，读旧表单不会自动触发转录。
2. 增量建立两张必要表，为 Case/event 增加 FCL 引用与类型化 payload；旧行和旧版本语义保持。文档表按第 3.2 节迁移归属列、约束和索引，核对原记录数量、digest 和历史读取；涉及 SQLite 重建表时必须在受控迁移事务中完成。编号唯一索引与外键保证 Inquiry/Case 原子提交。所有序列与版本不能靠 COUNT(*) + 1 无锁生成。
3. 原生配置只新增 fcl kind 的受版本分发数据。旧 binary 可能把未知 kind 误当 maritime，故不允许未升级 writer 接管新数据。
4. 文档新分支只能由 FCL selector 读写。旧请求不能移除 FCL 绑定或转换成 manual/native_unlinked 绕过审核；旧版本列表过滤新记录，直读明确要求新合同。
5. 每个受影响 SQLite store 使用新版本门禁，升级前停止旧 writers，事务升级后读回。不能复制一个可写数据库再做双写。临时测试使用 fresh fixture；真实升级与 Linux writer 门禁另验。
6. 回退先关闭公开提交/FCL 编辑发布入口，保留新表、事件、文档版本、PDF 和只读兼容 reader。不删除原件、不换回旧备份假装最新。旧 writer 对新 schema 拒绝打开。
7. 需要灾难恢复时单独确认恢复点和潜在业务丢失，保留新库；生产备份恢复与部署均非本次审计授权。

## 9. 精确文件方案与职责

以下为 M1 实施涉及的文件职责；每次实际写权限由本机单节点 Task Packet 缩小到精确文件，不是整目录写权限授权：

| 文件 | 修改职责 |
|---|---|
| `services/access-gateway/portal/cases.ts`、`case-contracts.ts` | Inquiry/Case/事件、公开 actor 与本票访问、FCL 个人管理、字段确认、编号、交接 |
| `services/access-gateway/portal/http.ts`、`server.ts`、`production.ts` | 窄 public/personnel 路由和显式受理账号注入，拒绝默认账号或占位企业 |
| `services/access-gateway/portal/native-admin.ts`、`native-admin-contracts.ts` | FCL 个人数据集与现有版本发布、权限和读回 |
| 新 `services/quote-native/fcl-contracts.ts`、`fcl.ts` | FCL 闭合合同、匹配、Cost/Sell；是现有服务内文件，不另起通用引擎 |
| `services/quote-documents/workflow-contracts.ts`、`workflow.ts`、`service.ts` | 个人归属存储迁移与仅 FCL 授权、出具人模板、Quote revision 持久化、sell 绑定、review/export 门禁、纠正性退回；旧业务不开放个人写入 |
| `services/quote-documents/engine.ts` | 尽量直接复用；必要的个人出具人及 FCL 路线/柜量展示，不重建 PDF |
| `apps/inquiry/model.ts`、`app.js`、`index.html`、`styles.css` | 固定 FCL 三步、公开提交和本票补充 UI；旧历史需要的模型保留版本化读取 |
| `apps/console/cases.js`、`quote-documents.js`、`quote-documents.css`、`native-admin.js` | 同一 Case 工作区、FCL 编辑器/Rate 配置，不新增导航体系 |
| `deploy/cli/workspace.ts`、`workspace-contracts.ts` | 人员 CLI；公开 CLI 的最小路由在现有 CLI 主入口接入，不授予查询 Key 写权限 |
| `deploy/scripts/start-portal-fixture.ts` | 显式 fixture 受理个人、无公司全链路、假 mail transport 与固定 clock |
| `deploy/scripts/generate-case-schemas.ts`、`generate-native-schemas.ts`、`generate-portal-openapi.ts` | 接受合同后由对应 01/06 维护正式生成物 |
| 现有 case/document/native/CLI/HTTP 测试及最小 FCL 测试 | 属地维护者覆盖对应反例与同源读回 |

共享 Contract/Schema 由 01 维护；Portal 07、CLI/e2e 06 与业务服务维护者须确认上述精确文件归属。`docs/agent/workstreams/current.json` 与 AGENTS 对 07 的列举差异不在本 RFC 顺手修复。

## 10. 验收与接受条件

完整矩阵见审计第 13 节，覆盖 Route/POD/Container/Validity/Multiple Rate/Case Version/Source Version 七类必测冲突，并加个人/企业隔离、零公司记录的全链路、外部补充、Cost/Sell 泄漏、退回、并发、幂等、历史 PDF 与 fake mail。

既有精确回归命令：

```sh
npx --no-install vitest run tests/e2e/shipper-inquiry.test.ts tests/access-gateway/portal-cases.test.ts tests/access-gateway/portal-cases-http.test.ts tests/access-gateway/portal-workspace-cli.test.ts tests/access-gateway/portal-quote-workflow-v3-http.test.ts tests/quote-documents/engine.test.ts tests/quote-documents/schemas.test.ts tests/quote-documents/service.test.ts tests/quote-documents/workflow.test.ts tests/quote-documents/workflow-linked.test.ts --maxWorkers=2
```

## 11. FCL.7a 实施附录

本附录记录 `FCL.7a` 对现有 Quote Documents 服务层的隔离实现，不扩大第 1 节范围，也不表示报价、审批、HTTP/UI/CLI 或生产发布已经完成。

- `DocumentStore` 默认仍最多打开 v3。v4 只由显式 FCL store opt-in 打开；v3 reader 遇到 v4 必须拒绝，不能静默降级。
- v4 将 `document_configs`、`document_revisions`、`document_current_revisions`、`document_audit` 重建为 `org`/`personal_owner_id` 二选一归属，并以 `CHECK((org IS NULL)!=(personal_owner_id IS NULL))` 固定。`document_configs` 两个 owner 列分别唯一。
- 迁移只在单个 `BEGIN EXCLUSIVE` 事务中完成，保留旧 payload、revision/current、digest、audit、PDF bytes 和 signing secret。迁移逐表核对固定 v3 列名、类型、nullability、primary/unique 约束；只接受命名索引 `document_revisions_document(document_id, version DESC)` 和 `document_current_org(org, updated_at DESC)`。未知列、触发器、额外显式索引或以名称伪装但列定义不符的索引以 `workflow_schema_unsupported` fail closed。预留 `_v4` 同名表不会被删除或覆盖。
- v4 reopen 和 read-only 路径校验元数据、固定列布局、nullable owner 列、XOR 约束、primary/unique owner 约束，以及 `document_revisions_document`、`document_revisions_personal`、`document_current_org`、`document_current_personal`、`document_audit_personal` 的实际列序、排序和唯一性；read-only 不执行建表或业务写入。
- FCL 文档配置合同为 `fcl-document-workflow@2026-09-20.v1`，服务方法为 `fclConfig(ctx)` 与 `saveFclConfig(ctx,input,key)`。归属使用 `org=NULL, personal_owner_id=<receiver>`，复用现有 `standardFeeTemplate` 和 `feeTemplateSelectionSchema`。
- 每次 FCL 读取、写入和幂等重放重新校验已验证个人身份、`organizationId=null`、固定 receiver 和 active callback。存在其他个人 owner 时启动失败；未启用 FCL 时个人行不可见。
- 个人配置写入使用 CAS、`confirmed=true`、个人 actor/action 幂等分区。同 key 异 body 返回 `idempotency_conflict`；同 key 重放返回当前配置，不重复 audit。audit、idempotency 与配置 readback 在同一事务内校验；提交后的读回失败不触发第二次回滚。

本节点的精确验证命令：

```sh
npx --no-install vitest run tests/quote-documents/fcl-personal-store.test.ts tests/quote-documents/service.test.ts tests/quote-documents/workflow.test.ts tests/quote-documents/workflow-linked.test.ts tests/quote-documents/schemas.test.ts --maxWorkers=2
npm run typecheck
node --import tsx/esm deploy/scripts/generate-native-schemas.ts
```

实施后必须新增对应 FCL 失败测试，并运行受影响测试、typecheck、lint、validate:schemas、validate:agent-standards、build:agent-pack、build、build:cli、git diff --check。浏览器和真实 PDF fixture 验收须另外实跑，不能被上述单元测试替代。新增精确测试路径在代码建立后登记，不将不存在的命令写为已通过。

本轮既有回归结果为 10 文件、113 通过、2 跳过；新的 FCL 系统、Schema 运行接入、真实报价和部署均未完成。

本次隔离实施接受：公开提交固定个人受理与本票凭据、仅 FCL 的个人授权及存储迁移、两张必要表、FCL 新绑定/版本失效规则、纠正性退回、客户输出白名单及上述文件职责。其依据是用户先确认个人受理、随后要求完整完成 M1；并非 K12 自行扩展业务范围。01 合同维护由本机负责，07 Portal 与06集成及相关业务文件由 K12 在每包精确授权下实施。新运行 Schema 随相关实现由同一 Zod 合同生成，本文的 JSON 示例不是运行输入。

实施和验收使用可丢弃合成 fixture。每节点允许一个范围内本地提交，后续节点可从已审核的候选 SHA 继续，不伪称候选已合并 Main。真实邮件、真实数据导入、生产发布、推送和合并仍需相应明确授权。若实现发现需要改变以上业务、安全或数据归属语义，本机先修订本文并审核，不让执行器自行扩大权限。

## FCL.3 实施说明

本节点只实现隔离服务层，不启用 HTTP、UI、CLI、Rate、Quote、Document 或 MCP。

- `CaseStore` 默认仍以 v1 打开，不创建 `fcl_inquiries`，也不增加事件类型列。
- FCL v2 升级必须显式提供 `fresh_fixture` 或 `exclusive_verified` 模式、`authorized=true` 和 `oldWritersStopped=true`。
- `fresh_fixture` 仅在 `business_cases`、`business_case_events`、`business_case_idempotency` 都为空时允许。
- `exclusive_verified` 必须执行服务端注入的同步 `assertExclusive`；缺失或抛错均阻断升级。本节点测试只使用受控离线 fixture callback，不包含生产 writer 探测。
- 已升级数据库只通过 `reopen` 模式重新打开；未升级的旧 writer 因 `user_version=2` 拒绝打开。
- `submitFclInquiry` 使用同一 `BEGIN IMMEDIATE` 保存 Inquiry、Case、两条类型化初始事件和幂等记录。首次提交在提交前与提交后各执行一次初始读回；幂等重放读取不可变原件与当前合法 Case 状态，不强制 Case 仍为 v1。
- 通知失败、超时、禁用或配置缺失不回滚业务保存，不重发；`complete` 只表示基本询价需求完整，不表示 Rate、费用、审核或正式报价完整。

## FCL.4 实施说明

本节点仍是隔离服务层实现，不启用 HTTP、UI、CLI、Rate、Quote、Document 或 MCP。

- `updateFclCaseStatus`、`supplementFclCase`、`supplementFclCaseAsStaff` 和 `confirmFclCase` 共用关闭的字段 diff/patch 模型。只允许已接受 FCL 字段，未知字段、`contract_version`、`transport_mode`、`consent`、owner/org/source/price 均拒绝。
- 字段 patch 的每一项显式包含 field/value；事件用同一字段 union 保存 before/after。柜型、service 和最终合并仍调用共享 final validator，不允许猜测或跳过语义校验。
- 客户补充只允许在 `needs_input` 状态使用本票凭据；staff 代录、状态更新和确认只允许当前固定 receiver。closed/cancelled 阻断新的补充、确认和状态变更。
- 客户补充和 staff 代录都产生新 Case version 和类型化事件。只有 `fcl_customer_supplement` 能成为 `latest_customer_supplement_ref`；staff 事件不会冒充 customer。
- 确认事件保存 reviewed customer ref、确认前后 version、理由及实际字段 before/after。内部 `review_context` 区分最新客户补充、最后确认 version/ref，以及是否需要重新核对。
- 写事务在 idempotency INSERT 前执行语义 readback，核对预期 version/status/input、事件 payload/actual actor 和原件 digest；失败会回滚 Case、event 和 idempotency。提交后再次读回。
- `listFclCases` 接受闭合 limit/status/cursor 查询，返回稳定的 newest-first cursor 分页。列表项由 internal view 显式 omit 原件、完整 event 历史、receiver 元数据和通知元数据；详情读取才返回完整内部视图。
- 客户可见摘要只投影 `visibility=customer` 的提交、补充和 status 事件。内部确认理由、internal note、receiver ID、凭据 hash 和匿名 session hash 不进入公共响应。

## FCL.5 实施说明

本节点复用 `NativeAdminStore` 现有四表，只为 FCL 增加显式 kind/scope/合同，不创建新表或第二套发布仓库。

- FCL dataset 固定 `fcl-rate-dataset@2026-09-20.v1`，覆盖 supplier/source/version、有效日期、柜型海运费和 additional fees。金额使用非负 decimal string；CNTR/SHIPMENT 的 container 条件由 closed discriminated union 表达，跨 item 的 container 关系由共享 service validator 执行。
- `NativeAdminStore` 默认仍是 v2。FCL 需要显式 `fresh_fixture` 或 `exclusive_verified` 升级到 v3；前者只在四张 native 表都为空时允许，后者必须执行服务端同步 exclusive callback。旧 reader 对 v3 拒绝打开。
- FCL scope 固定为 `fcl-person:<receiver user id>`，只接受已验证、无组织且 userId 等于配置 receiver 的 context。每次 read/write/replay 都重新验证 receiver callback；其他个人、组织角色和 platform operator 无回退权限。
- `get/preview/save/publish/disable/rollback` 共用既有 CAS、preview hash、reviewed confirmation、audit 和 idempotency。FCL active release 读取闭合校验 row id、release id、positive version、ISO published_at、完整 dataset、digest 和 scope/kind。
- 保存 draft 允许保留有效期已过但结构/来源/币种完整的资料；本节点不按当前日期阻断发布，真实 Ready/签发日期约束留给后续报价节点。
- FCL rollback 不改 active 指向旧 release，而是以旧内容创建新的 release id 和新 version。测试覆盖 R2 → R4 → 回滚生成 R6，R6 内容匹配 R2 但 release id 不同，旧报价来源不会被重新恢复为当前 release。
- FCL 写事务在 COMMIT 前执行 draft/active/release/version/audit exact readback，并比较完整 expected release。任何失败回滚业务表和 audit；COMMIT 后的读取错误不再触发二次 ROLLBACK。

## FCL.6 实施说明

本节点只实现服务层精确匹配，不保存报价、审核结果、正式文件或 HTTP 路由。

- 新 `FclQuoteService` 只依赖 `CaseService.getFclCase` 和 `NativeAdminService.get(ctx,'fcl')` 的已授权读回，不直接访问数据库，也不接受客户端提供的 Case payload、Rate、价格、owner 或 source。
- 请求固定 `fcl-quote-workflow@2026-09-20.v1`，只允许 case binding、expected version/ref 和可选 selected rate id；未知字段拒绝。
- 匹配只接受精确 POL、POD、全部柜型覆盖且 Ready Date 位于同一 Rate header 的有效期。不会推断深圳/盐田、Vancouver/Prince Rupert、40HQ/40GP 或跨多个 Rate 拼接柜型。
- Case version、expected customer supplement ref 和终态先于候选计算检查。随后先返回缺字段 `needs_input`，再处理字段齐全但未确认/需复核的 `manual_review`；来源读取失败不得遮盖 Case 缺项。stale binding 和 closed/cancelled 为 `blocked`。
- 无 active FCL release、发布损坏或读取失败为 `unavailable`；零候选为 `manual_review`；多候选未指定为 `manual_review` 并列出全部候选；显式 selected id 必须在候选集合中并重新满足全部条件，非候选 id 为 `blocked`。
- 选中快照保存完整 Rate、rate/release id、release version、dataset digest、source ref/version、有效期、selected_at、Case version/latest supplement ref 和匹配 trace。该结果不等于审核、批准或正式报价。
- 当前 clock 只用于 selected_at，不替代 cargo_ready_date；clock 必须是严格 ISO datetime，否则统一 `fcl_quote_clock_unavailable`。future Rate window 可作为成本候选，正式签发门禁仍留 FCL.9。
- 生成 `fcl-quote-request.schema.json` 和 `fcl-quote-response.schema.json`；未知字段、五状态和来源快照均有闭合 Draft 2020-12 合同。

## FCL.7b–8 实施说明

本节点只追加服务层 Cost/Sell 报价快照，不审核、不导出、不提供 HTTP/UI/CLI，也不改变旧企业 Quote Documents 合同。

- Document DB 目标 schema 为 v5，仅新增 `fcl_quote_revisions(quote_id,version,personal_owner_id,case_ref,payload,content_digest,actor,created_at)`，复合主键为 `(quote_id,version)`，并增加 owner/case 索引。v3/v4 升级到 v5 在同一 `BEGIN EXCLUSIVE` 事务内完成，保留旧 schema、数据、PDF bytes 与 signing secret；旧 max4 reader 对 v5 返回版本不支持。
- `saveFclQuote/getFclQuote/listFclQuotes` 复用 7a FCL receiver 授权、`document_idempotency` 和 `document_audit`。每次读取、写入、幂等重放都验证个人身份、receiver active、Case 可见性和 quote owner；历史版本在 Case 关闭后仍可由本人读取。
- Case 与 Native 服务只新增同步 `withFclReadLock` guard：它先验证本人和 active，再 `BEGIN IMMEDIATE`，拒绝 AsyncFunction/thenable，固定 Case → Rate → Document 顺序；三层数据库不是同一原子事务，锁只覆盖读取到 Document commit 的窗口。
- 创建和 replace 必须重新调用既有 FclQuote matcher，严格核对 Case version/ref、selected rate、release id/version/digest；retain 只使用已保存的完整来源快照，更新人工售价、附费、scope、FX 和备注，不刷新旧来源成本。
- Rate 来源行由服务端派生：O/F 按 Case 柜型和数量，Rate 附费仅使用已选 service，CNTR 使用对应柜型数量，SHIPMENT=1；客户端不能上传 Rate/Case/来源 cost。手工行的 CNTR/SHIPMENT 数量和柜型必须与 Case 数值匹配，最多与来源行合计 60 行，以兼容现有文档 60 个 fee_items 上限。
- 每个 `cost_price`/`sell_price` 显式保留 `0` 和 `null`，禁止补零或把 scope 说明当成费用。Scope 无完整 priced 行时为 pending；已有完整 priced 行自动记为 priced；`included` 指向同 quote 的真实完整 priced row（不强绑同 service）；`free` 可保留 sell=0 的真实成本和负 GP，但拒绝正 Sell；`out_of_scope` 不得与实际收费行并存。
- 金额使用共享 precision 48 / HALF_UP：逐行 quantity×price 先 round2，再按 USD/CAD/CNY 汇总；Revenue、Cost、GP、Margin 均保留独立可解释 trace。单币种原币利润不要求 CNY FX；混合贡献币种缺必要 USD/CAD→CNY FX 时 quote completeness 标记缺失，CNY 折算值和统一利润为 null，不自动取行情或补 1。
- 新 Cost/Sell Schema 为闭合 Draft 2020-12；正 decimal 上限为 10 位整数、6 位小数，计算金额和 Ratio 使用足以容纳合法输入乘积/负利润的十进制范围。`customer_note` 对齐旧文档 500 字符，模板引用复用现有 `templateRefSchema`，模板不提供价格权威。
- 保存事务对 payload、内容 digest、row metadata、audit 和 idempotency 做同事务读回；触发器替换为合法 JSON 也必须回滚。提交后读回失败不回滚已提交版本；外层锁释放失败时，同一幂等 key 重试必须读取已有 quote，不重复 quote/audit。

## FCL.9 实施说明

本节点只生成客户售价投影和 `fcl_linked` draft，不实现 approve/reject、正式 PDF、HTTP/UI/CLI、handoff 或第二套审批对象。

- Quote get/list/save 增加 live `currentness` 投影，不改已存 snapshot/digest。Case version/补充/状态、Quote 当前版本、active Rate release/Rate 内容、来源有效期均分别返回可识别 reason code；历史 quote 仍可读历史金额。
- 继续使用 Document DB v5 的 `document_revisions`、`document_current_revisions`、`document_revision_events`、`document_audit` 和 `document_idempotency`，不新增表或 store。个人文档固定 `org=NULL`、`personal_owner_id=receiver`、`document_kind=fcl_linked`。
- 客户 DraftDocument 只由服务端 quote/case/config 生成：费用行只取 `sell_price`，note 只取 `customer_note`，内部成本、利润、supplier/source 原文和 internal note 不进入客户投影。`container_no` 保持 null，柜型/数量保留在 case projection；POL/POD/final destination 不做推断。
- 服务端用现有 Document signing secret 对 domain、document/owner/revision/version、Case/Quote/Source/模板/客户投影和日期做 HMAC。读取和重放校验签名、历史 quote digest 引用、source binding、revision/current/event/audit 元数据和 owner；本地引用损坏 fail closed，当前 Rate 变化只影响 `currentness`。
- cache 只保留完整可审核 quote；混币缺 FX、缺成本/售价、待补 scope 均不得生成客户文档。日期门禁为 `quote_date <= today <= valid_until`，且整个窗口位于来源 Rate 有效期内；未发布 draft 不改变当前 active source。
- 同一 document 仅允许 draft refresh append 下一 draft revision并保留历史；approved/rejected 的后续实际转换留给 FCL.10。

## FCL.10 实施说明

本节点在同一 DocumentWorkflowService、v5 表、revision/current/event/audit/idempotency 和临时 `reviews` Map 内增加 FCL review/approve/reject，不新增审批表、审批服务或数据库。

- `reviewFclDocument` 只在 Case、active Rate、Quote、模板、日期和 currentness 全部有效且 quote 完整时发出 10 分钟 review credential。review hash 使用现有 secret、FCL domain、个人 owner/actor、document/revision/version、完整 content digest、Case/Quote/来源/模板/日期和 expiry。
- `approveFclDocument` 只接受 document/version/review hash及 `confirmed:true`，在 Case→Rate→Document 同步锁内重新校验 review 记录、currentness、quote completeness 和真实 payload，再 append approved revision。decision 记录 source revision/version/digest、reviewed/approved actor/time、review hash/expiry 和 approved revision/version，并由 HMAC 覆盖。
- `rejectFclDocument` 是纠正动作，只要求当前 draft、个人权限、CAS、非空 reason 和 Case→Document 顺序；不读取 active Rate 或 quote currentness。拒绝只写内部 decision/reject event，不把 reason 注入 public Case event。
- draft 普通 refresh 保留；rejected 使用显式 `resubmit`，允许同一 Quote 仅修正展示字段；approved 使用显式 `re_quote`，要求 Quote ref/version 或个人模板版本发生变化。重提/re_quote 生成新 draft，清除旧 decision，保留旧 approved/rejected revision。
- decision 为 payload 可选字段；旧 draft 无 decision 时仍保持原签名/digest 可读。approved/rejected 强制 decision 完整、前驱 revision 为真实 draft 且 HMAC/digest 有效；读取同时核对 row source/review/rejection、current pointer、event/audit 和 idempotency reference。

## FCL.11 实施说明

本节点只导出当前 approved FCL customer PDF 或读取既存历史 bytes，不新增 PDF 引擎、表、审批对象或生产发布。

- `exportFclDocument` 使用闭合 formal/history 请求。formal 只在 Case/Quote/active Rate/template/date/currentness 和已保存 approval decision 全部有效时生成或复用 PDF；history 只读取已有 approved 版本缓存，不使用当前数据重建。
- 首次正式导出在 Case→Native→Document 一致读取窗口中取得 approved payload，释放锁后调用现有 renderer；完成后重新取得相同锁顺序和 Document 写事务，复核 revision/content digest、currentness 和缓存，再写 PDF/audit/idempotency。
- `document_pdfs` 仍是唯一 bytes 权威。另以现有 `document_idempotency` 存储带 HMAC 的 PDF binding，绑定 owner/document/revision/version/content digest/sha/length/生成 audit；每个下载 key 只引用已验证 binding，缓存 bytes 或 sha 被同时替换、binding digest/audit 被替换均 fail closed。历史下载只读，不要求 writable store。
- renderer 只接收显式 customer input、template 和 FCL 客户 metadata。手续费仅使用 sell 投影，客户 scope 使用人类可读 service/范围名称；sentinel 成本、GP、供应商、source 原文和 internal note 不进入 HTML/PDF。filename 由服务端按文档 ID/version 生成。

FCL.11-R1 进一步将 FCL 客户表格固定为 7 列（费用项目、数量、单位、单价、币种、小计、说明），把客户备注扩展到 33% 宽度并维持 A4、分页和旧企业 8 列输出不变。FCL 只显示实际提供的换算率与可计算换算结果，单 USD 无 FX 时只显示原币合计；history 在既无 PDF bytes 也无 binding 时返回 `fcl_document_history_bytes_missing`，有 PDF 但无 binding 继续 fail closed。

## FCL.12 实施说明

本节点只实现隔离服务层的已批准报价交接，不新增 Handoff 服务、Booking、Shipment、Order 或数据库表。交接权威仍是既有 `business_case_events` 与 `business_case_idempotency`；事件固定为 `kind=fcl_handoff_recorded`、`visibility=internal`。内部事件不进入公开 Case event allowlist，客户可见 Case 摘要不包含 `handoff_note`。

### FCL.12.1 实际服务 API 与闭合 DTO

实现入口为现有 `DocumentWorkflowService` 的两个同步方法：

```text
saveFclHandoff(ctx, input, key): FclHandoffView
getFclHandoff(ctx, input): FclHandoffView
```

`saveFclHandoff` 的闭合请求为 `fcl-handoff@2026-09-21.v1`：

```json
{
  "contract_version":"fcl-handoff@2026-09-21.v1",
  "case_ref":"<uuid>",
  "expected_case_version":2,
  "expected_customer_supplement_ref":"<uuid|null>",
  "quote_ref":"<uuid>",
  "expected_quote_version":1,
  "expected_quote_digest":"<sha256-hex>",
  "document_id":"<uuid>",
  "expected_document_version":2,
  "expected_pdf_sha256":"<sha256-hex>",
  "confirmed":true,
  "note":"<trimmed 1..2000 characters>"
}
```

客户端不能提交客户名称、地址、成本、售价、Rate、审批人、actor、事件 ID、时间或持久化 owner；这些字段全部由服务端从当前 Case、Quote、Document 和已验证 PDF binding 派生。

`getFclHandoff` 的闭合请求只有：

```json
{
  "contract_version":"fcl-handoff@2026-09-21.v1",
  "case_ref":"<uuid>"
}
```

两个方法共用闭合输出：

```json
{
  "contract_version":"fcl-handoff@2026-09-21.v1",
  "case_ref":"<uuid>",
  "status":"pending|handed_off",
  "reason_codes":["<bounded reason>"],
  "current":null,
  "history":[],
  "replay":{
    "replayed":false,
    "submitted_request_digest":null,
    "submitted_current":false
  }
}
```

`current` 和 `history` 的每一项是闭合 Handoff payload，只保存 Case/Quote/Document/approved revision/PDF 的 opaque refs、digest、客户路由/柜型投影、批准时间、内部交接备注、actor/time 和 `request_digest`；不复制 Cost/Sell/Rate 权威表，也不生成第二份报价或审批对象。无事件时返回 `pending` 和 `fcl_handoff_not_recorded`；当前 Case、Quote、Rate、模板、日期、Document 或 PDF 变化时，旧事件只进入 `history`，当前状态返回 `pending`。

### FCL.12.2 冲突、重放和容量

- `saveFclHandoff` 要求 Quote 当前、Document 已批准、审批 decision/HMAC 有效且正式 PDF binding 与 bytes 均已存在。不会为 handoff 自动渲染 PDF、自动审批、发邮件或写入 Booking。
- 同一 `key`、同一请求 `request_digest` 重放时，使用固定 `scope/key/request_digest` 重新定位原 event，不按当前 Case/Quote/Document 新版本门禁拒绝历史恢复，也不重复插入 event 或 idempotency。
- 重放输出显式设置 `replay.replayed=true`、`replay.submitted_request_digest=<原请求摘要>` 和 `replay.submitted_current`。该字段只在原 event 仍通过当前 Case/Quote/Rate/模板/Document/PDF currentness 时为 `true`；变化时为 `false`，并返回派生出的 `pending/current=null` 视图，不把历史事件伪装成当前交接。
- 同一 Document approved revision、approved version 和 PDF digest 使用不同 key 时返回 `fcl_handoff_already_recorded`，不追加第二个歧义事件。
- Handoff 历史最多 100 条。写入前在 Case 事务提交前校验容量，已有 100 条时第 101 条返回 `fcl_handoff_history_limit_exceeded`，不会先提交再让后续读取永久失败。读取侧也明确检测超过 100 条而不是静默截断。

### FCL.12.3 锁顺序与唯一 Case 业务写

保存路径固定使用以下同步顺序：

```text
Case BEGIN IMMEDIATE
  -> Native Rate BEGIN IMMEDIATE
  -> Document BEGIN IMMEDIATE
  -> 验证 Case/Quote/Document/PDF 并构造服务端 payload
  -> 写 Case event 与 Case idempotency
  -> COMMIT Case
  -> 完成 event/idempotency 读回
  -> 释放 Document，再释放 Rate
```

Document 写 guard 保持到 Case COMMIT 和提交后读回完成；它不是 FCL.11 的只读 snapshot。Native/Document 尚未提交或验证失败时仍按其正常 guard 回滚，不禁止其既有安全回滚。Case event 与 idempotency 仍是唯一 Handoff 写入；`recordFclHandoffInTransaction` 要求真实活动事务，不能独立自动提交半写。

插入前后会核对完整的 `business_cases` row 与不可变 FCL Inquiry 原件；插入后在同一 Case 事务和 COMMIT 后分别核对 event metadata、payload、idempotency key/digest/case 绑定。事务由连接级同步 guard 跟踪，不依赖 Node 22.13 缺失的 `DatabaseSync.isTransaction`。提交前失败会尽力 `ROLLBACK`；若 `COMMIT` 已实际完成后才发生 transport 异常，无事务可回滚的错误被吞掉并保留原异常。相同 key 重试仍恢复原事件且不重复写入。

### FCL.12.4 未交付入口

CLI、HTTP、UI 仍待 FCL.13；本 M1 不新增 MCP 写入口，也不改变静态工具注册。FCL.12 没有新增 route、没有改变现有 Case/Quote/Document 公共合同，只交付上述服务层方法和生成 Schema，部署、真实连接、外部邮件、Booking/SO 及生产业务验收均不在本节点范围内。

## FCL.13a 实施说明

本附录记录 FCL service 到现有 Portal 运行入口的窄 HTTP 接线。它不新增 MCP tool、不修改静态工具注册、不交付 UI/CLI 页面，也不创建第二套业务服务。

### FCL.13a.1 Canonical staff HTTP map

人员接口固定在 `/console/api/v1/fcl/<action>`。请求先使用既有 `/console` cookie、Origin/Host/transport、CSRF、device-auth 和当前 session context；FCL action 不接受客户端 owner、tenant、source、价格权威或通用 `operation` 字段。

```text
GET  case-list
POST case-get
POST case-status
POST case-staff-supplement
POST case-confirm
GET  rate-get
POST rate-save
GET  rate-preview
POST rate-publish
POST rate-disable
POST rate-rollback
POST quote-match
POST quote-save
POST quote-get
POST quote-list
GET  issuer-config
POST issuer-config-save
POST document-save
POST document-get
POST document-list
POST document-review
POST document-approve
POST document-reject
POST document-export
POST handoff-save
POST handoff-get
GET  notification-get
POST notification-save
```

以上是唯一 canonical staff route/method map；不提供 REST 风格别名。`case-list` 的 query 只允许 `limit/status/cursor` 并有界解析。`quote-match` 保留 matcher 原五状态与 data evidence，HTTP 外层不把 `manual_review`、`blocked` 或 `unavailable` 改写成 `success`。`document-export` 在 HTTP action 内真实 await service Promise，再按导出 Schema 验证响应。

`fcl-http-contracts.ts` 用现有 service Zod Schema 生成每个 action 的闭合 request/response map；response 成功态绑定对应 data Schema，`blocked/unavailable` 的 error data 为 `null`，`quote-match` 保留 matcher 的 MatchData 证据。CLI/OpenAPI 必须复用该 map，不复制第二套字段。生成的 FCL HTTP response schema 会对实际序列化 envelope 再验证。

`fcl-http-contracts.ts` 同时导出 `FCL_HTTP_BODY_LIMITS`、`FCL_HTTP_RESPONSE_LIMITS`、公开 action body limits 和 response limit，作为 CLI/OpenAPI 的统一 transport 限制。`rate-save` 允许 16 MiB 的合法 Rate dataset，rate 相关响应允许 40 MiB 以覆盖 draft+active 两份数据，其余 Quote/Case/Document/Notification 使用 12 MiB 响应上限；超过请求上限返回 HTTP 413、`needs_input`、`body_too_large`，不会伪装成服务不可用。该字节上限是领域 Schema 之外额外限制；超长备注或大批量数据应缩减备注/条目后重新保存完整 dataset。当前 save 是替换而不是追加，不得把数据拆成多次 save 以免覆盖丢失。

### FCL.13a.2 Public inquiry HTTP 与本票 session

公开接口单独位于 `/inquiry/api/v1`，不复用 `/console` cookie Path 或平台管理员身份：

```text
GET  /inquiry/api/v1/session
POST /inquiry/api/v1/fcl/submit
POST /inquiry/api/v1/fcl/credential/exchange
GET  /inquiry/api/v1/fcl
POST /inquiry/api/v1/fcl/supplement
POST /inquiry/api/v1/logout
```

公开 bootstrap 返回五状态 envelope、CSRF 和匿名 session；submit/exchange/supplement 必须带现有 CSRF、Origin/Host/transport、JSON body limit、闭合 Schema 和幂等 key。浏览器只在 URL fragment 保存恢复信息，exchange 后清除 fragment，后续使用 `Path=/inquiry`、HttpOnly、SameSite 的加密/认证 cookie；credential 不进入 query、localStorage 或访问日志。

公开 cookie 的内部 payload 使用闭合 Schema、AES-GCM 认证和至少 32 bytes 的服务端 secret。无目标 cookie 等同于匿名，不静默创建新身份；重复、损坏或过期目标 cookie fail closed。exchange 保留匿名 session ID 和原匿名 session 期限，不延长 credential 的 CaseService 到期时间。

`GET /inquiry/api/v1/fcl` 只允许 `inquiry_id` query，必须等于 cookie 绑定票；`supplement` 的薄 wrapper 显式包含同一 `inquiry_id`，去除该字段后才调用既有 Case 客户补料 Schema。跨票、跨标签页或 credential query 一律拒绝，不把 A 票操作发送到 B 票。每次 CaseService 读取仍重新校验 credential 到期。

公开响应使用同一 FCL HTTP version 和裸五状态 envelope；submit/exchange/get/supplement 的成功 data 非空，logout 成功 data 为 null，错误 data 为 null。公开 session 只返回公开 allowlist，不返回内部 Case/Cost/Sell/GP、审核原因、handoff 备注或 receiver 信息。内存中有界 per-IP attempt limiter 限制 bootstrap/exchange 滥用；key 总量固定为 10,000，清理到期项后仍满则对新 key 返回 429，不驱逐仍有效旧 key。它不复用海关 20 次公共配额，也不建立新 Quota 业务平台。exchange/logout 与其他公开写一样验证现有 `Idempotency-Key` 头，但不新增业务幂等表。

### FCL.13a.3 Notification 配置与提交行为

通知配置复用 Native `native_configs/native_audit/native_idempotency`，使用 `kind=fcl-notification`、个人 `scope=fcl-person:<receiver>`，不新建 SMTP、邮件模板或队列服务。配置版本为 `fcl-notification@2026-09-21.v1`，闭合字段只有 `enabled`、`recipient`、`cc`：

```text
getFclNotification(ctx)
saveFclNotification(ctx,input,key)
```

保存使用 CAS、`confirmed=true`、个人 actor/action 幂等分区和 COMMIT 前/后完整 readback；config row 必须 `active=NULL`，audit、idempotency result、版本和 input 全部核对。same-key replay 从已提交 result 恢复，不以当前新版本伪装旧请求；配置变化以 `replay.submitted_version/current` 明确。通知配置和 FCL Rate 使用不同 kind/scope row，保存通知不会改变 active release 或使报价失效。

Inquiry 成功保存后才读取该受控配置；缺失、disabled、transport 失败或 timeout 只写 `not_attempted/disabled/sent/failed` 通知状态，不改变 Inquiry 原件。server 注入 fake transport，客户端不能提供 SMTP/transport；accepted 不等于 delivered，同 key replay 不重复发送。

### FCL.13a.4 Fixture 与生产边界

`start-portal-fixture.ts --fixtures` 在 `PORTAL_FIXTURE_FCL_PERSONAL=true` 时显式进入个人 FCL 模式：不 seed `org_fixture`/`tenant_fixture`，组织数为 0；只在全新空 store 使用 `fresh_fixture`，已有 FCL store 使用 `reopen`，不 reset 数据库或 secret。Case/Native/Quote/Document 共享固定业务时钟 `2026-10-08T12:00:00Z`，session/CLI TTL 仍使用真实时间；receiver 必须来自显式 fixture identity 且 `emailVerified=true`，启动日志只打印 origin、synthetic 日期和非秘密边界。

生产 FCL 默认关闭。`PORTAL_FCL_ENABLED=true` 在尚未接入可信 receiver authority 前以 `fcl_receiver_authority_unavailable` 启动失败，不使用用户表存在、在线 session、`()=>true` 或客户端 boolean 伪造 receiver。server 对 FCL public cookie 强制 `secureCookie=!fixture`，生产调用方不能通过 false 绕过 Transport/Secure 要求。

真实部署、真实邮件、真实 IdP authority、UI 和 CLI 仍不在 FCL.13a 范围内；FCL.13b 尚未开始。

## FCL.13b 实施说明

FCL.13b 在已验证的 FCL.13a HTTP 合同之上交付公开询价页和个人 FCL 工作区，不新增业务权威、不接入 Booking/SO/邮件外发，也不开启生产。公开页复用 `/inquiry/` 三步表单、本票 fragment 交换和 HttpOnly cookie；人员页复用 `/console/#fcl` 与既有 Case、Native Rate、Quote、Document、Handoff 服务。

### FCL.13b.1 Rate preview 历史 release 薄适配

FCL.13a 的 `rate-preview` 只预览当前草稿，而既有 `NativeAdminService.preview(ctx,'fcl',release_id?)` 已支持按历史 release 预览。`rate-rollback` 必须提交目标 release 的 preview hash，因此 13b 只补充既有能力的 HTTP 透传，不改变领域算法、权限、发布语义或 active release 指向。

旧请求：

```json
{}
```

新请求：

```json
{"release_id":"00000000-0000-4000-8000-000000000001"}
```

`release_id` 为可选 UUID；省略时仍按当前草稿预览，保持 13a 行为兼容。HTTP 只允许 `GET /console/api/v1/fcl/rate-preview?release_id=<uuid>`，拒绝未知 key、重复 key 和非法 UUID。请求 map 由 `fclRatePreviewRequestSchema` 闭合，生成的 `schemas/access-gateway/fcl/rate-preview.schema.json` 必须包含可选 `release_id`。历史 release 预览仍经过 `NativeAdminService` 的个人 scope、exact receiver、发布存在性、digest 和权限校验；其他个人或企业 context 不能借用该 query 读取 FCL 个人 release。

### FCL.13b.2 页面与状态

公开页固定为 Inquiry → Case 个人本票视图：

- 三步表单覆盖线路、柜型/柜数、货物、日期、Incoterm、服务、联系人和 consent；不猜测港口、服务或价格。
- 成功提交后先写入 fragment，凭据交换成功才清除；交换失败保留 fragment 和内存链接，刷新可重试，不把 credential 放入 query、localStorage 或日志。
- 本票 GET、补充和 bootstrap 使用 cookie 绑定 `inquiry_id`，异步响应以 generation guard 防止旧票覆盖新票。
- 客户补充可编辑完整闭合字段，提交前显示客户端 before/after；失败保留全部输入。公开事件不暴露内部字段或 Cost/Sell/GP。

个人 FCL 工作区覆盖：

- Case list/get、状态、工作人员代录完整字段、确认/重新核对和事件 before/after。
- Rate dataset 草稿保存、预览、发布、停用和历史回退；附费、服务、单位、柜型、币种和来源版本由人员明确填写，不用缺价补零。
- Quote match 保留 matcher 五状态与候选；不自动选最低价。首次报价 `operation=create`，已有当前报价使用 `operation=update`，缺价/缺 FX 的 `needs_input` data 原样保留并在同一 `quote_ref` 新版本补全。
- CostSell 来源成本只读，售价、人工费用、服务范围、FX 和备注由人员填写；保存后只展示服务器计算结果。
- Case 工作区在宽屏使用“需求摘要 / CostSell / 利润与文件”三列；状态处理与工作人员 17 字段代录折叠，窄屏按既有规则堆叠。
- Document create/refresh/resubmit/re_quote、独立 review、approve、reject、历史查看和正式/历史 PDF 导出；编辑报价或来源变化清除 review/export 凭证。PDF 必须按 response schema、文件名、长度、`%PDF-` 头和服务端 sha256 校验后才允许下载。
- Handoff 只接受当前 approved Document 和本次会话实际校验的正式 PDF；展示 pending/handed_off/history 和不透明引用，不创建 Booking、Shipment、Order 或 SO。
- Quote/Document 历史读取保留服务器 `needs_input`、`manual_review` 合法 data；个人页面只在同一 `quote_ref` 上更新待补报价，并显示历史金额、版本和来源窗口，不改写旧版本。
- Case/Status/Staff/Confirm/Issuer/Notification/Document-display 表单在非成功响应、路由切换及 `loadRelated`/`loadConfig` 重绘时保留本地 draft；离开 Case 或切换 scope 时使旧 async 响应失效，未保存引用的利润不会伪装成已审核结果。

人员 FCL 写请求统一使用闭合 `fclHttpResponseSchemas` 和 `acceptBusiness:true`：`success`、`needs_input`、`manual_review` 保留 data；`blocked`、`unavailable` 不得当成功或无结果，必须显示 reason code 并保留待重试 draft/idempotency key。缺价、缺 FX、来源/版本冲突、权限失败、PDF renderer 不可用分别按上述状态展示。

### FCL.13b.3 验证边界

精确测试覆盖公开补充 change projection、报价 `needs_input` → 同 quote update、历史 release preview → rollback、个人/企业跨 scope 拒绝、query 严格解析、PDF hash/文件名校验以及真实 loopback HTTP 全链。浏览器 fixture 使用 `PORTAL_FIXTURE_FCL_PERSONAL=true` 和既有 `start-portal-fixture.ts --fixtures`，从公开三步提交、staff confirm、rate publish、needs_input quote update、Document review/approve 跑到正式 PDF 与 Handoff；本机若缺少可用 sandbox，只允许把结果标为 `partial`，不得声称 PDF/Handoff 已通过。

FCL.13b 不修改 MCP 工具合同、不新增 REST 别名、不进入 FCL.13c OpenAPI/CLI 扩展。13c 如启用 CLI/OpenAPI，必须复用同一 `fcl-http-contracts.ts` request/response map 和 `rate-preview` 可选 release_id 合同。

### FCL.13b.4 R1 收口说明

R1 只修正 13b 已授权 UI 和既有 HTTP 合同内的交互边界，不新增实体、权限或后台算法：

- 公开补充保存完整字段和 message raw draft；未知结果后不换 payload/key，成功前保留用户输入并在同 snapshot 上重试。
- Handoff 备注进入受控 draft；未知结果重试沿用同一请求和 idempotency key，只有成功后清理；交接按钮在前置条件不满足时 disabled 并显示原因。
- Quote/Document 历史面板对同一对象提供 `1..current_version` 有界版本选择；旧金额、source、scope、条款和状态只读展示，历史 PDF 下载由所选 target version 交给既有 history 接口判定，不依赖当前最新版状态。
- Web 人工费用编辑保留 `template_ref` 和 `quantity_conditions`，并提供已配置标准费用项目引用选择；选择项目只写引用，不自动编造成本、售价或 FX。
- 完整原始 Inquiry 和当前需求使用同一只读 17 字段摘要；独立 review 明确展示 Document 绑定的 Case projection、客户 scope、报价日期/有效期和出具人版本。
- FCL 内部路由和 Case 切换在 dirty 时阻断或确认丢弃；取消导航不改 draft，确认导航同步清理 quote 编辑派生状态。公开页 `pagehide` 对 persisted BFCache 不做破坏性 cleanup。
- 窄屏 FCL 三列按需求、CostSell、利润/文件顺序堆叠；桌面保持三列。

## FCL.13c 实施说明

13c 只把已交付 FCL HTTP action 接入既有 `freightclaw workspace` CLI，并扩展现有 OpenAPI 生成器；不新增业务服务、权限算法、REST 别名或 MCP 写入口。

### FCL.13c.1 CLI

人员命令固定为 `workspace fcl <canonical-action>`，路径复用 `/console/api/v1/fcl/<action>`，request/response Schema 直接使用 `fclHttpRequestSchemas` 与 `fclHttpResponseSchemas`。public 命令固定为 `workspace fcl inquiry session|submit|exchange|get|supplement|logout`，不复用 `/console` person session，也不提供旧 `workspace inquiry` 别名。

public 命令使用独立 `--inquiry-session-file` 私有文件。该文件绑定单一 origin、匿名 cookie/CSRF 和单一 ticket，权限为 0600、拒绝 symlink，并以同目录临时文件、完整写入、fsync、原子替换更新。session bootstrap 只在明确 `ENOENT` 时创建；已有、损坏、过期或权限错误文件 fail closed，不静默建立新身份。读取到写回期间使用有界私有锁；并发写入返回 `inquiry_session_locked`。

submit 显式要求 `--idempotency-key`，发送前持久保存 key、canonical request digest 和 body snapshot。网络未知结果保留原 session/key/body；same-key 重试仍调用服务端 idempotent replay，不用本地缓存替代当前 session、receiver 或 credential 校验。成功后先持久 ticket recovery，再输出脱敏摘要；credential 不进入 argv、query、env、stdout 或日志。exchange 可从同一私有文件读取已保存 credential，或从 0600 文件/受限 stdin 读取 `{inquiry_id,credential}`，从而恢复 Web 已签发的本票；跨票 inquiry_id 拒绝。logout 成功后把文件改为无 cookie tombstone，旧授权不能复用。

人员 FCL 命令复用既有 device flow 与 0600 person session file，只调用 FCL private receiver action；`organization=null`，API Key 不替代 person identity，也不扩大组织或配置权限。写命令要求显式 key，CLI 不自动重试、不自动 confirmed、不选最低来源、不补 FX、不填零。

### FCL.13c.2 PDF 与 OpenAPI

`document-export` 必须提供 `--file`，使用响应上限 40 MiB 以外的实际 FCL response limit 读取，按闭合 Schema 校验后检查 `%PDF-`、decoded byte length、8 MiB 上限和真实 SHA-256。文件用 `wx`、0600 创建，不覆盖已有文件；stdout 移除 `content_base64`，保留 metadata、客户合计、trace 和本地 filename。历史导出必须满足 `historical=true`、`valid_now=false`。renderer 等待上限为 120 秒，其他 FCL action 为 15 秒。

OpenAPI 生成器同时更新 `apps/console/openapi.json` 与 `docs/integrations/openapi.json`，包含全部 28 个 staff action 和 6 个 public action、PortalSession/InquirySession cookie、POST CSRF、显式 idempotency、闭合 request/response Schema、五状态错误、request/response byte limits、PDF 字段及 `rate-preview` 的 GET `release_id` query。FCL 人员能力不加入机器 API Key 文档。

### FCL.13c.3 边界与被替代描述

本节不表示生产已启用。真实部署仍缺可信 FCL receiver authority adapter、真实 IdP authority、真实邮件和运营验收；生产 FCL 默认关闭，API/CLI 存在不等于 `pilot_verified` 或 `deployed`。13c 不修改 MCP 工具合同、不新增静态工具，也不进入 Booking/SO/邮件订舱。

`docs/rfcs/2026-09-20-fcl-main-loop.schema.json` 是实施前 proposal，不被运行时读取；当前运行合同是 `fcl-http-contracts.ts` 及其生成 Schema。审计文档和早期节点中的“CLI/UI/HTTP 未实现”描述不再代表 13c 完成后的全局状态。

### FCL.13c.4 最终本地验收记录

13c 最终实现 SHA 为 `47766b2874e41542d9ecb6f62c53ef8c2426ac5f`。可复现的零企业合成 fixture、真实本地 HTTP、Edge/沙箱 renderer、CLI device flow、ticket recovery、Rate/CostSell 混币、Document review/approve、PDF、Handoff、历史版本和 restart 读回步骤见 [FCL M1 本地验收 Runbook](../runbooks/2026-09-21-fcl-m1-local-acceptance.md)。

该记录只代表本地合成验收：真实 production receiver authority、IdP、邮件 transport、生产数据库、部署与运营验收仍未完成，因此不能声明 `pilot_verified` 或 `deployed`。

补充验收还确认：bundled CLI 可保存不完整 Inquiry，`pol`、`cargo_ready_date`、`40HQ.quantity` 的 null 不会被自动补齐，`get.complete=false`；exchange 后 same-key 重放返回同一 Inquiry；重启前旧 person session 为 CLI exit 5，重启后必须重新 device flow；零企业 fixture 保持 0 organizations / 0 memberships。root 另用关闭后的 DB/secret 私有副本完成了两个入口 HTTP 200 的独立 demo，原验收数据未被该 demo 写入。
