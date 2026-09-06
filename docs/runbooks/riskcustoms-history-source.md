# RiskCustoms 来源历史接口交付

2026-09-06，按用户追加授权在 RiskCustoms 仓库完成来源端接口。与 FreightClaw main `8517de1e4706d8d9daaeee50a27757b483e143f7` 现有客户端进行了真实 loopback HTTP 联调，数据全部来自隔离测试库。本次未连接或部署生产环境。

来源新增 `POST /api/m2m/v2/history/list`、`POST /api/m2m/v2/history/get`。请求版本为 `customs-history-request@2026-09-06.v1`，返回版本为 `customs-history@2026-09-06.v1`，与本仓库已有合同兼容。企业、调用方、应用和用户来自已验证的 Bearer 绑定及 RS256 委托；scope 精确为 `customs.history.read`，且只接受人员身份。

来源保存查询输入和结果快照、单项税费输入和结果，以及批量估算的逐行快照。每条最多 1 MiB，保留 30 天；每个企业/调用方/应用/人员/操作最多 1,000 条，每页最多 100 条。输入不足或来源不可用的记录保留原状态；没有来源版本时明确为 `unavailable`。金额、来源与规则仍由 RiskCustoms 决定。

当前来源发布不可用不会阻止查看已有的有效历史记录；查看和恢复不会重新算税或改变历史日期。MCP 页面恢复按钮只填回表单。新计算继续执行当前来源就绪、授权和发布身份检查。

本地联调确认：现有 MCP 查询和税费客户端可读取来源结果；两个历史类型都能列出并读取对应记录，恢复输入与原输入相等，历史快照与原结果相等。来源回归另外验证重启、分页、越权、记录过期、损坏、审计失败和批量逐行状态。

生产接入顺序：部署来源代码；显式执行 D1/Node SQLite migration 0008；核对来源数据库与档案；在代理配置中显式允许两个历史 POST 路径；核对人员委托及来源快照后，将对应 Portal 来源连接的 `customsHistoryEnabled` 设置为 `true`。来源未配置、身份不一致或响应异常时仍返回 unavailable。这些部署操作没有由代码合入自动执行。

来源参考：[完整 OpenAPI](https://github.com/zqj372-ops/riskcustoms-hs/blob/main/docs/contracts/riskcustoms-delegated.openapi.json)、[接口与迁移说明](https://github.com/zqj372-ops/riskcustoms-hs/blob/main/docs/operations/customs-history.md)。联调回执见[脱敏记录](../product/2026-09-05-mcp-product-redesign/evidence/2026-09-06-riskcustoms-history-readback.json)。

来源实现已提交至 `5733eee`，对应 [RiskCustoms PR](https://github.com/zqj372-ops/riskcustoms-hs/pull/5)。生产验收仍按本说明单独进行。
