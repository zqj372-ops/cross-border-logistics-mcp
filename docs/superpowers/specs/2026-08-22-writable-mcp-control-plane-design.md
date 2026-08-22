# 可写 MCP 模块控制面设计

- 日期：2026-08-22
- 状态：已获用户确认，进入实施
- 适用范围：本仓库 Node/TypeScript MCP 平台、Module Runtime v0、`apps/admin`
- 视觉基准：`/Users/autumn/.codex/generated_images/01a023ab-99c0-70c1-a4de-f0f75e5d9970/exec-cb608496-a874-401f-be3e-188aba22b047.png`

## 1. 事实、前提纠正与设计结论

### 已确认事实

- 当前 Module Runtime 只在启动时挂载随应用构建的静态可信模块，manifest 的
  `lifecycle` 仍固定为 `static`。
- 当前 Admin 是本机回环、默认关闭、只读脱敏快照；保存、审批、发布、读回和回滚 API
  尚未实现。
- 当前生产 SQLite 只承担审计、幂等和 session binding，不包含模块制品、发布或回滚状态。
- 当前报价、关务、客户记录和文档仍由外部业务系统拥有；本控制面没有权限把这些数据
  迁入 MCP。
- 用户要求的第一批真实写入是 MCP 自身的模块/插件配置和发布元数据，而不是业务数据。

### 必须纠正的前提

- “与 FastAdmin 结合”不等于把 PHP FastAdmin 变成 MCP 后端。现有宿主是 Node/TypeScript，
  引入第二套 PHP 权限、ORM、会话和插件运行时会形成双重权威。
- “插件已登记”不等于“代码已动态加载”或“已获生产资格”。首版只允许部署清单内、已随
  当前应用构建的模块参与启停；任意 URL、Git 仓库、本地路径、上传源码和运行时 `eval`
  均不进入实现。
- “发布成功”必须区分控制元数据已持久化、当前进程策略已切换、运行时读回一致和生产
  资格。任何一项缺失都不能合并成一个模糊的绿色状态。

### 设计结论

使用 FastAdmin 的模块中心、审批、发布、回滚信息架构，使用自托管 AdminLTE 4 样式作为
页面外壳；后端继续使用现有 Node/TypeScript 平台。首版形成一个真实、窄语义、可审计的
模块发布控制面：它能在本机/fixture 受控环境中持久登记当前部署清单中的模块、生成差异
预览、执行双人审批、发布启停策略、完成运行时 exact readback，并通过同一流程回滚到上一已读回
release（本地受控环境）。production Admin 写入口在 v1 保持 `blocked`；真实 JWT claim policy、Deployment
Evidence 信任链和多实例发布在后续 RFC 完成前不得开启。

首版不是完整的通用热插拔平台。它不下载或加载新代码；新模块版本必须先进入受信构建和
部署清单，再由本控制面登记和激活。对已经随当前进程挂载的模块，发布通过调用门禁原子切换
启用状态，工具继续出现在目录中但禁用模块调用返回 `unavailable`。这符合“暂时不可用仍
保留可见性”的现行标准，也避免伪装成代码级 hot-plug。

控制面 policy 的启用由实例身份连续性决定，不由 release 数量或一个可随意关闭的环境变量决定。
显式初始化写入 marker 与 control DB 后，即使数据库尚无 release 也已经进入 sticky enabled 状态；
后续把 `MCP_ADMIN_CONTROL_ENABLED` 设为 `false`、删除或省略，都只能导致启动 fail closed，不能
绕过 activation policy 回到全静态启用。只有固定 `MCP_INSTANCE_STATE_DIR` 下从未初始化、没有
marker/DB 且显式 `MCP_LEGACY_STATIC_MODE=true` 的全新实例，才允许 legacy static-all-active；
缺少固定 state-dir 配置本身必须 fail closed。

## 2. 目标与非目标

### 目标

1. 对 MCP 自身模块发布配置执行真实持久化写入。
2. 所有写操作使用服务端认证上下文，不接受请求体中的 tenant、actor、role 或 scope。
3. 所有 POST 要求幂等键；同键同请求重放，同键不同请求 `blocked`。
4. 发布必须经过 preview、另一 actor 审批、commit、运行时读回和审计。
5. 回滚复用同一 preview/approval/publish 流程，并创建新 release，不删除历史。
6. 只允许当前部署清单中的不可变模块描述符，拒绝客户端 URL、路径、源码和 secret。
7. 保持现有九个业务工具、Agent context 工具、统一五状态和业务权威边界兼容。
8. 提供中文、可访问、可在本机浏览器完整操作的 AdminLTE 风格模块中心。
9. v1 只证明本机单进程 control-plane 写入；production API 对所有写操作保持 `blocked`。

### 非目标

