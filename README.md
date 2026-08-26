# 跨境物流 MCP

> A thin, fail-closed control plane for logistics tools used by ChatGPT, Codex, enterprise assistants, and internal workbenches.

这是一个独立运行的 MCP 服务端平台：它负责 transport、身份与租户上下文、RBAC、Schema、审计、幂等、会话、状态包络和窄 API 适配；报价、关务、文档等业务系统继续拥有自己的业务权威。MCP 不复制报价、Zone、关税、客户记录或文档主表。

> [!IMPORTANT]
> 本 README 描述的是当前 checkout 的可核对边界，不把代码存在、fixture 通过、fake HTTP 测试或计划文档写成生产上线证明。当前未获生产资格的能力必须保持 unavailable、manual_review、blocked 或 needs_input。

## 先看结论

- cargo、container 是 MCP 内的本地确定性计算，负责 CBM、体积重、分泡、计费重和理论/运营装柜摘要。
- AI 负责理解意图、补齐输入、选择工具和解释结果；金额、税率、Zone、重量、容量、状态和版本由确定性代码或上游权威系统决定。
- Module Runtime v0 在启动时挂载静态可信模块，通过 manifest、capability、lease 和 catalog 暴露工具；远程安装、模型驱动写入和运行时 hot-plug 仍不是当前生产能力。
- Agent Standard Access v0 为不同 Agent 角色提供 allowlisted profile、Standard Pack、固定 MCP resources 和只读 system.agent_context.get。
- Admin control-plane v1 只管理当前已挂载模块的 inventory、preview、四眼审批、activation policy 和 runtime exact readback；它不加载任意代码，也不拥有报价、关务或客户数据。
- ready=false、版本缺失、响应冲突、超时和写后读回失败不会被 AI 或 fixture 静默补成 success。

## 一眼看懂：客户端如何进入受控工具

~~~mermaid
flowchart LR
  C["ChatGPT / Codex / 企业助手 / 内部工作台"] --> T["MCP transport\n身份 · tenant/RBAC · Schema\naudit · idempotency · session"]
  T --> H["Module Runtime v0\n静态可信模块 · capability · lease · catalog"]
  H --> L["本地确定性工具\ncargo · container"]
  H --> A["Agent Standard Access\nprofile · Standard Pack · MCP resources"]
  T --> X["窄适配器\nquote · RiskCustoms · knowledge · review/status"]
  X --> S["现有权威业务系统\n报价 · 关务 · 文档"]
  T -. "pending contract" .-> P["PDF / 文档 API"]
~~~

图中的“权威业务系统”仍拥有价格、关务规则、文档记录和业务状态；MCP 只保留必要的版本引用、snapshot ID、opaque handle、审计关联和写后读回证据。某个业务 API 故障只关闭依赖它的工具；身份、审计、session 或幂等等平台依赖缺失，才会阻断更大范围的生产入口。

### 三条不可越过的边界

1. success 必须有匹配的来源、版本和证据门禁；不能因为“有一个数”就代表可用。
2. ready=false、合同缺失、响应冲突、超时和读回失败保持 needs_input、manual_review、blocked 或 unavailable。
3. fixture、fake HTTP 和本地测试只证明隔离环境中的行为；它们不证明生产连接、生产数据或生产 readiness。

## 当前能力状态

| 能力 | 当前状态 | 可调用边界 | 下一门禁 / 证据 |
| --- | --- | --- | --- |
| Admin control-plane | control contracts、inventory/hash、SQLite identity marker、activation gate、register/preview/approval 与 UI/API 模型可见；完整 publish/reconcile、startup 接线和真实 HTTP exact readback 仍待并行最终回读 | 仅本地受控 fixture/loopback；生产 `POST /admin/api/v1/control/**` 固定 `blocked` | 显式 initializer/root、identity/tenant/schema/permission/lock continuity、不同 actor approval、publish 后 exact readback 和独立证据 |
| cargo.calculate / container.plan_summary | 本地确定性计算；返回单位、规则/数据版本、假设、warnings、blockers 和 trace | 可在 fixture/local composition 验证；container 是理论/可解释摘要，不是 3D 装柜承诺 | 继续保持契约、单位和重量证据约束 |
| quote.canada_final_mile.calculate | adapter 已实现并通过 fake HTTP/local 组合验证，但生产合同未获资格 | 生产路径保持 unavailable / fail-closed；不返回可发送报价 | 完成生产 API 合同、发布快照、staging 和 readback 验收 |
| customs.ca.search | 已有 status→query 和失败闭合；main 尚未注入生产组合 | 缺 M2M 认证合同、ready gate 或非测试 release 时不可用 | 服务 JWT、tenant mapping、M2M 限流/审计、非测试 staging 证据 |
| customs.ca.estimate | 尚无已核验生产 API 合同 | 固定 unavailable，不拼造税额 | 独立 estimate API、认证、版本和失败映射合同 |
| quote.save_draft / review.create_task | 生产写源未获资格 | 必须 preview → approval → commit → readback；当前不可生产写入 | 同一幂等键、审批、写后读回和目标系统合同 |
| PDF / 文档 | 未注册 | 不调用、不写入 | OpenAPI、认证、输入/输出、副作用和读回合同 |
| system.agent_context.get | Agent Standard Access v0 的只读上下文工具 | 仅返回注册表 allowlist 内的 profile/module/resource 上下文 | Standard Pack、profile、资源和 adapter 校验 |

