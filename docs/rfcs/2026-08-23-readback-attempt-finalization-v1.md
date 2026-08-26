---
standard_id: readback-attempt-finalization-v1
version: 2026-08-23.v1
priority: 87
audience: developer,reviewer,operator
rule_ids: CONTROL-ATTEMPT-001,CONTROL-FINALIZE-001,CONTROL-RECOVERY-001
status: accepted
---

# RFC：readback attempt 与原子终结 v1

- 日期：2026-08-23
- 状态：accepted for implementation；独立设计审查已验证 exact DDL、指纹规范与 crash-gap 合同，具体实现仍须另行验收。
- 基线：`208124075cbc1cf4d3d25ff9a9d69ef1ae17ea6b`，共享 worktree 尚有未提交实现。
- 影响：模块控制仓储、SQLite 初始 schema、Fake、ModuleControlService、启动恢复、运行时 readiness。
- 不影响：Phase 1 MCP 业务工具输入输出、五种 envelope 状态、报价/关务/客户/文档权威边界。
- 当前事实：本 RFC 只闭合实现合同；不证明 Service、Admin API、UI、生产认证、部署或生产 readback 已完成。

## 1. 问题

现有预实现仓储把 terminal readback 和 idempotency completion 暴露成两个独立写入口：

```ts
recordReadback(request): Promise<ReadbackWriteResult>;
completeIdempotency(request): Promise<ControlIdempotencyRecord>;
```

进程若在二者之间退出，会留下 terminal release/readback，但同 key 的 `finalResult=null`。重放时既
不能安全重试 adapter，也无法原样返回第一次结果。现有一 release 一 readback row 还会在 reconcile
时覆盖旧证据，无法证明每次外部尝试发生了什么。

第二个缺口是 adapter 调用没有 durable claim。进程在外部调用后、终态持久化前退出时，重启无法
区分“从未调用”与“可能已经调用”，重复调用会破坏 at-most-once 边界。

第三个缺口是 SQLite 与内存 activation gate 不可能原子提交。“旧 route 一定更严格”是错误前提：
回滚或移除模块时，旧 route 可能更宽松。必须采用 DB-first、受控请求 barrier、同步 gate commit、
失败即 fatal/unready、重启从持久证据恢复的协议。

## 2. 决策

### 2.1 私有 attempt ledger

增加第九张 strict table `module_readback_attempts`。每次 publish 初次 readback 或 operator reconcile
都对应一条不可覆盖的 attempt。它绑定：

- management tenant、action、idempotency key、canonical request hash；
- 原始 actor、request/trace/audit refs；
- release ID、positive revision、完整 desired module refs；
- server-generated attempt ID 与 readback ref；
- boot-scoped `owner_boot_id`；
- `claimed|finalized` phase 与精确 RFC3339 时间；
- finalized 后的完整 terminal observation、reason codes 与 finalizer actor。

`pending` 不是 terminal attempt status。adapter 返回 pending、超时、异常或不完整结果必须收敛为
`unknown/manual_review`；attempt 不得永久悬挂。

### 2.2 不可伪造的进程内能力

`claimReadbackAttempt` 返回闭合 union：

```ts
type ReadbackAttemptClaimResult =
  | {
      readonly disposition: "created";
      readonly attempt: ReadbackAttemptRecord;
      readonly ownerCapability: ReadbackAttemptOwnerCapability;
    }
  | {
      readonly disposition: "existing";
      readonly attempt: ReadbackAttemptRecord;
    };
```

只有 `created` 可调用 adapter。`ownerCapability` 由 repository instance 的 private WeakSet/WeakMap
品牌化，递归冻结，不可序列化、不可克隆、不可跨 repository 借用，也不进入日志或数据库。
owner finalization 必须提交该 capability。启动恢复使用另一个只由 assembly 持有的 private recovery
driver；HTTP、MCP handler 和普通 service caller 都不能取得它。

能力不是 durable authority。durable authority 是唯一 attempt row；能力只保证当前进程中只有创建
claim 的调用链可进入 owner finalization。`owner_boot_id` 是每次启动随机生成、进程内固定且从不
复用的 opaque ID，不能用 PID、时间戳或客户端值代替。

