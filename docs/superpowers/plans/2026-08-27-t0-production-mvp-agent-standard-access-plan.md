# T0 确定性工具与 Agent 标准读取生产 MVP 计划

> 状态：实施前规划。本文不代表已获得生产发布资格，也不授权连接真实报价、关务、
> Freightcom、订舱、文档或客户系统。执行时必须从干净、已同步的 `main` 创建独立
> `codex/` 分支/worktree，不得把当前未提交的 Tenant Access 候选改动混入本计划。
>
> 文档关系：本文现在是
> `2026-08-27-t0-tenant-access-production-service-plan.md` 的 **T0 MCP Runtime 实现切片**。
> 服务拆分、长期 Key→短期 JWT、生产 Access Console、集中吊销和单区域 GO/NO-GO
> 以服务级总规划为准；本文不得被解释为已覆盖 Unified Access Gateway。

## 1. 目标

在不开放任何外部业务适配器和业务写操作的前提下，交付一个可审计、可回滚、可由
ChatGPT、Codex 和企业 Agent 调用的首个生产 MCP 范围：

1. `cargo.calculate`：货物体积、重量、体积重、分泡和计费重的确定性计算；
2. `container.plan_summary`：理论容量、运营目标、载重和装载顺序摘要；
3. `system.agent_context.get`：读取 allowlisted `runtime-caller` Agent 标准上下文；
4. 五个固定只读资源：bootstrap、标准索引、包络合同、模块目录和 Agent profile；
5. 企业短期 JWT、tenant/actor 服务端注入、RBAC、审计、幂等和 session fail-closed；
6. 单区域、受控流量、可观测、可备份恢复的生产部署。

本计划的成功标准不是“页面能打开”或“测试全绿”，而是固定 Git SHA 和镜像 digest 在
staging/生产完成身份、目录、计算、审计、备份、监控和回滚的确定性读回。

## 2. 当前已确认基线

截至规划日，仓库已经存在以下实现基础：

- `cargo`、`container`、`agent-access` 均为静态可信 T0 模块；
- `cargo.calculate`、`container.plan_summary` 已有严格输入/输出合同和确定性测试；
- `system.agent_context.get` 已从不可变 Standard Pack 读取 allowlisted profile；
- 运行时有五个固定 `logistics://` 资源，不读取任意 cwd Markdown；
- 生产组合有 JWKS/JWT、Origin/Host、审计、幂等、session binding 和 SQLite fail-closed；
- 当前生产组合仍会构建更宽的工具/模块目录，Agent Standard Pack 缺失也尚未成为 T0
  全局 readiness 阻断条件；
- 当前客户端示例仍列出报价、关务、Freightcom 和写工具，不是 T0 生产配置；
- Tenant/API Key 生产签发不属于本计划，第一版只使用企业短期 JWT。

因此，本计划不是重写 cargo/container/Agent Access，而是把已有能力收敛为一个结构上
只有 T0 的生产 profile，并补齐生产证据链。

## 3. 固定范围

### 3.1 生产工具 allowlist

`t0-v1` 生产 profile 只允许注册：

```text
cargo.calculate
container.plan_summary
system.agent_context.get
```

该 allowlist 必须在 MCP tool registration 之前生效，不得只依赖客户端
`enabled_tools`、JWT scope、Admin 页面隐藏或 adapter 返回 `unavailable`。

以下工具在 `t0-v1` 中必须同时满足“未注册、不可见、不可调用、无 adapter 初始化”：

```text
knowledge.search_curated
system.get_data_status
quote.canada_final_mile.calculate
quote.freightcom_ltl.preview
customs.ca.search
customs.ca.estimate
quote.save_draft
review.create_task
```

任何未知 production profile、空 profile 或 profile/目录不一致必须在监听前 fail closed。

### 3.2 固定 Agent 资源

```text
logistics://agent/bootstrap
logistics://standards/index
logistics://contracts/envelope/current
logistics://modules/catalog
logistics://agent/profiles
```

资源内容来自构建阶段生成并经过 reviewed descriptor 校验的
`dist/standards/agent-standard-pack.json`。运行时不得读取仓库 Markdown、任意路径、URL、
客户文件或客户端提交的资源位置。

### 3.3 明确不做

