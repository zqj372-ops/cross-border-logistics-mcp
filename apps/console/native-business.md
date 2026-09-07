> 配置入口已统一到「服务市场 → 模块配置」。加拿大尾程询价对应固定私人地址运价，承运商 LTL 询价对应 Freightcom，两个关务模块共用同一份关务配置。旧业务管理链接继续兼容跳转；本文的保存、核验、发布和 CLI 操作保持有效。

# 关务与私人地址业务后台

后台入口：账号 → 业务管理。当前企业的负责人、管理员可修改配置；普通成员只可查询。平台角色不代替企业身份修改此处配置。账号菜单、顶部导航和工作台的「业务管理」统一进入状态总览，再进入关务管理、私人地址运价或外部连接。三个业务与 CLI 共用接口。

私人地址是每企业一套固定派送配置，不建立或选择渠道。旧渠道页面仅保留其他运输业务的历史资料入口，不参与私人地址计价。工作台展示本人实际提交的询价及处理状态；服务市场负责发现和进入服务，避免重复摆放能力卡片。

## 从空白开始

新库不加载旧运价、关务数据、业务记录或承运商凭证。先保存草稿，再核验预览并确认发布。保存草稿不改变当前版本。支持停用与预览回退；回退只选择本企业的历史版本。查询只使用当前发布，失败不调用旧服务兜底。

关务数据格式校验不是法规真实性证明。发布人必须核对官方来源、数据完整性、适用条件和日期。系统保留来源版本、文件/行哈希、发布摘要和确认操作，不将测试数据提升为正式来源。尚未发布时返回 unavailable。

## 关务独立页面

`#business-admin/customs-data/` 下分为 `nomenclature`（税号目录）、`tariffs`（税率）、`measures`（贸易措施）、`requirements`（单证要求）、`sources`（来源）、`import`（导入）、`publish`（核验与发布）。目录支持国家与关键词过滤，每页 25 条，可展开完整记录与来源引用。

默认查看当前发布数据；选择「已保存草稿」并搜索可核对待发布内容。没有发布时保持空状态，不把草稿当成有效数据。

## 关务数据导入

上传归一化 JSON 数据包，最大 16 MiB。可以使用原 RiskCustoms 导出/解析环节生成的数据，但不导入旧账户、凭证或查询记录。当前上传入口接受归一化数据，不直接解析官方 PDF、HTML 或任意 Excel。

数据字段：`label`、`rule_date`、`test_data`、`sources`、`nomenclature`、`tariffs`、`measures`、`requirements`。每一记录必须关联来源版本、artifact、定位和 SHA-256；税号要包含法定名称、语言、层级和经确认的 HS6 映射。需要完整上级层级时，必须一并导入上级记录。缺少映射、税率或适用条件时保留补充输入/人工复核。

跨币种估算还需要 `exchange_rates`：`effective_date`、`expires_at`、`fetched_at`、`source_url`、`source_authority`（CBSA/BoC）、`usd_to_cad`、`cny_to_cad`。汇率来自已核对的官方记录，金额和汇率使用十进制字符串。没有覆盖日期的汇率时不换算；同币种估算无需换汇。

完整字段格式通过 CLI 查看：

```sh
freightclaw workspace schema customs-data save
```

网页上传的是上面 Schema 中 `input` 对应的数据包；CLI 保存输入还需要 `expected_version`。首次保存填 0，后续以 get 回读的 version 为准。

## 私人地址运价

`#business-admin/residential-rates/` 下按任务分为五页：

1. `base`：基本资料、固定始发仓、来源协议与版本、有效期和客户条件。
2. `coverage`：邮编覆盖，逐条维护邮编、分区、城市与省份。
3. `pricing`：价格档位、体积/重量折托、超长与复核阈值。
4. `fees`：住宅、尾板、地牛、预约、等待和燃油费用。
5. `publish`：核验、确认发布、停用与历史回退。