五个 mutation action 都在查询 idempotency 之前先进入同一个 assembly-owned exclusive mutation
barrier。register/preview/approval 持有到各自原子 domain/idempotency transaction 结束；publish/
reconcile 持有到 terminal finalization 与 gate commit 完成。第二个 same-key 请求因此等待第一个
owner 完成，随后 replay durable finalResult；它不会在 owner 活跃时观察并处理 `existing`。
repository 若在 exclusive critical section 内返回 `existing` 且 attempt 的 owner boot 是当前 boot，
表示 coordinator/owner promise 不变量已破坏，必须 fatal/unready，不能 recovery finalize、调用 adapter
或返回普通五状态 envelope。只有 pre-listen startup recovery 可处理 owner boot 不等于当前 boot 的
existing/unfinished claim。重启后所有预存在的 `claimed` attempt 都属于 prior boot，恢复绝不重新调用
adapter。

### 2.3 当前投影与历史证据分离

`module_readbacks` 在 v1 中是 terminal-only 的每 release 当前 readback 投影，status 只允许
`verified|mismatch|unknown`，并增加非空 `attempt_id`。claim 不写 pending row；terminal finalization
才插入或替换 current row。旧 attempt 的完整 observation 永久保存在 attempt ledger 中。DTO 合同
仍可解析 pre-service pending readback fixture，但本 v1 SQLite repository 与 ModuleControlService 不
生产该分支：claimed 期间 `latest_readback` 只能是 null、旧 active release 的 terminal readback，或
同一 unresolved release 上一条 finalized attempt 的 terminal projection。

因此同一 unresolved release 可由不同 reconcile idempotency key 产生多个 attempt，但必须保持同一
release/revision/desired refs；每个 attempt/readback ref 唯一，旧 attempt 不可变，current readback
只指向最新 terminal attempt。

### 2.4 单一终结事务

service-facing repository 不再暴露可组合出 crash gap 的 `recordReadback` 与
`completeIdempotency`。publish/reconcile 只使用：

```ts
claimReadbackAttempt(request): Promise<ReadbackAttemptClaimResult>;
finalizeReadbackAndComplete(request): Promise<ReadbackFinalizationResult>;
getUnfinishedReadbackAttempt(query): Promise<ReadbackAttemptRecord | null>;
listUnfinishedReadbackAttempts(): Promise<readonly ReadbackAttemptRecord[]>;
getReadbackAttemptHistory(query): Promise<readonly ReadbackAttemptRecord[]>;
```

`finalizeReadbackAndComplete` 在一个 `BEGIN IMMEDIATE` transaction 中完成：

1. 验证 identity、tenant、idempotency/action/key/hash、release/revision/desired refs；
2. 验证 attempt 仍 claimed，owner capability 或 private recovery driver 有效；
3. 单次取得/canonicalize finalization instant，并在 transaction 内从当前 `MAX(sequence)` 分配连续的
   reconciliation/completion event sequence；
4. 先插入 terminal reconciliation event 与 completed idempotency event，使 immediate event FK 目标
   已存在；这些 transaction-internal 中间状态对外不可见；
5. 写 terminal current readback projection；
6. `verified` 时把 release 转为 `active_verified` 并按规则 supersede 前一 active release；
   `mismatch|unknown` 时把 release 转为 `manual_review`；
7. 把完整 terminal observation 与两个 event sequence 写入 attempt 并转为 finalized；
8. 把 idempotency 转为 completed 并写 immutable action-specific `finalResult`；
9. 重读完整 release/readback/attempt/idempotency/event 关系，执行 FK/health graph 检查后提交。

任一子写失败必须整体 rollback。允许的未终结状态只有：

```text
idempotency = domain_committed
release      = published_pending_readback 或原 manual_review
attempt      = claimed
current readback 不存在或仍是上一条 terminal projection
finalResult  = NULL
```

禁止的是同一个 attempt lineage 内出现 finalized/terminal readback 而对应 idempotency
`finalResult=NULL`。上一条 finalized attempt 的 current projection 可以在新 attempt 处于 claimed、
新 idempotency `finalResult=NULL` 时继续存在；full health 必须按 `attempt_id` 关联，不能跨 attempt
误判。

### 2.5 publish 与 reconcile 顺序

