---
standard_id: writable-module-control-plane-v1
version: 2026-08-22.v1
priority: 85
audience: developer,reviewer,operator
rule_ids: CONTROL-WRITE-001,CONTROL-AUTH-001,CONTROL-RELEASE-001
---

# RFC: 可写模块控制面 v1

- 状态：accepted for implementation by user confirmation on 2026-08-22
- 日期：2026-08-22
- 基线：`81b5ca83aeca65e3b44ffc06c50e368d948e4f09`
- 影响范围：本机/fixture 模块控制元数据、Admin 管理 API、静态模块启停门禁、构建清单、发布与回滚 runbook
- 不改变：Phase 1 业务工具合同、统一五状态字段、报价/关务/客户/文档权威边界

## 动机

当前 Admin 页面只能展示脱敏快照，Module Runtime 只能在启动时挂载静态可信模块。用户需要
真正保存 MCP 自身模块配置，并通过预览、审批、发布、读回和回滚管理已随应用构建的模块。
继续只增加说明文档或前端假开关不能满足该需求；直接引入 FastAdmin PHP 后端、任意插件
下载器或运行时代码加载又会破坏现有平台权威和供应链边界。

## 决策

1. 新增 `src/logistics_mcp/control-plane/**`，归平台团队所有，只保存模块控制元数据，不保存
   任何业务主数据。
2. 新增 `schemas/admin-control/**`，定义 Admin 管理 API 的 Draft 2020-12 请求/响应。该目录
   不改变 `docs/contracts/**` 的 Phase 1 MCP 工具合同。
3. 构建生成只包含当前应用内静态可信模块的 module inventory 和 canonical descriptor
   digest。inventory 仅是登记/激活 allowlist，不是默认 active 集合；客户端只能按 exact
   ID/version/digest 登记，不能提交 URL、路径、源码或 secret。v1 inventory 只允许 `local_build`、
   `production_eligible=false`；不接受 `verified_release`。
4. 新增独立 SQLite control store，路径由 server assembly 传入的绝对 application root 固定派生
   为 `<application-root>/.runtime/mcp-instance-state/control.sqlite`，marker 固定为同一 state
   directory 下的 `control-identity.json`。不接受环境变量、请求参数或诊断引用作为 DB/marker 路径
   override。表是窄语义 release/preview/approval/readback/event/identity 表，不提供通用
   key-value 或 SQL 写入口。
5. 新增管理 API：读取 control state、登记部署清单模块、生成部署/回滚 preview、审批、发布，
   以及对固定 `published_pending_readback|manual_review` release 做 exact readback reconciliation。
   启动只自动处理前者一次；后者只由操作员调用 reconcile。
   所有 POST 要求 Idempotency-Key，身份由 verifier 注入。
6. 管理写入要求 active role 为 admin、roles 包含 admin、`platform:admin` scope 和服务端配置的管理 tenant。preview creator
   与 approver 必须是不同 actor。
7. 新增 `ModuleActivationRegistry`。它只切换已挂载模块的调用门禁，不加载代码、不卸载
   lease、不改变工具公共合同。inventory 只提供 allowlist；初始 snapshot 严格为
   `releaseId:null`、`revision:0`、`activeModules:[]`，不得把 inventory 全量设为 active。没有
   `active_verified` release 时模块不可路由，调用返回 `unavailable`，reason
   `module_policy_not_released`，但工具仍保留在 `tools/list`，非模块工具不受影响。首次激活
   必须完整经过登记→preview→不同 actor 四眼 approval→publish→runtime exact readback；只有
   readback 成功后的 release 才能放行模块路由。普通 `module_disabled_by_release` 保留工具目录
   可见性，调用返回 `unavailable`；security quarantine、退役和管理员安全禁用不属于 v1，请求
   必须 `blocked`，未来合同另行定义目录移除。
8. publish 必须在持久化后应用不可变 activation snapshot，并对 release/revision/module refs
   做 exact readback。`active_verified`/`verified` 只表示当前 runtime exact readback，不表示
   artifact signature、source attestation 或 production qualification；读回未知或不一致返回
   `manual_review`。
9. rollback 通过同一 preview/approval/publish 流程创建新 revision，不删除或改写历史 release。
10. Admin UI 使用自托管 AdminLTE 4 CSS 和现有原生 ES module；FastAdmin 只作为信息架构参考，
    不引入其 PHP runtime、权限表、ORM 或插件安装器。
