# Integration handoff：Admin control-plane

本文件只交接 Admin control-plane 相关边界。它不是生产上线证明，也不把并行分支中的代码、静态页面、fixture 或计划当作最终接通证据。报价、关务、客户记录和其他业务数据继续由既有外部权威系统管理；本 MCP 不复制这些主表，也不把适配器写成已上线。

## 当前状态（2026-08-26 文档切片）

| 状态分类 | 当前可确认事实 | 交接含义 |
| --- | --- | --- |
| 当前已实现的切片 | control contract/inventory/hash、SQLite control store/identity marker、activation gate、register/preview/approval service 以及 Admin UI/API 模型在当前 checkout 可见 | 只说明实现切片存在；必须用最终命令和运行时证据确认 |
| 当前已有测试切片 | 可见 control-plane、runtime activation、Admin API/UI 测试文件 | 不把测试文件存在或静态检查写成 passed |
| 并行未完成 / 待最终回读 | 本次读取时 `publish`/`reconcile` 仍有未实现分支；`start.ts` 的 initializer/store/Admin API 接线、真实 HTTP 完整流程和 exact readback 尚待并行代理完成后回读 | handoff 保持 pending；不能交接为已可写 |
| 本地受控 | explicit initializer、fixture/local、loopback、synthetic data、fixture identities | 仅供隔离验收；fixture identity 不进入 production |
| 生产固定边界 | `POST /admin/api/v1/control/**` 固定 `blocked/admin_control_production_disabled_v1`，且应早于 authenticator/service | 不能通过 env、Admin 静态资源或 token 打开 |

## 交接前必须确认的状态边界

### 固定 application root 与 control state

server assembly 必须显式提供绝对 application root，且同一 root 在初始化、重启、回滚和 readback 中保持不变：

```text
state_dir  = <application-root>/.runtime/mcp-instance-state
control_db = <state_dir>/control.sqlite
marker     = <state_dir>/control-identity.json
```

initializer 是唯一创建者。部署/测试人员必须先显式执行 initializer；runtime startup/open 不隐式创建、修复、替换、删除或迁移 state。缺少 state、marker、DB、schema、身份输入、锁或权限不应触发兼容 fallback，而应在 listen 前 fail closed。`MCP_ADMIN_CONTROL_ENABLED` 必须是字面值 `true`。

交接必须把以下对象放在同一份 evidence record 中：

| 对象 | 交接内容 | 不通过处理 |
| --- | --- | --- |
| control DB | 非空 backup、`control_db_id`、schema/user_version、release/revision、inventory digest set、event/readback refs | `blocked`；不换 fresh DB、不清历史 |
| marker | 同目录 regular `control-identity.json`、原文 hash、唯一字段 | `blocked`；不从 env/DB 猜值 |
| application root | absolute root、目录权限、无 symlink、固定派生路径 | `blocked`；root drift 不是普通配置变化 |
| identity/tenant | marker 与 DB singleton 的 `instance_id`、`management_tenant_id`、`control_db_id`、absolute path、schema tuple 完全一致 | `blocked`；不接受请求中的任意 tenant |
| schema/permission | strict v1、`0700/0400/0600`、无 sidecar/额外 state 文件 | `blocked`；不由 startup 自修 |
| lock | 单进程 SQLite lock 与 WAL/FULL 持久性约束 | `blocked`；不绕过并发锁 |

备份记录只放 hash、size、版本、时间和 opaque references；不得包含 secret、客户地址、报价明细、税务全文、原始聊天或凭证。

### Admin API 与身份边界

v1 管理路径为：

```text
GET  /admin/api/v1/control/state
POST /admin/api/v1/control/packages/register
POST /admin/api/v1/control/deployments/preview
POST /admin/api/v1/control/approvals
POST /admin/api/v1/control/deployments/publish
POST /admin/api/v1/control/deployments/reconcile
```

POST 在 production 必须先经过固定 boundary gate，返回 `blocked`，不得触达 authenticator、control service、数据库写入或业务 adapter。fixture `local_operator` 与 `local_approver` 只属于 loopback local 的 synthetic fixture identity；不能被生产 verifier 接受，也不能出现在生产配置、token、日志或交接证据中。

浏览器 token/password 只能在 password/token 输入框内存短暂存在；不写 URL/query、localStorage、sessionStorage、cookie、持久化 DOM、日志、fixture data 或 audit event。服务端只保留 opaque identity/reference 和脱敏摘要。