价格按分区 × 托数矩阵维护，支持直接改价、分区启停和独立燃油比例；新增或删除档位、计费阈值放在可展开区域。邮编支持分区、城市、邮编及省份搜索，行编辑器可添加、删除和翻页。页签切换保留本次输入；「保存全部草稿」校验整份配置，首次配置需填齐各页后保存。刷新或关闭浏览器时会提示仍有未保存修改；未保存输入不会自动写入服务器。预览确认时只显示一次配置摘要。

- 自有运价当前使用 USD；不自动将其他币种换成美元。
- 精确邮编优先于前三位；重复覆盖或重复价格档位阻止发布。
- 不自动猜始发仓，不在缺少的托数档位间插值，不套用旧燃油或附加费。
- 空白费用不是免费；明确免费填字符串 `"0"`。
- 私人地址入口要求明确住宅类型和卸货条件。查询只做试算，不发邮件、不订舱。

Freightcom 是外部承运商 API。后台保存的正式凭证按企业隔离并加密，回读只显示是否存在。保存成功不等于实际询价已验证。住宅目的地按 B2C/C2C 提交，尾板和预约条件随请求明确传递；承运商价格保留原币种。

## 表格批量维护

价格与邮编页可下载空白 CSV 模板、导入 CSV/XLSX/XLS、导出当前编辑中的草稿。最大 5 MiB、5000 行、100 列；XLSX/XLS 读取首张工作表并显示表名。公式必须先粘贴为值，不能用公式缓存当正式价格。

价格支持两种原后台格式：`分区、托数、价格` 明细表，或 `分区、1托、2托…` 矩阵表。可附 `始发仓、燃油比例、启用`；始发仓存在时必须匹配当前固定仓。邮编表使用 `邮编、分区、城市、省份`。来源及有效期仍需在基本资料中明确填写，不从旧系统自动带入。

导入先显示错误行、识别条数及新增/覆盖数量。确认后按分区/托数或邮编合并到编辑中的草稿，未涉及条目保留；再保存全部草稿、核验、确认发布。空的矩阵价格表示不导入该格，0 表示明确免费；若要删除已有价格请在编辑器删除。导入燃油/启用列留空会保留对应已配置值，避免改燃油时重新启用停用分区。界面上清空独立燃油则明确使用本版本全局比例。

分区禁用会保留数据，并让该区查询转人工复核。发布页直接展示价格、费用、计费阈值和分区例外；大表展示前 100 条，可先在维护页筛选核对全部或导出完整数据。

## CLI

使用当前分支构建的 CLI；线上 0.1.0 下载包尚未更新为本次工作台功能。生产配置与网页部署后才可从生产地址使用新操作。CLI 通过浏览器确认获得独立人员会话；现有查询 API Key 不增加后台管理权限。

```sh
freightclaw workspace login start --endpoint http://127.0.0.1:8907 --session-file /private/path/fc-session.json
# 浏览器核对代码并确认后：
freightclaw workspace login finish --session-file /private/path/fc-session.json
freightclaw workspace commands
freightclaw workspace customs-data get --session-file /private/path/fc-session.json
freightclaw workspace customs-data browse --input filters.json --session-file /private/path/fc-session.json
freightclaw workspace residential-rates get --session-file /private/path/fc-session.json
freightclaw workspace freightcom get --session-file /private/path/fc-session.json
```

当前构建包含 43 条 workspace 命令。新增 `customs-data browse` 对已有受权限保护的 get 结果进行本地检索，网页使用相同规则，不新增服务端写入口。`filters.json` 示例：

```json
{"selection":"published","collection":"nomenclature","country":"CA","query":"732393","offset":0,"limit":25}
```

`selection` 可选 `published` / `draft`；`collection` 可选 `nomenclature` / `tariffs` / `measures` / `requirements` / `sources`。默认当前发布、全部国家、每页 25 条；CLI 单页最多 100 条，结果带版本、总数和来源字段。

表格操作也可在 CLI 完成，原文件在本机解析：