- 不引入 PHP、ThinkPHP、FastAdmin ORM 或 FastAdmin 插件安装器。
- 不实现远程仓库搜索、任意上传、在线解压、运行时 npm install、`eval` 或 `vm` 执行。
- 不修改报价、Zone、税率、客户、订单、文档或关务主数据。
- 不实现 T1-T3 任意代码隔离运行时、N/N-1 代码代并存或无重启版本升级。
- 不实现或接受 `verified_release`/`production_eligible=true`；opaque ref 不作为签名证明。
- 不开放 production Admin 写 API，不把本地 fixture token 迁入生产认证路径。
- 不把本地 fixture、descriptor digest、HTTP 200 或进程存活写成生产发布证明。
- 不提供共享管理员口令、header bypass 或客户端可伪造身份字段。
- v1 不提供 security quarantine、模块退役或管理员安全禁用语义；这些请求必须返回 `blocked`，
  不能伪装成普通 operational disable。未来合同另行定义目录移除和安全隔离。

## 3. 信任边界与总体架构

```mermaid
flowchart LR
  B["本机 Admin 浏览器\nBearer 仅保存在内存"] --> A["Admin Control API\nOrigin/Host/Body/Auth/RBAC"]
  A --> S["Module Control Service\npreview/approval/publish/rollback"]
  S --> I["Build Module Inventory\n部署清单内描述符"]
  S --> D["SQLite Control Store\nrelease/event/idempotency"]
  S --> R["Activation Registry\n当前进程调用门禁"]
  R --> G["MCP Tool Registry\n工具仍可见"]
  G --> M["静态可信模块\ncargo/container/agent-access"]
  S --> U["Runtime Readback\nrelease + active refs"]
```

### 浏览器边界

- 静态页面和 API 首版仍只允许回环地址访问。
- GET 脱敏快照可以保持匿名；模块控制状态和所有写 API 必须提供 Bearer。
- Bearer 只保存在页面内存，不进入 URL、localStorage、sessionStorage、日志或 fixture。
- 所有写请求必须带精确同源 `Origin`、JSON Content-Type 和 `Idempotency-Key`。
- fixture 模式允许两个明确的本地演示身份，用于证明申请人与审批人不同；该分支只在
  回环 fixture 组合中存在，生产 verifier 不认识演示 token。

### 服务端身份边界

- v1 只接受 fixture assembly 中两个服务端配置的本机演示 token；它们分别映射到申请人和
  审批人，且只在 loopback + fixture mode 生效。
- `MCP_DATA_MODE=production` 时所有 `/admin/api/v1/control/**` POST 固定返回
  `blocked/admin_control_production_disabled_v1`，即使 Bearer 签名有效也不进入 service。
- 后续 production RFC 必须把 RS256 验签与 issuer、audience、subject、tenant、active role、
  `iat`、`exp`、最大生命周期校验组成一个不可拆分的 authenticator；只调用当前 verifier
  再 `parseExecutionContext` 不足以授权管理写入。
- service 仍要求 `context.role === "admin"`、`roles` 包含 admin、`platform:admin` scope，
  并命中唯一服务端配置的管理 tenant；`roles` 中出现 admin 不能提升非 admin active role。
- 请求体 schema 明确拒绝 `tenant_id`、`actor_id`、`roles`、`scopes`、token、URL、路径和
  secret 字段。
- preview 创建者不能批准自己的 preview；approval 绑定 tenant、preview canonical hash、base
  release/revision、inventory digest set、creator、approver 和 expiry，并采用 append-only final
  CAS。reject 不可覆盖成 approve，publish 必须原子消费 preview/approval。

### Sticky control-plane identity

`MCP_ADMIN_CONTROL_ENABLED` 不是 activation policy 的权威来源。它只能作为已初始化部署的
一致性检查：对已经存在的 identity，值为 `false` 或缺失都必须在监听前 fail closed；绝不能
借此回到 legacy static-all-active。显式初始化后即使 `release_count=0` 也已经 sticky enabled。

v1 还必须有一个启动时无条件解析的、固定部署锚点 `MCP_INSTANCE_STATE_DIR`。它是绝对 host
路径，不是客户端输入，也不是由 `MCP_ADMIN_CONTROL_ENABLED` 决定的可选开关；fixture 的
部署清单固定为 `<application-root>/.runtime/mcp-instance-state`，生产部署必须在 host/服务
单元中固定一个持久挂载路径。缺少该锚点本身就是启动错误，不能因为环境变量被删除而进入
legacy。控制 DB 与 marker 的路径由该锚点固定派生，v1 不接受可旁路的任意路径：

```text
MCP_INSTANCE_STATE_DIR=/absolute/stable/mcp-instance-state
MCP_CONTROL_DB_PATH=<MCP_INSTANCE_STATE_DIR>/control.sqlite
MCP_CONTROL_MARKER_PATH=<MCP_INSTANCE_STATE_DIR>/control-identity.json
```

marker 必须位于 DB 文件之外（同一 identity directory 可以，但不能是 SQLite 内容或表），
使用 UTF-8、无 BOM、单个 RFC 8785/JCS JSON 对象、末尾一个 LF；解析拒绝未知字段、重复键、
额外字节和符号链接。格式固定为：

