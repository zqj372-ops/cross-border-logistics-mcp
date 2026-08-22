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
   digest。客户端只能按 exact ID/version/digest 登记，不能提交 URL、路径、源码或 secret。
   v1 inventory 只允许 `local_build`、`production_eligible=false`；不接受 `verified_release`。
4. 新增独立 SQLite control store，路径由启动必查的固定 `MCP_INSTANCE_STATE_DIR` 派生（
   `control.sqlite`，`MCP_CONTROL_DB_PATH` 仅为等值诊断引用）。表是窄语义 release/preview/
   approval/readback/event/identity 表，不提供通用 key-value 或 SQL 写入口。
5. 新增管理 API：读取 control state、登记部署清单模块、生成部署/回滚 preview、审批、发布，
   以及对固定 `published_pending_readback|manual_review` release 做 exact readback reconciliation。
   启动只自动处理前者一次；后者只由操作员调用 reconcile。
   所有 POST 要求 Idempotency-Key，身份由 verifier 注入。
6. 管理写入要求 active role 为 admin、roles 包含 admin、`platform:admin` scope 和服务端配置的管理 tenant。preview creator
   与 approver 必须是不同 actor。
7. 新增 `ModuleActivationRegistry`。它只切换已挂载模块的调用门禁，不加载代码、不卸载
   lease、不改变工具公共合同。普通 `module_disabled_by_release` 保留工具目录可见性，调用
   返回 `unavailable`；security quarantine、退役和管理员安全禁用不属于 v1，请求必须
   `blocked`，未来合同另行定义目录移除。
8. publish 必须在持久化后应用不可变 activation snapshot，并对 release/revision/module refs
   做 exact readback。`active_verified`/`verified` 只表示当前 runtime exact readback，不表示
   artifact signature、source attestation 或 production qualification；读回未知或不一致返回
   `manual_review`。
9. rollback 通过同一 preview/approval/publish 流程创建新 revision，不删除或改写历史 release。
10. Admin UI 使用自托管 AdminLTE 4 CSS 和现有原生 ES module；FastAdmin 只作为信息架构参考，
    不引入其 PHP runtime、权限表、ORM 或插件安装器。
11. v1 只允许 loopback fixture/local 写入；`MCP_DATA_MODE=production` 的 Admin POST 固定
    `blocked`。生产认证、Deployment Evidence 和多实例发布必须另行 RFC，不能靠配置打开。
12. 控制面使用固定、启动必查的 `MCP_INSTANCE_STATE_DIR/control-identity.json`，marker 与
    `MCP_INSTANCE_ID`、绝对 DB path、`control_db_id` 和 schema version 绑定；显式初始化后即
    sticky enabled，不能用 `MCP_ADMIN_CONTROL_ENABLED=false`/缺失、删除旧 path/instance env
    或 legacy flag 绕过已有 activation policy。只有 state directory、marker、DB 都不存在且
    显式 `MCP_LEGACY_STATIC_MODE=true` 的全新实例才允许 legacy static-all-active；已初始化
    实例的 enabled=false/缺失、DB path/identity/schema/marker 不一致或换新空 DB 均 fail closed、
    不监听。
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
- 控制面未启用，或全新 control DB 明确没有 release 时默认启用当前全部静态模块。控制面已
  启用但 DB/状态不可恢复时启动失败，不回落全启用。
- 新版本模块代码仍需应用构建和进程发布；control plane 不宣称跨代码版本 hot-plug。

## Canonical hash contract

request canonical hash 与 preview canonical hash 是两个不同的可审计值。二者都对 UTF-8、无
BOM 的 RFC 8785/JCS canonical JSON 做 SHA-256；等价实现必须逐字节遵守 JCS，不能使用未经
补充规则的 `JSON.stringify`。hash preimage 固定为：

```text
MCP-CONTROL-HASH\0v1\0<domain>\0<schema_version>\0<JCS bytes>
```

`<domain>` 只能是 `request` 或 `preview`，当前 `<schema_version>` 是 `2026-08-22.v1`；
输出固定为 `mcp-control-hash/v1/<domain>/sha256:<64 lowercase hex>`。request payload 必须
含 action 和完整已校验请求；preview payload 必须含服务端绑定的 tenant/creator、intent、base
release/revision、inventory digest set、desired refs、policy/schema version、validation 和
expiry。对象键按 JCS 排序；`desired refs`、inventory digest set、`reason_codes` 等集合数组
按稳定键排序；有顺序语义的数组保持顺序。跨重启计算结果必须一致；更换 schema version 或
domain 必须产生不同 hash。

inventory descriptor digest 仍是 `sha256:<64 lowercase hex>`，只对完整 canonical descriptor
做 SHA-256，不带 control hash domain prefix。它只证明 deployment descriptor 未漂移，不能替代
request/preview hash、artifact/image digest、签名或生产 qualification。Task 1 当前只负责
descriptor/inventory 公共合同，本次不改其源码、schema 或测试；Task 2/3 必须提供共享 helper
和跨重启、对象键序、集合输入顺序、顺序数组、schema/domain separation 回归测试。

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
- 新 DB 与 marker 只由显式 initializer 原子创建；普通 runtime 不自动重建缺失的 enabled DB，
  也不修复/替换 marker。
