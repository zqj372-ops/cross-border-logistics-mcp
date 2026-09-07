# 关务与私人地址业务后台

后台入口：账号 → 业务管理。当前企业的负责人、管理员可修改配置；普通成员只可查询。平台角色不代替企业身份修改此处配置。三个入口与 CLI 共用接口：关务数据、私人地址运价、Freightcom 连接。

## 从空白开始

新库不加载旧运价、关务数据、业务记录或承运商凭证。先保存草稿，再核验预览并确认发布。保存草稿不改变当前版本。支持停用与预览回退；回退只选择本企业的历史版本。查询只使用当前发布，失败不调用旧服务兜底。

关务数据格式校验不是法规真实性证明。发布人必须核对官方来源、数据完整性、适用条件和日期。系统保留来源版本、文件/行哈希、发布摘要和确认操作，不将测试数据提升为正式来源。尚未发布时返回 unavailable。

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

先维护始发仓、来源协议与版本、有效期、客户派送条件，再填写邮编分区、价格档位、体积/重量折托、超长与复核阈值、住宅/尾板/地牛/预约/等待费用。

- 自有运价当前使用 USD；不自动将其他币种换成美元。
- 精确邮编优先于前三位；重复覆盖或重复价格档位阻止发布。
- 不自动猜始发仓，不在缺少的托数档位间插值，不套用旧燃油或附加费。
- 空白费用不是免费；明确免费填字符串 `"0"`。
- 私人地址入口要求明确住宅类型和卸货条件。查询只做试算，不发邮件、不订舱。

Freightcom 是外部承运商 API。后台保存的正式凭证按企业隔离并加密，回读只显示是否存在。保存成功不等于实际询价已验证。住宅目的地按 B2C/C2C 提交，尾板和预约条件随请求明确传递；承运商价格保留原币种。

## CLI

使用当前分支构建的 CLI；线上 0.1.0 下载包尚未更新为本次工作台功能。生产配置与网页部署后才可从生产地址使用新操作。CLI 通过浏览器确认获得独立人员会话；现有查询 API Key 不增加后台管理权限。

```sh
freightclaw workspace login start --endpoint http://127.0.0.1:8907 --session-file /private/path/fc-session.json
# 浏览器核对代码并确认后：
freightclaw workspace login finish --session-file /private/path/fc-session.json
freightclaw workspace commands
freightclaw workspace customs-data get --session-file /private/path/fc-session.json
freightclaw workspace residential-rates get --session-file /private/path/fc-session.json
freightclaw workspace freightcom get --session-file /private/path/fc-session.json
```

两种数据都支持 get、save、preview、publish、disable、rollback。写命令需 `--idempotency-key`，同一次重试保持相同值；保存与发布是两个不同请求。发布输入为 `expected_version`、预览回读的 `preview_hash`、`confirmation: "reviewed_sources_and_conditions"`。回退预览：`preview --input target.json`，target.json 为 `{"release_id":"选定历史版本UUID"}`；确认回退额外携带 release_id。

Freightcom 支持 get/save/disable。凭证仅从权限为 0600 的输入文件或标准输入读取，不放在命令参数里。save 字段见 `workspace schema freightcom save`，确认值为 `use_for_current_organization`。

查询命令：`workspace customs query`、`workspace tax estimate`、`workspace tax batch`、`workspace quote self`、`workspace quote freightcom`，均用 `--input request.json --session-file ...`。输入格式用 `workspace schema <命令>` 查看。只读查询不用提供幂等键。关务个人历史使用 `workspace customs-history list/get`；服务身份和匿名查询不写入个人历史。

原有使用统一 API Key 的业务 CLI 仍使用原操作和合同，由现有企业授权决定访问范围。未登录关税每日 20 次与尾程登录要求不变。

## 运行与数据边界

自有引擎与管理库需要 Node.js 22.13+、Python 3。生产当前支持单实例本地 SQLite；PostgreSQL 多实例管理库尚未适配，启动时拒绝混用。业务库和随库加密密钥应一并备份并限制文件权限。CLI 授权待确认状态在当前进程内，重启需重新发起确认。

报价核心来自冻结的 Python 版本，关务核心来自冻结的 RiskCustoms TypeScript 版本。迁入文件、提交和修改后的哈希见各自 provenance.json。代码可运行、数据已发布、承运商实际成功、生产已部署是不同状态，应分别核验。