同 tenant/action/idempotency key 的检查先于 unresolved-release gate：

1. 同 key、不同 hash：立即 conflict，零 adapter、零新写入；
2. 同 key、completed：原样返回 persisted finalResult；
3. same-boot 的第二个同 key 请求在 mutation barrier 外等待 owner，owner 完成后 replay；在 exclusive
   critical section 内看到 same-boot existing 是 fatal invariant violation，零 adapter；
4. publish 的同 key、domain_committed、无 attempt、固定 release 仍 pending：可创建唯一 claim；
5. 只有新 publish key 才检查 newest unresolved，随后原子消费 preview/approval 并创建 release；
6. 新 reconcile key 在一个 transaction 中创建 domain_committed idempotency 与 claim，不创建 release。

新 publish key 在存在 `published_pending_readback|manual_review` 时 blocked。reconcile 只能针对 newest
unresolved release，且不能改变 release/revision/desired refs。

### 2.6 启动恢复与 immutable final result

ModuleControlService 的 recovery coordinator 从 persisted attempt + release 生成 action-specific
`manual_review` envelope，调用 `assertControlProducerEnvelope` 获取 detached deep-frozen snapshot，再由
private recovery driver 原子终结同一 attempt/readback lineage：

```text
readback.status = unknown
reason_codes    = ["readback.interrupted"]
release.status  = manual_review
```

恢复不调用 adapter，不生成替代 attempt，不把 unknown 修成 success。claim 时持久化的
request/trace/audit refs 用于第一次 finalResult；一旦写入，后续 replay 原样返回，不重新生成。
原始 `attempt.actor_ref` 与 idempotency actor 保持不变；recovery finalizer 和它创建的两个 terminal
event 使用固定服务端 actor ref `system_startup_recovery`。完整 graph 必须验证 terminal event actor
等于 `attempt.finalized_by_actor_ref`，而不是错误地要求它等于原始业务 actor。

启动必须在创建 HTTP/service caller 之前枚举所有 prior-boot unfinished attempts，不能只查一条；
private recovery driver 在 listen 后不可调用。若发现旧式不一致状态：terminal
readback/release 已存在，但 idempotency 仍 domain_committed 且 finalResult null，则初始化 fail closed，
要求显式 repair/migration；不得隐式包装为 success。

### 2.7 DB-first activation gate 与 fatal fence

同一 runtime 的所有 service instance 与所有 module handler 共享一个 assembly-owned async 读写
coordinator；SQLite handle lock 不能替代进程内 barrier。内部接口固定为：

```ts
interface RuntimeMutationCoordinator {
  withMutation<T>(operation: () => Promise<T>): Promise<T>;
  withControlledDispatch<T>(operation: () => Promise<T>): Promise<T>;
  tripFatal(error: unknown): never;
  isFatal(): boolean;
}
```

`withMutation` 取得 exclusive writer barrier，且同一 boot 的所有 Service instance 必须使用同一个
实例。`withControlledDispatch` 取得 shared reader barrier，先检查 fatal，再读取 activation snapshot，
完成 active 判定并持有到原 handler 完成；所有 module handler 禁止绕过它直接调用
`registry.isActive()`。writer 必须等待既有 handler 完成，并从 stage 前一直持有到 gate commit 成功
或 fatal latch 在 barrier 内生效。publish/reconcile 顺序为：

coordinator 是 fail-fast non-reentrant。它用 execution-context ownership 检测递归 writer、reader→
writer 与 writer→reader；这些路径在等待锁之前触发 fatal invariant error，不能悬挂。trusted adapter
只使用私有 stage/readback driver，禁止经 public tool router 回调受控 handler。普通 module handler
也不能调用 ModuleControlService mutation；这种编程错误不是可重试业务 `blocked`。

```text
acquire mutation barrier
stage candidate without changing served gate
durably claim attempt
adapter apply/readback only for created claim
atomic DB finalization
synchronous no-I/O proof-backed gate commit
release barrier
```

activation gate 由 assembly-only factory 创建：

```ts
const { readFacade, privateDriver } = createActivationGate(trustedInventory);
```