> 代码存在、fixture 通过或计划已写入，不等于生产资格通过。

## 一次请求如何走

~~~mermaid
sequenceDiagram
  participant A as Agent client
  participant M as MCP server
  participant V as Schema/RBAC/session
  participant D as Deterministic tool or adapter
  participant S as Source system
  A->>M: initialize + tools/list/resources
  M->>V: verify token, tenant/actor, profile, permissions
  V-->>M: server-owned execution context
  A->>M: call tool with schema-valid input
  M->>D: invoke allowlisted handler
  alt local deterministic calculation
    D-->>M: result + units + versions + trace
  else approved upstream adapter
    D->>S: narrow request through outbound policy
    S-->>D: source response + readiness/version evidence
  else missing gate or conflicting evidence
    D-->>M: needs_input/manual_review/blocked/unavailable
  end
  M-->>A: envelope with status, sources, warnings, blockers, trace
~~~

进入工具前由服务端注入并校验 tenant/actor、token、profile、权限和请求 Schema。ready=false 必须原样保留，不能由 AI 或 fixture fallback 升级；写工具还必须经过 preview、approval、commit 和 readback。

统一响应包络只允许五种状态：success、needs_input、manual_review、blocked、unavailable。

### Admin control-plane 的固定边界

control state 只能由显式 initializer 建立，startup/runtime open 不隐式创建、修复、替换或删除。application root 必须由 assembly 明确提供，并固定派生以下路径：

```text
state_dir  = <application-root>/.runtime/mcp-instance-state
control_db = <state_dir>/control.sqlite
marker     = <state_dir>/control-identity.json
```

control DB、marker、root、`instance_id`、`management_tenant_id`、schema、permission 和 single-process SQLite lock 任一漂移，都在 listen/写入前 fail closed。发布流程固定为 preview → 不同 actor approval → publish → exact readback；`active_verified` 只是 runtime exact readback，不是 artifact signature 或 production qualification。未闭合的 pending/readback 必须进入 `manual_review`/`unavailable`，并由 operator-only reconcile 处理。

本地 Admin 页面只展示脱敏状态，回滚用语固定为“回滚到上一已读回版本（本地受控环境）”。fixture identity 只允许 loopback local。浏览器 password/token 只在内存中短暂存在，不进 URL、storage、cookie、日志或审计；生产 Admin POST 固定 blocked，不能靠环境变量打开。

## Agent 调用适配

Agent 适配是“客户端如何接入同一事实源和安全边界”，不是为每个客户端复制一套业务规则。

~~~mermaid
flowchart TB
  R["docs/agent/index.json\n标准 · profile · module · resource"] --> P["runtime-caller profile\n固定上下文范围"]
  P --> G["system.agent_context.get\n只读 allowlisted context"]
  G --> Q["固定 MCP resources\nbootstrap · standards · contracts · catalog · profiles"]
  Q --> C["ChatGPT / Codex / 企业助手\n各自 transport/auth 模板"]
  C --> W["同一工具目录与统一 envelope\n客户端不改变权威边界"]
~~~

仓库提供三份客户端模板：

| 客户端表面 | 模板 | Transport / auth 边界 | 重要限制 |
| --- | --- | --- | --- |
| ChatGPT Work | [deploy/clients/chatgpt.example.json](deploy/clients/chatgpt.example.json) | 由工作区管理员安装远程 MCP 插件；企业短期身份令牌由插件与企业身份平台配置 | 管理员接入清单，不可直接导入 |
| Codex | [deploy/clients/codex.example.toml](deploy/clients/codex.example.toml) | MCP URL；LOGISTICS_MCP_BEARER_TOKEN 由企业身份平台注入；写工具审批模式为 writes | 使用前替换示例地址，不把 token 写入配置文件 |
| 企业助手 | [deploy/clients/enterprise-assistant.example.json](deploy/clients/enterprise-assistant.example.json) | Streamable HTTP；Bearer 短期令牌由企业身份平台提供 | 企业助手接入清单，不可直接导入 |

