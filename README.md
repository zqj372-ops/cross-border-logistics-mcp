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
- `t0-v1` production composition 在注册前把目录结构性收敛为 cargo、container、agent-access 三个静态模块、三个工具和五个固定资源；非 T0 handler/adapter 不构造。
- Admin control-plane v1 只管理当前已挂载模块的 inventory、preview、四眼审批、activation policy 和 runtime exact readback；它不加载任意代码，也不拥有报价、关务或客户数据。
- Tenant Access v1 在独立 store 中管理租户接入元数据与机器凭证；完整 Key 只显示一次，只保存带盐 hash、前缀和末四位。生产客户端必须先通过统一凭证网关把长期 Key 换成短期 JWT，再调用现有 MCP JWT 入口。
- ready=false、版本缺失、响应冲突、超时和写后读回失败不会被 AI 或 fixture 静默补成 success。

## 一眼看懂：客户端如何进入受控工具

~~~mermaid
flowchart LR
  C["ChatGPT / Codex / 企业助手 / 内部工作台"] --> G["企业 IdP / 统一凭证网关\nAPI Key -> 短期 JWT"]
  G --> T["MCP transport\nJWT 身份 · tenant/RBAC · Schema\naudit · idempotency · session"]
  T --> H["Module Runtime v0\n静态可信模块 · capability · lease · catalog"]
  H --> L["本地确定性工具\ncargo · container"]
  H --> A["Agent Standard Access\nprofile · Standard Pack · MCP resources"]
  T -. "fixture / 后续独立 profile；不属于 t0-v1" .-> X["窄适配器\nquote · RiskCustoms · knowledge · review/status"]
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
| T0 MCP Runtime | **仓库实现与本地测试候选**：`t0-staging`/`t0-v1` 只构造 3 个静态模块、3 个工具和 5 个资源；模块 descriptor 同时绑定工具合同标识，Agent Pack/catalog 漂移和非 T0 adapter 注入失败闭合 | 只接受短期 RS256 JWT；JWKS 是唯一应用级出站 host；生产目录不含报价、关务、Freightcom 或写工具 | 真实 Edge/JWKS/持久库、staging exact smoke、镜像 digest 和真实演练仍待完成，当前仍是 NO-GO |
| Unified Access Gateway / Access Console | **provider-neutral 候选已写入**：closed Schema、长期 Key→短 JWT、精确 T0 scope、RS256/JWKS 当前/前一 key、本地 synthetic 互操作、审计失败闭合和窄 Console 已有本地测试；production assembly 会拒绝缺失或 synthetic provider | synthetic 仅限 local contract test；MCP 仍拒绝长期 Key；Console 只呈现租户、客户端、Key、三个工具权限和 operation readback | real IdP、KMS/HSM、托管 DB、共享限流、集中审计/吊销、生产管理 API 和真实 Gateway 部署均待适配验证 |
| Admin control-plane | **已本地验证（fixture HTTP）**：register → preview → 不同 actor approval → publish → activation `active_verified` 与 exact readback；同一 application root 重启后恢复已读回状态；prior-boot 未完成 attempt 在 listen 前收敛为 `unknown/manual_review`，未决 release 仍使启动 fail-closed | 仅本地受控 fixture/loopback；control POST 的 fixture 流程可走 `/packages/register`、`/deployments/preview`、`/approvals`、`/deployments/publish`、`/deployments/reconcile`；生产所有管理 POST 固定 HTTP 403 | 生产身份、多实例、制品签名/attestation、Deployment Evidence 和生产资格仍未上线；未决 release 只能由 operator reconcile，不把本地 readback 当生产证明 |
| Tenant Access / API Key | **已本地验证（fixture HTTP + loopback MCP 诊断链路）**：租户创建/暂停、T0 工具精确授权、一次性签发、功能调整轮换、幂等重放 withheld、吊销、到期和脱敏 state | 仅 loopback fixture 可用 `lmcpk_...` 直连诊断；凭证固定 `service` 角色，`tools/list` 只暴露 `cargo.calculate`、`container.plan_summary`、`system.agent_context.get`；生产 MCP 实例只接受短期 JWT | 生产统一凭证网关、企业 IdP、TLS 网关、KMS/Secret Manager、限流、审计、集中吊销、备份恢复、负载、告警和回滚演练仍未完成；正式报价/关务/Freightcom/业务写操作不开放 |
| cargo.calculate / container.plan_summary | **已本地验证**：本地确定性计算，返回单位、规则/数据版本、假设、warnings、blockers 和 trace | 可在 fixture/local composition 验证；container 是理论/可解释摘要，不是 3D 装柜承诺 | 继续保持契约、单位和重量证据约束 |
| quote.canada_final_mile.calculate | **已本地验证（fake HTTP/local）**，但生产合同未获资格 | 生产路径保持 `unavailable` / fail-closed；不返回可发送报价 | 完成生产 API 合同、发布快照、staging 和 readback 验收 |
| customs.ca.search | **已本地验证（fake HTTP/local）**：M2M status→query、服务端有界 secret-file、双 host allowlist、本地 tenant 精确白名单和发布身份失败闭合；生产工厂默认 disabled，仍未获生产资格 | 只有显式启用且 endpoint、专用/全局 host allowlist、tenant allowlist、secret 文件全部有效时才装配；`ready=false`、测试数据或发布身份冲突保持 `unavailable` / `manual_review` | 上游 Draft 候选合入、真实 endpoint/Bearer 与 token-to-tenant mapping、非测试 release、staging status→query 与脱敏工具读回 |
| customs.ca.estimate | **生产未上线**；尚无已核验生产 API 合同 | 固定 `unavailable`，不拼造税额 | 独立 estimate API、认证、版本和失败映射合同 |
| quote.freightcom_ltl.preview | **fixture/manual_review**：T1 静态模块已登记，固定测试 host 的 POST `/rate` → GET `/rate/{request_id}` 轮询和 Schema/状态边界已有本地/fake HTTP 验证；完成结果固定 `manual_review`、`sendable=false`、`bookable=false`、`authoritative=false` | 仅显式测试开关下的 fixture/测试路径；不做 FX、不保存、不发送、不订舱；生产 Freightcom adapter 代码级禁用 | 测试凭证/真实外部调用的独立证据、正式生产合同、发布与 readiness 仍未完成；测试结果不能成为正式报价 |
| quote.save_draft / review.create_task | **生产未上线**；生产写源未获资格 | 必须 preview → approval → commit → readback；当前不可生产写入 | 同一幂等键、审批、写后读回和目标系统合同 |
| PDF / 文档 | **未注册 / 生产未上线** | 不调用、不写入 | OpenAPI、认证、输入/输出、副作用和读回合同 |
| system.agent_context.get | **已本地验证** Agent Standard Access v0 的只读上下文工具 | 仅返回注册表 allowlist 内的 profile/module/resource 上下文 | Standard Pack、profile、资源和 adapter 校验 |

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

