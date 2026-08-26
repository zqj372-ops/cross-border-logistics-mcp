# Security gates

这是 Admin 控制面和 MCP 集成的安全验收清单，不是生产授权。本文将四种状态分开记录：

| 状态 | 允许写法 |
| --- | --- |
| 当前已实现、已有测试切片 | 当前 checkout 的源码和 focused test 资产已经存在；仍须用本次最终命令取得 fresh output |
| 并行未完成/待最终回读 | 接线、跨进程/重启、真实 HTTP 或最终 e2e 尚未由本次文档切片确认 |
| 本地受控环境 | 显式 initializer、fixture identity、loopback、合成数据；`evidence_level=local_build`、`production_eligible=false` |
| 生产固定 blocked | v1 `MCP_DATA_MODE=production` 的 Admin `POST` 固定 `blocked`，不因环境变量或静态 UI 改变 |

任何一项没有命令输出或批准的 staging evidence，都只能写“待实际执行”或“待适配验证”。
fixture、计划、源码 diff、静态快照和 `healthz` 都不能单独证明生产 readiness。

## 1. 启动前的 control state 安全门

### 1.1 固定 root 和路径

managed entrypoint 必须显式收到一个绝对、存在、regular 的 `application root`。从它只允许固定
派生下列路径：

```text
state_dir  = <application-root>/.runtime/mcp-instance-state
control_db = <state_dir>/control.sqlite
marker     = <state_dir>/control-identity.json
```

runtime 不读取 cwd，不接受请求、CLI、配置或环境变量提供的 DB/marker path override；
`MCP_STATE_DB_PATH` 不能成为 control-plane state 的替代路径。root 变化会派生新的绝对 state
路径，必须视为不同 instance 并 fail closed。

### 1.2 显式 initializer 门

显式 initializer 是唯一的 state 创建者。它必须在同一父文件系统中以 exclusive staging directory
原子建立目录、SQLite v1 schema、identity row 和 marker，再 rename 到不存在的 final state
directory，并完成所需 fsync。runtime open 不得隐式：

- 创建、修复、替换或删除 state directory；
- 创建空 DB 或补写 marker；
- 从 inventory、draft、环境变量或“没有 release”推导 active set；
- 在 enabled/identity/state 检查失败时继续监听。

`MCP_ADMIN_CONTROL_ENABLED` 不是 initializer、activation policy 或 bypass。managed start 只接受
字面值 `true`；缺失、`false`、大小写变化或其他值都必须在 listen 前 fail closed，即使 DB 中
尚无 release 也一样。

### 1.3 marker、DB identity 和 tenant continuity

marker 必须是 regular file、无 symlink、UTF-8、无 BOM、单一 RFC 8785/JCS JSON object 加一个
LF；未知字段、重复键和额外字节均拒绝。字段集合固定为：

```json
{"control_db_id":"db_<32-lower-hex>","control_db_path":"/absolute/path/to/application-root/.runtime/mcp-instance-state/control.sqlite","instance_id":"<MCP_INSTANCE_ID>","management_tenant_id":"<MCP_ADMIN_TENANT_ID>","marker_format":"mcp-control-identity/v1","schema_version":1}
```

SQLite 的 singleton `control_identity` 行必须逐字段匹配 marker 的 `control_db_id`、绝对
`control_db_path`、`instance_id`、`management_tenant_id`、`marker_format` 和 `schema_version`。
当前启动身份 `MCP_INSTANCE_ID`、`MCP_ADMIN_TENANT_ID` 必须存在且逐字匹配；tenant 缺失、变化、
跨 tenant 查询或 identity 漂移都是 fail closed，不得把删除输入解释成“未初始化”。

### 1.4 schema、permission、lock

启动和每次 live repository 操作都要重新验证：

- state directory `0700`、marker `0400`、control DB `0600`，owner 与 application root 一致；
- application root、`.runtime`、state directory、marker、DB 和中间路径都不是 symlink；DB 是
  regular single-link file；
- `user_version=1`、编译内置的 strict v1 schema、表/index 数量和 schema fingerprint 一致，
  `PRAGMA quick_check` 与 foreign-key check 通过；不接受 fresh replacement DB、未知版本或
  schema drift；
- SQLite 使用 WAL、`synchronous=FULL`、foreign keys、`trusted_schema=OFF` 和有界的单进程
  exclusive lock；锁冲突、WAL/SHM 残留异常或第二进程争用都必须阻止启动/继续写入；
- DB、marker、identity tuple、schema 和 lock 检查完成前，不创建 HTTP listener。