11. v1 只允许 loopback fixture/local 写入；`MCP_DATA_MODE=production` 的 Admin POST 固定
    `blocked`。生产认证、Deployment Evidence 和多实例发布必须另行 RFC，不能靠配置打开。
12. 控制面使用由 application root 固定派生、启动必查的 state directory；marker 与
   `MCP_INSTANCE_ID`、`MCP_ADMIN_TENANT_ID`、绝对 DB path、`control_db_id` 和 schema version
   绑定。显式 initializer 成功后才允许 entrypoint 打开 control state；
   `MCP_ADMIN_CONTROL_ENABLED` 缺失或不是字面 `true`、state directory 整体缺失/不完整、root
   变化、任何 symlink、marker/DB identity/schema/tenant 不一致或换新空 DB 均 fail closed、不监听。
   初始化不是 runtime 的隐式恢复机制；不存在 release 也不能改变该 managed policy 或假设 active set。
13. request canonical hash 与 preview canonical hash 均使用 UTF-8 RFC 8785/JCS + SHA-256、固定
    `v1/domain/schema_version` domain prefix 和明确的集合排序规则；descriptor digest 继续是
    无 control domain 的 `sha256:<64 lowercase hex>`，三者不互换。

## 所有权

| 路径 | 所有者 | 内容 |
| --- | --- | --- |
| `src/logistics_mcp/control-plane/**` | 平台任务 02 | inventory、store、service、activation、errors/types |
| `schemas/admin-control/**` | 本 RFC 控制面合同维护者 | 仅 Admin API schema |
| `src/logistics_mcp/server/admin-control-api.ts` | 平台任务 02 | HTTP 管理边界 |
| `src/logistics_mcp/server/{admin-static,start,composition}.ts` | 平台任务 02 | 受控接线与 activation gate |
| `apps/admin/**` | 控制台集成 | AdminLTE 外壳、模块中心和真实 API 交互 |
| `tests/{control-plane,platform,e2e}/**` | 对应实现所有者 | 合同、安全、存储、运行时和浏览器外协议测试 |
| `deploy/scripts/build.mjs`、`docs/runbooks/**` | 集成任务 06 | inventory/admin 资产构建与运行边界 |

上述新增路径所有权已同步写入 `AGENTS.md`。`docs/contracts/**` 不在本 RFC 实施中修改。如果后续要新增公共 MCP 管理工具或改变业务工具
envelope，必须另行提交共享合同 RFC。

## API 和状态兼容

- 现有 `/mcp`、`/healthz`、`/readyz`、九个 Phase 1 工具和
  `system.agent_context.get` 名称/Schema/权限保持不变。
- 新 API 位于 `/admin/api/v1/control/**`，不是 MCP 业务工具，不进入现有工具目录。
- Admin API 使用独立 `2026-08-22.v1` closed envelope，包含 request ID、trace ID、audit ID、
  五状态、discriminated data、reason codes 和 readback；不声称复用完整 MCP envelope。
- managed control-plane entrypoint 必须先由显式 initializer 建立并校验 state directory、marker、
  DB、identity 和 schema；没有 release 时保留 managed policy，但 active snapshot 仍是空集，模块
  不可路由。初始化后 DB/状态不可恢复、根路径变化、symlink、tenant/identity 漂移或
  `MCP_ADMIN_CONTROL_ENABLED` 缺失/非 `true` 时启动失败，不监听。
- 新版本模块代码仍需应用构建和进程发布；control plane 不宣称跨代码版本 hot-plug。

## Canonical hash contract

request canonical hash 与 preview canonical hash 是两个不同的可审计值。二者都对 UTF-8、无
BOM 的 RFC 8785/JCS canonical JSON 做 SHA-256；等价实现必须逐字节遵守 JCS，不能使用未经
补充规则的 `JSON.stringify`。hash preimage 的字节序列固定为：ASCII `MCP-CONTROL-HASH`，
单字节 NUL `0x00`，ASCII `v1`，单字节 NUL `0x00`，ASCII domain `request` 或 `preview`，单字节
NUL `0x00`，ASCII `schema_version`，单字节 NUL `0x00`，再接 RFC 8785/JCS canonical JSON
的 UTF-8 bytes；文档中的 `\0`/`\x00` 只是 escaped display，绝不是反斜杠字符文本。最后对
整段 framed bytes 做 SHA-256，输出固定为
`mcp-control-hash/v1/<domain>/sha256:<64 lowercase hex>`。