- 不连接 Quote、RiskCustoms、Freightcom、PDF、订舱或客户记录系统；
- 不开放 save、send、publish、booking、customs submit 或 generic commit；
- 不实现远程插件安装、任意代码加载、hot-plug 或 generation router；
- 不把 container summary 描述为 3D 装柜方案或现场装载承诺；
- 不把 Agent Standard Pack 或模块目录描述为业务数据/上游 readiness 权威；
- 不在本阶段开放生产 Admin POST、生产 API Key 签发或动态租户管理；
- 不以 fixture token、localhost UI、`/healthz` 或单元测试替代 staging 证据。

## 4. 目标架构

```text
ChatGPT / Codex / Enterprise Agent
                |
                | HTTPS + short-lived JWT
                v
Enterprise Gateway: TLS / WAF / rate limit / request ID
                |
                v
MCP t0-v1 production composition
  - verified tenant / actor / client / session
  - exact T0 exposure policy
  - audit / idempotency / session binding
  - immutable Agent Standard Pack
                |
       +--------+---------+
       |        |         |
       v        v         v
     cargo   container  agent-access
       T0       T0        T0
       |        |         |
       +---- no outbound network -----+
```

除企业 JWT 的 JWKS 读取外，T0 模块不得产生业务出站网络流量。T0 运行时不得读取
RiskCustoms/Freightcom secret，也不得构造这些 adapter。

## 5. Agent 标准读取协议

### 5.1 推荐调用顺序

每个新 MCP session 的客户端 smoke 和 Agent 引导按以下顺序：

1. 完成 MCP initialize；
2. 读取 `tools/list`，确认当前运行时只暴露三个 T0 工具；
3. 读取 `resources/list`，确认只暴露五个固定资源；
4. 读取 `logistics://agent/bootstrap`；
5. 调用 `system.agent_context.get({"profile_id":"runtime-caller"})`；
6. 按返回的五状态、单位、证据和理论边界决定是否调用 cargo/container；
7. 对 `needs_input` 向用户补问，对 `manual_review` 保留人工复核，不把
   `blocked`/`unavailable` 改写成成功。

### 5.2 安全原则

Agent 标准读取是引导和兼容协议，不是安全授权边界：

- 即使 Agent 没有先读取标准，服务端仍必须执行 Schema、RBAC、tenant、审计和 T0 边界；
- 不使用“Agent 已阅读”布尔值绕过服务端检查；
- `modules.catalog` 是设计目录，不是运行时可用性证明；当前可调用能力只以当前 session 的
  `tools/list` 和实际工具响应为准；
- `system.agent_context.get` 只允许 `runtime-caller`，未知/开发/审核 profile 固定 blocked；
- Standard Pack 缺失、hash 不符、descriptor 不符或 profile broaden 必须使 T0 production
  `/readyz` 为 503，并阻断 `/mcp`，而不是只让 Agent 工具局部 unavailable。

### 5.3 T0 runtime-caller profile

第一版 profile 只允许选择 `cargo` 和 `container` 模块。`freightcom-ltl` 可以继续存在于
开发注册表，但不得进入 T0 runtime-caller 的 allowed module set，也不得由 T0 客户端模板
列出。若此处需要改变已发布 Agent schema/资源字段，必须先提交 RFC；不得在实现中静默漂移。

## 6. 工作包与所有权

### WP0：冻结 T0 production profile 合同

所有权：任务 01 基线。

计划文件：

- 新建 `docs/rfcs/2026-08-XX-t0-production-profile-v1.md`；
- 更新相关产品/运行说明；
- 若公共 Agent schema 不变，不修改 `docs/contracts/**`；若需要新增字段，先单独接受 RFC。

RFC 必须固定：

- profile ID：`t0-v1`；
- 三个工具和五个资源的 exact set；
- 未列出工具在注册前被移除；
- Standard Pack 为 readiness 必需依赖；
- JWT claims、角色、scope 和 tenant 注入边界；
- 版本兼容、客户端迁移、回滚和测试命令。

退出条件：RFC 被接受，旧/新 `tools/list` 与失败行为有明确 JSON 示例。

### WP1：实现结构性的 T0 production composition

所有权：任务 02 平台。

预计文件：

- 新建 `src/logistics_mcp/server/production-profile.ts`；
- 修改 `src/logistics_mcp/server/composition.ts`；
- 修改 `src/logistics_mcp/server/start.ts`；
- 必要时修改 `src/logistics_mcp/server/tool-registry.ts`；
- 新建 `tests/platform/t0-production-exposure.test.ts`；
- 新建 `tests/e2e/t0-production-runtime.test.ts`。

