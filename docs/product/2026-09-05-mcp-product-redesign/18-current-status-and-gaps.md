# 当前进度、功能缺口与验收顺序

更新日期：2026-09-06。本文用于本轮工作树归档与 main 集成，替代旧方案中对“当前能力”的描述；旧 RFC 的工具契约和历史验收记录继续保留。

## 1. 核查范围与发布身份

本轮按当前代码、公开接口副本和本地保存的脱敏回执核对，未连接生产数据库、服务器或业务 API，也未重新使用客户 Key。

| 证据 | 当前可确认内容 |
| --- | --- |
| 归档前源码 | `codex/tenant-api-key-control`，HEAD `34e1e9567440e768eb9e7a1b6cfe8c2ded70baed`，包含门户、业务 API、统一 Key 等未提交实现 |
| 集成前 main | 本轮远端读取为 `03153b91aee35403332c63ba6f294ac40f2f52ae`；其源码树与上述已提交 HEAD 相同 |
| 最近保存的 Portal/MCP 发布 | `freightclaw-portal:a42849576004`，完整 build ID `a428495760049453f5256e6b704dbbc14d0a0a8b29661d2426f6af8b1e7d31fd` |
| 公网验收快照 | `2026-09-05T17:33:33.767298Z`，即北京时间 2026-09-06 01:33；12 项通过，客户 Key 未调用 |
| 数据备份 | Portal 三库一致备份及恢复检查、Runtime 数据库恢复已记录；不是本轮重新执行 |

生产 build 由原工作树 362 个构建输入的内容清单标识。将源码提交到 main 不会改变那次已发布镜像的身份，也不自动发布新镜像。本轮 Git 提交和 CI 结果应以提交记录及对应 CI 为准，不能回填成历史生产验收。

证据入口：[生产交付记录](17-market-manual-production-delivery.md)、[生产台账](15-implementation-delivery.md)、[脱敏发布快照摘要](evidence/2026-09-06-release-snapshot.json)。完整原始回执保留在本地忽略目录 `.runtime/production-evidence/`，不提交凭证或业务数据库。

## 2. 已实现能力

| 范围 | 实现与证据 | 尚未证明 |
| --- | --- | --- |
| 主门户、市场与手册 | `apps/console`；8 项能力、七章手册、OpenAPI、Agent 指南；已有发布与响应式验证记录 | 市场卡片不代表来源数据就绪 |
| 人员与组织 | Authentik 邮箱登录/验证/恢复、企业准入、成员邀请与角色、应用、申请、审批、开通 | 企业微信登录仍未实现 |
| 统一 Key | 一次性交付、轮换、明确更新服务、老 Key 启用 T0、撤销；同一 Key 支持 REST 与 MCP 换票 | 最近真实客户 Key 回执仍为 `last_used_at=null`、`production_customer_key_invoked=false` |
| 基础工具 | `cargo.calculate`、`container.plan_summary`、`system.agent_context.get` 同时支持 MCP/REST | 不提供三维装载承诺 |
| 尾程/资料提取 | `quote.zone_preview`、`quote.ai_extract_preview` 的生产 service actor 只读样例已成功 | 当前客户正式价格有效性；提取服务长期稳定性 |
| 关务/税费 | `customs.query`、`customs.tax.estimate` 与有界批量估算；M2M 连接和实际租户绑定已有记录 | 正式数据未发布，相关查询和估算仍不可正式使用 |
| Freightcom | 正式只读客户端、精确权限、原币种费用/有效期校验和 UI | 企业正式凭证与生产 rate 读回 |
| 报价记录/审核/PDF | 人员专用保存、列表、单条读回、审核队列/处理、草稿及正式 PDF 生成/下载校验；已有隔离测试 | 真实企业人员全流程、当前价格/有效期与正式文件验收 |

普通人员使用登录会话，程序使用应用权限。报价保存、人工处理和 PDF 不属于公开机器预览权限；旧 `quote.save_draft` 等 MCP 工具的未启用状态与这些新人员接口是不同范围。

## 3. 优先关闭的业务缺口

| 顺序 | 缺口 | 完成条件 |
| --- | --- | --- |
| 1 | 关务正式数据 | 业务负责人完成来源适用性、特殊/动态措施、版本审查；发布正式 release 和复合快照，验证查询/单项/批量估算与真实版本一致 |
| 2 | 报价正式业务流程 | 确认当前价格来源及有效期；真实人员按授权完成试算、保存、人工价格确认、正式 PDF、下载校验和历史恢复 |
| 3 | Freightcom 企业连接 | 配置企业正式凭证与租户账号映射；实际只读询价返回可核对的承运商、金额、币种、费用项和有效期 |
| 4 | 统一 Key 客户验收 | 使用实际保存的 Key 调用 REST、兑换 MCP JWT、初始化/列工具/只读调用；核对暂停/撤销后的拒绝并保存脱敏回执 |