RFC 8785/JCS 负责 number、string、`null` 和 object-key 的逐字节规范化；不能以未经 JCS
约束的 `JSON.stringify` 代替。所有 set-like arrays 必须先规范化元素，再按元素 UTF-8 bytes
的 lexicographic 升序排序。`desired_modules` 与 `inventory_refs` 的唯一排序 tuple 是
`module_id NUL version NUL descriptor_digest`；`required_capabilities`、`optional_capabilities`、
`capability_refs`、`standard_refs`、`evidence_ref_ids`、`tool_names`、`reason_codes` 和
`source_ref_ids` 是字符串集合，均按 UTF-8 bytes 排序。`approval_history`、`event_history`、
`calculation_trace` 和任何明确的 order-semantic array 保持输入顺序，不能全局排序；集合排序
规则不能由客户端自行解释。

request hash 的 closed payload 精确为：
`{"action":<one of packages.register|deployments.preview|approvals.decide|deployments.publish|deployments.reconcile>,"management_tenant_id":<server-authenticated tenant>,"actor_ref":<server-authenticated actor>,"request":<the exact strict request object>}`。
strict request object 只允许 register 的 `schema_version,module_id,version,descriptor_digest`；
preview change 的 `schema_version,intent,desired_modules`；preview rollback 的
`schema_version,intent,target_release_id`；approval 的 `schema_version,preview_ref,decision,reason_code`；
publish 的 `schema_version,preview_ref,approval_id`；或 reconcile 的 `schema_version,release_id`。
request hash 排除 `request_id`、`trace_id`、`audit_id`、`idempotency_key`、新生成的
preview/approval/release IDs、所有 timestamps 和 HTTP 包装；strict request 中显式的 domain
reference 仍是语义输入。

preview hash 的 closed payload 精确为：
`{"action":"deployments.preview","management_tenant_id":<server-authenticated tenant>,"creator_actor_ref":<server-authenticated creator>,"intent":<change|rollback>,"base_release_revision":<integer>,"target_release_id":<string|null>,"inventory_refs":<sorted tuple array>,"desired_modules":<sorted tuple array>,"policy_version":"writable-module-control-plane-v1","schema_version":"2026-08-22.v1","validation":{"base_matches":<boolean>,"desired_modules_valid":<boolean>,"inventory_matches":<boolean>,"minimum_active_modules":<boolean>,"reason_codes":<sorted string array>},"preview_ttl_seconds":<integer>}`。
它排除 `preview_ref`、`request_id`、`trace_id`、`audit_id`、`idempotency_key`、release/approval
IDs generated by this operation、`created_at`、`expires_at`、`published_at` 和其他
transport/event timestamps；`target_release_id` 是 rollback strict-request 的 semantic reference,
not a generated execution ID。No implementation may add fields to either payload without a
schema/RFC version。

#### Golden vectors (Node `node:crypto`, schema `2026-08-22.v1`)

以下输入已经按上述规则排序。每行 `canonical JCS` 是对象键和数组规范化后的精确 UTF-8 输入；
`framed escaped` 使用 `\x00` 表示单字节 `0x00`，并拼接完全相同的 JSON bytes。使用 Node
`node:crypto` 复算必须得到以下 closed hash。

```text
Vector 1 — request
canonical JCS = {"action":"packages.register","actor_ref":"actor_operator","management_tenant_id":"tenant_demo","request":{"descriptor_digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","module_id":"cargo","schema_version":"2026-08-22.v1","version":"1.0.0"}}
framed escaped = MCP-CONTROL-HASH\x00v1\x00request\x002026-08-22.v1\x00{"action":"packages.register","actor_ref":"actor_operator","management_tenant_id":"tenant_demo","request":{"descriptor_digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","module_id":"cargo","schema_version":"2026-08-22.v1","version":"1.0.0"}}
expected = mcp-control-hash/v1/request/sha256:1dc6b77eedfc0639d6fb264c4e0557bdeb39a46bbabb968db13a6be7ee8c86da

Vector 2 — preview
canonical JCS = {"action":"deployments.preview","base_release_revision":0,"creator_actor_ref":"actor_operator","desired_modules":[{"descriptor_digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","module_id":"cargo","version":"1.0.0"}],"intent":"change","inventory_refs":[{"descriptor_digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","module_id":"cargo","version":"1.0.0"}],"management_tenant_id":"tenant_demo","policy_version":"writable-module-control-plane-v1","preview_ttl_seconds":900,"schema_version":"2026-08-22.v1","validation":{"base_matches":true,"desired_modules_valid":true,"inventory_matches":true,"minimum_active_modules":true,"reason_codes":[]}}
framed escaped = MCP-CONTROL-HASH\x00v1\x00preview\x002026-08-22.v1\x00{"action":"deployments.preview","base_release_revision":0,"creator_actor_ref":"actor_operator","desired_modules":[{"descriptor_digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","module_id":"cargo","version":"1.0.0"}],"intent":"change","inventory_refs":[{"descriptor_digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","module_id":"cargo","version":"1.0.0"}],"management_tenant_id":"tenant_demo","policy_version":"writable-module-control-plane-v1","preview_ttl_seconds":900,"schema_version":"2026-08-22.v1","validation":{"base_matches":true,"desired_modules_valid":true,"inventory_matches":true,"minimum_active_modules":true,"reason_codes":[]}}
expected = mcp-control-hash/v1/preview/sha256:13348c6594c3d24cc30aeb62f839e6b6fd1fe133830a2fdad11b8d4b59b6e503
```

