# 公开船期来源扩展

状态：依据用户明确要求“OOCL 和 EMC、WHL、YML、SML、HMM、MSC、MSK、HPL 都要做”，以及后续“先做船期”，实施本地只读船期扩展。当前 EMC、SML、YML 已通过本地程序与页面验收，MSK 已通过独立 CLI 实查，OOCL PDF 取得部分结果；其余来源的具体阻塞见下表。2026-09-28 用户已授权提交、推送及部署，生产支持范围以该次发布的目标环境读回为准。

## 原因与最小改动

已有受控 HTTP collector、来源证据、CLI、Portal 服务和查询页面可复用。问题是部分来源只有目录项，页面还只显示 ONE/COSCO，且常驻 Portal 复用的传输对象会跨业务查询耗尽请求预算。

- 增加三个基于实际官方响应的 HTTP 适配器，不增加服务或队列；后续浏览器尝试增加锁定版本的 `playwright-core`，见下方续推进记录。
- 复用现有域名、路径、字段白名单、TLS、DNS 地址限制、字节上限、超时和证据存储。
- 每次业务查询创建独立传输预算和匿名会话；一次查询内的地点及船期请求仍共用预算。
- 页面根据服务端能力列出船公司；已实查来源可选择，其余显示“待验证”或“待接入”。
- 地点多义时要求用户选定官方候选；不把来源错误当成零条船期。

## 影响入口与合同

影响独立 collector 的 `carriers`、`locations`、`query`，及已有 `schedule-live` 的 Web/API/CLI 共用服务。没有新增 MCP 工具、通用写入口或权威业务表。

旧输入示例仍有效：

```json
{"carrier":"COSCO","origin":{"text":"Shanghai","country_code":"CN","carrier_location_id":null},"destination":{"text":"Vancouver","country_code":"CA","carrier_location_id":null},"from":"2026-09-28","until":"2026-10-25","routing":"any"}
```

新增输入示例：

```json
{"carrier":"SML","origin":{"text":"Shanghai","country_code":"CN","carrier_location_id":null},"destination":{"text":"Vancouver","country_code":"CA","carrier_location_id":null},"from":"2026-09-28","until":"2026-10-25","routing":"any"}
```

SML 加入 collector 船公司枚举；HPL、SM_LINE、SMLINE 加入别名归一化。EMC→EVERGREEN、MSK→MAERSK 延续已有映射。统一包络版本及结果字段不变，JSON Schema 仍显式关闭额外字段。旧请求行为保持；固定枚举的旧客户端需要更新 schema 才能接收新来源。

Portal 请求仍使用规范船公司标识（例如 EVERGREEN），CLI 可使用别名。个人固定受理人的只读查询范围由 COSCO 扩至 COSCO、ONE、EVERGREEN、SML、YML，仍逐次核对身份并与部署 allowlist 取交集。没有扩大其他个人的访问权。**FCL“使用此船期”的报价关联仍限定 COSCO**；新增来源不获得改价、订舱或发送权限。

## 来源验收

2026-09-27，上海至加拿大温哥华，离港区间 2026-09-28—2026-10-25：

| 来源 | 本次状态 | 实际证据 |
| --- | --- | --- |
| EMC / 长荣 | 本地程序及页面通过 | 5 条；8 天短区间返回 2 条；官方地点 CAVCR 与 UN/LOCODE CAVAN 保持区别 |
| SML / SM Line | 本地程序及页面通过 | 4 条；44 天跨窗口返回 7 条 |
| YML / 阳明 | 本地程序及页面通过 | 4 条，与官网浏览器逐条一致 |
| HMM | 浏览器通道已实现，待实查通过 | 官网浏览器 4 条；独立 Chromium 仍获得 Access Denied 页面 |
| OOCL | 浏览器通道已实现，待实查通过 | 官网浏览器本次返回 16 条；独立 Chromium 返回 HTTP 451 错误页；未复制或重放浏览器 token |
| WHL | 待官方可用接入路径 | 官网入口验证码/访问拦截 |
| HPL / 赫伯罗特 | 公共页面采集待验证 | 匿名地点接口 401；本次浏览器入口显示安全挑战；不能仅据缺少 API token 断言网页路线不可行 |
| MSK / 马士基 | 受控有界面 Chromium 与统一 CLI 通过本地指定查询 | 上海至温哥华四周 5 条、短区间 2 条；宁波至温哥华四周 4 条；重启后上海四周再次 5 条。CY/CY、40 尺高箱；保留官方城市/码头 ID 和各港时区，截单尚未采集；尚未启用 Portal |
| MSC | 官网浏览器返回 7 条；独立 HTTP 返回 403 | 用户确认本次条款后查询上海 CNSHA → 温哥华 CAVAN、9 月 28 日起，返回 7 条 CHINOOK 航线；其中 3 条在 10 月 25 日前离港。真实接口已定位，但相同公开参数的独立请求返回 Access Denied |

