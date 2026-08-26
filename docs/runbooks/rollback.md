# Rollback runbook

control-plane 回滚不是删除或改写历史，也不是把旧镜像强行启动。它是在仍理解 control DB/schema/activation policy 的版本上，以上一份 runtime exact-readback profile 为目标，创建一份新的 rollback revision，再走完整的 preview→不同 actor approval→publish→exact readback 流程。本 runbook 只覆盖本地受控环境的操作边界；生产 Admin POST 和生产回滚在 v1 固定 `blocked`。

## 回滚目标与状态含义

- 可选目标必须是当前 control state 中有完整 release/revision、module id/version/digest、profile/config refs、tenant/instance 和 exact readback evidence 的上一份 verified profile。
- `active_verified`/`verified` 只代表 runtime exact readback；它不是 artifact signature、source attestation 或 production qualification。不能把它单独当成镜像可信证明或生产资格。
- 回滚产生新 release/revision，保留 target release、revision、event、audit、idempotency 和 control DB history；不直接编辑、删除或重排 target 历史。
- UI/操作文案固定为：**“回滚到上一已读回版本（本地受控环境）”**。这句话不表示生产可回滚。

## 兼容门与禁止目标

在暂停写操作后，先从已审计发布记录取上一 verified profile、previous digest、previous config hash、inventory digest set、release/revision 和 non-empty backup；不从聊天、截图、记忆或未核验 tag 猜值。

必须同时证明下列对象仍在同一连续性边界内：

| 对象 | 回滚前必须核对 |
| --- | --- |
| application root | 与原控制面相同的绝对 root；state directory 及中间节点不得是 symlink |
| control DB / marker | `<application-root>/.runtime/mcp-instance-state/control.sqlite` 与同目录 `control-identity.json` 均存在、非空、regular、hash 可追溯 |
| identity / tenant | marker 与 DB singleton 的 `control_db_id`、absolute path、`instance_id`、`management_tenant_id`、schema tuple 完全一致 |
| schema / permission | strict 支持版本、`user_version`、state dir `0700`、marker `0400`、DB `0600`、无 sidecar 均符合合同 |
| lock | single-process SQLite lock 可获得；没有并发实例、锁冲突或绕过锁的强制操作 |
| backup / migration | non-empty backup 可定位；已应用 migration（applied migration）保留，不做紧急逆迁移或删除历史 |

initializer 是唯一创建者。回滚和 startup 都不得隐式创建、修复、替换或删除 control DB、marker、目录、schema 或 release history；缺失、损坏、root 漂移、identity/tenant 漂移、schema 不兼容、权限错误或 lock 冲突均在监听/写入前 `blocked`。

任何 pre-control-plane image 都不是 managed rollback target：旧代码即使能启动，也可能忽略 active policy、marker、control schema 和 release history。它必须从回滚候选清单隔离/移除；只能选 control-plane-aware image digest，并另外通过候选构建和兼容检查。

## 受控回滚步骤

1. **冻结入口**：暂停新的 Admin preview/approval/publish 和业务写适配；保留当前 audit、incident reference、pending/manual-review 状态和 control DB。
2. **建立 rollback preview**：由 operator 选择上一份已读回 profile，提交新 rollback preview。preview 必须固定 base release、目标 module refs、desired diff、validation、expiry、creator、management tenant 和 idempotency key；不得直接改 SQLite，不得把历史 release 当作新记录覆盖。
3. **不同 actor 审批**：由与 creator 不同的 actor，在相同 management tenant、角色和权限下审批未过期 preview。self-approval、重复/冲突审批、tenant/actor 漂移、权限不足或过期都必须 fail closed。
4. **发布新 revision**：publish 仅允许已持久化、已批准的 rollback preview；先保存新 release/revision，再应用已挂载模块的 activation snapshot。它不加载新代码，不改变工具公共合同，不改写外部报价、关务、客户记录或 target history。
5. **exact readback**：逐项读取并比较新 release/revision、目标 module id/version/digest、profile/config refs、application root、identity/tenant、activation policy、audit/idempotency outcome 和实际工具行为。只有 exact readback 成功，模块路由才可回到目标 profile；`active_verified`/`verified` 必须与 readback evidence 对应。
6. **异常闭合**：readback unknown、冲突、超时、锁/marker/DB 不一致，或上游仅返回 `domain_committed` 时，保持 `manual_review`/`unavailable`，不包装成 success，不再次激活，不重放外部写入。未解决 release 阻止后续 publish。
7. **记录与恢复**：保存新 revision、旧/新 digest、config hash、readback refs、audit ID、操作者、时间和 owner；经人工复核后再恢复 client smoke。回滚失败时保持 blocked/manual_review，不能退回 pre-control-plane image。

## pending 与 reconcile

- `published_pending_readback` 只允许固定的一次启动/运行时 exact readback 尝试。
- 未认领的 `domain_committed` pending 才能开始规定的 pending readback；abandoned durable claim 视为 interrupted unknown，不进行第二次 adapter call。
- `manual_review` 不在启动时自动重试；只有 operator-only `reconcile` 能针对固定 release 记录新的核对尝试。reconcile 不创建替代业务主表、不编辑历史 release，也不把 manual-review replay 变成新的外部 activation/readback。
- reconcile 仍未闭合时，新 publish 固定 blocked。所有目标系统写后读回都必须由其本身的权威数据确认；MCP 不拥有报价、Zone、关税或客户数据。

## 生产边界与 secret 处理

生产 `POST /admin/api/v1/control/**` 固定在 method/boundary gate 返回 `blocked/admin_control_production_disabled_v1`，早于 authenticator、control service 和 adapter；fixture identity 只允许 loopback local，不能作为生产身份。环境变量、静态 Admin 资源或 fixture token 都不能解除该门。

Admin UI 的 password/token 只存在浏览器输入框的内存中，不写 URL、query、localStorage、sessionStorage、cookie、持久化 DOM、日志或审计；runbook、备份和事件只保存 opaque reference、hash 与脱敏摘要。生产回滚若未来获批，仍须另有被接受的 RFC、企业身份与 multi-instance fencing 证据，本任务不执行。

## 最终验收命令与证据槽位

下列命令是回滚交接的待执行清单，不是已运行结果。每个证据槽位必须由授权验收人实际填写，当前统一为 `[待实际执行]`：

| 命令/动作 | 必须证明 | 证据槽位 |
| --- | --- | --- |
| `npm run build` | control-plane-aware candidate 与不可变产物 hash | `[待实际执行：build log / artifact hash]` |
| control DB/marker/root/identity/tenant/schema/permission/lock 只读核对 | continuity 与 compatibility gate | `[待实际执行：backup hash / marker hash / lock record]` |
| `npx vitest run tests/e2e/module-control-plane.test.ts tests/e2e/security-gates.test.ts tests/e2e/release-gates.test.ts --pool=forks --no-file-parallelism --maxWorkers=1` | rollback new revision、四眼审批、exact readback、失败闭合 | `[待实际执行：test output]` |
| `npm run verify:runtime` | 本地 fixture runtime 与 readiness boundary | `[待实际执行：runtime output]` |
| `git diff --check` | 文档/补丁完整性 | `[待实际执行：command output]` |
| changed docs/config targeted `rg` secret/PII review | 无 secret/客户或业务明文泄漏 | `[待实际执行：match review record]` |

没有完整 readback、兼容门和审批证据时，回滚状态只能是 pending/manual_review/blocked；不能声称已恢复、已上线或生产可用。