使用 Vector 1 的同一 canonical JSON、只把 domain 换为 `preview`，应得到
`mcp-control-hash/v1/preview/sha256:7f756bdf267eb3ef54b6ee5a3211a947255f491072f72f92dc7f844e6024c04b`，
以证明 domain separation；只修改 schema version 也必须改变 framed bytes 和 hash。
`descriptor_digest` 仍独立为 `sha256:<64 lowercase hex>`，对完整 canonical module descriptor
计算且不加 control framing，不能等同 request/preview hash。

descriptor digest 只证明 deployment descriptor 未漂移，不能替代 request/preview hash、
artifact/image digest、签名或生产 qualification。Task 1 当前只负责 descriptor/inventory
公共合同，本次不改其源码、schema 或测试；Task 2/3 必须提供共享 helper 和跨重启、对象键序、
集合输入顺序、顺序数组、schema/domain separation 回归测试。

## 安全

- `/admin` 首版继续仅回环访问；生产多人访问仍需批准的企业身份网关，未在本 RFC 中授权
  直接公网暴露。
- 所有写 API 检查 loopback、Host、Origin、Content-Type、body size、Bearer、tenant、active role、
  scope、schema 和幂等键，检查顺序发生在业务写入之前。
- token 只在浏览器内存和请求 Authorization header 中存在，不持久化、不回显、不审计。
- 生产不接受 fixture token；fixture 两身份只在回环 fixture assembly 显式配置。v1 production
  Admin POST 在认证/业务 service 前固定 blocked。
- 客户端不能提交 tenant/actor/role/scope、URL、Git 地址、本地路径、命令、源码、token、
  secret 或数据库连接。
- `module_disabled_by_release` 只表示普通 operational unavailable：工具保留在 `tools/list`，
  调用返回 `unavailable`。security quarantine、退役和管理员安全禁用不是 v1 能力；请求这些
  语义必须 `blocked`，不得用 operational disable 模拟未来的目录移除。
- 控制事件只保留受控 actor/tenant/object refs、reason、status、revision 和时间；不保存业务正文。

## 数据与迁移

- 使用独立 control DB，schema 从 v1 开始，避免隐式改变现有 production platform store。
- 新 DB 与 marker 只由显式 initializer 原子创建；普通 runtime 不自动重建缺失的 managed DB，
  也不修复/替换 marker。
- 数据库启用 strict tables、foreign keys、WAL、FULL synchronous、quick check 和 `0600`。
- v1 使用 SQLite exclusive locking，只允许一个进程持有同一 control DB。
- v1 只支持新库创建和同版本重开；未知 user_version 或 schema drift 失败闭合。
- 已应用 schema 不在紧急回滚中逆迁；回滚应用代码时保留 control DB 和 release 历史。
- 测试必须保留同一 application root，初始化后同时删除
  `MCP_ADMIN_CONTROL_ENABLED`、`MCP_INSTANCE_ID` 和 `MCP_ADMIN_TENANT_ID`，并证明启动仍发现
  `control-identity.json` 后 fail closed，而不是把缺失身份当作未初始化。

控制面 strict data model 的 tenant 字段统一为 `management_tenant_id`，不得用含义不明的
`tenant_id` 替代：

| 记录 | 必填 management tenant 绑定 | 关键约束 |
| --- | --- | --- |
| `control_identity` | `management_tenant_id` | 与 marker、服务端当前管理 tenant 逐字一致；缺失/变化 fail closed |
| `module_registrations`、`module_previews`、`module_approvals` | `management_tenant_id` | 作为租户范围和唯一约束组成部分，不能跨 tenant 读取或重放 |
| `module_releases`、`module_readbacks` | `management_tenant_id` | release、revision、readback 必须属于同一管理 tenant |
| `module_control_idempotency`、`module_control_events` | `management_tenant_id` | 幂等键、事件和最终结果不能跨 tenant 复用；缺失/变化 fail closed |

