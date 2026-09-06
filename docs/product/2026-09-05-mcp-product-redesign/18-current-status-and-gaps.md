# 当前进度、功能边界与验收状态

更新日期：2026-09-06。当前实现以 main `68bfa352574b3ccbc9f21ecccec132677011436b` 为基线，在 `codex/complete-mcp-capabilities-20260906` 完成。范围依据为[功能补齐 RFC](../../rfcs/2026-09-06-capability-completion-v1.md)。企业微信已从需求和待办中移除。

## 1. 代码完成情况

| 范围 | 本轮实现 | 验证与边界 |
| --- | --- | --- |
| 业务 MCP | 五项已有业务能力进入显式 `business-v1`；统一 Key 兑换包含当前精确权限的短 JWT；与三项 T0 共八项 | 客户端实际初始化、列工具、调用；私有 Provider 检查 JWT 和工作负载密钥，来源不可用保留 unavailable |
| 调用记录与用量 | 企业/应用/人员隔离、服务/状态/时间筛选、分页、数量和平均耗时；网页和机器调用共用持久记录 | 仅保留身份引用、请求号、状态、耗时和时间；默认30天、每企业1万条，不保存原始业务输入或响应，不是商业计费 |
| 关务/税费历史 | 来源列表与单条读回适配器、闭合 Schema、身份与记录校验、历史详情及恢复表单 | MCP 适配与页面、RiskCustoms 来源存储及 list/get 均完成；实际客户端隔离 HTTP 联调及来源重启恢复通过，生产部署待验收 |
| 模块切换 | Ed25519 签名、制品/SBOM 摘要、出站主机白名单、持久版本序号、挂载、在途固定、排空取消、停用/回滚、MCP 目录变更通知 | 使用经过批准的私有 HTTP Provider；无任意代码安装入口；签名不代替实际 Provider 镜像和数据核对 |
| Portal 多实例 | PostgreSQL 共享账号、授权、Key、会话、幂等及调用记录；显式 SQLite 迁移与写后核对；代理/Compose 示例 | 隔离 PostgreSQL 验证跨进程并发、会话单次消费、撤销保留、迁移和连接中断恢复；Runtime 自身仍保留实例会话绑定 |
| 稳定性修复 | 响应实际字节上限、Key 最近使用时间、生产 T0 REST 经 MCP Runtime 持久审计、在线应用权威就绪检查 | 包含流式超限取消、签发期间撤权、审计编号读回、权威中断与恢复 |
| 文档与交付 | README、手册、Agent 指南、OpenAPI、Schemas、新 Agent profile、运维说明和 CI 数据库验证 | [完整操作说明](../../runbooks/capability-completion-v1.md)；新功能须按配置启用，此轮未部署生产 |

`cargo.calculate`、`container.plan_summary`、`system.agent_context.get` 的旧 `t0-v1` 精确白名单保留。五项业务为 `customs.query`、`customs.tax.estimate`、`quote.zone_preview`、`quote.ai_extract_preview`、`quote.freightcom_ltl.preview`。税费批量估算仍走已有 REST；MCP 对应单项估算。

原有人员登录、企业/成员管理、申请审批、统一 Key、报价保存/历史/复核/PDF 已在前次实现。本轮没有将查询 Key 扩为人员写权限，也没有以改标签代替真实 MCP 注册和调用。

## 2. 需要来源或生产环境完成的事项

| 项目 | 当前可确认的证据 | 仍需完成 |
| --- | --- | --- |
| 正式关务数据 | 最近保存回执为15 staged、0 published、0 publication snapshot | 来源负责人审核适用性、动态措施、版本并发布正式 release/复合快照，再核对真实查询与估算 |
| 当前报价和正式文件 | 历史试算来源版本2026-06-03；人员保存、审核、PDF 和历史适配已实现 | 核实当前获批价格与有效期，真实企业人员完成报价到正式 PDF 的读回 |
| Freightcom 企业接入 | 只读适配器、权限、原币种费用和有效期校验已实现 | 提供正式企业凭证、账号映射并取得可核对的真实 rate |
| 真实客户统一 Key | 旧回执未执行客户 Key 调用；本轮修复了 lastUsedAt 未更新 | 实际企业 REST/MCP 调用、当前权限和暂停/撤销验证；旧 lastUsedAt=null 不能单独证明从未调用 |
| 关务来源历史 | 后续已按用户授权完成 RiskCustoms 查询/税费 list/get、人员快照、批量按行、隔离及重启恢复；与本仓库现有客户端真实 HTTP 联调通过 | 来源部署并迁移至 0008，代理显式加入两条历史路径，再启用 `customsHistoryEnabled` 并完成生产人员读回 |
| 新代码部署 | 本地、CI 和 main 集成与生产发布分别留证 | 将候选按运维说明部署到明确环境，验证实际发布身份、共享库、签名 Provider、业务授权及来源状态 |