### 1.5 备份和兼容门

任何 local controlled rehearsal、staging 或经另行授权的生产变更前，operator 必须生成非空、
可恢复且不含 secret 正文的备份记录。备份对象和兼容门至少包含：

| 备份/门项 | 必须记录或验证 | 失败动作 |
| --- | --- | --- |
| control DB | `control.sqlite` 非空备份、digest/reference、SQLite quick check、WAL/SHM 处理结果 | 停止；不以空 DB 替换 |
| marker | `control-identity.json` 原始字节的受控备份/reference、digest、regular/0400/no-symlink | 停止；不重写 marker |
| application root | root 的 canonical/absolute reference、state_dir 和 DB/marker 派生关系 | root 不一致则拒绝打开 |
| identity/tenant | `instance_id`、`management_tenant_id` 的脱敏记录及 marker/DB 逐字段比对 | 缺失、变化、跨 tenant 即 blocked |
| schema | `schema_version`、`user_version`、编译 schema/fingerprint 和 migration 状态 | 不兼容则不得启动或回滚 |
| permission | directory/file mode、owner、link count、symlink 检查结果 | 修复前不监听；不在 runtime 隐式 chmod |
| lock | 备份时的单进程持有者、第二进程拒绝结果、WAL/SHM 状态和关闭结果 | lock conflict；不强删活跃锁 |
| release policy | active release/revision、inventory digest set、最新 readback、未决 attempt | 未决或不匹配则停止发布 |

备份清单可包含绝对路径的受控 reference，但日志、普通审计和 UI 只能使用 opaque reference；
不得将 token、API key、密码、连接串或客户业务正文写入备份清单。

## 2. HTTP、身份和请求顺序

Admin control API 不是 MCP 业务工具，固定只识别：

```text
GET  /admin/api/v1/control/state
POST /admin/api/v1/control/packages/register
POST /admin/api/v1/control/deployments/preview
POST /admin/api/v1/control/approvals
POST /admin/api/v1/control/deployments/publish
POST /admin/api/v1/control/deployments/reconcile
```

POST 的安全顺序必须保持为：

```text
loopback/HTTPS/Host/Origin
  → method/path
  → production-mode fixed block
  → Content-Type/body size
  → exactly one Bearer header
  → fixture authenticator or approved future verifier
  → server-owned execution context
  → active role/roles/scope/management tenant
  → Idempotency-Key
  → strict request schema
  → ModuleControlService
```

在 production mode，`POST` 必须在 authenticator 和 service 之前返回
`blocked/admin_control_production_disabled_v1`；不能通过设置
`MCP_ADMIN_CONTROL_ENABLED=true`、打开 UI、配置 token 或添加 Origin 绕过。

请求还必须拒绝：远程地址、非允许 Host、非允许/缺失写 Origin、重复 Authorization、cookie/query
token、非 JSON、超大/不一致 Content-Length、未知字段和 malformed JSON。请求体不能携带
`tenant_id`、`management_tenant_id`、`actor_id`、`role`、`roles`、`scopes`、URL、路径、源码、
命令、token、secret、DB connection 或任意 artifact metadata；这些值只来自服务端配置、认证
claims 和当前 deployment inventory。

fixture identity 只在 loopback local fixture assembly 存在，申请人和审批人是两个不同 actor；
fixture token 不得进入 production verifier、production environment、production logs 或生产
请求路径。生产身份、admin tenant、JWT issuer/audience/iat/exp/max-lifetime、Deployment Evidence
信任链和多实例 fencing 仍需未来 RFC，不能靠当前 fixture verifier 代替。

## 3. 浏览器 token 处理

- UI 使用 password input；Bearer 只存在于模块作用域的内存变量。
- 不得写入 URL/query string、`localStorage`、`sessionStorage`、cookie、DOM 文本、浏览器错误
  上报、console、audit 或普通日志。
- UI 请求失败时只显示固定、脱敏的状态和 reason code；不得把 Authorization header、完整 URL、
  secret reference 的值或异常原文回显。
- `?fixture=1` 只在 loopback local demo 显示两个明确标注的 fixture identity 入口；live/production
  query path 不显示 fixture identity，且不得从 fixture 静默回退。

## 4. 四眼审批、发布和 readback

控制流必须按以下顺序闭合：

```text
exact inventory registration
  → preview（base release/revision + desired set + diff + validation）
  → different-actor approval
  → publish
  → runtime activation exact readback
```

### 必须验证的状态