RED 测试先证明当前生产组合错误地暴露非 T0 工具/模块，然后实现：

1. 生产启动必须显式选择受支持的不可变 profile；
2. `t0-v1` 只创建 cargo、container、agent-access ModuleDefinition；
3. 不创建 Freightcom/RiskCustoms/quote/review adapter；
4. definition 在注册前按 exact set 校验，缺少、多出、重复都阻断启动；
5. `/readyz` 检查 ModuleHost mounted、catalog exact match 和 Agent Pack trusted；
6. `/mcp` 在 readiness 未通过时返回固定、脱敏的 unavailable；
7. broad legacy scope 也不能恢复未注册工具；
8. 直接调用非 T0 名称不得进入 handler、adapter、audit domain success 或外部网络。

退出条件：官方 MCP SDK 完成 initialize，`tools/list` 精确等于三个名称，负例调用没有任何
非 T0 adapter 副作用。

### WP2：冻结 cargo 确定性向量和资源边界

所有权：任务 03 cargo。

预计文件：

- 扩充 `tests/cargo/**`；
- 只在失败测试证明必要时修改 `src/logistics_mcp/domains/cargo/**`。

必须覆盖：

- mm/cm/m、g/kg/lb 的精确转换；
- unit weight、piece weights、line total weight 三种互斥证据；
- density/divisor、分泡比例和 rounding rule 的显式版本；
- 大数量、高精度、小数边界、重复 source ref、未知字段；
- 缺重量/规则为 `needs_input`，证据冲突为 `manual_review`；
- 不出现金额、Zone、客户默认值、二进制 float 或隐式单位；
- trace 的每一步均可追溯到输入、规则版本和 source ref；
- 取消、超时和异常不得留下跨请求状态。

至少维护一组版本化 golden vectors，变更结果必须通过 RFC/版本升级，不得只改 fixture。

退出条件：golden vectors 在目标 Node 版本和容器镜像内得到完全一致的 decimal-string 输出。

### WP3：冻结 container 理论摘要和禁止空间承诺

所有权：任务 04 container。

预计文件：

- 扩充 `tests/container/**`；
- 只在失败测试证明必要时修改 `src/logistics_mcp/domains/container/**`。

必须覆盖：

- 物理容量、运营目标和 payload 三个独立限制；
- 超方、超重、目标超限、最少柜数和 bottleneck；
- 装载约束冲突、priority/FIFO、头尾冲突解释；
- 输入 line refs 与 CargoMetrics 数量完全匹配；
- 客户端不能覆盖 `theoretical_only=true`；
- coordinate、rotation、layout、center of mass、3D 等请求在计算前 blocked；
- 结果不包含坐标、角度、空间摆位或可执行现场承诺；
- golden vectors 的 trace、warning、blocker 和 source refs 可重复。

退出条件：对相同输入在目标 Node/镜像内输出稳定；所有 3D/现场承诺负例在 handler 前失败。

### WP4：生产化 Agent Standard Pack 和 T0 客户端流程

所有权：任务 02 Agent Context；客户端模板由任务 06 集成维护。

预计文件：

- 修改 `docs/agent/profiles/runtime-caller.json`；
- 若接受 RFC，更新 `docs/agent/index.json` 和 reviewed pack descriptor；
- 修改 `src/logistics_mcp/agent-context/**`；
- 新建 `tests/agent-context/t0-runtime-caller.test.ts`；
- 新建 `tests/e2e/t0-agent-bootstrap.test.ts`；
- 新建 `deploy/clients/codex.t0.example.toml`；
- 新建 `deploy/clients/chatgpt.t0.example.json`；
- 新建 `deploy/clients/enterprise-assistant.t0.example.json`；
- 新建 `tests/e2e/t0-client-config.test.ts`。

实现要求：

1. build 从 `docs/agent/index.json` 生成确定性 pack；
2. reviewed descriptor 必须由安全审核后的 pack bytes 更新，不能自动信任任意新 hash；
3. runtime 只读取固定 pack 路径并复核 bytes/hash/metadata；
4. T0 runtime-caller 仅允许 cargo/container，不返回开发者或管理员标准；
5. 五个资源固定、只读、大小有界，不含绝对用户路径、凭据或客户数据；
6. T0 客户端模板只列三个工具，token 只通过企业身份注入；
7. ChatGPT、Codex、企业助手分别完成 tools/resources/context/cargo/container smoke；
8. 客户端必须把五状态映射为提问、人工复核、不可用或阻断，不做模型 fallback。