本轮未连接生产数据库、服务器或业务 API。用户随后明确授权实现 RiskCustoms 接口，已在来源仓库补齐实际接口并完成跨仓库隔离联调；原开发工作区及无关数据工作保留。来源接口代码完成与生产部署分别验收。税则 staged 数量和报价版本来自此前保存回执，并非本轮线上刷新；版本日期本身不证明价格有效或失效。

自动对客发送、订舱、付款、正式报关、商业套餐计费和任意模块代码远程安装不属于已批准的本轮范围。企业微信不需要。

## 3. 生产身份与历史证据

最近保存的 Portal/MCP 发布为 `freightclaw-portal:a42849576004`，完整 build ID `a428495760049453f5256e6b704dbbc14d0a0a8b29661d2426f6af8b1e7d31fd`。公网快照时间为 `2026-09-05T17:33:33.767298Z`，12项通过，客户 Key 未调用；Portal 三库及 Runtime 恢复检查是此前记录。

该镜像由原工作树362个构建输入的清单标识。本次 Git 提交不改变历史镜像身份，不自动发布新镜像。证据入口：[生产交付记录](17-market-manual-production-delivery.md)、[生产台账](15-implementation-delivery.md)、[脱敏发布摘要](evidence/2026-09-06-release-snapshot.json)。本地原始回执、运行库和凭证继续留在忽略目录。

## 4. 本轮验证

以下记录以本轮实际运行输出为准；此前1657项通过是 main 基线的历史结果，不能替代新增功能回归。

| 检查 | 实际结果 |
| --- | --- |
| `npm run build` | 通过；T0 制品校验、运行包、OpenAPI 与14项 Agent 标准包生成成功 |
| `npm test -- --run`（启用两个隔离 PostgreSQL 集成组） | 175个文件、1689项通过；0失败、0跳过，72.06秒 |
| `npm run typecheck` / `npm run lint` | 通过 |
| `npm run validate:schemas` | 17个 MCP Schema、11个示例、28个 Access Gateway Schema 通过 |
| `npm run validate:agent-standards` / `npm run build:agent-pack` | 14项标准、6个 profile、5个模块、5个资源；生成包通过 |
| `npm run validate:agent-adapters` | 3个客户端适配器及固定资源白名单通过 |
| `bash deploy/scripts/check-release.sh --fixture-only` | Quote v2 合同和17个 Schema / 11个示例通过；禁用业务网络调用 |
| Admin 两项前端自检 | 通过 |
| Chromium 浏览器 | 8项流程通过；桌面1440px、手机390px；零页面异常。包含筛选/空态、退出清理、人员隔离、来源不可用；历史详情和恢复表单使用明确的浏览器 fixture |
| OpenAPI、文档、差异检查 | 两个副本一致；新增说明相对链接有效；`git diff --check`通过 |
| 凭证模式扫描 | 113个变更文本文件扫描仅命中1处 PEM 格式校验，人工核对并非密钥材料 |

脱敏回执：[本轮验证结果](evidence/2026-09-06-capability-verification.json)。页面：[桌面调用记录](evidence/2026-09-06-capability-calls-desktop.png)、[手机调用记录](evidence/2026-09-06-capability-calls-mobile.png)。本地未运行 Docker daemon，容器基础配置、业务/共享 overlay 与镜像构建由对应提交的 CI 检查，不计为本地已运行结果。

浏览器使用本地隔离账号及来源不可用结果。成功的调用记录说明请求被记录并按权限展示，不说明关务真实数据已可用。部署验证使用同一提交的 CI 镜像结果；生产依赖仍按第2节单独验收。

## 5. 维护入口

- [功能补齐与发布操作](../../runbooks/capability-completion-v1.md)：新 MCP 换票、历史合同、共享迁移、模块签名/切换和回滚。
- [实施记录](../../superpowers/plans/2026-09-06-capability-completion.md)：本轮工作范围和回归结果。
- [关务来源验收](../../runbooks/customs-candidate-production-api.md)、[报价来源验收](../../runbooks/quote-candidate-production-api.md)、[Business API 边界](../../runbooks/business-api-v2.md)：真实业务验收。

01–14号方案保留为历史设计，当前能力以README、18号状态文档及对应运行合同为准。标准包运行时只读生成制品。原工作区本地技能与名称带 ` 2` 的四个重复 Admin 文件保持原样，不纳入产品源码。

## 6. RiskCustoms 来源接口后续交付

2026-09-06 按用户补充要求实现来源历史 list/get，并整理合入已有新版查询、税费单项/批量和 Node 持久化接口。已通过真实 HTTP 查询→来源保存→MCP 历史读取→原输入/快照相等的联调；当前发布未就绪时仍可读取历史，重启恢复经过验证。详见[来源历史交付](../../runbooks/riskcustoms-history-source.md)和[脱敏联调回执](evidence/2026-09-06-riskcustoms-history-readback.json)。企业微信仍不在需求中。