## 控制面交接顺序

完整的本地受控流程必须可逐步读回：

1. 当前 build inventory-only 登记；只允许当前静态可信 build 的 module id/version/digest，不接受 arbitrary artifact URL、路径、源码或 secret。
2. creator 创建 preview，绑定固定 base release、desired refs、diff、validation、expiry、management tenant 和 idempotency key。
3. 不同 actor 在相同 tenant/权限下审批；creator 自审批、重复/冲突审批、tenant 漂移或过期 preview 必须 fail closed。
4. publish 持久化新的 release/revision，再切换已挂载模块的 activation snapshot；不加载任意代码、不改变工具公共合同、不写外部报价/关务/客户主表。
5. publish 后 exact readback 必须逐项匹配 release/revision、module refs、profile/config refs、instance/management tenant、activation policy、audit/idempotency outcome 与运行时工具行为。
6. `active_verified`/`verified` 仅表示 runtime exact readback，不是 artifact signature、source attestation 或 production qualification。三态必须分别记录：idempotency completed、module release active_verified、readback verified。
7. readback unknown、冲突、超时或 `domain_committed` 只能进入 `manual_review`/`unavailable`；不得伪造 success。`published_pending_readback` 只允许固定一次尝试，abandoned claim 不进行第二次 adapter call；manual review 只能由 operator-only reconcile 处理，未闭合时阻止新 publish。

回滚同样走上述 preview→不同 actor approval→publish→exact readback，但目标是新 rollback revision；保留 target release/revision/event/DB history，不修改历史。UI 文案固定为：**“回滚到上一已读回版本（本地受控环境）”**。任何 pre-control-plane image 都不是 managed rollback target。

## 权威与适配器交接边界

- MCP deterministic authority 只负责已批准的协议、状态机、单位/规则计算、control metadata、activation policy 和证据包络。
- 报价金额/Zone、关务状态/税费、客户地址/记录、文档主表和目标业务写入的权威仍在外部系统；MCP 只保存必要的版本引用、snapshot ID、opaque handle、审计关联和读回证据。
- 外部 `ready=false`、版本缺失、响应冲突、超时或写后读回失败必须保持 `unavailable`/`manual_review`/`blocked`/`needs_input`；AI、fixture 和截图不得补成 success。
- 适配器只有在真实 endpoint、认证、tenant mapping、非测试 release、staging 和 exact readback 证据齐全后，才能另行走基线 RFC；本 handoff 不批准任何 adapter online。

## 最终交接验收（待实际执行）

下面只列验收动作与证据槽位，当前不填结果、不预写通过数：

| 命令/动作 | 证据目标 | 槽位 |
| --- | --- | --- |
| `npm run build` | 候选编译产物、Admin 资源和 hash | `[待实际执行：build log / artifact hash]` |
| `npx vitest run tests/e2e/module-control-plane.test.ts tests/e2e/security-gates.test.ts tests/e2e/release-gates.test.ts --pool=forks --no-file-parallelism --maxWorkers=1` | real HTTP fixture、四眼审批、exact readback、生产 POST blocked | `[待实际执行：test output]` |
| `npm test`、`npm run typecheck`、`npm run lint` | 全量回归、类型和规范 | `[待实际执行：command outputs]` |
| `npm run validate:schemas`、`npm run validate:agent-standards`、`npm run build:agent-pack`、`npm run validate:agent-adapters` | 契约与 Agent 产物 | `[待实际执行：validator/pack evidence]` |
| `npm run verify:runtime`、`bash deploy/scripts/check-release.sh --fixture-only` | loopback fixture boundary、无网络 | `[待实际执行：runtime/check output]` |
| control DB/marker/root/identity/tenant/schema/permission/lock 只读核对 | backup 与 compatibility gate | `[待实际执行：continuity record]` |
| changed docs/config targeted `rg` secret/PII review | 无 token、URL secret、客户/业务明文 | `[待实际执行：match review]` |
| `git diff --check`、`git status --short`、`git diff --stat` | 补丁完整、未提交、未触碰他人写集 | `[待实际执行：diff/status record]` |

在上述证据实际填入前，交接状态保持 pending/manual_review/blocked；不得写成已发布、已上线或 production ready。