- 数据库启用 strict tables、foreign keys、WAL、FULL synchronous、quick check 和 `0600`。
- v1 使用 SQLite exclusive locking，只允许一个进程持有同一 control DB。
- v1 只支持新库创建和同版本重开；未知 user_version 或 schema drift 失败闭合。
- 已应用 schema 不在紧急回滚中逆迁；回滚应用代码时保留 control DB 和 release 历史。
- 测试必须保留 fixed `MCP_INSTANCE_STATE_DIR`，初始化后同时删除
  `MCP_ADMIN_CONTROL_ENABLED`、`MCP_CONTROL_DB_PATH`、`MCP_CONTROL_MARKER_PATH` 和
  `MCP_INSTANCE_ID`，并证明启动仍发现 `control-identity.json` 后 fail closed，而不是进入
  never-initialized legacy。

### Identity marker

初始化配置固定提供一个启动时无条件解析的绝对 host 锚点 `MCP_INSTANCE_STATE_DIR`。fixture
固定为 `<application-root>/.runtime/mcp-instance-state`；生产必须由 host/service unit 固定一个
持久挂载路径，缺少该锚点本身即 fail closed。v1 从该目录固定派生
`control.sqlite` 与其外部 marker `control-identity.json`，不接受可通过删除环境变量旁路的任意
DB/marker path：

```text
MCP_INSTANCE_STATE_DIR=/absolute/stable/mcp-instance-state
MCP_CONTROL_DB_PATH=<MCP_INSTANCE_STATE_DIR>/control.sqlite
MCP_CONTROL_MARKER_PATH=<MCP_INSTANCE_STATE_DIR>/control-identity.json
```

marker 是 UTF-8、无 BOM、单个 JCS JSON 对象加一个 LF，唯一字段为：

```json
{"control_db_id":"db_<32-lower-hex>","control_db_path":"/absolute/path/to/control.sqlite","instance_id":"<MCP_INSTANCE_ID>","marker_format":"mcp-control-identity/v1","schema_version":1}
```

DB 另有固定 singleton `control_identity` 行保存相同的 instance/path/db-id/schema tuple；
`control_db_id` 是 initializer 生成的随机 128-bit ID。identity directory `0700`、marker
`0400`、DB `0600`，均拒绝 symlink。initializer 在 sibling staging directory 中完成 schema、
identity row、fsync 和 marker 的 `O_CREAT|O_EXCL` 写入，再以一次 directory rename 原子安装
DB+marker；目标已存在时拒绝，普通启动绝不隐式创建。marker 缺失/损坏、DB path 不匹配、换新
空 DB、DB row/marker/instance/schema 不一致或 control policy enabled=false/缺失时均不监听。
只有 state directory、marker、DB 都不存在且显式 `MCP_LEGACY_STATIC_MODE=true` 的从未初始化
新实例，才可以 legacy static-all-active；legacy flag 在 marker 出现后永远无效。即使操作者
同时删除 `MCP_ADMIN_CONTROL_ENABLED`、旧的 DB/marker path override 和 `MCP_INSTANCE_ID`，
启动仍会从固定 state directory 发现 sentinel 并 fail closed，而不是判断 never-initialized。

## 发布语义

- 登记：exact match 当前 build inventory；只说明当前构建包含该 descriptor。
- preview：固定 base release、desired refs、diff、validation、creator 和 expiry。
- approval：另一 actor 决定并绑定 preview hash/base/inventory/expiry；append-only 终态，
  reject/expired/consumed 不可发布或覆盖。
- publish：先拒绝 newest unresolved release；无 `published_pending_readback|manual_review` 时才
  compare-and-set base，创建 release，应用 activation，读回 exact snapshot。
- publish 幂等记录在 release 事务中进入 `domain_committed` 并固定 release ID；进程中断后的
  同键重试只能恢复该 release 的 readback，不能创建第二个 release。
- success：只说明当前环境中的控制写入和运行时读回成功；是否 production eligible 由 inventory
  evidence 单独给出。
- manual_review：数据库写入已发生但 activation/readback 未知或不一致。
- reconciliation：启动前只对最新 `published_pending_readback` 自动 exact readback 一次；已是
  `manual_review` 的 release 启动时不自动重试，只能由操作员 reconcile。reconcile 只重读/恢复
  最新固定 release，不创建新 release；任一 newest unresolved release 阻止新的 publish。
- `active_verified`/`verified`：仅为当前 runtime activation exact readback 结果，不是 artifact
  signature 或 production qualification。
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
   时停止回滚，不能忽略独立文件后默认全部启用。
4. 若需恢复某个 module profile，使用仍可运行的新版本控制面按“回滚到上一已读回版本（本地
   受控环境）”生成 rollback preview→双人审批→新 release→exact readback，不直接编辑 SQLite。
5. 验收必须验证 tools/list、普通 operational disable 的 `unavailable`、重新启用、audit 和
   active release readback；security quarantine/退役/管理员安全禁用请求必须是 `blocked`，不移除目录。

本次不修改 release/security/rollback runbook；Task 7 才能写入最终操作步骤。Task 7 的最终交接
验收必须固定 production Admin POST=`blocked`、fixture identities 不进入 production、SQLite
single-process lock、marker/DB identity continuity 和 compatibility gate 证据。

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
