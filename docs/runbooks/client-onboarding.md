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

已登记的十个工具是：`cargo.calculate`、`container.plan_summary`、
`quote.canada_final_mile.calculate`、`quote.create_pdf`、`quote.save_draft`、
`customs.ca.search`、`customs.ca.estimate`、`knowledge.search_curated`、
`system.get_data_status`、`review.create_task`。报价单工具当前不可用，正式连接未启用；
不存在 `commit_operation`、send、publish、booking 或通用写工具。

客户端必须按统一 envelope 处理：

- `success`：展示版本、来源、trace 和 warnings；仍遵守 `sendable=false` 与
  `theoretical_only=true`。
- `needs_input`：把 blockers 转成字段问题；不能使用默认地址、重量、Zone、汇率或税率。
- `manual_review`：展示原因、来源和责任角色，交给人工复核；不能当作最终报价/税额。
- `unavailable`：展示权威源/版本不可用；不以搜索、旧数据、fixture 或模型估值替代。
- `blocked`：展示权限/Phase 1/安全策略拒绝；不改名重试或绕过网关。

## 接入 smoke

1. 管理员使用既有示例地址和短期身份在 staging 获取工具列表，确认十个已登记工具及报价单工具的不可用状态。
2. 调用 `system.get_data_status`，核对 RiskCustoms `ready`、`test_data` 和 release IDs。
3. 运行 cargo/quote 查询和一个 `needs_input` 负例；确认金额/重量带单位和版本。
4. 只在批准的 fixture/sandbox 中验证写工具的 preview→approval→commit→readback；
   `quote.create_pdf` 仅验证不可发送的报价单结果和精确读回边界，不得发送、发布、订舱或写生产。
5. 保存响应、审计 ID、工具版本和管理员批准记录；ChatGPT Work 插件和
   企业助手必须在 staging 通过身份、权限、审批和状态处理验收后再开放。