退出条件：pack 可重复构建且 digest 固定；篡改、缺失、symlink、profile broaden 和未知资源全部
fail closed；三个客户端的 staging smoke 留有当前响应和 audit ID。

### WP5：生产身份、持久化和网络边界

所有权：任务 02 平台与任务 06 集成。

要求：

- 企业 IdP 提供 RS256/JWKS、固定 issuer/audience、15 分钟以内 token；
- claims 至少包含 tenant、actor、role/roles、scopes、client、session、iat、exp；
- 推荐给 T0 token 使用 exact `tool:<canonical-name>` scopes；结构性 T0 profile 仍是最终边界；
- TLS/WAF/限流在受批准企业网关完成，容器不直接发布公网端口；
- JWKS host 是 T0 唯一应用级出站 host；业务出站默认拒绝；
- audit、idempotency、session binding 使用持久 SQLite volume，权限 `0600`；
- SDK server/transport 保持进程内，路由必须按 `MCP_INSTANCE_ID` sticky；
- 记录备份、恢复、容量和文件完整性证据，不把 SQLite volume 当作已经具备 HA；
- 日志不记录货物描述全文、客户标识、token、完整输入或计算明细。

建议的初始内部服务目标，需由业务/运维 owner 最终确认：

- 月可用性 SLO：99.5%；
- HTTP p95：500 ms 以内，纯计算 handler p95：200 ms 以内；
- 审计持久化成功率：100%，失败即工具失败；
- RPO：15 分钟以内，RTO：60 分钟以内；
- 初始容量验收：50 并发、持续 10 分钟，无跨租户、无结果漂移、无未受控内存增长。

### WP6：部署、可观测、备份和回滚

所有权：任务 06 集成。

预计文件：

- 新建 `deploy/compose.t0.yml` 或受 RFC 约束的等价 profile；
- 新建 `deploy/env.t0.example`，只含假值；
- 更新 `deploy/README.md`；
- 新建 `docs/runbooks/t0-release.md`；
- 新建 `docs/runbooks/t0-rollback.md`；
- 新建 `tests/e2e/t0-release-gates.test.ts`。

门禁要求：

1. 镜像使用不可变 digest，记录 source SHA、lockfile hash、Node 版本和 Standard Pack digest；
2. CI 运行 target Node、全量测试、Schema、Agent 标准/adapter 校验、镜像构建；
3. 增加依赖、secret、SAST、容器漏洞、许可证、SBOM 和 provenance/attestation 检查；
4. orchestrator 路由使用 `/readyz`，不能只用 `/healthz`；
5. 配置 restart policy、CPU/内存限制、只读 root、non-root、cap drop 和 no-new-privileges；
6. 监控请求量、p50/p95/p99、五状态分布、认证拒绝、审计失败、readiness、重启和 SQLite 健康；
7. 告警至少覆盖 readiness 失败、认证异常增长、audit failure、磁盘空间和重启循环；
8. 在非空数据上做备份恢复演练，读回 session metadata/audit/idempotency 一致性；
9. 回滚固定到上一份已验证镜像 digest、配置和 Standard Pack digest；
10. 回滚后重复 tools/resources/context 和两个计算工具的 exact smoke。

退出条件：runbook 中所有证据槽位由实际执行结果填入，不保留“预计通过”。

## 7. RED → GREEN 实施顺序

严格按以下顺序执行，每一步小步提交：

1. `test: t0 production profile rejects the current broad catalog`；
2. `feat: add immutable t0 production exposure policy`；
3. `test: pin t0 cargo and container golden vectors`；
4. `fix/feat: close only demonstrated deterministic gaps`；
5. `test: require trusted Agent Pack for t0 readiness`；
6. `feat: narrow runtime-caller and t0 client adapters`；
7. `test: add t0 production SDK and negative adapter smoke`；
8. `chore: add t0 deployment and release gates`；
9. `docs: add t0 staging, release and rollback evidence`。

共享合同变化必须先单独 RFC/基线提交；不得把合同、平台、cargo、container、deploy 的改动
塞进一个提交。