只把前三家本次通过的来源标为 `live_verified`。这表示已观察航线的实时取数，不是全球航线覆盖、承运资质、可订舱舱位或正式价格。现有 COSCO/ONE 的历史验收范围保留。

逐条读回船名、航次、起讫港、开航/到达日期并核验保存证据的 SHA-256。来源只给日期时不制造午夜或 UTC；来源航程不以日期差覆盖；船名不用于推断实际承运人。长荣 HTML 的匿名会话标识与脚本在保存前移除。未知页面、源端拒绝、字段变化或地点冲突均保留失败/复核状态。

本机默认 DNS 返回 198.18.*，被现有安全检查拒绝；实查使用忽略目录中的测试预加载器查询公共 DNS，保留 TLS、地址与请求限制。没有修改系统 DNS。页面验收使用仓库内置 fixture 身份和独立临时数据库，取数走真实公开来源；没有生产数据、真实账号或外发操作。

## 续推进：独立浏览器验证

HMM/OOCL 的普通官方表单流程已通过既有 `CarrierBrowserPort` 接入 collector
和独立 CLI。程序自行启动临时 Chromium 会话、选择官方地点、提交只读船期查询，
返回结果后使用原有解析、分窗、证据存储及包络；不导入用户浏览器、Cookie 或 token，
不求解交互验证码。该路径仍未启用到生产 Portal，也未提升两家的能力状态。
CLI 的执行文件及可选既有本机代理端口仅来自管理员环境配置，不能进入业务输入。
临时 CONNECT 通道固定来源的公共 IPv4，保留 TLS、浏览器沙箱、来源路径限制、
取消、请求及响应上限和现有批准期限。没有加入通用爬虫服务或持久会话池。

真实 OOCL 响应暴露的解析缺陷已修复：出发/到达各用自身时区；缺失地点不再拿
查询城市补齐；卡车段保留来源码头/堆场 ID；缺失海运日期、段落或来源总数不会
被当作完整结果；源端错误与明确零条分开。分窗汇总保留子结果的不完整覆盖状态，
并按第一段海运开航日筛选，避免前置门点段导致有效航次被漏掉。
分窗汇总也保留来源的截断标记；浏览器对已禁止的超大统计请求只做阻断，
不再误终止允许的船期查询，允许请求的大小限制仍然生效。两处均先复现测试失败
再修复。

独立 Edge 和匹配版本 Chromium 的尝试均未通过：HMM 返回 Access Denied；
OOCL 最后一次为 HTTP 451，正文是通用的不可显示错误页，未给出可确认的具体原因。
这只能证明当前程序访问路径被拒绝，不能证明换库能解决，也不能推断必须购买 API。
本次再次实查 EMC/SML/YML 返回 5/4/4 条并通过证据哈希和离港日期检查；EMC 首次
遇到一次传输超时，独立重试恢复，说明可用性仍受来源响应影响。
记录保存在忽略目录中的 `browser-collector-acceptance.json`、
`hmm-cli-chromium.json`、`oocl-cli-chromium.json` 和 `*-browser-regression*.json`。