```sh
freightclaw workspace residential-rates import-preview --file rates.xlsx --input table-options.json --session-file /private/path/fc-session.json
freightclaw workspace residential-rates export --file published-rates.csv --input published-table.json --session-file /private/path/fc-session.json
```

`table-options.json` 为 `{"table":"rates","selection":"draft"}`，邮编使用 `zones`；`published-table.json` 改为 `selection: "published"`。导入要求已有完整草稿，返回 `data.save_input`，核对后将此对象保存为 JSON，再用既有 `residential-rates save` 提交。预览不写库；导出文件采用新建模式，已有文件不会覆盖。首次配置也可通过 `schema residential-rates save` 准备完整 JSON。

两种数据都支持 get、save、preview、publish、disable、rollback。写命令需 `--idempotency-key`，同一次重试保持相同值；保存与发布是两个不同请求。发布输入为 `expected_version`、预览回读的 `preview_hash`、`confirmation: "reviewed_sources_and_conditions"`。回退预览：`preview --input target.json`，target.json 为 `{"release_id":"选定历史版本UUID"}`；确认回退额外携带 release_id。

Freightcom 支持 get/save/disable。凭证仅从权限为 0600 的输入文件或标准输入读取，不放在命令参数里。save 字段见 `workspace schema freightcom save`，确认值为 `use_for_current_organization`。

查询命令：`workspace customs query`、`workspace tax estimate`、`workspace tax batch`、`workspace quote self`、`workspace quote freightcom`，均用 `--input request.json --session-file ...`。输入格式用 `workspace schema <命令>` 查看。只读查询不用提供幂等键。关务个人历史使用 `workspace customs-history list/get`；服务身份和匿名查询不写入个人历史。

原有使用统一 API Key 的业务 CLI 仍使用原操作和合同，由现有企业授权决定访问范围。未登录关税每日 20 次与尾程登录要求不变。

## 运行与数据边界

自有引擎与管理库需要 Node.js 22.13+、Python 3。生产当前支持单实例本地 SQLite；PostgreSQL 多实例管理库尚未适配，启动时拒绝混用。业务库和随库加密密钥应一并备份并限制文件权限。CLI 授权待确认状态在当前进程内，重启需重新发起确认。

报价核心来自冻结的 Python 版本，关务核心来自冻结的 RiskCustoms TypeScript 版本。迁入文件、提交和修改后的哈希见各自 provenance.json。代码可运行、数据已发布、承运商实际成功、生产已部署是不同状态，应分别核验。

## 私人地址资料解析

从服务市场的「询价资料提取」或私人地址询价页面进入。原生模式不需要模型密钥，也不调用旧报价网站；报价运价仍须另行配置、核验和发布。

粘贴文字后点击「提取资料」，核对逐行件数、尺寸、单重／行总重、体积及原文依据。缺少单位不会默认厘米；多件货物只写一个重量时，需说明是单件还是总重。多个地址或合计冲突会保留待确认项，不选取看起来合理的值。尾板、地牛、预约未提及则保持待确认。确认下方表单后才能试算；重新解析会清除上次试算与确认状态。

```sh
freightclaw workspace schema quote extract --json
freightclaw workspace quote extract --session-file ./session.json --input inquiry.json
# 使用已开通 quote.ai_extract_preview 权限的统一 API Key：
freightclaw quote extract --input inquiry.json
```

`inquiry.json` 内容为 `{"customer_message":"2纸箱 每件10kg 100x100x100cm\n住宅 M1B5W9"}`。退出码 3 表示仍需补充，4 表示存在待复核冲突；JSON 保留已识别的行和依据，不表示接口调用失败。不要将尚有 missing_fields 的结果直接用作已确认报价输入。

当前支持文本和粘贴的制表符／竖线表格。表头须声明件数、尺寸及重量单位，重量需注明单重或总重。不接收图片／PDF，不做地址地图验证，也不自动保存正式报价、审核或发邮件。原生报价记录、审核和正式文档迁移仍是独立待交付环节。