```json
{"control_db_id":"db_<32-lower-hex>","control_db_path":"/absolute/path/to/module-control/control.sqlite","instance_id":"<MCP_INSTANCE_ID>","marker_format":"mcp-control-identity/v1","schema_version":1}
```

`control_db_id` 是显式 initializer 生成的随机 128-bit 标识，不从路径或 release 推导。SQLite
内的非通用 singleton `control_identity` 行必须保存完全相同的 `control_db_id`、绝对
`control_db_path`、`instance_id` 和 `schema_version=1`；启动时同时校验 marker、该行、实际
canonical path、`MCP_INSTANCE_ID` 和当前 control schema。marker 创建后不得覆盖或原地修改。
identity directory 为 `0700`，marker 为 `0400`，DB 为 `0600`；DB 和 marker 都必须是 regular
file 且不能是 symlink。

显式 initializer 只接受尚不存在的 state directory，使用 `O_CREAT|O_EXCL` 创建带
`0700` 权限的 sibling staging directory，在其中建立 strict v1 DB、写入 `control_identity`
行、设置 `user_version=1`、fsync DB 后再以 `O_CREAT|O_EXCL` 写 marker、fsync marker 和目录，
最后将整个 directory 原子 rename 到目标路径并 fsync 父目录。目标 DB、marker 或 identity
directory 已存在时拒绝；普通启动绝不创建、修复、替换或删除其中任何文件。

启动判定必须是：

- `MCP_INSTANCE_STATE_DIR` 已配置但 state directory 不存在、固定 marker/DB 都不存在，且显式
  `MCP_LEGACY_STATIC_MODE=true`：这是“从未初始化”的全新实例，才允许 legacy static-all-active；
  legacy flag 缺失/false 不得自动回落。若固定 state-dir 配置本身缺失，启动失败；普通启动不创建
  state directory。
- fixed marker 与 DB 均存在、身份完全匹配、`MCP_INSTANCE_ID` 与 marker 一致且
  `MCP_ADMIN_CONTROL_ENABLED=true`：进入 sticky enabled，即使没有 release 也恢复 control policy；
  `MCP_LEGACY_STATIC_MODE` 在此状态永远无效并必须被拒绝。
- marker/DB 任一存在而另一缺失、state directory 已存在但不完整、`MCP_INSTANCE_ID` 或
  `MCP_ADMIN_CONTROL_ENABLED` 被删除/false、启用了任意可选路径 override，或 pair 不完整：均
  fail closed、不监听，禁止回落全静态启用。即使操作者同时删除 enabled、DB path、marker path
  和 instance 环境变量，启动仍从固定 `MCP_INSTANCE_STATE_DIR/control-identity.json` 发现
  sticky sentinel 并失败，而不是判断 never-initialized。
- DB path 不匹配、换成新空 DB、marker 损坏、marker 与 DB identity/instance/schema 不一致、schema
  drift、权限/锁冲突：均 fail closed、不监听。只有显式 initializer 才能建立新 identity，不能由
  普通启动隐式初始化。

### 制品边界

- 构建生成 `dist/control-plane/module-inventory.json`。每项只描述随当前应用构建的模块：
  `module_id`、`version`、`risk_level`、工具名、标准引用和 canonical descriptor digest。
- descriptor digest 只证明清单描述未漂移，不冒充容器镜像或签名制品 digest。
- v1 inventory 固定 `evidence_level=local_build`、`production_eligible=false`。可选本地 build
  refs 只能由服务端构建生成，不接受浏览器输入，也不能被 UI 表述为签名已验证。
- `verified_release` 不属于 v1 输入或状态。后续 Deployment Evidence RFC 必须定义 canonical
  descriptor、source/build SHA、artifact/image digest、签名算法和 key/trust root、签名覆盖
  内容、验证结果、SBOM/attestation、verified time 的绑定后，才能评估生产资格。

### Canonical hash contract

控制面必须区分 `request canonical hash`、`preview canonical hash` 和 inventory 的
`descriptor digest`：三者不能互换，也不能把任何一个写成 artifact signature 或生产资格证明。

- request/preview hash 的算法固定为 RFC 8785/JCS canonical JSON（UTF-8，无 BOM）后 SHA-256。
  若实现使用等价库，必须逐字节实现相同的 JCS number、string、object-key 和 `null` 规则，不能
  用 `JSON.stringify` 代替。
- hash preimage 必须以固定 domain-separated 前缀开头：
  `MCP-CONTROL-HASH\0v1\0<domain>\0<schema_version>\0`，其中 `<domain>` 只能是
  `request` 或 `preview`，`<schema_version>` 当前固定为 `2026-08-22.v1`；前缀之后是
  对应 JCS UTF-8 字节。输出格式固定为
  `mcp-control-hash/v1/<domain>/sha256:<64 lowercase hex>`。