随后 MSK 和 MSC 的官网浏览器分别取得 5 条和 7 条实际航次。MSK 还返回截单信息；
MSC 的 7 条覆盖到 11 月，按原 28 天窗口仅有 3 条，不能把总条数当作区间条数。
实际响应保存在 `msk-browser-result.json` 和 `msc-browser-result.json`，截图配套留存。
浏览器实查不等于无人值守程序可用，尚未将两家开放到 Portal。MSC 单次查询的条款
确认也不代表获得商用再分发许可。

MSK 独立程序在允许必要公开脚本后可以加载表单，但本机代理及直连两条受控路径的
地点请求均出现 `net::ERR_HTTP2_PROTOCOL_ERROR`；HTTP/1.1 诊断也未完成查询。
本地假代理验证未复现“握手超时提前关闭已建立隧道”的猜测，因此没有据此改超时。
另实连 Maersk 域名下的公开 MCP 服务，初始化、目录及 `get_schedules` 均返回 200，
但后者只有 `{ "error": "none" }` 和交互组件，不含航次列表，不能算程序取数成功。
这些初期失败与官网浏览器成功均独立记录；后续受控有界面采集成功见下节，
不以早期失败推断当前程序仍不可查询。
MCP 组件的公开脚本仍访问同组 `api.maersk.com` 数据接口。MSC 独立 HTTP 验证
只复用了公开表单参数，没有复制浏览器 Cookie、请求头或 token，结果为 403。

## 续推进：官方 PDF 与下载入口

新增本地开发探测脚本 `tools/probe_oocl_pdf.py`，使用已安装的 curl/pdfplumber，
不新增依赖、服务或 Portal 能力。固定下载 OOCL PNW2/PNW3 官方航线 PDF，按同船
挂港先后匹配起讫港；验证布局、船名航次、文件日期与大小，保留原始日期单元格及
来源哈希。文件省略年份，依据更新日期和航次顺序唯一推断，并明确警告待复核；
不补造时区、承运人、码头、截单或转运。该探测不具备生产传输的 DNS 固定能力。

9 月 27 日程序实时取得 PNW2 的 2 条上海至温哥华船期，离港 9 月 28 日/10 月 10 日，
到港 10 月 13 日/10 月 21 日。PNW3 后续下载返回 403；此前保存的 PDF 可以解析出
3 条，但只计入文件读回，不计为本次实时取数成功。两份文件均经过页面渲染、逐条
字段和 SHA-256 读回检查。输出始终为部分 `manual_review`，所有来源失败才是
`unavailable`，未将 OOCL 提升为 `live_verified`。

WHL 主站及日本站的官方 PDF 入口均返回 HTTP 200 的拦截 HTML，不能按文件名
认定为 PDF。HPL 的另一下载入口同样出现真人验证，用户已选择“暂不验证，继续
其他来源”，本轮不继续该动作。MSC 新匿名浏览器仍为 403；HMM 经既有代理的普通
域名路径也遭拒绝。未据此改动生产 DNS 或放宽连接器安全检查。

## 续推进：MSK 独立 CLI

同一受控浏览器通道在有界面 Chromium 下取得 5 条真实航次，随后接入统一 CLI、
证据存储与结果包络。修复了语言资源参数被白名单误拒绝、地点列表的显示与精确
选择，以及全页脚本加载拖延表单操作的问题；没有复制浏览器凭据或求解验证码。
初期分别加载三个页面的完整 CLI 查询多次超过 120 秒，已改为同一次 CLI 操作内
共用匿名页面，操作结束立即关闭，不跨查询保留会话。修复后 10 月 5—18 日窗口
从来源 5 条中保留 2 条，浏览器阶段耗时 25.391 秒；另起进程重查原四周窗口返回
5 条。全部字段与证据哈希读回通过。仍遵守原 120 秒整体上限和 90 秒浏览器会话
上限；这组实测不构成持续可用性承诺。

另查宁波至温哥华四周返回 4 条。官方地点区分 Ningbo（CNNGB）与 Ningbo(zhoushan)
（CNZOS）；未选 ID 时正确返回地点歧义，再指定官网返回的 `104T898SJZ6GU` 查询。
这组结果也完成逐字段及证据哈希读回，记录为 `msk-cli-ningbo-selected.json`。