router 只取得 `readFacade` 与 coordinator 的 controlled-dispatch facade；Service 通过 closure/private
field 持有 driver。driver、recovery driver、mutation writer capability 不进入 repository public type、
HTTP 参数、diagnostics、fixture data 或 registry public object。gate proof 一次性消费，commit 同步且
无 I/O，fatal latch 必须在释放 writer barrier 前生效。

DB finalization 成功而 gate commit 尚未完成时，任何受控请求都不得经过旧 gate。如果 gate commit
抛错：

- 不回滚已提交 DB；
- 不返回 success、unavailable 或非持久 manual_review；
- 立即触发不可清除 fatal readiness latch；
- 停止监听或拒绝所有受控请求；
- 仅允许新进程在 listen 前从 exact active release/readback/inventory evidence 恢复 gate。

恢复失败则保持 unready。这一协议是 DB-first + fail-stop，不宣称 DB 与内存原子一致。

如果 adapter 已调用而 terminal DB finalization 失败，也必须触发 fatal latch。新进程把 unfinished
claim 收敛为 interrupted unknown，零第二次 adapter 调用。

## 3. SQLite schema 与约束

唯一规范、可直接执行且纳入 fingerprint 的完整九表 DDL 是同目录的
`2026-08-23-readback-attempt-finalization-v1.schema.sql`。实现必须逐条使用该 artifact 的 table/index
名称、字段、NOT NULL、CHECK、UNIQUE、FK 与 statement 顺序；本节只作可读摘要，不能替代或放宽
该 SQL。artifact 缺失、无法在空 DB 执行或与实现 schema normalization 不一致时，本 RFC 不可接受。

`module_readback_attempts` 的摘要字段为：

```text
management_tenant_id, attempt_id,
action, idempotency_key, request_hash,
actor_ref, request_id, trace_id, audit_id,
release_id, revision, desired_modules_json,
readback_ref, owner_boot_id,
phase, claimed_at, finalized_at,
terminal_status, applied_release_id, applied_revision,
applied_modules_json, reason_codes_json, checked_at,
finalized_by_actor_ref,
reconciliation_event_sequence, completion_event_sequence
```

关键关系必须由 SQLite 自身约束，不能只靠 TypeScript 事后检查。`module_control_idempotency` 增加
以下候选键；它把 request hash 与唯一 domain release 一起固定：

```sql
UNIQUE (
  management_tenant_id,
  action,
  idempotency_key,
  request_hash,
  domain_record_ref
)
```

attempt 的关键约束为：

```sql
PRIMARY KEY (management_tenant_id, attempt_id)
CHECK (action IN ('deployments.publish', 'deployments.reconcile'))
UNIQUE (management_tenant_id, action, idempotency_key)
UNIQUE (management_tenant_id, readback_ref)
UNIQUE (reconciliation_event_sequence)
UNIQUE (completion_event_sequence)
UNIQUE (
  management_tenant_id,
  attempt_id,
  release_id,
  revision,
  readback_ref
)
FOREIGN KEY (
  management_tenant_id,
  action,
  idempotency_key,
  request_hash,
  release_id
) REFERENCES module_control_idempotency (
  management_tenant_id,
  action,
  idempotency_key,
  request_hash,
  domain_record_ref
)
FOREIGN KEY (management_tenant_id, release_id, revision)
  REFERENCES module_releases (management_tenant_id, release_id, revision)
FOREIGN KEY (reconciliation_event_sequence)
  REFERENCES module_control_events (sequence)
FOREIGN KEY (completion_event_sequence)
  REFERENCES module_control_events (sequence)
```

两个 event FK 使用 immediate 语义；因此 2.4 的 transaction 固定先插入两个 event，再 finalize
attempt。禁止把顺序改回“先 attempt 后 event”，也禁止依赖连接级 deferred pragma 隐式放行。

`module_readbacks` 删除 `pending` 分支，增加非空 `attempt_id`，并用下列复合外键把 current projection
固定到同一 attempt/release/revision/readback-ref；release 不反向外键到 readback：

```sql
CHECK (status IN ('verified', 'mismatch', 'unknown'))
FOREIGN KEY (
  management_tenant_id,
  attempt_id,
  release_id,
  revision,
  readback_ref
) REFERENCES module_readback_attempts (
  management_tenant_id,
  attempt_id,
  release_id,
  revision,
  readback_ref
)
```