- request payload 必须包含 action 和完整、已校验的请求字段；preview payload 必须包含服务端
  绑定的 tenant/creator、intent、base release/revision、inventory digest set、desired module
  refs、policy/schema version、validation 和 expiry 等字段，不包含不可重建的传输包装。两种
  hash 使用不同 domain，即使 JSON 内容相同也必须不同；schema version 改变也必须不同。
- JCS 会固定对象键顺序；语义为集合的数组（`desired module refs`、inventory digest set、
  `reason_codes`）先按文档规定的稳定键排序；有顺序语义的数组必须保持输入顺序，不能全局排序。
  这条规则必须由测试和实现共享，不能由客户端自行解释。
- descriptor digest 仍固定为 `sha256:<64 lowercase hex>`，只对完整 canonical module
  descriptor 做 SHA-256，不加上述 control hash domain prefix；它只是当前部署 inventory
  描述符的漂移检测，既不是 request/preview hash，也不是 artifact/image digest、签名或
  `active_verified` 的来源。

Task 1 当前只维护 descriptor/inventory 公共合同，本次规格修订不改其源码、schema 或测试；若
Task 1 不承载 request/preview hash，则在 Task 2/3 提供并锁定共享 canonical-hash helper。无论
helper 放在哪个任务，跨重启、对象键序、集合输入顺序、顺序语义数组、schema version 和
domain separation 都必须有回归测试。

## 4. 组件职责

### `module-inventory`

- 从实际 Module Definition 和工具贡献生成 canonical descriptor。descriptor 覆盖 module
  ID/version/risk/lifecycle/required+optional capabilities/module standards，以及每个工具的
  owner/name/permission/kind/risk/input schema ID/output schema ID/standard refs。
- 对 canonical JSON 计算 SHA-256。
- 校验 module ID/version 唯一、tool owner 唯一、manifest 合法、标准引用完整。
- v1 只接受当前固定服务端 RBAC 已知的 bundled tools；未知 tool policy 在 inventory 阶段拒绝，
  不能出现“目录可见但永远被 RBAC 拒绝”的登记成功。
- 运行时只读取构建产物，不从 cwd 搜索 manifest 或 Markdown。

### `SqliteModuleControlStore`

- 使用固定 `MCP_INSTANCE_STATE_DIR` 派生的独立 control DB；不把控制面记录混入业务主库。
- 新库与 identity marker 只能由显式 initializer 原子创建；普通 runtime open 要求固定 state
  directory 下的 DB、marker、`control_identity` 行和 v1 schema 已存在。因此已初始化环境中
  DB/marker 丢失不会被启动流程静默重建或回到 legacy。
- 数据库文件要求 regular file、`0600`、WAL、FULL synchronous、strict tables、schema version。
- v1 使用 SQLite exclusive locking 保证同一 control DB 只有一个运行进程；第二个实例启动
  fail closed。production 多实例不在 v1 范围。
- 提供原子操作，不向上层暴露通用 SQL 或通用 JSON 写入口。
- 保存 `control_identity`、模块登记、preview、approval、release、readback、幂等结果和追加式事件；
  `control_identity` 是唯一的窄语义元数据行，不是通用 key-value 表。

### `ModuleControlService`

- 承担请求 schema、inventory match、状态机、四眼审批、幂等和读回协调。
- 返回统一五状态：`success`、`needs_input`、`manual_review`、`blocked`、`unavailable`。
- 不接受客户端构造的 audit ID、release ID、时间戳或 actor 引用。
- 所有 ID 由服务端生成，所有时间来自注入 clock，便于确定性测试。

### `ModuleActivationRegistry`

- 保存当前进程已应用的 `release_id`、revision 和 active module refs。
- 只有 inventory 内已挂载模块能被设为 active。
- 发布时一次性替换不可变 snapshot；请求开始时读取同一个 snapshot，避免半更新。
- 禁用模块的工具仍在 `tools/list` 中；实际调用在领域 handler 前返回
  `unavailable`，reason code 为 `module_disabled_by_release`。
- 只有 state directory/marker/DB 都从未创建且显式 `MCP_LEGACY_STATIC_MODE=true` 的新实例才可用
  legacy static-all-active；显式 initializer 一旦创建 identity marker，即使 `release_count=0`
  也必须恢复 sticky policy。`MCP_ADMIN_CONTROL_ENABLED` 为 `false`/缺失、marker/DB identity
  不一致、换新空 DB、损坏或锁冲突时均必须阻止监听，不能回退到全启用。
- v1 的 `module_disabled_by_release` 只表示普通 operational unavailable：工具保留在
  `tools/list`，调用返回 `unavailable`。security quarantine、退役、管理员安全禁用不属于 v1；
  请求这些语义必须返回 `blocked`，不得借 operational disable 模拟，未来合同另行定义目录移除。

### `AdminControlApi`

- 是窄路由集合，不提供通用 `/config` PATCH。
- 在解析业务 JSON 前完成 loopback、Host、Origin、body size、Content-Type、Bearer、tenant、
  role 和 scope 检查。