本地 Admin 页面只展示脱敏状态，回滚用语固定为“回滚到上一已读回版本（本地受控环境）”。fixture identity 只允许 loopback local。浏览器 password/token 只在内存中短暂存在，不进 URL、storage、cookie、日志或审计；生产 Admin POST 固定返回 HTTP 403 与 `status=blocked`，不能靠环境变量打开。

Tenant Access 独立使用 `.runtime/mcp-tenant-access/access.sqlite`，不向模块控制 DB 加表。管理员在页面只配置租户、Key metadata 和当前 T0 内置工具权限；调整功能通过轮换完成，旧 Key 原子吊销，新 Key 进入 `pending_delivery`。只有安全交付确认并精确读回同一 `operation_id`、新凭证和工具清单后，loopback fixture 才可认证；`tools/list` 只返回被授权工具。租户暂停、凭证到期/轮换/吊销后立即认证失败。客户端不能提交 `tenant_id`、scope 或工具覆盖签发绑定，页面动作只服从服务端 `allowed_actions`。生产不接受长期 Key 直连 MCP 实例，必须经统一凭证网关换短期 JWT 后进入现有 JWT verifier。

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
| Codex | [deploy/clients/codex.example.toml](deploy/clients/codex.example.toml) | MCP URL；LOGISTICS_MCP_BEARER_TOKEN 由企业身份平台注入；只声明三个 T0 工具 | 使用前替换示例地址，不把 token 写入配置文件 |
| 企业助手 | [deploy/clients/enterprise-assistant.example.json](deploy/clients/enterprise-assistant.example.json) | Streamable HTTP；Bearer 短期令牌由企业身份平台提供 | 企业助手接入清单，不可直接导入 |

三个模板都指向 runtime-caller profile、固定资源 URI 和 allowlisted tools。客户端不能提交 tenant/actor 身份、上游 token、任意 URL、密码或 secret；写工具仍需审批。

当前 Agent 注册表包含 13 个标准、5 个 profile、4 个登记模块和 5 个固定 MCP resources；`runtime-caller` 只投影 cargo、container、agent-access 三个 T0 模块。机器入口是 [docs/agent/index.json](docs/agent/index.json)；构建产物为 `dist/standards/agent-standard-pack.json`，运行时只读取该 pack；上下文工具是 `system.agent_context.get`。

## 工具与契约

