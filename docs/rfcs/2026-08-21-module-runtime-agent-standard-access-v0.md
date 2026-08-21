---
standard_id: effective-rfc
version: 2026-08-21.v0
priority: 70
audience: developer,reviewer,operator
rule_ids: RFC-CHANGE-001
---

# RFC: Module Runtime 与 Agent Standard Access v0

- 状态：accepted for implementation on `codex/v2`; shared-contract promotion remains reviewable
- 日期：2026-08-21
- 影响范围：平台运行时、模块工具注册、Agent 只读上下文、构建与客户端适配示例
- 不改变：报价、关税、Zone、客户记录等业务权威边界；不连接生产系统

## 动机

当前 `main` 已有固定的 Phase 1 工具注册和 Streamable HTTP 传输，但模块边界仍由
`server/composition.ts` 手工拼接，Agent 只能依赖根目录 Markdown 和客户端自己的工作区
约定。这样会造成三类差距：模块没有统一的 manifest/lifecycle/lease，标准没有稳定的
机器入口，运行时调用方也没有安全的 profile/context 投影。

## v0 决策

1. 新增 `Module Runtime`，只支持启动时加载的静态可信模块。每个模块必须声明
   `module_id`、`version`、`risk_level`、依赖能力和工具贡献；运行时提供 capability
   registry、工具 catalog、registration lease、mount/unmount/close 生命周期。
2. 新增 `docs/agent/index.json` 作为权威注册表。选择 JSON 是为了复用 Node 22 和现有
   无额外依赖的构建链；JSON 是 YAML 1.2 的合法子集，后续需要 YAML 投影时不改变语义。
3. 标准文档使用稳定的 front matter 和规则 ID。构建器只读取注册表允许的文件，生成带
   `sha256`、规则优先级、profile audience 和 source refs 的
   `dist/standards/agent-standard-pack.json`；运行时不从 cwd 随意读取 Markdown。
4. 新增 Agent profile 与 resolver。profile 只能引用注册表中的 `standard_set`、
   `allowed_rule_ids` 和 `audience`；未知 profile、未知规则、路径越界和重复规则均失败闭合。
5. 新增只读 `system.agent_context.get`。输入只接受 allowlisted `profile_id` 和可选
   `module_id`；输出沿用现有五状态响应包络，内容为脱敏的标准片段、模块目录和版本证据。
6. 通过 MCP resources 暴露固定 URI：bootstrap、standards index、contract envelope、
   module catalog、agent profiles。资源内容来自构建时生成的 pack，不携带租户记录、凭据、
   原始路径或网络地址。
7. 现有 cargo/container 先以 trusted module adapter 接入 catalog；保留旧工具契约和
   handler 作为兼容边界，避免复制业务权威数据。其它领域后续按同一 adapter 迁移。

## 新增边界

- `docs/agent/**`：注册表、profile、workstream projection 和 bootstrap 元数据。
- `docs/standards/**`：模块与 Agent 访问规范的规范化文档。
- `schemas/agent/**`：注册表和 profile 的 Draft 2020-12 schema。
- `src/logistics_mcp/agent-context/**`：registry、resolver、pack builder、validation、CLI。
- `src/logistics_mcp/module-runtime/**`：manifest、capabilities、catalog、lease、host。
- `src/logistics_mcp/modules/**`：现有 cargo/container 的窄模块适配。
- `tests/agent-context/**`、`tests/module-runtime/**`：红测、契约和生命周期测试。

这些目录由本 RFC 新增的 platform/runtime ownership 管理；若后续需要改变现有
`docs/contracts/**` 的 envelope 或状态字段，必须另行 RFC，不在本次 v0 隐式修改。

## 兼容性

- 原有九个 Phase 1 工具名称、输入 schema、输出 envelope 和权限保持不变。
- `system.agent_context.get` 是新增 read-only control-plane tool；未配置 Agent pack 时
  返回 `unavailable`，不回退读取 cwd Markdown。
- 原有客户端配置保留，新增 `agent_context` 能力声明和资源 URI 说明；不把 token、租户或
  actor 写入示例文件。
- Module Runtime v0 不承诺运行中 hot-plug；manifest 版本冲突、能力缺失和重复工具名在
  mount 阶段拒绝启动。

## 安全与失败闭合

- 模块只能通过声明的 capability 访问平台服务，不得到任意 filesystem/network handle。
- Agent profile 是 allowlist，不接受调用方传入路径、glob、URL 或任意规则 ID。
- `system.agent_context.get` 不读取 tenant data；所有租户/actor 上下文仍由服务端注入，
  不信任工具输入中的身份字段。
- pack 中只允许相对路径、有限 audience 和脱敏摘要；日志不记录原始文档全文。
- 规则冲突按 `priority` 先高后低排序；同优先级且语义冲突时返回 blocked，不猜测合并。

## 迁移与回滚

1. 先发布注册表、schemas、标准 pack builder 和只读测试。
2. 再启用 Module Host，挂载 cargo/container adapter，比较 catalog 与旧 registry。
3. 最后在 HTTP server 中注册 Agent tool/resources，并更新客户端适配示例。
4. 回滚时将 `MCP_AGENT_CONTEXT_ENABLED=false` 或移除 pack，旧 Phase 1 注册路径仍可运行；
   不删除旧 handler 和契约。

## 验证

- `npm run validate:agent-standards`
- `npm run build:agent-pack`
- `npm run test:agent-context`
- `npm run test:module-runtime`
- `npm run validate:agent-adapters`
- `npm run typecheck`
- `npm test -- --pool=forks --poolOptions.forks.singleFork=true`
- `git diff --check`
