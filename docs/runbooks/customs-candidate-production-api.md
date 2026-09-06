# ClearDDP 生产 API 连接验收

日期：2026-09-05。已完成真实服务连接、独立候选部署、精确路由切换及重启后读回。正式关税数据仍未发布；连接验收不代表客户企业已开通或税费结果可用于业务。

## 部署范围

`clearddp.com` 的四条精确路径连接 `tk-server` 上的独立进程 `riskcustoms-hs-published-candidate-v3`，监听 `127.0.0.1:13118`：

| 方法 | 路径 | 当前业务结果 |
| --- | --- | --- |
| GET | `/api/m2m/status` | 503 `data_not_ready`，`ready=false`、`testData=true` |
| POST | `/api/m2m/v2/query` | 503 `data_not_ready` |
| POST | `/api/m2m/v1/tariff-estimate` | 503 `unavailable`，`publication_not_ready` |
| POST | `/api/m2m/v1/tariff-estimates/batch` | 503 `unavailable` |

实际请求从 Oracle Portal 主机经公开 HTTPS 发起，使用现有受保护连接与 RS256 委托。无凭据及错误凭据均返回 401；独立负向检查确认跨 tenant 为 403、错误 Host 为 421、候选进程未开放的旧 query 路径为 404。响应带 `no-store` 及限制型 CSP。

其他网页、浏览器 API 与管理路径继续使用原 13108 服务。原首页在变更前后及候选重启后均为 200、538 bytes，SHA-256 `b51c6a20e36ea84ae9ba666e7778aa039b6be2f862d43969f4a2a079ccd1b5ea` 不变；原 PM2 进程保持在线且零重启。

## 代码与数据身份

- 代码 release：`20260905144958-published-v3-d7edd1b-02`。
- 代码 manifest SHA-256：`308b4da1dd808e8d9ef5d67371d27f1c3b4594a4956b437236d611b7523537f0`。
- 密封数据副本：1,068,630,016 bytes，SHA-256 `72ca38f7924ab0d86fc2f564ddcb5a2aaad95125158dcc5eb26ac25d96e85e36`。
- 实际发布状态：15 staged、0 published、0 publication snapshot。
- 数据库引用 20 份归档，其中 19 份逐字节/hash通过；唯一失败为未选中的历史 SIMA 候选，保持隔离。

运行数据库只新增最小请求审计，不改变候选发布状态。私钥留在 Portal 主机；关务端只持有公钥与精确连接绑定。受保护令牌没有复制为可使用的原始凭据，也不进入回执或日志。

## 重启与回滚

收紧归档只读权限后，已主动重启候选并重复公开验收，结果一致。启动需要完成数据与归档完整性检查，进程 online 不能替代端口及业务就绪检查。

备份目录：`/var/backups/riskcustoms-published-candidate/20260905144958-published-v3-d7edd1b/`。回滚先恢复原 Nginx 配置并通过 `nginx -t`，重载后核对原首页，再停止新候选；保留候选、归档、密封数据与审计，不反向修改发布状态。

服务端回执位于 `/var/lib/riskcustoms-hs-published-candidate/candidate-release-set-v3/`：`deployment-status.json`、`public-acceptance.jsonl`、`post-restart-acceptance.jsonl`。部署状态明确记录 `customerOrganizationActive=false`。

来源仓库交付：`/Users/autumn/Documents/Codex/worktrees/freightclaw-customs-api/docs/operations/clearddp-published-candidate-deployment-2026-09-05.md`。该来源候选专项测试 9 项通过，完整 server 测试 144 passed、20 skipped、0 failed，类型检查及差异检查通过。

## 真实企业绑定与业务发布状态

聚仓科技开户后，Portal 配置及关务唯一启用的 M2M 连接已重绑定实际租户 `tenant_d7f0f731a0a851940fdc12c2`。来源客户端、服务应用、连接密钥哈希和 JWKS 未改变。配置备份为 `/var/backups/riskcustoms-published-candidate/20260905T153807Z-enterprise-rebind`；候选完成启动完整性检查后，从 Portal 主机再次以真实 HTTPS service actor 查询，返回 503、`riskcustoms-query.v2`、`data_not_ready`、`ready=false`、`testData=true`，请求标识匹配。这次读回证明实际租户绑定通过，先前 `customerOrganizationActive=false` 的部署回执保留为开户前的历史记录。

2026-09-06 后续[门户交付记录](../product/2026-09-05-mcp-product-redesign/17-market-manual-production-delivery.md)已确认企业所有者、应用、授权及原有 Key 状态，替代本次初始验收时“邀请待领取”的状态；客户 Key 的实际机器调用仍未验证。关务负责人还需按已有发布流程完成适用性、特殊措施、预期结果及版本签署。平台继续保留 `unavailable` 或 `manual_review`，不会把候选数据提升为正式税费。
