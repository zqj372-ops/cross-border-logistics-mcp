# Access Console

这是 Unified Access Gateway 的窄前端资产。它呈现租户、客户端、长期 Key 生命周期、三个
T0 工具 entitlement、operation readback、24 小时运营概览、脱敏最近异常、生产门禁和 Agent
接入清单。仓库提供前端合同、本地合成测试和受管理员保护的只读 overview API；Cloudflare Access JWT 精确管理员映射和受保护 `/admin/` 入口按其装配模式验证。

当前企业人员主入口已迁至 [apps/console](../console/README.md)，包含成员、申请、统一 Key 与业务操作。本目录保留窄管理职责；部署状态及尚未完成的客户业务验收以 [2026-09-06 状态台账](../../docs/product/2026-09-05-mcp-product-redesign/18-current-status-and-gaps.md) 为准，不能用旧候选模式的门禁覆盖新 Portal 发布回执。
