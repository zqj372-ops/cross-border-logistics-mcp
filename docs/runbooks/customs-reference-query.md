# 官方关税参考查询

此路径用于正式来源明确返回 `503 data_not_ready` 时提供官方原文候选，不能计算正式应缴税费。接受范围见 [RFC](../rfcs/2026-09-27-customs-reference-query-v1.md)。认证失败、连接失败、资料哈希变化均失败闭合。

在现有 `PORTAL_BUSINESS_CONFIG_FILE` 对应连接增加 `customsReference`，包含绝对 `snapshotFile` 与 `sha256`。文件应归运行用户所有、权限 `0400`，从只读目录挂载。不得接受用户提交的路径、URL 或哈希。移除此配置即可恢复旧来源行为；无需迁移业务数据库。

2026-09-27 候选资料包含 6 个 staged 来源：CN MOF 2026、GACC 2026、MOF 出口税率；CBSA T2026-2 英法版；USITC 2026 Revision 19。共 95,824 条税号、362,453 条原始税率。资料只保留 source_release/source_artifact/nomenclature/tariff_rule；不含用户、凭据或审批记录。SQLite SHA-256 为 `bcf2f933fbb340bc82710bb5e6932faece3f7e2c0b69a13f7e714fb240474379`，大小 211,329,024 bytes。US Revision 19 原件哈希为 `b83a0e40640e0fd36c434a37d0317c51e1d466ce9160613f7384609665128e28`。原件抓取日期随结果返回，不能把历史抓取日期标成当前已复核。

参考查询每个国家最多 9 条候选、每条最多 100 条原始税率；完整国家税号在所选国家精确匹配，其他国家只展示相同 HS 前缀供对照。中文查询先在当前日期有效的中国官方品名中匹配全部关键词，取最多 9 个不同 HS6，再查询美加本国候选；中文匹配依据保留在中国资料页，不冒充目的国品名译文。英文等原文查询保持所选国家关键词匹配，显式 `selectedHs6` 优先。此路径不把用户查询发送给翻译服务，不猜俗称或商品属性。跨地区同前缀、父级规则、优惠待遇与原产地条件仍须人工核对；缺税率不代表免税。

中英对照见 [v2 RFC](../rfcs/2026-09-27-customs-bilingual-names-v2.md)。可选 `customsReference.nameTranslation` 形状为 `{"model":"当前已验证模型","apiKeyFile":"/run/secrets/customs-translation-key"}`。凭据文件须为绝对路径、非符号链接，权限 `0400` 或 `0600`，由运行用户可读；不进入仓库或日志。仅翻译公开品名，失败保留原文并显示译文暂不可用；每次最多一个有界批次，重复品名使用缓存。移除该配置可关闭翻译，税号和税率原文查询仍可用。v2 新增候选 `name_translation`，原始来源字段及正式输出版本不变，v1 仍可读。

验证命令：

```sh
npx vitest run tests/customs-native/reference.test.ts tests/access-gateway/portal-customs-client.test.ts tests/access-gateway/portal-tax-client.test.ts tests/access-gateway/portal-public-customs.test.ts tests/access-gateway/portal-public-quota.test.ts tests/access-gateway/portal-business-access-http.test.ts tests/console/customs-reference.test.ts tests/e2e/freightclaw-cli.test.ts tests/e2e/freightclaw-cli-package.test.ts
npm run typecheck
npm run lint
npm run validate:schemas
npm run validate:portal-openapi
npm run validate:agent-standards
npm run build
npm run build:cli
```

发布时保留旧镜像、配置和业务数据库备份；先以无业务写入的独立容器核对真实资料与来源状态，再切换 Portal。读回 readyz、匿名查询、来源版本、候选状态与未发布税费拒绝时的额度。Web/API/CLI 均不得把参考响应升级为 success。CLI 对 manual_review 返回退出码 4。

正式税费仍须完成附加税与贸易救济、排除条款、待遇资格、汇率及叠加矩阵的来源核验与审核发布。不得以本参考资料哈希代替正式 publication_snapshot，也不得为解除门禁编造审批记录。