- 对错误只返回稳定 reason code 和脱敏消息，不回显 token、输入正文、SQL 或 stack。

## 5. 数据模型

控制数据库使用以下 strict tables。表名可在实现中保留此前缀，字段语义不可合并为通用
key-value 表。

| 表 | 主键/唯一约束 | 关键内容 |
| --- | --- | --- |
| `control_identity` | 固定 singleton key；`control_db_id` 唯一 | `instance_id`、绝对 `control_db_path`、`control_db_id`、`schema_version=1`；只用于 marker/DB identity continuity |
| `module_registrations` | `tenant_id, module_id, version, descriptor_digest` | inventory 引用、登记 actor/time、固定 local evidence |
| `module_previews` | `tenant_id, preview_ref` | intent、canonical hash、base release/revision、inventory digest set、desired refs、diff、validation、creator、expiry、consumed |
| `module_approvals` | `tenant_id, approval_id`；`tenant_id, preview_ref` 唯一 | immutable approver、decision、preview hash、expiry、reason code、time、consumed |
| `module_releases` | `tenant_id, release_id`；tenant 内 revision 唯一递增 | desired refs、previous release、preview、approval、publisher、状态 |
| `module_readbacks` | `tenant_id, release_id` | applied release/revision/module refs、verified、reason、time |
| `module_control_idempotency` | `tenant_id, action, idempotency_key` | request hash、`reserved|domain_committed|completed`、domain record ref、final result、created/expiry |
| `module_control_events` | 自增 sequence；event ID 唯一 | 脱敏动作、actor ref、对象 ref、status、reason、time |

v1 是平台全局策略但只允许一个配置的管理 tenant；所有表仍显式保存/索引 tenant，任何其他
tenant 在 service 前 `blocked`。不保存 Bearer、客户地址、报价、税务材料、原始聊天、任意
URL、源码、任意文件路径或 secret 正文。actor/tenant 只保存受控标识，UI 默认显示截断
reference。

## 6. 状态机

```text
inventory candidate
  -> registered
  -> previewed
  -> approved | rejected | expired
  -> published_pending_readback
  -> active_verified | manual_review
  -> superseded

rollback target
  -> rollback preview
  -> approved
  -> new release referencing target profile
  -> active_verified | manual_review
```

- `registered` 只说明部署清单匹配，不说明生产资格。
- preview 固定 base release、inventory descriptor refs、desired active set、creator 和 expiry。
- base release 或 inventory 变化后 publish 必须 `blocked`，不能静默重算。
- approval 必须来自不同 actor；reject 后 preview 不可 publish。
- publish 创建新 release，应用 activation snapshot，再读回 exact release/revision/module set。
- `active_verified`/`verified` 只表示当前 runtime activation snapshot 与该 release 的 exact
  readback 一致；不表示 artifact signature、source attestation 或 production qualification。
- `published_pending_readback` 必须在启动完成监听前自动执行一次 exact readback；成功才转为
  `active_verified`，不一致/未知转为 `manual_review`，不得自动反复重试。
- 已是 `manual_review` 的 release 在启动时不自动调用 readback；只允许操作员调用窄
  `reconcile`。任何 newest unresolved release（`published_pending_readback` 或 `manual_review`）
  都阻止新的 publish；reconcile 只固定原 release/revision/module refs，不创建新 release、
  不修改 desired set。
- 同一 idempotency replay 可以恢复其固定 release 的 exact readback，但不能绕过上述 unresolved
  gate 或创建第二个 release；读回不一致保留事件并返回 `manual_review`。
- rollback 创建新 revision，不删除、改写或重新激活旧记录本身。

## 7. HTTP API

所有请求/响应在 `schemas/admin-control/**` 使用 Draft 2020-12，
`additionalProperties: false`。Admin 使用独立 `2026-08-22.v1` envelope，不冒充 MCP 工具
envelope，但必须包含服务端 `request_id`、`trace_id`、`audit_id`、五状态、带 discriminator 的
closed `data`、`reason_codes` 和 closed `readback`。`trace_id` 不能替代 `audit_id`。所有 POST
都要求 `Idempotency-Key` 16–200 字符。

### `GET /admin/api/v1/control/state`

需要管理身份。返回当前 inventory、登记状态、active release、最近 preview/approval/readback、
可回滚 release 和脱敏事件。只返回当前控制范围，不返回业务数据。

### `POST /admin/api/v1/control/packages/register`

请求只包含 schema version、module ID、version、descriptor digest。服务端从 inventory 读取其余
字段并执行 exact match。未知或不匹配项 `blocked`；依赖不可用 `unavailable`；登记并读回一致
才 `success`。

### `POST /admin/api/v1/control/deployments/preview`

请求包含 `intent=change|rollback`。change 提供完整 desired module refs；rollback 提供明确
`target_release_id`。服务端验证：全部已登记、当前 build 存在、风险策略允许、无重复、至少
保留平台必需模块、base release 未漂移。成功返回 preview ref、脱敏 diff、验证项和 expiry。