### Identity marker

server assembly 固定提供一个启动时无条件解析的绝对 regular `application-root`。fixture 与生产
都从该 root 固定派生 state directory；生产 root 由受管 host/service unit 固定，缺少或变化即
fail closed。v1 从该目录固定派生 `control.sqlite` 与 `control-identity.json`，不接受任何环境
变量、请求参数或诊断引用作为 DB/marker path override：

```text
state_dir  = <application-root>/.runtime/mcp-instance-state
control_db = <state_dir>/control.sqlite
marker     = <state_dir>/control-identity.json
```

managed entrypoint 只能在部署/测试显式调用 initializer 成功后打开 control state；initializer 是
唯一创建者，runtime open 不创建、修复、替换或删除任何状态文件。入口必须先解析 application
root、派生固定路径、验证 marker/DB/identity tuple 和 control schema，再构造监听器；任一检查失败
都必须不监听。state directory 整体删除、缺失、不完整，root 派生 path 改变、权限/锁冲突或任何
symlink 均 fail closed。

marker 是 regular file、UTF-8、无 BOM、单个 RFC 8785/JCS JSON object 加一个 LF；未知字段、重复
键、额外字节和 symlink 一律拒绝，唯一字段为：

```json
{"control_db_id":"db_<32-lower-hex>","control_db_path":"/absolute/path/to/application-root/.runtime/mcp-instance-state/control.sqlite","instance_id":"<MCP_INSTANCE_ID>","management_tenant_id":"<MCP_ADMIN_TENANT_ID>","marker_format":"mcp-control-identity/v1","schema_version":1}
```

DB 另有固定 singleton `control_identity` 行保存完全相同的 `management_tenant_id`、instance、
path、db-id 和 schema tuple；`control_db_id` 是 initializer 生成的随机 128-bit ID，不从 path、
tenant 或 release 推导。identity directory `0700`、marker `0400`、DB `0600`，均拒绝 symlink。
initializer 必须在同一父文件系统内用 `fs.mkdtemp` 或等价的 exclusive `mkdir` 创建 sibling staging
directory（不能把 `O_CREAT` 描述成创建目录），目录权限 `0700`；staging DB 事务内建立 strict v1
schema、identity row 和 `user_version=1`，执行 `PRAGMA wal_checkpoint(TRUNCATE)` 并关闭所有
SQLite handles。若 clean close 后仍有 `control.sqlite-wal` 或 `control.sqlite-shm`，initializer
必须失败并清理 staging；否则 fsync 主 DB。marker 再以 `O_CREAT|O_EXCL` regular file 写入并
fsync，fsync staging directory 后才允许把 staging directory rename 到不存在的 final state
directory；最后 fsync parent directory。目标已存在、目标为 symlink、任一中间节点为 symlink 或
rename 非原子时拒绝。

启动时必须校验当前 `MCP_INSTANCE_ID` 与 `MCP_ADMIN_TENANT_ID` 都存在且逐字匹配 marker/DB。
tenant 缺失、变化或与服务端管理 tenant 不一致，instance 缺失/变化，`MCP_ADMIN_CONTROL_ENABLED`
缺失/不是字面 `true`，marker/DB 缺失、损坏、path/schema/identity 不一致、换新空 DB 或锁冲突，
均 fail closed、不监听；不存在 release 也不能改变 managed policy 或 active set。

## 发布语义

- 登记：exact match 当前 build inventory；只说明当前构建包含该 descriptor。
- inventory 是 allowlist，不是 activation policy；初始 snapshot 为
  `releaseId:null`、`revision:0`、`activeModules:[]`。没有 `active_verified` release 时模块调用
  返回 `unavailable`/`module_policy_not_released`，但 `tools/list` 保持可见。
- 首次激活只能走完整登记→preview→不同 actor 四眼 approval→publish→runtime exact readback，
  不得从 inventory、启动恢复或 draft 推导 active policy。
- preview：固定 base release、desired refs、diff、validation、creator 和 expiry。
- approval：另一 actor 决定并绑定 preview hash/base/inventory/expiry；append-only 终态，
  reject/expired/consumed 不可发布或覆盖。
