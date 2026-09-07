# 原生业务闭环完成 v1

Status: accepted for implementation under the user's ordered delivery request on 2026-09-08. Release authorization is conditional on real configuration and acceptance; this document grants no authority to invent business data or send bookings/email.

## 顺序与合同

1. 混装：既有 quote.zone_preview 输入增加明确版本化 `extensions.cargo_lines_v1`。旧输入仍接受，原生引擎在多件超长但无分组时返回 needs_input，不再把整票件数当超长件数。旧远端适配器不支持此扩展时明确拒绝，不删除字段后降级计算。
2. 原生保存/审核/PDF：沿用新报价单模块的人员、企业、模板、幂等与 PDF 基础设施，将服务器重新计算的原生报价快照绑定到文档记录。来源发布、请求摘要和金额绑定由服务器完成。审核前重新核对来源版本、有效期和总额；客户字段不具备改价权。记录保留原始输入及来源证据，PDF 使用固定快照。
3. 关税更新：受控文件导入、来源/内容哈希核验、变更预览、确认保存草稿和发布；不得将任意 URL 或任意 SQL 变成后台能力。正式源文件/来源更新和实际发布各自留证，不自动将测试数据提升为正式数据。
4. 两种报价：共享有单位、逐组证据的货物/地址/条件模型。Freightcom 只接收明确的实体托盘；不把计费托数当实体数量，不把混装总重平均分给托盘。缺项在查询前列出。所有操作有人员 CLI 同等入口。
5. 正式配置/部署：真实资料与凭证由用户指定；只在配置验证、业务验收和目标环境明确后上线。

## 混装 JSON 与计算

旧输入为总体积、总重、件数、包装、最长边等。新输入保持这些字段，另含：
`extensions: { cargo_lines_v1: [{id,quantity,packaging_type,length_cm,width_cm,height_cm,weight:{mode:"unit_weight"|"line_total_weight",value_kg}}] }`。
总量与逐组推导必须一致。包装为 carton/crate/pallet/bag/other；尺寸与重量为正 decimal string，单位写入字段名称。每组只允许一种重量证据。计费托数为体积折托、重量折托、显式实体托数和特殊货物折托的最大值；特殊货物折托 = 超长件数 × 已发布倍数 + 非超长木箱件数。木箱与超长重叠只计一次。每组尺寸、重量、包装、折托依据进入计算 trace。原代码副本不修改；修复在原生服务适配层实现并记录算法版本。

## 兼容性、验证与回滚

MCP 静态工具名、五状态、查询 Key 权限保持不变；扩展由严格 Schema 验证。验证长短混装、木箱混装、汇总冲突、缺单位/重量口径、旧来源拒绝扩展、来源变更、跨企业、幂等重试、审核和 PDF 固定快照。网页与 CLI 使用同一合同。相关阶段作为可验收候选提交，记录各阶段实际验证。回滚保留业务库与记录，不删除数据；旧代码不能安全读取的新数据应拒绝启动。未完成的阶段不得记为已完成。


## 实施补充：完整包及原配置兼容

线上法规库超过原 JSON 限额，采用受控文件名与 SHA-256 的完整 SQLite 包，SQL 查询实现按原仓库固定提交移植；MCP 注册表不变。接收目录不支持任意路径/URL，包发布检查来源状态、审批引用、ready/test_data 与快照门禁。只读法规导出器不复制业务/身份/凭证表，不将 staged 改成 published。完整包已选择后停用不回落手动 JSON。

运价合同增加 `extensions.origins_v1`（不同起运地的邮编、价格和分区控制）、`extensions.quote_valid_days_v1`（报价有效天数）；询价扩展 `extensions.origin_v1`，表格操作增加可选 origin。三个源未设置的最大值字段允许 null。既有无扩展请求保持兼容；旧远端适配器明确拒绝新扩展。用户确认截止日期 2027-01-01，并授权从运行服务取配置。

原生业务和报价单 SQLite user_version 升至 2；默认其他 Portal 存储仍为 1。旧程序应拒绝版本 2，防止忽略退回状态、来源绑定或完整包选择。回滚必须恢复匹配备份，不能降低版本号绕过检查。正式上线仍受来源就绪、模板、承运商与目标容器验收约束。

## 源配置兼容补充：城市分区

`extensions.postal_city_v1: true` 显式启用原系统的邮编加城市匹配。无此扩展时仍禁止重复邮编；启用后同一邮编可保留不同城市/分区，城市按原系统空白折叠和大写规范化。同一城市仍对应多个分区时返回 manual_review；未提供所需城市时 needs_input，不按第一行、最低价或猜测选区。完整邮编仍优先于 FSA。CSV 合并按邮编、城市、省份匹配，保留不相关的冲突记录；网页配置及 CLI 使用相同合同。此扩展同时作用于 origins_v1。回归包含城市区分、缺城市、同城冲突、表格合并和源表计数对照。
