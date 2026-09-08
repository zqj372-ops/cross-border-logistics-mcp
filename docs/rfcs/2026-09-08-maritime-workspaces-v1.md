# 独立询价、船期与码头效率工作台 v1

状态：用户 2026-09-08 明确要求拆分两种私人地址报价，并增加船期及码头效率模块。本次根代理作为基线维护者记录并接受下面的 Portal / 人员 CLI 实施合同；新的 MCP 工具命名、模块制品和平台挂载仍为待评审，不修改静态 MCP 注册表。

## 产品与所有权

- 自有运价：`#quote/private`，`quote.zone_preview`，配置 `residential-rates`。独立资料与结果，沿用当前引擎、运价、报价单合同。
- Freightcom：`#quote/freightcom`，`quote.freightcom_ltl.preview`，配置 `freightcom`。逐托录入实体托盘，独立资料与结果；不再从自有报价页面自动拷贝条件。
- 船期：`#schedules`，市场 `ocean.schedules`，配置 `sailing-schedules`。
- 码头效率：`#terminal-efficiency`，市场 `port.efficiency`，配置 `terminal-efficiency`。
- 第一版候选范围为中国起运港与加拿大主要港口。官方查询入口公开可读；企业自行整理的数据只向本企业成员提供。无发布数据时给出官方入口，不能声称完成实时查询。
- 新领域目录 `services/maritime/**` 由本任务维护；Portal 编排、控制台、人员 CLI、对应测试与文档由本任务集成。价格、关务、旧 Phase 1 合同不改变。

## 数据与权威

本版提供经人员核验的结构化快照保存、预览、发布、查询、停用与回退。数据初始为空。船司、港务局及授权数据供应商是来源权威，企业快照是有期限的操作副本，不宣称自动同步、实时 API 或生产就绪。不抓取登录后数据、不绕过站点限制、不接受任意 URL 抓取或 SQL。来源 URL 只作证据链接，服务端不请求它。

船期记录分别保存起运/目的港、船司、船名航次、各自带时区偏移的离港/到港时间及 planned / estimated / actual 事件类型。直达与中转明确区分。预计到港不等于实际到港，也不推导可提货日。

效率记录按港口、码头、指标、统计起止时间和单位保存。铁路滞箱天数、锚地等待小时、闸口周转分钟、进口堆场占用英尺分别显示，不合成无来源的拥堵分数。`on_dock_feet` 不是箱量。不同统计周期、码头或口径不自动平均。缺值保持 null 及原因，过期资料不能作为当前数据。

所有来源包含名称、HTTPS 证据链接、版本、观察时间、失效时间和人工核验标识；每条记录绑定本批次内的唯一来源。发布重新检查完整性、未来观察时间、过期来源、重复记录、事件顺序、指标/单位一致性。输出保留来源、批次、发布 ID、哈希和统计窗口；没有快照为 unavailable，失效来源为 manual_review，匹配无记录不等于无船或码头正常。

## API、Schema 与权限

沿用 Portal 人员会话、服务端企业和当前成员检查。查询限本企业有效成员，配置写入仅 owner/admin；API Key 不获得新增权限。读写输入及输出使用闭合 Zod 合同生成 Draft 2020-12 Schema；入口统一在 `/console/api/v1`。

- `GET /admin/{sailing-schedules|terminal-efficiency}` 读取本企业草稿和发布历史。
- `POST /admin/{kind}/save`：`{expected_version,input}`。
- `GET /admin/{kind}/preview[?release_id=...]`。
- `POST /admin/{kind}/publish`：沿用 `{expected_version,preview_hash,confirmation:"reviewed_sources_and_conditions"}`。
- `POST /admin/{kind}/disable` 和 `/rollback` 沿用已接受的精确版本/发布引用合同。
- `POST /maritime/{sailing-schedules|terminal-efficiency}/query`：窄查询字段，响应 `maritime-query@2026-09-08.v1` 与既有五状态。
- 人员 CLI：`workspace schedules query|get|save|preview|publish|disable|rollback`；`workspace terminals` 同样七项。原 `quote self` 与 `quote freightcom` 保持分开。旧 `quote shared-preview` 仅保留兼容性，不在新页面自动调用。

配置资源复用既有 SQLite 事务、租户/kind 分区、版本校验、幂等、审计及写后读回；新增 kind 不新增公共 MCP 权限。源文件、客户材料、凭证、数据内容不写入审计，仅记录 digest 和引用。每批最多 500 条记录、1 份明确来源，输入限制 512 KiB，不接受无界响应或通用执行参数。

## 兼容、验收和回滚

旧 `#quote` 仍进入自有运价，旧私人地址链接继续可用；入口不依赖前一次访问的报价方式。两页分别保留本页输入，不把改过的字段对应到旧结果。市场分别进入配置；无权限时不展示写按钮。

验证：报价路由与状态隔离、多托输入、两条调用路径；海运时间/来源/单位校验、过期/无数据、跨企业、管理权限、幂等、过期预览、发布停用回退和重启读回；HTTP/CLI Schema 一致；桌面和手机实际操作、控制台错误和截图。合成 fixture 与线上数据区分。

回滚应用不会删除新 kind 的数据，旧版不读取它们；保留原数据库备份及新版本。生产启用和自动上游适配需完成对应来源授权、接口合同与实际读回。不得把本次本地发布流程视为生产发布。