- registration 只接受当前 deployment inventory 的 exact `module_id/version/descriptor_digest`。
  inventory 是 allowlist，不是 activation policy；不支持 arbitrary code hot-plug。
- preview 必须绑定当前 base release/revision、inventory digest set、desired modules、creator、
  preview hash 和 expiry。
- approval 必须绑定 preview canonical hash、base、inventory、expiry、creator 和 approver；
  creator 自己 approval 固定 `blocked`。终态 reject/approve 不能被覆盖。
- publish 必须在持久化边界内完成 idempotency、release、activation 和 readback 约束，且不得把
  HTTP 200 或 `code=0` 当作成功。
- 只有 runtime 返回的 release ID、revision 和完整 module ref 集合逐项匹配候选，才可生成
  exact-readback proof 并使该 release 成为 `active_verified`。

成功 publish 的三个状态必须分开记录：

```text
module_control_idempotency.status = completed
module_releases.status             = active_verified
Admin envelope.readback.status     = verified
```

`active_verified`/`verified` 只表示 runtime exact readback；它不是 artifact signature、镜像
digest、签名密钥信任、SBOM、attestation 或 production qualification。local/fixture inventory
继续是 `evidence_level=local_build`、`production_eligible=false`。

## 5. pending、manual_review 和 reconcile

- `published_pending_readback`：domain 已提交但 readback 尚未终态；只允许对该固定 release 做
  pending-only readback，不创建第二个 release。
- `domain_committed`：幂等记录已固定 domain release；只能 claim 它对应的 pending release，不能
  扩大目标或从中重建 active set。
- 一个未认领的 pending release 可按固定规则做一次 readback；启动前应先重新枚举 unfinished
  attempt。上次 boot 遗留的 claimed attempt 必须先终结为 interrupted `unknown`，随后不得为同一
  claim 再调用第二次 adapter/readback。
- `manual_review`：结果未知或不一致；启动不自动重试，publish replay 只返回已经原子持久化的
  结果，activation/readback 次数都必须为零。
- 只有 operator reconcile 能为 unresolved release 建立新的 attempt；它重读同一 release/revision，
  不新建 release。最新 unresolved release 存在时，任何新的 publish 都必须 blocked。
- 相同 idempotency key + 相同 request hash 只 replay；相同 key + 不同 hash 必须 conflict/block。

## 6. activation 和业务权威边界

activation registry 只控制已经由 Module Runtime v0 挂载的 handler 是否可调用：

- 初始 snapshot 严格为 `releaseId:null/revision:0/activeModules:[]`；不能从 inventory 全量激活；
- 没有 `active_verified` 时，模块调用 `unavailable/module_policy_not_released`，但
  `tools/list` 仍显示模块，非模块工具不受影响；
- 普通 `module_disabled_by_release` 是 operational unavailable，不移除工具目录；
- security quarantine、retirement 和 administrator security-disable 不是 v1 operational toggle，
  请求必须 `blocked`，未来 catalog-removal contract 另行定义；
- 控制面不得变成报价、Zone、税率、客户记录、关务规则或 PDF 业务主数据的第二权威。外部报价、
  关务和客户数据仍由各自系统管理；ready=false 或响应冲突保持 `unavailable`/`manual_review`。

## 7. 最终证据槽位（全部待实际执行）

以下命令是最终验收清单，不预填通过数，不把历史输出复制为本次结果：

```text
[待实际执行] npm test
[待实际执行] npm run typecheck
[待实际执行] npm run lint
[待实际执行] npm run validate:schemas
[待实际执行] npm run validate:agent-standards
[待实际执行] npm run build:agent-pack
[待实际执行] npm run validate:agent-adapters
[待实际执行] npm run build
[待实际执行] npm run verify:runtime
[待实际执行] bash deploy/scripts/check-release.sh --fixture-only
[待实际执行] git diff --check
[待实际执行] 针对 changed docs/fixtures 的 secret/PII rg 检查并人工复核每个命中
[待实际执行] markdown link/path 检查
```

证据槽位：

```text
branch/HEAD: 待实际执行
control DB backup reference + digest: 待实际执行
marker backup reference + digest: 待实际执行
application-root/derived-path identity tuple: 待实际执行
schema/permission/lock result: 待实际执行
fixture register/preview/approval/publish/readback: 待实际执行
manual_review/reconcile evidence: 待实际执行
rollback new revision + unchanged target history: 待实际执行
production Admin POST blocked before authenticator/service: 待实际执行
fixture identity absent from production path: 待实际执行
```
