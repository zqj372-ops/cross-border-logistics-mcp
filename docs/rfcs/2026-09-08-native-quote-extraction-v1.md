# 原生询价资料解析 v1

状态：实施规范，属于用户 2026-09-08 明确授权的源代码迁移及解析加强。仅替换 nativeQuote 的资料提取实现；不增加 MCP 工具、权限、写操作或 Phase 1 合同。

## 来源与兼容

核对用户所有的 `canada-final-mile-auto-quote` 当前 main：`e7d26d9711ea2183dacea9ab6016008f5ad64ff1`。此前已移植该版本的计价引擎；本次依据其中前后端解析器的词法、单位换算和行／合计处理迁移为单一服务端实现。文件哈希及改写范围见 `services/quote-native/provenance.json`。不复制旧配置、凭证、历史记录或自动通知逻辑。

旧请求、新请求均为现有 `quote.ai_extract_preview` 的 `{ "customer_message": "…" }`。保留 `portal-quote@2026-09-05.v1` / `quote-preview@2026-09-05.v2`，闭合输入／输出 Schema 不变。旧 native 实现返回 `unavailable/native_extraction_not_configured`；新实现返回既有 `extraction_mode=deterministic_recovery`，`quote_result=null`、`saved=false`、`sendable=false`。不谎称调用了 AI。

`cargo_items` 保留 quantity、单件尺寸／重量、行体积／行总重及 source_span；`missing_fields` 是当前需要确认的字段。Boolean 的既有合同不能表达 null：未提供的服务条件仍列入 missing_fields，网页转为未选择，CLI 文档要求调用方检查状态和 missing_fields。无缺项也只代表解析完成，不代表客户确认或正式报价。

## 证据与计算

金额不进入解析。测量值以 decimal string 和字段单位返回；decimal.js 精确换算 cm/mm/m/in/ft、kg/lb/g/t、cbm/cu ft。原文缺数量、缺单位、多件货物不明重量口径均不默认。行总重不会除以件数伪造成单重；总重／体积／件数与逐行合计矛盾时清空冲突合计并返回 manual_review。部分行缺值不把已识别子集当整票总量。

只解析当前请求的文字，不查询地理服务、不接受模型产生的确认字段、不调旧系统、不写业务库、不发送通知。原文仅在本次响应的证据跨度中返回，不进入日志；来源引用只保留输入哈希、解析器版本和请求内 locator。

20,000 字符、150 个输入行、100 个货物组与数值长度上限。复杂分组无法明确归属时要求拆行。表格按声明表头列和单位识别，不按裸数字位置推断重量。

## 接入与权限

沿用 Portal 会话和业务应用 grant；未登录不能查询私人地址。人员 CLI 新增 `workspace quote extract`，API Key CLI 继续使用原有 `quote extract`。操作只在连接显式启用 quote.ai_extract_preview 时开放。无需发布运价即可提取，后续试算必须经过既有正式运价发布门槛。

## 验证与回退

回归覆盖前缀件数、每件／总重、多行不完整、混合单位、总量冲突、单位缺失、表格列顺序、未知／矛盾卸货条件、输入注入及尺寸／数量边界。网页验证原文→解析→人工确认→合成已发布运价试算、重新解析清除旧结果；CLI 校验同样结果。原有网关授权、CLI 打包和原生引擎回归照常运行。

回退为恢复原 native 提取 unavailable 实现或从部署连接移除该 operation；不涉及数据迁移、历史删除或旧服务默认回退。生产尚未部署，完整原生报价记录、审核和正式文档不属于本解析增量的完成声明。