### `POST /admin/api/v1/control/approvals`

请求包含 preview ref、`approve|reject` 和受限 reason code。actor 与 creator 相同返回
`blocked`。过期、已消费或 base 漂移返回 `blocked`。审批记录持久化并读回后才 `success`。

### `POST /admin/api/v1/control/deployments/publish`

请求包含 preview ref 和 approval ID。服务端重验 context、preview、approval、base、inventory
和 active set；先检查 newest unresolved release；只要存在 `published_pending_readback` 或
`manual_review`，就 `blocked`，不得创建新的 release。无 unresolved release 时才创建 release、
更新 activation registry 并执行 exact readback。只有 readback 一致才 `success`；持久化成功但
进程读回未知时返回 `manual_review`。

### `POST /admin/api/v1/control/deployments/reconcile`

请求只包含 schema version 和服务端已返回的 `release_id`。只允许 newest
`published_pending_readback|manual_review` release；启动阶段只对
`published_pending_readback` 自动做一次 exact readback，已经是 `manual_review` 的 release
不在启动时自动重试，只能由操作员调用本 endpoint。服务端按固定 release/revision/module refs
重做 exact readback，并完成原幂等状态。已 verified、superseded、未知或非当前 tenant release
`blocked`。reconcile 不创建 release、不修改 desired set，也不接受客户端 readback 内容。

## 8. 幂等、并发与一致性

- action + idempotency key 构成唯一键；请求 canonical hash 固定。
- 同键同 hash 返回首次完整结果；同键不同 hash 返回 `blocked/idempotency_conflict`。
- register、preview 和 approval 可在同一事务内完成 domain write、event 和 final result。
- publish 先预留幂等记录，再在 release 事务中把它推进到 `domain_committed` 并固定
  `release_id`。activation/readback 完成后才写入 `completed` final result。
- 如果进程在 `domain_committed` 后退出，同键重试按固定 release 恢复 readback，绝不创建
  第二个 release；恢复仍未知时固定为 `manual_review`，后续由显式 reconciliation 处理。
- preview、approval 和 publish 都使用数据库事务和 compare-and-set base release。
- 每个 publish 生成递增 revision；两个并发 publish 只有一个能命中 base revision。
- activation snapshot 为不可变对象，一次替换；handler 在请求开始时固定读取。
- 数据库 commit 后 activation/readback 失败属于未知生效结果，返回 `manual_review`。启动时
  必须在监听前对最新 `published_pending_readback` 做一次 exact readback；若结果仍未知/不一致，
  只落为 `manual_review`，不自动再次尝试，新的 publish 继续被 unresolved gate 阻止，不能回滚
  数据库假装没写过。

## 9. UI 设计系统与交互

视觉基准采用 AdminLTE 4 的深色侧栏、白色主画布和表格主导布局；不照搬示例业务数据。

### 9.1 视觉实现清单

概念图原生画布为 1536×1024；浏览器主验收使用 1440×900，并额外验证 390×844。页面没有
需要切出的位图资产，全部可见文本、表格、按钮、状态和图标都必须保持 code-native。

| Token | 值 | 用途 |
| --- | --- | --- |
| `--control-bg` | `#f4f6f9` | 主画布浅灰背景 |
| `--control-surface` | `#ffffff` | 表格、详情、预览表面；保持真白 |
| `--control-sidebar` | `#0b1f3a` | 左侧固定导航 |
| `--control-text` | `#172033` | 标题和主要正文 |
| `--control-muted` | `#667085` | 次要说明和未选中状态 |
| `--control-border` | `#d8dee8` | 表格、分区和控件边界 |
| `--control-accent` | `#0d6efd` | 选中导航、主按钮、当前阶段 |
| `--control-success` | `#198754` | 已登记、运行时 exact readback 一致 |
| `--control-warning` | `#b26a00` | 待审批、待适配验证 |
| `--control-danger` | `#b42318` | blocked、reject、readback mismatch |