三个模板都指向 runtime-caller profile、固定资源 URI 和 allowlisted tools。客户端不能提交 tenant/actor 身份、上游 token、任意 URL、密码或 secret；写工具仍需审批。

当前 Agent 注册表包含 8 个标准、5 个 profile、3 个可信模块和 5 个固定 MCP resources。机器入口是 [docs/agent/index.json](docs/agent/index.json)，上下文工具是 system.agent_context.get。

## 工具与契约

当前 Phase 1 有九个业务工具，另有一个 Agent 上下文工具：

| 类别 | 工具 |
| --- | --- |
| 货物与装柜 | cargo.calculate、container.plan_summary |
| 报价 | quote.canada_final_mile.calculate、quote.save_draft |
| 关务 | customs.ca.search、customs.ca.estimate |
| 状态与知识 | system.get_data_status、knowledge.search_curated |
| 人工复核 | review.create_task |
| Agent 上下文 | system.agent_context.get |

必须先读：

- [业务模块开发与 MCP 热插拔集成规范](MODULE_DEVELOPMENT_STANDARD.md)：Module Contract、风险等级、能力注入、工具命名、回滚和交付物。
- [统一响应包络](docs/contracts/envelope.md)：状态、来源、警告、阻断、计算 trace 和审计字段。
- [工具目录](docs/contracts/tool-catalog.md)：工具边界、权限、Schema、失败状态和生产资格。
- [权威矩阵](docs/contracts/authority-matrix.md)：本地计算、Quote API、RiskCustoms API 和文档系统的权威归属。
- [Schema 目录](docs/contracts/schemas/) 与 [示例目录](docs/contracts/examples/)：Draft 2020-12 契约和结构化样例。
- [Agent 标准注册表](docs/agent/index.json)：标准、规则、profile、模块和固定资源的机器入口。

契约不可变边界：

- 默认使用 Draft 2020-12 Schema，additionalProperties 显式为 false；扩展进入版本化或 extensions 命名空间。
- 金额使用 decimal string + ISO 4217 三位币种；重量、长度、体积和数量带单位。
- 结果保留规则/数据版本、source refs、assumptions、warnings、blockers 和 calculation trace。
- unit_weight、piece_weights、line_total_weight 是互斥重量证据模式；证据不足必须补输入或人工复核。
- 生产写工具使用服务端注入的 tenant/actor、idempotency_key、preview/approval/commit 和成功前的写后读回。

## Quick Start：本地隔离演示

需要 Node.js >=22.13.0。

~~~bash
npm ci
npm run init:control-fixture
npm run start:fixture
~~~

`npm run init:control-fixture` 是一次显式的本地 control-state 初始化；必须先成功执行，startup 不会隐式创建或修复 control DB/marker。`start:fixture` 随后构建真实编译产物，再以 fixture 模式启动本地服务。另开一个终端执行：

~~~bash
npm run verify:runtime
~~~

本地演示入口：

| 地址 | 用途 | 边界 |
| --- | --- | --- |
| http://127.0.0.1:8080/admin/ | 中文脱敏 Admin 快照/本地控制面入口 | 只展示当前进程的 fixture/运行时信息；回滚文案为“回滚到上一已读回版本（本地受控环境）”，不代表生产控制台 |
| http://127.0.0.1:8080/admin/api/v1/control/state | control state read-only endpoint（若当前 assembly 已接线） | loopback fixture；完整写链路与 exact readback 仍待最终回读 |
| http://127.0.0.1:8080/mcp | MCP Streamable HTTP 入口 | 本地假 token 为 local-fixture-token |
| http://127.0.0.1:8080/readyz | readiness 观察 | fixture 模式保持 503/fixture_mode_not_production_ready，这是预期结果 |

演示模式只绑定 127.0.0.1，不会连接生产数据库、服务器或外部业务仓库；?fixture=1 只用于完整界面演示。

提交前的常用验证：

~~~bash
npm test
npm run typecheck
npm run lint
npm run validate:schemas
npm run validate:agent-standards
npm run validate:agent-adapters
npm run build
npm run verify:runtime
git diff --check
~~~

这些命令证明的是当前 checkout 的编译、契约、Agent 资源、fixture 和隔离测试证据；它们不替代生产 endpoint、认证、发布快照、staging、出站策略和读后写回验收。

## 目录地图