同一个 release/revision 同时最多一条 live claim，必须是 partial unique index，不是普通查询约定：

```sql
CREATE UNIQUE INDEX uq_module_readback_attempts_claimed_release
ON module_readback_attempts (
  management_tenant_id,
  release_id,
  revision
)
WHERE phase = 'claimed';
```

上述 table、candidate key、partial index、CHECK、FK 及 SQL 文本规范化结果都进入严格 schema
fingerprint。v1 不 prune completed idempotency、attempt、readback 或 event lineage。

phase CHECK：

```text
claimed
  => terminal_status/finalized_at/checked_at/finalizer 均为 NULL
     reconciliation/completion event sequence 均为 NULL
     applied pair 为 NULL，applied modules/reasons 为 []

finalized
  => terminal_status IN (verified,mismatch,unknown)
     finalized_at/checked_at/finalizer 均非 NULL
     reconciliation/completion event sequence 均为 positive 且不相等

verified
  => applied release/revision/modules 与 desired exact-match，reasons=[]

mismatch|unknown
  => reasons 非空，applied release/revision 同时空或同时非空
```

索引：

```text
unfinished:      (management_tenant_id, claimed_at, release_id, revision) WHERE phase='claimed'
release history: (management_tenant_id, release_id, revision, reconciliation_event_sequence DESC, attempt_id DESC)
idempotency:     (management_tenant_id, action, idempotency_key, request_hash)
readback ref:    (management_tenant_id, readback_ref)
```

完整 health graph 必须扫描全部 durable rows，并验证：sequence 从 1 连续；SQL transaction rollback
不留下 sequence gap（sequence 在同一 `BEGIN IMMEDIATE` 内分配）；业务 rollback 仍创建新 release 与
正常 publish/reconciliation/completion events，因此会消费 sequence；
每 release 一个 publish domain event；每 finalized attempt 一个 terminal reconciliation event；每
completed publish/reconcile idempotency 一个 completion event；claimed attempt 在同一 attempt/
release/idempotency lineage 内没有 terminal event、completed idempotency 或 active_verified target
release，但不禁止另一个旧 release 继续 active_verified；current readback 的 `attempt_id` 必须指向该 release 最新
terminal reconciliation event sequence 对应的 finalized attempt。相同时间戳不能决定顺序；history 以
terminal reconciliation event sequence DESC、再以 attempt ID DESC 作确定性排序。
所有 finalized attempt 的 reconciliation/completion sequence 两个集合必须全局互斥：任一 event
sequence 只能被一个 attempt 的一个角色引用，不能作为另一 attempt 的另一个角色复用。SQLite 的两列
独立 UNIQUE 只能约束列内重复，跨列互斥由 full health graph fail closed 强制并纳入回归测试。

owner 正常终结时 `finalized_by_actor_ref` 等于 attempt 原始 actor；启动恢复时固定为
`system_startup_recovery`。两个 terminal event 的 actor 必须与 finalizer 一致；idempotency actor 仍与
attempt 原始 actor 一致，二者不得互相覆盖。

时间关系为：

```text
idempotency.createdAt <= attempt.claimedAt <= attempt.finalizedAt
attempt.finalizedAt == terminal reconciliation occurredAt == completion occurredAt
```

`finalizeReadbackAndComplete` 只调用注入 clock 一次，把该值只 canonicalize 一次，然后把同一组精确
UTF-8 字节写入 attempt `finalized_at`、terminal reconciliation `occurred_at` 与 completion
`occurred_at`。不允许三次取时、分别格式化或依赖毫秒截断恰好相等。

Admin `events_truncated` 只描述 latest-256 projection，不替代完整 health graph。

## 4. 权限、状态与日志

- 不新增公开 envelope status 或公开 `idempotency_status`；attempt phase 仅是 private repository state。
- publish/reconcile 继续要求 active admin role、roles 包含 admin、`platform:admin` scope、精确 management tenant。
- recovery driver 只在 pre-listen assembly 内可用；HTTP body 不能提供 attempt、capability、actor 或 correlation refs。
- attempt/event/finalResult 不保存地址、报价、税务正文、原始聊天、token、secret、adapter raw response 或路径。
- `active_verified` 只表示当前 runtime exact readback，不表示签名、SBOM、生产发布或生产资格。