生产 `t0-v1` 只注册下表前三项。其余 Phase 1/T1 工具继续保留在源码和 fixture 回归轨道，
但不属于 T0 生产目录：

| 发布边界 | 类别 | 工具 |
| --- | --- | --- |
| `t0-v1` | 货物 | cargo.calculate |
| `t0-v1` | 装柜理论摘要 | container.plan_summary |
| `t0-v1` | Agent 上下文 | system.agent_context.get |
| fixture/后续独立发布 | 报价 | quote.canada_final_mile.calculate、quote.save_draft |
| fixture/后续独立发布 | 关务 | customs.ca.search、customs.ca.estimate |
| fixture/后续独立发布 | 状态与知识 | system.get_data_status、knowledge.search_curated |
| fixture/后续独立发布 | 人工复核 | review.create_task |
| fixture 测试 | Freightcom 测试预览 | quote.freightcom_ltl.preview |

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
npm run validate:schemas
npm run validate:agent-standards
npm run validate:agent-adapters
npm run test:access-gateway
npm run build
npm run init:control-fixture
npm run start:fixture
~~~

`docs/agent/index.json` 是 Agent 标准的机器入口；`validate:agent-standards` 校验它及 allowlist，`validate:agent-adapters` 校验三份客户端模板和固定资源，`build` 生成真实 runtime bundle 与 `dist/standards/agent-standard-pack.json`。`npm run init:control-fixture` 本身会先 build，随后显式初始化 control state、独立 Tenant Access state 和独立 Plugin Config state；startup 不会隐式创建、覆盖或修复它们。旧 checkout 已有 control state 但缺少后两者时，分别只运行一次 `npm run init:tenant-access-fixture` 与 `npm run init:plugin-config-fixture`。`start:fixture` 再以 fixture 模式启动本地服务。若只演示 Freightcom 测试模块，可用 `npm run start:freightcom-test-mcp` 替代 `start:fixture`；该路径仍只产生人工复核结果，不具生产资格。详细步骤见 [Tenant 与 API Key 本地演示 runbook](docs/runbooks/tenant-api-key-fixture.md)。另开一个终端执行：

~~~bash
npm run verify:runtime
~~~

本地演示入口：

| 地址 | 用途 | 边界 |
| --- | --- | --- |
| http://127.0.0.1:8080/admin/ | 中文脱敏 Admin 快照/本地控制面入口 | 只展示当前进程的 fixture/运行时信息；回滚文案为“回滚到上一已读回版本（本地受控环境）”，不代表生产控制台 |
| http://127.0.0.1:8080/admin/?fixture=1#tenant-access | 租户与 API Key 本地演示 | 完整 Key 只显示一次；只配置 T0 内置工具权限；确认安全保存并精确读回 operation 后才可在 loopback fixture 调用，生产管理 POST 固定阻断 |
| http://127.0.0.1:8080/admin/api/v1/access/state | Tenant Access 脱敏状态 | 返回租户、凭证前缀/末四位、交付/有效状态、允许动作和最近 operation，不返回完整 Key |
| http://127.0.0.1:8080/admin/api/v1/control/state | control state read-only endpoint | loopback fixture；可读回 inventory、activation、preview/approval、release history 和 exact readback |
| `/admin/api/v1/control/packages/register` 等 control POST | fixture-only 的登记、preview、审批、publish/reconcile API | fixture 可验证写后读回；生产对应管理 POST 固定 HTTP 403，不连接生产 |
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
apps/access-console/  Unified Access Gateway 的窄租户接入前端候选
services/access-gateway/ provider-neutral Key exchange、RS256/JWKS 与生产 fail-closed assembly
deploy/               Docker、Compose、环境样例、客户端接入模板和 release 脚本
docs/contracts/       统一包络、工具目录、权威矩阵、Schema 和示例
docs/agent/           标准注册表、profile 和当前 workstream
docs/standards/       Agent、Module Runtime、平台契约和发布适配规范
docs/runbooks/        接入、发布、回滚、安全门禁和集成交接
tests/                platform、module-runtime、agent-context、domains、adapters、e2e
~~~

## 安全与生产边界