- publish 的顺序固定为：先按 tenant/action/idempotency key 查记录并比较 request hash；同 key
  不同 hash 返回 `blocked/idempotency_conflict`，同 key 同 hash 先走持久化 replay。固定 release
  为 `manual_review` 时是 final replay，零 activation、零 readback；只有 `domain_committed` 且
  固定 release 仍为 `published_pending_readback` 时才允许 pending-only readback resume，不创建
  第二个 release。只有新 key 才检查 newest unresolved；存在 `published_pending_readback` 或
  `manual_review` 时 `blocked`。通过后才 compare-and-set base、预留幂等记录、创建 release、应用
  activation 并 exact readback。
- publish 幂等记录在 release 事务中进入 `domain_committed`，固定 release ID，并将 release
  置为 `published_pending_readback`；从 `domain_committed` 自动 readback 仅限该 pending 状态。
  进程中断后的同键重试不能创建第二个 release。
- success：只说明当前环境中的控制写入和运行时读回成功；是否 production eligible 由 inventory
  evidence 单独给出。
- manual_review：数据库写入已发生但 activation/readback 未知或不一致。
- reconciliation：启动前只对最新 `published_pending_readback` 自动 exact readback 一次；已是
  `manual_review` 的 release 启动时不自动重试，只能由操作员 reconcile。reconcile 只重读/恢复
  最新固定 release，不创建新 release；任一 newest unresolved release 阻止新的 publish。
- `active_verified`/`verified`：仅为当前 runtime activation exact readback 结果，不是 artifact
  signature 或 production qualification。
- successful publish 的三个对象状态必须明确分离：Only `module_control_idempotency.status` becomes
  `completed`; `module_releases.status` becomes `active_verified`; Admin `readback.status` becomes
  `verified`。这三者同时成立才是成功发布的三态；`domain_committed`、`published_pending_readback`、
  `pending` 或 `manual_review` 不能被互换或提前包装成这组三态。
- rollback：复制目标的 runtime exact-readback profile 形成新 release，保留完整历史；UI/操作文案
  统一为“回滚到上一已读回版本（本地受控环境）”。

## UI 与依赖

- 新增固定版本 `admin-lte` 和其 peer `bootstrap`；构建只复制所需本地 CSS/JS，CSP 保持
  `self`，不使用 CDN。
- 保留原生 HTML/CSS/ES module，不引入第二套前端框架。
- UI 中所有模块状态来自 control state API；fixture 数据不得静默回退到 live 页面。
- 写按钮在未绑定身份、无 preview、无另一 actor approval 或 readback 未就绪时保持禁用。

## 分阶段实施

1. inventory、activation 类型和合同 schema。
2. SQLite store 与 ModuleControlService 状态机。
3. 管理认证/HTTP API 与 composition 接线。
4. ModuleActivationRegistry 调用门禁、启动恢复和运行时读回。
5. AdminLTE 模块中心、两身份 fixture 流程和脱敏 UI。
6. 构建、e2e、安全、release/rollback 文档和全量验证。

## 回滚

1. 关闭新的 Admin 写入口，保留 control DB、事件和当前 release reference。
2. 应用代码只能回滚到仍理解 control DB/schema/activation policy 的 control-plane-aware image
   digest；`active_verified` 不是 artifact 签名或生产资格证明。不删除 control DB、不逆迁 schema。
3. 禁止回滚到不认识 control DB/schema/activation policy 的旧代码；compatibility gate 未通过
   时停止回滚，不能让旧代码忽略独立控制面文件后启动。
4. 若需恢复某个 module profile，使用仍可运行的新版本控制面按“回滚到上一已读回版本（本地
   受控环境）”生成 rollback preview→双人审批→新 release→exact readback，不直接编辑 SQLite。
5. 验收必须验证 tools/list、普通 operational disable 的 `unavailable`、重新启用、audit 和
   active release readback；security quarantine/退役/管理员安全禁用请求必须是 `blocked`，不移除目录。

本次不修改 release/security/rollback runbook。Task 7 更新并验收前，它们仍是旧应用/集成流程的
参考，不是新控制面发布权威；这阻塞 Task 5 和最终验收，但不阻塞 Task 2 的 store 实现。Task 7
才能写入最终操作步骤；最终交接验收必须固定 production Admin POST=`blocked`、fixture identities
不进入 production、SQLite single-process lock、marker/DB/management-tenant identity continuity
和 compatibility gate 证据。

## 验证

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

本 RFC 不授权生产部署、外部业务系统写入、任意制品下载或公开 Admin 入口。