## 5. 兼容与迁移

该控制面尚未发布，v1 初始 schema 直接收口为九张 strict table，不静默接受八表预实现。schema
fingerprint、`user_version`、columns/indexes/FK 任一不匹配都 fail closed。

开发 fixture 可通过明确的测试重建流程生成新 DB；真实控制 DB 不自动删除或重建。若未来已有需
保留的旧数据，必须另写 migration/repair RFC，保留原 DB、release/event history 和 identity tuple，
并把无法证明 gate commit 的旧 terminal/null-final state降级到人工复核，不能提升为 success。

## 6. 回归测试

必须先红后绿覆盖：

1. 九表 schema、strict/FK/CHECK/index/fingerprint、reopen、tamper、unknown old state fail closed；
2. claim 唯一性、same-key replay、different-hash conflict、created-only capability、跨实例/clone/Proxy rejection；
   same-boot concurrent same-key 只调用一次 adapter、第二个等待后 replay；exclusive section 内出现
   current-boot existing claim 立即 fatal；prior-boot recovery 零 adapter；
3. publish unclaimed domain_committed 的唯一 claim；reconcile 新 key 绑定同一 release/revision；
4. verified/mismatch/unknown 原子终结及每个 sub-write failpoint rollback；
5. 任一 rollback 后不存在 terminal readback + null finalResult；
6. abandoned claim recovery 零 adapter，immutable manual_review replay；
7. 同一 release 两次以上 reconcile 的 immutable attempt history 与 current projection；
8. full event graph、事件时间关系、latest-256 `eventsTruncated` 投影分离；
   terminal-only current readback、复合 FK、live-claim partial unique index、单次 clock 的精确字节相等；
   reconciliation/completion sequence 全局跨列互斥且每个 event 只服务一个 attempt 角色；
9. 两 service instance 共享 mutation barrier；DB-finalize/gate-commit gap 零受控 dispatch；
   reader→writer、writer→reader 与递归 writer 在等待前 fail-fast，adapter 不经 router 重入；
10. gate commit 或 post-adapter DB finalize 异常触发 fatal/unready，restart exact restore；
11. attempt/event/finalResult 敏感字段扫描。

最小验证命令：

```bash
npx vitest run tests/control-plane --pool=forks --no-file-parallelism --maxWorkers=1
npx vitest run tests/platform/sqlite-production-store.test.ts tests/e2e --pool=forks --no-file-parallelism --maxWorkers=1
npm run validate:schemas
npm run validate:agent-standards
npm run build:agent-pack
npm run typecheck
npm run lint
git diff --check
```

## 7. 回滚

实现未被 Service 使用前，可回滚 attempt 接口和九表预实现，但不得把旧分离写入口重新暴露给已
接线的 Service。Service 一旦依赖原子终结，回滚必须同时回滚 Service、startup recovery、activation
barrier 和 schema，并保留数据库副本；不得只删 attempt table 或把 completed finalResult 置空。

若运行期 gate commit 失败，只能 fail-stop 并按已验证 DB evidence 重启恢复；不能通过回滚内存 gate
继续服务，也不能编辑数据库伪造 readback。

## 8. 接受条件

本 RFC 只有在以下设计条件全部满足后才能从 draft 改为 accepted for implementation：

- 独立审查确认本设计闭合三个 crash gap，且没有扩大业务权威；
- 计划、repository interface、拟实现的 SQLite DDL/Fake TDD 批次和迁移/回滚要求互相一致；
- 注册前的 Agent standard/profile 变更经过检查，runtime-caller 仍不获得 CONTROL/Admin 内容；
- 文档明确本地 fixture 能力不等于生产资格。

设计接受可依据已审查的 schema/interface/DDL、红测清单与计划完成；它不以 Task 2/3 已经实现为
前置条件。RFC 接受只授权按本合同实现，不是实现验收。实现完成还必须另行满足 repository/Fake/SQLite 全绿、
schema/type/lint/diff check，以及 Service/activation wiring 对 fatal fence、restart restore 和
zero-second-adapter-call 的独立证明；未满足前不得称为 ready 或生产可用。
