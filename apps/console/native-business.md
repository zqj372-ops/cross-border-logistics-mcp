# 原生业务配置

[人员 CLI](workspace-cli.md) / 关务、私人地址与承运商

入口：**能力市场 → 对应模块 → 模块配置**。本页说明原生模块；个人整柜的海运费和费用模板使用独立 FCL 操作，不要套用本页私人地址运价的有效期规则。

## 配置顺序

```text
保存草稿 → 核验来源与预览 → 确认发布 → 查询读回
                              ↓
                     必要时停用 / 预览回退
```

新库不加载旧运价、业务记录或凭证。保存草稿不改变当前发布。回退只能选择当前授权范围的历史版本；查询失败不会调用旧服务兜底。

当前原生模块沿用其既有配置归属与管理角色。查询、配置和应用 Key 权限分别校验，不因个人 FCL 免建企业而自动改变其他模块的合同。

## 关务数据

关务配置分为税号目录、税率、贸易措施、单证要求、来源、导入与发布。默认查看当前发布，可切换草稿；目录每页 25 条，支持国家、关键词和来源查看。

| 方式 | 输入与要求 |
| --- | --- |
| JSON 补录 | 最大 16 MiB；归一化包，不直接解析任意 PDF / HTML / Excel |
| 完整数据更新 | 维护人员传入接收目录的 SQLite 快照；核对哈希、来源和就绪状态 |
| 发布 | 核对官方来源、完整性、适用条件和日期；格式合法不等于法规已核验 |

JSON 包包含 label、rule_date、test_data、sources、nomenclature、tariffs、measures、requirements。记录关联来源版本、artifact、定位和 SHA-256；税号带法定名称、语言、层级及确认过的 HS6 映射。缺税率、映射或条件时保留待补充或人工复核。

跨币种估算需要经核对的 CBSA/BoC 汇率记录：effective_date、expires_at、fetched_at、source_url、source_authority、usd_to_cad、cny_to_cad。没有覆盖日期的汇率不换算；同币种无需汇率。完整字段以 Schema 为准：

```sh
freightclaw workspace schema customs-data save
freightclaw workspace customs-data get --session-file session.json
freightclaw workspace customs-data browse --input filters.json --session-file session.json
```

`filters.json` 示例：

```json
{"selection":"published","collection":"nomenclature","country":"CA","query":"732393","offset":0,"limit":25}
```

selection 为 published/draft；collection 可选上述集合。CLI 单页最多 100 条。完整快照用 `customs-packages list/import/browse/publish/disable`；未就绪版本可浏览，不能启用。JSON 发布不会替换已选中的完整数据包。

## 私人地址自有运价

| 页面 | 维护内容 |
| --- | --- |
| 基本资料 | 固定始发仓、来源、版本、有效期和客户条件 |
| 邮编覆盖 | 邮编、分区、城市和省份 |
| 价格档位 | 分区 × 托数、体积/重量折托、超长与复核阈值 |
| 附加费用 | 住宅、尾板、地牛、预约、等待和燃油 |
| 核验发布 | 草稿摘要、发布、停用和历史回退 |

Toronto、Calgary 按不同起运地维护价格、邮编、燃油和分区开关；共同条款、附加费和有效期共享。通过 origins_v1/origin_v1 扩展明确起运地，不能擅自猜测。

- 当前自有运价使用 USD，不把其他币种重标为美元。
- 精确邮编优先；重复覆盖或档位阻止发布。城市分区模式要求必要的城市信息，冲突保留人工复核。
- 不在缺失档位间插值，不套用旧燃油。空白不等于免费，明确免费使用字符串 `"0"`。
- 停用分区保留数据，并让该区查询转人工复核。未设重量等上限不代表免除复核。
- 保存完整草稿后再发布，页面未保存输入不会自动写入服务器。

这里的运价仍有有效期；原生正式报价有效天数不得晚于运价截止。**不将此规则套到整柜海运费表或其他费用模板。**

## 批量维护表格

支持 CSV/XLSX/XLS，最大 5 MiB、5000 行、100 列，Excel 读取首张表。公式先粘贴为值，不使用缓存作为正式价格。

| 表 | 列 |
| --- | --- |
| 价格明细 | 分区、托数、价格 |
| 价格矩阵 | 分区、1托、2托…；可附始发仓、燃油比例、启用 |
| 邮编 | 邮编、分区、城市、省份 |

先看错误行、新增与覆盖数量，确认合并到草稿，再保存、核验和发布。未涉及条目保留；矩阵空格不导入，0 表示明确免费。删除记录用编辑器；燃油/启用列留空保留已有值，清空页面中的独立燃油则使用本版本全局比例。

```sh
freightclaw workspace residential-rates import-preview --file rates.xlsx --input options.json --session-file session.json
freightclaw workspace residential-rates export --file published-rates.csv --input selection.json --session-file session.json
```

options 可为 `{"table":"rates","selection":"draft"}`，邮编用 zones，按需要增加 origin。导入要求已有完整草稿，预览返回 data.save_input，核对后使用 save。导出不覆盖已有文件。

## 私人地址资料解析

自有运价和 Freightcom 是两条独立报价路径，各自填写资料。Freightcom 每行代表一个实体托盘，填写重量、尺寸、件数、描述及货运等级；保留原币种。凭证按既有归属隔离、加密，不回显。保存连接不等于真实询价已验证。

资料提取支持文字和带单位的文本表格，不处理图片/PDF、不做地图地址验证。未知单位、单重/总重和冲突地址保留待确认；核对后再试算。试算不会自动发送邮件或订舱。

```sh
freightclaw workspace schema quote extract
freightclaw workspace quote extract --input inquiry.json --session-file session.json
freightclaw workspace quote self --input quote.json --session-file session.json
freightclaw workspace quote freightcom --input carrier.json --session-file session.json
```

## CLI 写入与运行

get/save/preview/publish/disable/rollback 使用当前版本、预览哈希及幂等键。发布确认值为 reviewed_sources_and_conditions；回退先预览指定 release_id。Freightcom 提供 get/save/disable，凭证只从私有输入文件或 stdin 读取，不写在参数中。

原生引擎需要 Node.js 22.13+ 与 Python 3，管理库当前为单实例本地 SQLite；不与 PostgreSQL 模式混用。数据库与加密密钥一并备份。CLI 待确认授权在进程内，重启后重新发起。

原生代码来源见各服务 provenance.json。代码运行、数据发布、供应商成功和生产上线分别核验。船期/码头的人工发布快照与受控采集器是不同能力，查询来源 URL 不会触发任意网站抓取。
