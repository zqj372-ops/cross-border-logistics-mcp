# 跨境物流 MCP Admin 控制面

**范围：** Admin 控制面 v1 的产品边界、状态语义和本地受控操作说明。它不是 FastAdmin
后端的替代品，也不是生产运维授权。

**合同版本：** `2026-08-22.v1`

**验收状态（截至本次文档切片读入的 checkout）：**

- **当前已实现、已有测试切片：** closed control contracts、inventory/descriptor hash、
  独立 SQLite control store、identity marker、activation read/dispatch facade、
  register/preview/approval service 路径，以及 Admin UI 的 closed state/API client 模型。
  这些是当前源码和测试资产的事实，不等同于最终全量通过。
- **并行未完成/待最终回读：** 本次读入时 `publish`、`reconcile` 的 service 路径仍处于未实现
  分支；启动入口尚未完成 initializer、control store、recovery 和 Admin control API 的统一接线；
  真实 HTTP 的注册→四眼审批→发布→exact readback→reconcile→rollback 仍须由最终集成验收重新
  执行。不能用测试文件存在、静态页面或计划文本代替这些证据。
- **本地受控环境：** 只允许显式初始化的 fixture/local assembly、回环访问和合成数据。其状态
  只能写成 `evidence_level=local_build`、`production_eligible=false`。
- **生产：** `MCP_DATA_MODE=production` 下所有 Admin `POST` 固定返回
  `blocked/admin_control_production_disabled_v1`，且必须在 authenticator 和 service 之前
  阻断。本次不连接、不部署、不宣称生产资格。

## 产品定位

Admin 控制面只管理“当前应用构建已经挂载的静态可信模块”的登记、激活策略和审计元数据。
它不下载任意插件，不执行源码或命令，不改变 Module Runtime v0 的挂载集合，也不建立报价、
关务、客户或文档业务主表。

业务权威边界如下：

| 事实 | 权威归属 | Admin/MCP 的职责 |
| --- | --- | --- |
| 报价金额、Zone、计费规则、有效期 | 外部报价系统 | 只显示适配状态和受控引用；适配器未验收时保持 `待适配验证`/`unavailable` |
| 关务分类、税费和放行规则 | 外部关务系统 | 不复制规则或客户材料；`ready=false` 保持 `unavailable`/`manual_review` |
| 客户地址、订单、业务记录、报价单文件 | 各自业务系统 | 不写入 control DB、fixture、普通审计日志或页面 |
| CBM、体积重、分泡、计费重、理论装柜摘要 | MCP 内确定性工具 | 按既有工具合同计算，保留单位、版本、假设、warnings、blockers 和 trace |
| 模块 inventory、preview、approval、release、readback | MCP control DB | 只保存控制元数据、opaque 引用和生命周期证据 |

AI 可以理解意图、补齐输入和解释结构化结果；不能补造价格、税率、Zone、客户记录、
生产签名或 activation policy。

## 信息架构

主导航保持六个视图：

1. **总览：** 显示进程健康、平台 readiness、当前控制面状态和阻断原因。`healthz` 只代表进程
   存活；`readyz` 也不能单独证明业务 API 或生产资格。
2. **模块中心：** 显示当前 deployment inventory、登记状态、desired draft、运行时状态、
   preview 差异和受控操作。
3. **Agent 接入：** 只显示脱敏的客户端登记和身份边界，不显示凭证正文。
4. **适配器状态：** 显示报价、关务、知识、状态和复核适配器的 readiness；未取得真实合同、
   版本和 staging readback 时固定显示“待适配验证”或“未获生产资格”。
5. **审批与发布：** 显示 preview、校验、creator/approver 区分、release trail、readback 和
   rollback target。
6. **审计日志：** 只显示脱敏 action、status、reason、revision 和 opaque reference；不显示
   token、地址、报价金额、税务材料、原始聊天或下游响应全文。

页面固定显示的警告是：

> 报价、关务与客户数据仍由外部权威系统管理

## 模块中心的真实生命周期

页面用四段 release rail 表示流程：

```text
登记制品 → 生成预览 → 双人审批 → 发布读回
```

四段都必须有服务端状态和证据；开关只修改浏览器内的 desired draft，不直接修改运行时。
正式控制流程为：

```text
当前 deployment inventory
  → exact module_id/version/descriptor_digest 登记
  → 固定 base release/revision 的 preview 与 redacted diff
  → 与 creator 不同的 actor approval
  → publish
  → runtime activation exact readback
  → 只有 readback 完全匹配，才提交 active policy
```

“不同 actor”是硬约束；请求体不能提供或覆盖 tenant、actor、role、scope、URL、路径、源码、
token 或 secret。`inventory` 是 allowlist，不是 active set。初始运行时快照必须是：

```json
{"releaseId":null,"revision":0,"activeModules":[]}
```

没有 `active_verified` release 时，模块调用返回
`unavailable/module_policy_not_released`，但模块工具仍保留在 `tools/list`；普通
`module_disabled_by_release` 同样保留目录可见性并返回 `unavailable`。security quarantine、
retirement 和 administrator security-disable 不是 v1 的 operational toggle，必须返回
`blocked`，不能借普通禁用语义模拟目录移除。

### 三个必须同时区分的状态

一次成功的本地/fixture publish 的三条状态不是同一个字段：

