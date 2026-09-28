# 关税参考检索修复 v3

状态：共享检索与资料边界修复按用户 2026-09-28“继续修复”实施；新增商品名称外送检索词服务尚待授权，默认关闭。未取得授权前不配置 `customsReference.searchTerms`。

## 原因与范围

86 个跨品类品名复查发现，按编码排序的字面匹配会把整机关键词出现在零件用途中的记录当作首项；加拿大双语记录挤占候选名额；美国来源错误父级可能带入无关税率；超过 50,000 字符的有效官方品名导致整次查询失败。第 9 个检索词曾被静默丢弃。现有原文翻译合同不能解决商品俗称到法律品名的检索。

共享查询修复完整处理输入关键词，按品名匹配程度排列中国锚点；排除关键词只作为其他商品复合词前缀、零件用途或部件名称的明显误匹配。该词法检查不是语义归类，未覆盖俗称仍可能无结果。各地区先选 9 个不同代码，再保留每代码最多 3 条语言记录；没有新增无上限查询或完整目录分页。

父级只取同国、同语言、当日有效且为自身编码严格前缀的税目；优先同来源。仅允许 GACC 明确指向的八位父项连接到同年度 MOF `customs_tariff_8_digit` 数据集，且只能有一个匹配；不存在通用跨版本回退。错误原始 `parent_code` 与行哈希保留作证据，错误父项不进入有效层级和税率。缺失无编码标题仍提示层级不完整，不合成官方文字。参考行品名上限独立提高到 100,000 字符；其他管理/正式合同上限不变。

## 兼容合同

`customs.query` 输入、权限、额度与命令不变，正式响应不变。参考输出改为 `portal-customs-reference@2026-09-28.v3`，保留 v1/v2 接收和渲染兼容。仍只有 `manual_review`、`formal_ready:false`，不提供应缴税额或正式归类结论。

旧形状：`{"schema_version":"portal-customs-reference@2026-09-27.v2","status":"manual_review","data":{"candidates":[{"item":{},"hierarchy":[],"rates":[],"name_translation":null}]},"reason_codes":["customs_reference_only"]}`。

新形状保留上述字段，`data.candidates` 上限 81；仅参考品名 `description_original` 上限 100,000；可附带闭合对象 `search:{"terms":["用户商品名称","建议法律检索词"],"assisted":true}`，最多 7 个词组。完整必填及来源字段以生成 Draft 2020-12 Schema 为准。UI 展示建议检索词，API/CLI 返回同样来源、候选及警示。机器建议永远不能提供税号或税率；所有返回行仍从哈希绑定的只读官方资料查得。

## 可选通用品名检索词服务

复用既有 DeepSeek 模型与受保护凭据，但使用独立配置 `customsReference.searchTerms`（与 `nameTranslation` 相同的 `model`、`apiKeyFile` 形状）。只有明确启用才发送商品名称；材质/用途附加字段、客户身份、租户、凭据、历史、业务材料均不进入请求。数字税号和显式 HS6 查询不调用模型。不更改现有仅翻译公开原文的 `nameTranslation`。

固定官方 HTTPS 接口、拒绝重定向。每次至多一批商品名称，最多 500 字符、800 输出 tokens、12 秒超时、2 个在途请求；无自动重试，失败冷却 30 秒。严格校验最多 6 个中英文词组，每种语言最多 3 个，每组最多 100 字符；拒绝模型生成税号字段、税率、URL、额外字段、截断输出及非法语言。返回词组只供本地查找官方记录，并明确标作机器建议；不参与正式规则、措施与发布审批。无法生成时保留原始关键词查找并提示。

此项扩大了旧 v2 RFC 的数据外送范围，须明确授权后才能启用和进行真实调用。模型是否能为所有俗称给出有用词组尚待真实跨品类验证；不能把合成测试或非空候选视为归类正确。

## 迁移、验证与回滚

不修改官方快照或业务数据库，不伪造正式发布。代码、生成 Schema、OpenAPI、Web 和 CLI 同步发布；先运行错误父级、超长品名、不同代码计数、整机/零件错配与关键词完整性回归，再对真实只读快照执行跨品类查询与分章精确查询。新增外送服务先以假 HTTP 验证字段最小化、失败闭合和数字税号不外送；取得授权后再验证真实服务和线上读回。

验证：`npx vitest run tests/customs-native/reference.test.ts tests/customs-native/search-term-suggestions.test.ts tests/console/customs-reference.test.ts tests/access-gateway/portal-business-access-http.test.ts tests/e2e/freightclaw-cli.test.ts`；类型、lint、Schema/OpenAPI、Agent 校验及构建。发布遵循现有备份、候选容器、CI 与读回流程。回滚恢复旧镜像/配置即可；单独移除 `searchTerms` 可关闭名称外送，保留只读原文查询与显示翻译。

进口限制、反倾销、反补贴、认证及单证来源缺口不在本修复中冒充完成；缺少资料持续显示待核验，不得生成无措施或免税结论。