最近关务来源回执为 **15 staged、0 published、0 publication snapshot**，不能把 staged 候选算成已发布税则。尾程试算来源版本为 **2026-06-03**；日期本身不证明价格无效，也不证明当前获批。资料提取曾出现超时后再成功，只能证明当次调用，不构成 SLA。

详见 [关务来源验收](../../runbooks/customs-candidate-production-api.md)、[报价来源验收](../../runbooks/quote-candidate-production-api.md) 和 [Business API 部署边界](../../runbooks/business-api-v2.md)。

## 4. 仍缺少的产品与平台能力

- **更多原生 MCP 工具：** 当前仅三个 T0 工具；五项业务能力通过 REST 提供。若要求客户端通过一个 MCP 自动发现这些业务，需要新合同、权限、运行时接入及客户端验收，不能只改市场协议标签。
- **客户侧业务调用日志和用量：** 当前个人中心“操作记录”展示成员、应用和授权变更。既有管理员 overview 不等于企业客户的调用明细、耗时、错误和用量查询。
- **关务/税费历史恢复：** 需要在来源系统建立记录、保留及授权恢复合同；当前查询引用不能冒充可恢复历史。
- **企业微信身份入口：** 当前使用邮箱密码及 Authentik；机器人凭据不能替代人员网页登录身份。
- **通用热插拔：** v0 是启动时静态可信模块，未完成远程安装、通用隔离运行池、无重启版本切换和完整客户端目录刷新。
- **多实例高可用：** 当前 Portal 三个 SQLite 使用单实例持久卷；需要独立的并发存储、会话/审计和故障切换设计及演练。

自动对客发送、订舱、付款、正式报关和商业套餐计费不在本阶段默认范围，不作为遗漏的已承诺功能。

## 5. 文档与源码归档规则

- 根 README 作为当前导航与状态入口；本文件区分已实现、历史回执和未验收事项。
- 01–14 号文档中的页面 handoff、两类 Key 和旧缺口属于当时方案，不能覆盖 15–18 号交付与核查结果。
- Phase 1 MCP 工具合同、T0 运行时、新业务 REST 和人员写接口分别保留版本，不因统一页面而扩张旧合同。
- main 收录本次业务实现、测试、Schemas、部署脚本和对应说明；忽略运行库、凭证、构建产物及 Python 缓存。
- 本地安装技能与四份名称带 ` 2` 的重复 Admin 文件保留在原工作区，不作为产品源码提交。

## 6. 验证口径

前次只读核查通过市场/OpenAPI 路由对应及 `git diff --check`；受本地云端占位文件影响，完整类型/Schema 检查未完成。对可读取的 93 个构建输入逐项比对均匹配，另外 269 个当时未完成比对，因此不能据此声称完整源码与发布清单一致。

本轮主线整理使用独立检出，按文件内容复制当前业务增量，再安装锁定依赖执行相关检查，避免将上述未完成检查沿用为成功。此前记录的 1655 项测试通过保留为发布批次的历史结果。

2026-09-06 主线集成实际执行结果（本地 Node.js 24.14.0；CI 使用 22.13.0）：

| 命令 / 检查 | 实际结果 |
| --- | --- |
| `npm ci --no-audit --no-fund` | 安装锁定的 283 个包 |
| `npm run build` | 通过；生成 OpenAPI、运行包和 13 项标准包，T0 制品校验通过 |
| `ACCESS_GATEWAY_TEST_POSTGRES=0 npm test -- --run` | 165 个文件通过、1 个文件跳过；1657 项通过、1 项跳过，0 失败，60.61 秒 |
| `npm run typecheck` / `npm run lint` | 通过 |
| `npm run validate:schemas` | 17 个 MCP Schema、11 个示例、18 个 Access Gateway Schema 通过 |
| `npm run validate:agent-standards` / `npm run build:agent-pack` | 13 项标准、5 个 profile、4 个模块、5 个资源通过；标准包生成成功 |
| `npm run validate:agent-adapters` | 3 个客户端适配器及固定资源白名单通过 |
| `bash deploy/scripts/check-release.sh --fixture-only` | Quote v2 合同、17 个 Schema 与 11 个示例通过；无业务网络调用 |
| `node apps/admin/self-check.mjs` / `node apps/admin/business-entrypoints-check.mjs` | 两项前端自检通过 |
| OpenAPI 两个副本与本轮更新文档的相对链接 | 两份内容一致；未发现缺失的相对链接 |
| `git diff --check` 与本轮候选凭证模式扫描 | 差异格式检查通过；3 处扫描命中均为格式校验或合成的拒绝用例，未发现实际凭证材料 |

PostgreSQL 条件集成测试未启用，未连接真实数据库。本轮没有重跑浏览器或生产业务验收；镜像构建及 Node.js 22.13.0 的结果以同一 main 提交的 CI 为准。提交、CI 与历史生产发布保持各自身份，不将任何一项替代另外两项。
