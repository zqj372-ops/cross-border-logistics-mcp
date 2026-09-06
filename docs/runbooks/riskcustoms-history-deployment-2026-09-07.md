# RiskCustoms 来源及关务历史生产启用

2026-09-07（Asia/Shanghai），已按用户明确授权部署来源服务、执行数据库迁移、配置代理并开启关务历史。本文记录实际执行结果；读取文档不会自动刷新生产。企业微信不在需求中。

## 本次部署身份

| 项目 | 实际版本 |
| --- | --- |
| RiskCustoms main | `18c113bf3243a45339c561a6560b2d4998fb3e6c` |
| 来源服务版本 | `0.2.3-history-18c113bf3243` |
| 来源制品 SHA-256 | `aa8ab17dc3a362b50c81581be8d09f87c8b73d4a67792b5bd21ab1fe86d8932e` |
| FreightClaw main | `712cddf7e355a008a09dfc56aa205eba64289e27` |
| Portal build ID | `593b537df6c438ecc002cadab5554044d750e258312af364cb7246b4ffb84475` |
| Portal 镜像 | `freightclaw-portal:593b537df6c4` |
| Portal image ID | `sha256:96a3d59ab94345809a53bc1d6133eb6843ae75564b5a936746ae69e35e1bd27a` |
| Portal 制品 SHA-256 | `d08b7ca63ef2e94ddc445b3fda5a37d6fa7550e3304ecba2433f156cd42c05bf` |
| Portal release ID | `portal-history-20260907` |
| MCP Runtime | 保留 `freightclaw-portal:a42849576004`，运行状态 healthy |

两个发布制品均从已提交 main 的文件生成，不包含本地无关数据、凭证或名称带 ` 2` 的重复文件。Portal 在服务器完成镜像构建并通过类型检查、运行包、OpenAPI 和 Agent Pack 构建。后续文档提交不改变上述制品身份。

## 已执行操作

1. 对来源旧 SQLite 做一致性备份，独立恢复读回完整性和外键检查；以备份建立新运行库，保留原库和档案。迁移命令实际只应用 `0008_m2m_customs_history.sql`，输出 `status=pass`、`baselined=[]`、`current=true`。迁移账本现为0001–0008，权威发布表内容摘要未变。
2. 在 tk-server 启动 `riskcustoms-hs-history-v1`，绑定回环13119；显式代理状态、查询、单项税费、批量税费和两个历史端点。Nginx 检查通过并 reload。重启后历史读取审计的数量和内容摘要相同。旧13118进程已停止并保留，新 PM2 状态已保存且开机服务 enabled；通用网站13108进程重启数仍为0。
3. 在 Oracle 对 Portal 三库和私有配置做备份及恢复验证，用独立状态副本启动新版镜像核对就绪。随后将对应企业连接 `customsHistoryEnabled` 设为 `true`，更新 Portal 镜像和 release/build ID，重启 Portal 并 reload 公网代理。
4. 新版启动创建 `calls.sqlite`。当前 `portal.sqlite`、`sessions.sqlite`、`business-access.sqlite`、`calls.sqlite` 四库检查均为 `ok`，外键错误0。Portal 保持单实例 SQLite；未执行 PostgreSQL 迁移。隔离验收容器已停止。

来源精确路径为 `GET /api/m2m/status`、`POST /api/m2m/v2/query`、`POST /api/m2m/v1/tariff-estimate`、`POST /api/m2m/v1/tariff-estimates/batch`、`POST /api/m2m/v2/history/list` 和 `POST /api/m2m/v2/history/get`。来源企业、调用方和签名配置延用既有合法绑定。

## 实际验收

| 检查 | 结果 |
| --- | --- |
| 生产 HTTPS 查询历史、税费历史 | 两类列表均 HTTP 200、`success`，各0条 |
| 不存在的历史记录 | 两类均 HTTP 200、`unavailable`、`data=null`；不返回其他人员内容 |
| 历史请求身份与缓存 | 真实 main 客户端校验当前企业、人员、应用、请求编号；JSON、no-store、无 Cloudflare challenge |
| 来源重启持久化 | 重启前后4条历史访问审计数量和摘要相同；后续读回正常 |
| 来源状态、查询、单项/批量税费 | HTTP 503，`data_not_ready` / `unavailable`；税费金额为空，请求编号相符 |
| 正式关务数据 | 本次线上读回15 staged、0 published、0 publication snapshot；`ready=false`、`testData=true` |
| Portal 就绪 | 公网 `/console/readyz` 返回新 build ID，六项检查全部 true |
| Portal 公网 | 七项检查通过：就绪、首页、版本化 JS/CSS、OpenAPI 和两个历史接口的未登录401 |
| 浏览器 | Edge 正常加载登录页；没有页面错误；没有执行人员登录 |

历史集成检查在来源服务器认可的现有企业和已验证 owner 范围内签发人员委托；私钥和来源凭证留在 Oracle。没有制造 Portal 会话，没有调用客户 API Key。查询和税费连接检查使用服务身份，不写人员历史。最终来源库为0条业务历史、12条验收读取审计。

验收脚本最初假设历史前端脚本独立发布；检查构建入口后确认其打包在版本化 `app.js` 中。最终验证下载了实际页面引用的 JS/CSS，并确认历史页面与请求路径均在 JS 制品内。Oracle 的通用脚本请求曾遇到 Cloudflare 1010、本机曾遇到 TLS 中断；正常浏览器与最终公网检查通过，未修改 Cloudflare 防护。

进入[个人中心 → 关务历史](https://www.freightclaw.net/console/#customs-history)可以登录查看本人记录。历史从新版本来源人员委托调用开始保存，旧记录不自动回填。目前列表为空，所以生产人员历史详情和恢复仍待真实记录验收。来源正式数据没有发布，查询及税费估算也尚未完成真实成功业务验收。

生产脱敏回执：[2026-09-07 关务历史部署](../product/2026-09-05-mcp-product-redesign/evidence/2026-09-07-customs-history-deployment.json)。来源完整部署说明见 [RiskCustoms 记录](https://github.com/zqj372-ops/riskcustoms-hs/blob/main/docs/operations/customs-history-deployment-2026-09-07.md)。本次没有启用 `business-v1` 私有 Provider、MCP 业务模块或多实例共享库；此前代码测试通过不等于这些组件已部署。

## 回滚

Portal 发布配置备份：`/data/logistics-mcp/portal/backups/history-promotion-593b537df6c4`；三库及状态恢复验证：`/data/logistics-mcp/portal/backups/history-predeploy-593b537df6c4`。Portal 新源码目录：`/data/logistics-mcp/portal/releases/593b537df6c4`。

先关闭历史开关，或恢复发布备份中的 `portal.env`、`release.env`、`business-config.json` 并使用旧 Portal 镜像 `freightclaw-portal:a42849576004`。重新启动 Portal 后核对旧 build ID 的 readyz，再测试并 reload `freightclaw-web`。保留 `calls.sqlite` 和来源新历史库，不覆盖运行库。

来源备份：`/var/lib/riskcustoms-hs-published-candidate/backups/20260906-history-18c113bf3243`；新数据库与档案：`/var/lib/riskcustoms-hs-published-candidate/history-18c113bf3243`。需要回滚来源时，先启动旧 PM2 `riskcustoms-hs-published-candidate-v3` 并确认13118就绪，再恢复备份中的 Nginx 配置、测试并 reload，将 `current` 指回 `20260905144958-published-v3-d7edd1b-02`。最后停新来源并保存 PM2 状态。不要对0008执行破坏性降级，也不要把新历史库覆盖回旧数据库。