- 字体：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`。
- 页面标题 28/36、600；分区标题 18/26、600；正文与表格 14/22、400；控件文字
  13/20、500；说明 12/18、400。按钮和输入不能依赖浏览器默认字号。
- 间距只使用 4、8、12、16、20、24、32；左侧栏桌面 184–208 px，主区最小 0，详情栏
  约占内容区 34%。
- 表面圆角 4–6 px，输入/按钮 4 px；不使用大圆角、悬浮玻璃或嵌套卡片。
- 阴影只允许顶部栏和浮层使用一层低对比阴影；表格/详情/预览使用 1 px border 分区。
- 动效只用于 120–180 ms 的焦点、选中和折叠反馈；`prefers-reduced-motion` 下关闭位移。

### 9.2 容器与组件族

- App shell：固定深色 sidebar、白色 topbar、浅灰 main、无营销 hero。
- Release rail：四个等权阶段，以线和编号表达当前/完成/待处理，不使用装饰性 badge。
- Status summary：只保留三张横向状态卡，每张一个数字和一句范围说明，不引入趋势或假指标。
- Module table：桌面表格是主容器；移动端保持表格语义并提供可聚焦横向滚动，不改成卡片堆。
- Detail inspector：不可变 descriptor/evidence 字段的定义列表；复制动作只复制 opaque ref。
- Preview region：diff、validation、creator/approver、release trail 四个明确区域；按钮状态由服务端
  对象和本地 desired draft 共同派生。
- Identity dialog：password input、连接、清除身份、fixture 双身份按钮；关闭后 token 仍只在内存，
  刷新即消失。
- Icons：使用单一 20 px outline SVG 家族，`currentColor`、1.75–2 px stroke、round cap/join；
  导航、状态、复制和 disclosure 不得混用 emoji 或文本箭头。

### 9.3 首屏允许文案

首屏可以显示且只显示以下产品文案及由 API 返回的模块事实；实现不得自行增加生产声明：

```text
跨境物流 MCP 控制台
本地受控环境
管理员身份未绑定 / 管理员身份已绑定
报价、关务与客户数据仍由外部权威系统管理
模块中心
登记制品
生成预览
双人审批
发布读回
已登记
待审批
当前激活
受控模块清单
制品详情
仅允许部署清单内制品
发布预览与验证
保存草稿
生成预览
提交审批
发布并读回
回滚到上一已读回版本（本地受控环境）
待适配验证
未获生产资格
```

模块 ID/version/risk/digest、状态数字和 reason code 必须来自已校验 API。概念图中的 email、
Git/registry URL、日期和版本号均是视觉占位，不进入实现允许文案。

### 9.4 响应式规则

- ≥1200 px：模块表格与详情 inspector 两列，preview 主区与 release trail 两列。
- 768–1199 px：详情 inspector 移到表格下方，状态卡仍保持一行或 2+1，操作按钮允许换行。
- <768 px：sidebar 由明确按钮展开；状态卡单列；表格横向滚动；preview 区域单列；主要操作
  保持至少 44 px 触控高度，页面不得出现整体横向溢出。
- 焦点顺序为导航→身份→release rail 摘要→表格→详情→preview→动作→trail；切换视图后焦点
  回到主标题，API 结果通过 `aria-live` 宣告但不朗读 token 或完整 digest。

- 导航：总览、模块中心、Agent 接入、适配器状态、审批与发布、审计日志。
- 模块中心主屏：四阶段发布轨、三张状态卡、模块表格、右侧不可变制品详情、下方预览/
  验证/审批/发布轨迹。
- 顶部持续显示环境和管理身份状态；未绑定身份时所有写按钮禁用。
- adapter 状态继续使用“待适配验证”“未获生产资格”，不生成全绿概览；`active_verified` 或
  “运行时 exact readback 一致”只表示当前进程的 activation snapshot 读回，不表示 artifact
  signature、source attestation 或 production qualification。
- 页面警示固定为“报价、关务与客户数据仍由外部权威系统管理”。
- token 输入使用 password 控件，只保存在 JS 内存；切换身份会清空之前的控制状态。
- fixture 模式提供“申请人演示身份”和“审批人演示身份”两个明确按钮；生产不展示。
- 所有开关只是编辑 desired draft；只有完成 preview→approval→publish→readback 后才改变
  runtime state。
- 键盘、焦点、颜色对比、文本状态、`aria-live`、移动端横向表格和 reduced motion 必须保留。

与概念图的一个有意差异：实现不得展示 email、真实 Git URL、registry URL 或原始证明值；
这些位置显示 opaque reference 和 evidence level。

## 10. 失败闭合矩阵

| 条件 | API 状态 | 运行时行为 |
| --- | --- | --- |
| 缺字段或 schema 错误 | `needs_input` | 零写入 |
| 身份、scope、tenant、Origin、Host 不合法 | `blocked` | 零写入、零下游调用 |
| production mode 的任意 Admin POST | `blocked` | v1 不进入 verifier/service/store |
| 客户端 URL/path/secret/未知模块 | `blocked` | 零登记 |
| 控制面已启用但 inventory/store 缺失、损坏或锁冲突 | 启动失败 | 不监听、不回落全启用 |
| 从未初始化且 fixed state directory/marker/DB 都不存在，并显式 `MCP_LEGACY_STATIC_MODE=true` | `unavailable` | 仅此情况保留 legacy static-all-active，不提供写 API |
| 已初始化但 `MCP_ADMIN_CONTROL_ENABLED=false`/缺失，或 marker/DB identity 不一致 | 启动失败 | 从 fixed state directory 发现 sentinel，不监听、不回落全静态启用 |
| 自批、过期 preview、base 漂移、幂等冲突 | `blocked` | 不发布 |
| 数据库已写但 activation/readback 未知或不一致 | `manual_review` | 不宣称成功，保留事件证据 |
| fixture 发布读回一致 | `success` + `production_eligible=false` | 只证明本地受控环境 |
| security quarantine、退役或管理员安全禁用请求 | `blocked` | v1 不移除目录，不用 `module_disabled_by_release` 代替 |
| `verified_release` 或 production-eligible 登记请求 | `blocked` | v1 不接受，等待独立证据信任链 RFC |

## 11. 测试与验收

### 单元与合同

- inventory canonicalization、完整工具合同 digest、重复 ID/tool、非法 manifest、未知 RBAC
  tool、`verified_release` 输入和 cwd 读取拒绝。
- descriptor digest 与 request/preview canonical hash 分离；对象键序、集合输入顺序、顺序语义数组、
  schema version/domain separation 以及跨重启 hash 稳定性。
- SQLite 显式 initializer 的 DB+marker 原子创建、`control_identity` 对账、重开、权限、schema
  drift、corruption、并发 revision 和原子事件。
- register/preview/approve/publish/rollback 的正例、五状态和幂等 replay/conflict。
- 自批、reject 终态、approval hash/expiry/consume、跨 tenant、非 admin active role、缺 scope、
  identity override 字段、URL/path/secret 字段拒绝。
- activation registry 原子替换、显式 fresh legacy、sticky identity、release 后/初始化后
  `enabled=false` fail-closed、删除 enabled/DB path/marker path/instance env 后仍发现固定 sentinel、
  DB path/空 DB/marker mismatch、禁用调用 unavailable 和 exact readback。

### HTTP 与端到端

- loopback、Host、Origin、JSON、32 KiB、Bearer、管理 tenant/active role/scope 门禁；production
  POST 在 verifier/service 前固定 blocked。
- 两个 fixture 身份完成 register→preview→approve→publish→readback→rollback。
- 重启后从 SQLite 恢复 active/pending release；启动只对 `published_pending_readback` 自动做一次
  exact readback，`manual_review` 不自动重试且只可由操作员 reconcile；newest unresolved 阻止新
  publish，reconcile 复用同一 release 且不创建副本。历史 release、事件和幂等重放仍可读。control
  DB/marker 缺失、损坏、path/identity mismatch、换新空 DB 或第二实例锁冲突时不监听。
- 初始化后保留 fixed `MCP_INSTANCE_STATE_DIR`，同时删除 `MCP_ADMIN_CONTROL_ENABLED`、
  `MCP_CONTROL_DB_PATH`、`MCP_CONTROL_MARKER_PATH` 和 `MCP_INSTANCE_ID`，启动仍必须发现
  `control-identity.json` 并 fail closed；不得按 never-initialized 回落 legacy。
- 现有 MCP tools/list 保留，禁用工具可见但调用 unavailable，重新启用后恢复。
- 请求 security quarantine、退役或管理员安全禁用必须 `blocked`，不得通过
  `module_disabled_by_release` 模拟目录移除。
- Admin UI 不把 draft toggle 当 runtime state，不持久化 token，不显示秘密或业务正文。

### 全量门禁

```bash
npm test
npm run typecheck
npm run lint
npm run validate:schemas
npm run validate:agent-standards
npm run validate:agent-adapters
npm run build
npm run verify:runtime
git diff --check
```

浏览器验收必须覆盖 1440×900 和移动视口，完整点击两身份审批、发布读回和回滚。最终截图与
本设计视觉基准逐项比较布局、文案、字体、颜色、表格密度、状态语义和核心交互。

## 12. 发布与回滚边界

- 首版只在隔离 fixture 和本地回环运行真实写流程，不连接生产业务系统。
- v1 production Admin 写固定 blocked。后续若要开启，必须先通过新 RFC 配置独立 control DB、
  完整 JWT claim policy、管理 tenant、精确 Origin/Host、Deployment Evidence 信任链和多实例
  fencing；不能只改环境变量解除阻断。
- 代码构建/进程版本升级仍走现有 release runbook；控制面不能下载新版本代码。存在任一已
  发布 module policy 后，禁止回滚到不理解 control DB/schema/activation policy 的旧镜像；
  compatibility gate 未通过时回滚必须停止，不能让旧代码忽略数据库后全启用。
- 紧急回滚仍需要明确目标 release、另一 actor approval、幂等和读回；不删除 SQLite 数据，
  不逆迁 migration。
- 同一进程中控制面暂不可用时保留当前 active snapshot；启用控制面的进程重启时如果不能
  恢复 control DB 和 exact release，必须 fail closed 且不监听，不能自动回退到没有 exact
  readback 证据的配置。

本次只修订设计/RFC/计划，不修改 runbook。Task 7 必须更新 release、security 和 rollback
runbook：rollback 必须拒绝 pre-control-plane image，先通过 control DB/schema/policy compatibility
gate，保留 DB、release 和 event history，模块 profile 只能走“回滚到上一已读回版本（本地受控环境）”
对应的 preview→双人审批→新 release→exact readback 流程；最终交接验收还必须固定 production Admin
POST=`blocked`、fixture identities 不进入 production、以及 SQLite single-process lock 证据。