| 层 | 成功状态 | 含义 |
| --- | --- | --- |
| `module_control_idempotency` | `completed` | 该控制写请求的最终持久化结果可 replay |
| `module_releases` | `active_verified` | 该 release 已经通过当前 runtime activation exact readback |
| Admin envelope `readback` | `verified` | 返回的 release/revision/module refs 与 runtime 完全一致 |

`active_verified`/`verified` **只表示当前运行时 activation 的 exact readback**；它不是 artifact
signature、source attestation、SBOM、镜像签名或 production qualification。v1 inventory 永远
写成 `evidence_level=local_build`、`production_eligible=false`，不能在 UI 中显示为已签名或可上线。

## 未决读回与人工复核

- `published_pending_readback` 表示 domain 已提交、运行时读回尚未终态；只允许针对该固定
  release 的 pending-only readback。
- `manual_review` 表示运行时应用或读回发生未知/不一致结果。它保留服务端状态和原因，页面
  强制刷新并要求人工确认；启动时不自动重试，也不重复 activation/readback。
- `domain_committed` 只能恢复该请求已经固定的 pending release，不能创建第二个 release。
- 只有 operator 通过 reconcile 才能对 unresolved release 创建新的 readback attempt；新的
  release 不在 reconcile 中产生。未解决的最新 release 存在时，新的 publish 必须阻断。
- 相同 idempotency key 与相同 canonical request hash 只 replay 已持久化结果；同 key 不同 hash
  返回冲突并阻断。

## 回滚语义

UI 和操作文案固定为：

> 回滚到上一已读回版本（本地受控环境）

回滚不是编辑旧行、删除历史或把指针静默改回去。它必须：

1. 选择一个历史中已有、且自身有 runtime exact readback 的旧 profile；
2. 生成 rollback preview，固定当前 base release/revision 和 target release；
3. 由不同 actor 完成 approval；
4. 以新 release/new revision publish；
5. 对新 revision 做 exact readback；
6. 保持 target release、target readback、event history 和审计历史不变。

如果 target 没有完整 readback、不是当前 inventory、已过期、不是更早 revision，或最新状态
仍 unresolved，回滚必须 `blocked`/`manual_review`，不能直接编辑 SQLite。

## 启动、身份与本地边界

managed entrypoint 必须在监听前得到显式 application root，并固定派生：

```text
state_dir  = <application-root>/.runtime/mcp-instance-state
control_db = <state_dir>/control.sqlite
marker     = <state_dir>/control-identity.json
```

显式 initializer 是唯一创建者。runtime open 不隐式创建、修复、替换或删除 state directory、
DB 或 marker；`MCP_ADMIN_CONTROL_ENABLED` 不是 initializer、activation policy 或绕过开关，
只接受字面 `true` 作为已初始化 managed instance 的一致性断言。缺少/不为 `true`、root 变化、
身份或 tenant 变化、marker/DB 缺失或漂移、schema/权限/锁不兼容，均必须 fail closed 且不监听。

本地 fixture 的两个身份只存在于 loopback fixture assembly：申请人和审批人必须使用不同 actor。
fixture identity 不进入 production verifier、生产环境变量、生产日志或生产 UI 路径。

## Secret 和显示安全

- 浏览器身份对话框使用 password input；Bearer 只保存在模块作用域的内存变量中。
- token/secret 不得写入 URL/query string、`localStorage`、`sessionStorage`、cookie、DOM 文本、
  error report、console、audit 或普通日志。
- 服务端日志和事件只保留脱敏 actor/tenant/object reference、revision、status、reason 和
  必要的 opaque ref；endpoint 和 credential 只允许 opaque `endpoint_ref`/`secret_ref`。
- `?fixture=1` 只允许在明确的 loopback 本地演示路径显示两个 demo identity 入口；正式路径不得
  显示 fixture identity，也不得用 fixture 数据静默回退。

## Admin API 约定

控制面 API 是独立的 Admin API，不进入既有 MCP 业务工具目录：

```http
GET  /admin/api/v1/control/state
POST /admin/api/v1/control/packages/register
POST /admin/api/v1/control/deployments/preview
POST /admin/api/v1/control/approvals
POST /admin/api/v1/control/deployments/publish
POST /admin/api/v1/control/deployments/reconcile
```

所有 POST 都必须有服务端注入的 identity/tenant、`Idempotency-Key`、strict schema、审计关联和
审批约束。当前 checkout 中 API 路由/请求模型资产已经出现，但全链路 dispatch、启动接线和
HTTP exact-readback 仍以并行实现和最终验收为准；不要把路由存在写成可发布。

## 产品验收口径

以下四句话必须分别回答，不能合并为一个绿色标签：

| 问题 | 允许的证据 | 当前文档口径 |
| --- | --- | --- |
| 代码是否存在？ | 当前 checkout 的源码 diff | 已有 control-plane/UI/API 切片；按最终 diff 复核 |
| 局部行为是否通过？ | 对应 focused/unit/HTTP fixture 输出 | 待最终命令实际执行；不预写通过数 |
| 本地受控流程是否闭合？ | initializer、restart、四眼、publish/readback、reconcile、rollback 的独立证据 | 待并行接线完成后最终回读 |
| 是否具备生产资格？ | Deployment Evidence、签名/信任链、生产身份、durable 多实例 fencing、staging readback | v1 不具备；生产 Admin POST 固定 `blocked` |

状态颜色不是证据；页面必须同时显示文字、reason 和 readback 状态。
