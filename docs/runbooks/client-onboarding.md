# Client onboarding

ChatGPT、Codex 和企业助手只使用同一远程 MCP endpoint：
`https://mcp.example.invalid/mcp`。仓库中的三个文件是示意模板/待管理员验证，不能直接
写入用户全局配置，也不包含真实 token。管理员必须先确认企业身份 provider、issuer、
audience、tenant mapping、Origin/Host allowlist、HTTPS gateway 和审计保留策略。

## 工具与状态

冻结的九个工具是：`cargo.calculate`、`container.plan_summary`、
`quote.canada_final_mile.calculate`、`quote.save_draft`、`customs.ca.search`、
`customs.ca.estimate`、`knowledge.search_curated`、`system.get_data_status`、
`review.create_task`。不存在 `commit_operation`、send、publish、booking 或通用写工具。

客户端必须按统一 envelope 处理：

- `success`：展示版本、来源、trace 和 warnings；仍遵守 `sendable=false` 与
  `theoretical_only=true`。
- `needs_input`：把 blockers 转成字段问题；不能使用默认地址、重量、Zone、汇率或税率。
- `manual_review`：展示原因、来源和责任角色，交给人工复核；不能当作最终报价/税额。
- `unavailable`：展示权威源/版本不可用；不以搜索、旧数据、fixture 或模型估值替代。
- `blocked`：展示权限/Phase 1/安全策略拒绝；不改名重试或绕过网关。

## 接入 smoke

1. 管理员使用假 endpoint 和短期身份在 staging 获取工具列表，确认只有九个工具。
2. 调用 `system.get_data_status`，核对 RiskCustoms `ready`、`test_data` 和 release IDs。
3. 运行 cargo/quote 查询和一个 `needs_input` 负例；确认金额/重量带单位和版本。
4. 只在批准的 fixture/sandbox 中验证 `quote.save_draft` 与 `review.create_task` 的
   preview→approval→commit→readback；不得发送、发布、订舱或写生产。
5. 保存响应、审计 ID、工具版本和管理员批准记录；客户端精确语法未由官方文档确认前，
   继续标记为“示意模板/待管理员验证”。