新增 Maersk 解析器复用既有分窗及日期筛选，保留官方 GEO ID、RKST、UN/LOCODE
的区别及两端码头时区。同一个来源 route ID 下的不同航次不会被合并；不推断实际
承运人。已核验范围是 CY/CY、40 尺高箱、官网优选海运路线，内陆形态失败闭合。
截单字段为 null 并提示尚未采集。能力目录暂留 `implemented_unverified`，尚未
完成的目标服务器、无界面及生产 Portal 验证不因本地 CLI 成功自动升级。

实际来源记录保存在忽略目录的 `msk-standalone-pinned-success.json`、
`msk-cli-success.json`、`msk-cli-short-shared.json`、`msk-cli-restart.json` 和
`msk-cli-readback.json`，不进入合成 fixture。

## 迁移、回滚与验证

没有数据库迁移。更新程序与 Schema 后可继续使用原请求；已设为 COSCO-only 的部署配置不会自动开放新船公司。生产连通性和页面验收必须在另行授权的发布步骤执行。

回滚可恢复旧构建，或在部署船公司 allowlist 去掉 EVERGREEN/SML/YML；禁用现有船期开关可停止实时查询。保留来源证据，无需删除业务数据。

回归覆盖地点歧义、时间精度、源端拒绝、字段/数量变化、窗口边界、后续窗口失败、表单编码白名单、每次查询预算、个人权限与部署限制、Web/API/CLI 流程。来源原始诊断保存在忽略的 `.runtime/maritime-expansion-20260927/`，不加入测试 fixture。

本地验证命令：

```sh
npm run typecheck
npx vitest run tests/maritime/schedule-collector tests/maritime/schedule-live \
  tests/console/maritime-customer-view.test.ts tests/console/maritime-access.test.ts \
  tests/console/maritime-locations.test.ts tests/e2e/schedule-live-cli.test.ts \
  tests/e2e/schedule-live-mcp.test.ts tests/e2e/schedule-live-managed-provider.test.ts \
  tests/access-gateway/portal-schedule-live-http.test.ts \
  tests/access-gateway/portal-fcl-production-composition.test.ts \
  tests/access-gateway/schedule-provider-health.test.ts
npm run validate:schemas
npm run validate:agent-standards
npm run build:agent-pack
npm run build
git diff --check
```

结果：类型检查通过；28 个测试文件、153 项测试通过；217 个 Schema、11 个示例通过；14 个标准、6 个 profile、5 个模块和 5 个资源通过。22 个改动源码/测试文件的 ESLint 通过。构建通过且生成 Agent pack。浏览器在本地 fixture 服务上完成选船公司、地点确认、查询、查看航次详情，三家计数与 CLI 一致，控制台无 error/warn；验收后退出临时身份并停止测试服务。没有执行生产发布。

续推进最终验证：同组回归现为 **29 个测试文件、165 项通过**；类型检查、本轮
14 个改动源码/测试文件的 ESLint、`git diff --check` 和重新构建均通过；最后两处
修复涉及文件的 ESLint 和浏览器边界测试也已重跑通过。
Schema/Agent 标准校验仍通过。本轮未新增 Portal 页面实测：新增浏览器采集通道
只接到独立 CLI 和可注入的 collector port，等待真实查询验收后再启用生产组装。
没有提交、推送、部署或生产业务验证。

PDF 探测追加验证：`python3 -I tests/maritime/schedule-collector/test_oocl_pdf_probe.py`
的 2 项测试通过，覆盖跨页/跨年、窗口和方向、缺失船名、布局/日期变化、损坏 PDF
及过期来源；新增缺失船名检查先复现失败后修复。PDF 步骤本身未修改 TypeScript
运行时代码。实际来源读回见忽略目录中的 `oocl-pdf-readback.json`。

MSK 接入后的最终全组回归为 **30 个测试文件、170 项通过**；语言资源白名单、
单次操作内页面复用和浏览器失败状态保留检查均先复现失败再修复。类型检查、
本次 6 个相关文件的 ESLint、Schema/Agent 标准校验和构建均通过。

追踪来源：[访问矩阵](../../services/maritime/schedule-collector/docs/carrier-access-matrix.md)。