~~~text
src/logistics_mcp/
├── platform/        tenant/actor、RBAC、envelope、audit、幂等、session、契约校验
├── server/          HTTP/MCP transport、工具注册、组合注入、production token verifier
├── module-runtime/  静态可信 Module Host、capability、lease、catalog
├── modules/         cargo、container、Agent Access 的 module contribution
├── agent-context/   registry、profile resolver、Standard Pack、MCP context 和 client adapters
├── domains/         cargo、container、quote、customs、knowledge、status、review 领域逻辑
└── adapters/        Quote/RiskCustoms/knowledge/status/review 的窄适配与 fixture ports

apps/admin/           中文脱敏只读 Admin 原型与 fixture 自检
deploy/               Docker、Compose、环境样例、客户端接入模板和 release 脚本
docs/contracts/       统一包络、工具目录、权威矩阵、Schema 和示例
docs/agent/           标准注册表、profile 和当前 workstream
docs/standards/       Agent、Module Runtime、平台契约和发布适配规范
docs/runbooks/        接入、发布、回滚、安全门禁和集成交接
tests/                platform、module-runtime、agent-context、domains、adapters、e2e
~~~

## 安全与生产边界

- 生产运行时由服务端注入 tenant/actor 和上游身份映射；客户端不能提交 token、base URL、密码或跨租户上下文。
- control-plane 的 application root、control DB、marker、management tenant、schema 和 single-process lock 必须通过显式 initializer/兼容门建立并连续核对；startup 不隐式 create/repair。
- 发布/回滚只操作已挂载模块的 activation policy；回滚通过新 revision 恢复上一份已读回 profile，不修改 target release 或事件历史。pre-control-plane image 不是 managed rollback target。
- 出站 URL 必须经过服务端 allowlist；不允许客户端选择任意上游地址、凭据 URL、重定向绕过或私有网络目标。
- 日志默认不写客户地址、报价明细、税务材料全文、原始聊天和凭证，使用 opaque handle、hash 和脱敏摘要。
- Admin 浏览器 password/token 只在内存中短暂存在，不写 URL、local/session storage、cookie、持久化 DOM、服务日志或 audit event。
- ready=false 的 RiskCustoms 结果只能进入 unavailable 或 manual_review；AI 不得把候选补成 confirmed，也不得补造税率。
- 报价和关务数据的权威仍在既有系统；MCP 不在本地建立价格、Zone、关税或客户记录主表。
- 组合测试通过不等于生产 API 获准启用；生产资格还需要真实合同、认证、tenant mapping、版本/发布证据、staging 读回和安全发布门禁。

## 深入阅读

### 产品与平台

- [产品实现说明](docs/product/2026-08-11-cross-border-logistics-mcp-product-implementation.md)
- [后台控制台说明](docs/product/admin-console.md)
- [Module Runtime + Agent Standard Access RFC](docs/rfcs/2026-08-21-module-runtime-agent-standard-access-v0.md)
- [Module Runtime + Agent Standard Access 实施计划](docs/superpowers/plans/2026-08-21-module-runtime-agent-access-plan.md)
- [API-first 适配实施计划](docs/superpowers/plans/2026-08-12-api-first-integration-plan.md)

### Agent 与发布

- [Agent bootstrap 标准](docs/standards/agent-bootstrap.md)
- [Agent Access v0 标准](docs/standards/agent-access-v0.md)
- [Module Runtime v0 标准](docs/standards/module-runtime-v0.md)
- [平台契约标准](docs/standards/platform-contracts.md)
- [发布 Agent adapter 标准](docs/standards/release-agent-adapters.md)
- [客户端接入 runbook](docs/runbooks/client-onboarding.md)
- [发布 runbook](docs/runbooks/release.md)
- [安全门禁 runbook](docs/runbooks/security-gates.md)
- [回滚 runbook](docs/runbooks/rollback.md)
- [集成交接 runbook](docs/runbooks/integration-handoff.md)

## 当前明确未完成的能力

以下不是 README 遗漏，而是当前边界：

- quote 生产调用保持关闭，未将本地 Zone/价格/规则或地图/聊天参考价当作权威。
- RiskCustoms 生产 M2M 认证、tenant mapping、非测试 release 和 staging 证据未完成前，不注入生产组合。
- customs.ca.estimate 没有已核验生产 API 合同，不在本地拼造税额。
- PDF/文档工具未注册；没有完整 API、副作用和写后读回合同前不启用。
- quote.save_draft 和 review.create_task 的生产写源仍需要审批、幂等和读回合同；不会发送、发布、订舱或覆盖既有记录。
- Admin control-plane 的 publish/reconcile、startup initializer/store/API 完整接线和真实 HTTP exact readback 仍需并行完成后重新回读；在此之前生产 Admin POST 固定 blocked，不能把本地 fixture 当作上线。

任何能力从 pending/disabled/unavailable 进入生产，都必须沿现有 RFC、契约、runbook 和发布门禁完成验证，而不是只更新 README。