## 8. 必须通过的验证矩阵

### 8.1 本地/CI

```bash
npm run validate:agent-standards
npm run build:agent-pack
npm run validate:agent-adapters
npm run test:agent-context
npm run test:module-runtime
npm exec vitest run tests/cargo tests/container --pool=forks --no-file-parallelism --maxWorkers=1
npm exec vitest run tests/platform/t0-production-exposure.test.ts tests/e2e/t0-production-runtime.test.ts tests/e2e/t0-agent-bootstrap.test.ts --pool=forks --no-file-parallelism --maxWorkers=1
npm run typecheck
npm run lint
npm run validate:schemas
npm test -- --run
npm run build
node apps/admin/self-check.mjs
npm audit --json
docker compose --env-file deploy/env.t0.example -f deploy/compose.t0.yml config
docker build -f deploy/Dockerfile .
git diff --check
```

命令不得并行运行会同时清理 `dist` 的 build/pack/test 任务。

### 8.2 staging exact smoke

必须使用官方 MCP SDK 或三个真实 Agent 客户端分别验证：

- `/healthz=200` 且 `/readyz=200`；
- `tools/list` 精确三个工具；
- `resources/list` 精确五个资源；
- bootstrap/context 的 pack/profile/source hash 与候选一致；
- cargo success、needs_input、manual_review 各一例；
- container success、needs_input、manual_review、3D blocked 各一例；
- 非 T0 工具不可见且不可调用；
- 过期 token、错误 issuer/audience、跨 tenant、错误 Origin/Host 全部拒绝；
- 每次工具调用有脱敏 audit ID，可从持久库读回；
- 重启后 session owner 不匹配失败闭合，重新 initialize 后恢复；
- 备份恢复后 health/readiness 和 exact smoke 重新通过；
- 回滚到上一 digest 后工具/资源/pack 仍完全匹配上一 verified profile。

## 9. 发布判定

### GO

仅当以下条件同时成立：

- 候选 commit 已合并到受保护 `main`，CI 对 exact SHA 全绿；
- 镜像 digest、Standard Pack digest、Node 版本和配置 hash 已记录；
- staging tools/resources/context/计算/审计/恢复/回滚全部 exact readback；
- 企业 IdP、TLS/WAF、限流、监控、告警、备份负责人已确认；
- 安全、运维、平台和业务 owner 明确批准；
- 生产 canary 只向批准租户开放三个 T0 工具。

### NO-GO

任一以下情况立即阻断：

- tools/list 出现任何非 T0 工具；
- Standard Pack 缺失、hash/descriptor/profile 不一致；
- cargo/container 相同向量在候选和镜像输出不一致；
- audit 写入失败但工具仍返回 success；
- 只有 `/healthz` 证据，没有 `/readyz` 和 Agent readback；
- 真实 endpoint、token、tenant mapping 或生产配置来自聊天、fixture 或示例文件；
- 备份/回滚未实际演练；
- 仍有未解决的跨租户、敏感日志、adapter 初始化或业务出站证据。

## 10. 建议排期

在企业 IdP、网关和 staging 基础设施已具备的假设下：

| 周次 | 交付 |
| --- | --- |
| 第 1 周 | WP0 RFC、T0 exposure RED/GREEN、目标 Node CI |
| 第 2 周 | cargo/container golden vectors、Agent Pack readiness、T0 客户端模板 |
| 第 3 周 | staging 部署、监控/告警、备份恢复、三客户端 smoke |
| 第 4 周 | 负载/长稳、故障演练、回滚、受控 canary |
| 缓冲 1 周 | 修复 staging 证据问题，不扩大范围 |

正常目标为 3–5 周。任何报价、关务、Freightcom、生产 API Key 或动态插件需求进入独立
后续里程碑，不得挤入 T0 上线范围。

## 11. 最终交付物

- 被接受的 T0 production profile RFC；
- 结构性只注册三个工具的生产 composition；
- cargo/container 版本化 golden vectors；
- trusted Agent Standard Pack 和 T0 runtime-caller profile；
- 三份 T0 Agent 客户端配置/接入清单；
- 目标 Node CI、镜像 digest、SBOM/扫描/attestation；
- staging exact smoke、负载、备份恢复和回滚证据；
- 生产 canary 与稳定窗口报告；
- 明确列出的后续 T1、API Key、Admin 和动态插件 backlog。
