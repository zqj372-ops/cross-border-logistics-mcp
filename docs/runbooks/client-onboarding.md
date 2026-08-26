# Client onboarding

ChatGPT、Codex 和企业助手只使用同一远程 MCP endpoint：
`https://mcp.example.invalid/mcp`。`deploy/clients/codex.example.toml` 已按 OpenAI 当前
`[mcp_servers.<name>]` 格式编写，但仍使用假地址，必须由管理员替换并通过
`LOGISTICS_MCP_BEARER_TOKEN` 注入短期令牌。另两个 JSON 只是对接清单，
不是可导入的机器配置，也不包含真实 token。

OpenAI 当前说明：ChatGPT 桌面端、Codex CLI 和 IDE 扩展在同一 Codex 主机上
共享 MCP 配置；ChatGPT Work 网页则由工作区管理员安装包含远程 MCP 工具的
插件，不读取本地 Codex 配置。参考：
<https://learn.chatgpt.com/docs/extend/mcp?surface=cli>。

管理员必须先确认企业身份 provider、issuer、audience、tenant mapping、
Origin/Host allowlist、HTTPS gateway 和审计保留策略。租户、操作人、角色和会话
都由服务端校验令牌后注入，客户端配置不得提供或覆盖这些字段。

## 工具与状态

冻结的九个业务工具仍是：`cargo.calculate`、`container.plan_summary`、
`quote.canada_final_mile.calculate`、`quote.save_draft`、`customs.ca.search`、
`customs.ca.estimate`、`knowledge.search_curated`、`system.get_data_status`、
`review.create_task`。另外暴露一个只读控制面工具 `system.agent_context.get`，用于
allowlisted profile 的标准和模块上下文。不存在 `commit_operation`、send、publish、booking
或通用写工具。

固定资源为：`logistics://agent/bootstrap`、`logistics://standards/index`、
`logistics://contracts/envelope/current`、`logistics://modules/catalog`、
`logistics://agent/profiles`。运行时只读取不可变 Standard Pack；Pack 缺失时返回
`unavailable`，不回退到当前工作目录 Markdown。

客户端必须按统一 envelope 处理：

- `success`：展示版本、来源、trace 和 warnings；仍遵守 `sendable=false` 与
  `theoretical_only=true`。
- `needs_input`：把 blockers 转成字段问题；不能使用默认地址、重量、Zone、汇率或税率。
- `manual_review`：展示原因、来源和责任角色，交给人工复核；不能当作最终报价/税额。
- `unavailable`：展示权威源/版本不可用；不以搜索、旧数据、fixture 或模型估值替代。
- `blocked`：展示权限/Phase 1/安全策略拒绝；不改名重试或绕过网关。

## 接入 smoke

1. 管理员使用假 endpoint 和短期身份在 staging 完成 initialize，获取 tools/resources 列表，
   确认九个业务工具加一个只读 Agent 控制面工具，并读回五个固定资源。
2. 调用 `system.agent_context.get`，只使用 `runtime-caller` profile 和已注册模块 ID；
   核对 profile、规则优先级、Standard Pack hash 和 `unavailable`/`blocked` 失败闭合。
3. 调用 `system.get_data_status` 核对其已注册的数据源；该工具当前没有 RiskCustoms M2M
   认证上下文，不能作为 RiskCustoms readiness 证明。
4. 在批准的 staging context 中调用 `customs.ca.search`；由适配器内部完成带认证的
   `/api/m2m/status`→`/api/m2m/query`，并核对返回的 `ready`、`test_data`、release IDs 和 hashes。
5. 运行 cargo/quote 查询和一个 `needs_input` 负例；确认金额/重量带单位和版本。
6. 只在批准的 fixture/sandbox 中验证 `quote.save_draft` 与 `review.create_task` 的
   preview→approval→commit→readback；不得发送、发布、订舱或写生产。
7. 保存响应、审计 ID、工具版本和管理员批准记录；ChatGPT Work 插件和
   企业助手必须在 staging 通过身份、权限、审批和状态处理验收后再开放。
