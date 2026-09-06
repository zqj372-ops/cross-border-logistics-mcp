# 功能补齐实施记录

基线：`68bfa352574b3ccbc9f21ecccec132677011436b`。工作分支：`codex/complete-mcp-capabilities-20260906`。范围依据：[已接受 RFC](../../rfcs/2026-09-06-capability-completion-v1.md)。企业微信不在本轮需求中。

- [x] 修复实际响应字节上限，并覆盖 chunked、超限取消和下载边界。
- [x] 持久记录统一 Key 最近使用时间，保持版本/撤销与并发语义。
- [x] 生产 T0 REST 使用 MCP Runtime 受控执行与持久审计。
- [x] 在线应用权威故障影响 Runtime readiness，恢复可核对。
- [x] 租户/应用调用日志、状态与耗时用量统计、客户页面。
- [x] 五项业务能力通过明确的新 MCP profile/换票合同使用。
- [x] 关务/税费来源记录及历史恢复接口、页面和失败闭合。
- [x] 签名制品、模块 generation 切换、排空、回滚及目录通知。
- [x] 共享 Portal 持久化、会话、授权与多实例部署/恢复验证。
- [x] 更新 README、手册、OpenAPI、状态台账与功能边界，移除企业微信待办。
- [x] 完整回归、浏览器验证与 main 集成准备；提交及 CI 以对应 GitHub 检查记录为准。

真实关税发布、获批价格、Freightcom 企业凭证和真实客户 Key 的线上验收以实际业务资料及授权为前提，不能用合成测试关闭。这些项目的代码、配置和可执行验收准备同样纳入检查。

第一切片：超限取消与 Key lastUsedAt 的新增测试先失败、修复后通过；Runtime 转发覆盖短 JWT、权限签发竞态、停用结果与审计编号保留、会话清理；在线权威 readiness 覆盖故障及恢复。后续 MCP 客户端调用、目录变更与全量回归均已通过。

最终本地回归：175个文件、1689项通过，0失败、0跳过；共享 PostgreSQL 两个集成组均启用。桌面/手机浏览器8项通过，零页面异常；来源历史恢复表单使用浏览器 fixture，不代表真实来源已经实现。构建、类型、lint、Schema、Agent标准/适配器和隔离发布检查通过。详见[当前状态及脱敏回执](../../product/2026-09-05-mcp-product-redesign/18-current-status-and-gaps.md)。

交付通过 `codex/complete-mcp-capabilities-20260906` 进入 main，保留必要 CI 检查。未执行生产部署；原工作区的本地技能和重复 Admin 文件继续保留。