- 生产运行时由服务端注入 tenant/actor 和上游身份映射；客户端不能提交 token、base URL、密码或跨租户上下文。
- 长期 API Key 不直接长期访问每个 MCP 实例；生产路径必须由企业 IdP/TLS 网关保护的统一凭证网关完成 KMS/Secret Manager 校验、限流、审计和集中吊销，再签发短期 JWT 调用现有 `/mcp`。
- RiskCustoms M2M 凭据只允许由部署系统挂载的有界普通 secret 文件提供；专用 host、全局出站 allowlist 与本地 tenant 精确白名单必须同时通过，默认不启用，也不回退到浏览器 Cookie、Turnstile 或匿名查询；本地 tenant 白名单不替代上游授权映射。
- control-plane 的 application root、control DB、marker、management tenant、schema 和 single-process lock 必须通过显式 initializer/兼容门建立并连续核对；startup 不隐式 create/repair。
- 发布/回滚只操作已挂载模块的 activation policy；回滚通过新 revision 恢复上一份已读回 profile，不修改 target release 或事件历史。pre-control-plane image 不是 managed rollback target。
- 出站 URL 必须经过服务端 allowlist；不允许客户端选择任意上游地址、凭据 URL、重定向绕过或私有网络目标。
- 日志默认不写客户地址、报价明细、税务材料全文、原始聊天和凭证，使用 opaque handle、hash 和脱敏摘要。
- Admin 浏览器 password/token 只在内存中短暂存在，不写 URL、local/session storage、cookie、持久化 DOM、服务日志或 audit event。
- ready=false 的 RiskCustoms 结果只能进入 unavailable 或 manual_review；AI 不得把候选补成 confirmed，也不得补造税率。
- 报价和关务数据的权威仍在既有系统；MCP 不在本地建立价格、Zone、关税或客户记录主表。
- 组合测试通过不等于生产 API 获准启用；生产资格还需要真实合同、认证、tenant mapping、版本/发布证据、staging 读回和安全发布门禁。控制面 fixture 的 `active_verified` 只表示当前本地 runtime exact readback；它不是制品签名、生产授权或业务 API readiness。
- 单区域上线前必须完成备份恢复、负载测试、告警演练和回滚演练；未完成前只能声明本地 fixture 已验证。

## 深入阅读

### 产品与平台

- [产品实现说明](docs/product/2026-08-11-cross-border-logistics-mcp-product-implementation.md)
- [后台控制台说明](docs/product/admin-console.md)
- [Module Runtime + Agent Standard Access RFC](docs/rfcs/2026-08-21-module-runtime-agent-standard-access-v0.md)
- [T0 Production Profile RFC](docs/rfcs/2026-08-27-t0-production-profile-v1.md)
- [Credential Exchange RFC](docs/rfcs/2026-08-27-credential-exchange-v1.md)
- [Module Runtime + Agent Standard Access 实施计划](docs/superpowers/plans/2026-08-21-module-runtime-agent-access-plan.md)
- [T0 租户接入服务总规划](docs/superpowers/plans/2026-08-27-t0-tenant-access-production-service-plan.md)
- [API-first 适配实施计划](docs/superpowers/plans/2026-08-12-api-first-integration-plan.md)

### Agent 与发布

- [Agent bootstrap 标准](docs/standards/agent-bootstrap.md)
- [Agent Access v0 标准](docs/standards/agent-access-v0.md)
- [Module Runtime v0 标准](docs/standards/module-runtime-v0.md)
- [平台契约标准](docs/standards/platform-contracts.md)
- [发布 Agent adapter 标准](docs/standards/release-agent-adapters.md)
- [客户端接入 runbook](docs/runbooks/client-onboarding.md)
- [T0 单区域发布 runbook](docs/runbooks/t0-release.md)
- [T0 单区域回滚 runbook](docs/runbooks/t0-rollback.md)
- [发布 runbook](docs/runbooks/release.md)
- [安全门禁 runbook](docs/runbooks/security-gates.md)
- [回滚 runbook](docs/runbooks/rollback.md)
- [集成交接 runbook](docs/runbooks/integration-handoff.md)

## 当前明确未完成的能力

以下不是 README 遗漏，而是当前边界：

- quote 生产调用保持关闭，未将本地 Zone/价格/规则或地图/聊天参考价当作权威。
- RiskCustoms 生产 M2M 工厂虽已接入，但默认 disabled；在真实认证、tenant mapping、非测试 release 和 staging 读回完成前，部署配置必须保持关闭，不能把本地/fake HTTP 证据写成生产联通。
- customs.ca.estimate 没有已核验生产 API 合同，不在本地拼造税额。
- PDF/文档工具未注册；没有完整 API、副作用和写后读回合同前不启用。
- quote.save_draft 和 review.create_task 的生产写源仍需要审批、幂等和读回合同；不会发送、发布、订舱或覆盖既有记录。
- Admin control-plane 的 fixture HTTP publish/approval/activation、exact readback、同 root 重启恢复和 prior-boot interruption 的 fail-closed 收敛已有测试证据；未决 release 仍不能自动恢复为 active，生产 Admin POST 固定 HTTP 403，控制面也未取得生产资格。

任何能力从 pending/disabled/unavailable 进入生产，都必须沿现有 RFC、契约、runbook 和发布门禁完成验证，而不是只更新 README。
