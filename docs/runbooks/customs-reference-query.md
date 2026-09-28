# 官方关税参考查询

此路径用于正式来源明确返回 `503 data_not_ready` 时提供官方原文候选，不能计算正式应缴税费。接受范围见 [RFC](../rfcs/2026-09-27-customs-reference-query-v1.md)。认证失败、连接失败、资料哈希变化均失败闭合。

在现有 `PORTAL_BUSINESS_CONFIG_FILE` 对应连接增加 `customsReference`，包含绝对 `snapshotFile` 与 `sha256`。文件应归运行用户所有、权限 `0400`，从只读目录挂载。不得接受用户提交的路径、URL 或哈希。移除此配置即可恢复旧来源行为；无需迁移业务数据库。

2026-09-27 候选资料包含 6 个 staged 来源：CN MOF 2026、GACC 2026、MOF 出口税率；CBSA T2026-2 英法版；USITC 2026 Revision 19。共 95,824 条税号、362,453 条原始税率。资料只保留 source_release/source_artifact/nomenclature/tariff_rule；不含用户、凭据或审批记录。SQLite SHA-256 为 `bcf2f933fbb340bc82710bb5e6932faece3f7e2c0b69a13f7e714fb240474379`，大小 211,329,024 bytes。US Revision 19 原件哈希为 `b83a0e40640e0fd36c434a37d0317c51e1d466ce9160613f7384609665128e28`。原件抓取日期随结果返回，不能把历史抓取日期标成当前已复核。

参考查询每个国家最多 9 个不同税号，每个税号最多保留 3 条语言记录，每条最多 100 条原始税率；完整国家税号在所选国家精确匹配，其他国家只展示相同 HS 前缀供对照。中文查询先在当前日期有效的中国官方品名中匹配全部关键词，按品名匹配程度取最多 9 个不同 HS6，再查询美加本国候选；中文匹配依据保留在中国资料页，不冒充目的国品名译文。英文等原文查询保持所选国家关键词匹配，显式 `selectedHs6` 优先。公开原文翻译服务始终不接收用户查询。可选的商品名检索词服务默认关闭，需按下述 v3 合同单独授权启用。跨地区同前缀、父级规则、优惠待遇与原产地条件仍须人工核对；缺税率不代表免税。

中英对照见 [v2 RFC](../rfcs/2026-09-27-customs-bilingual-names-v2.md)。可选 `customsReference.nameTranslation` 形状为 `{"model":"当前已验证模型","apiKeyFile":"/run/secrets/customs-translation-key"}`。凭据文件须为绝对路径、非符号链接，权限 `0400` 或 `0600`，由运行用户可读；不进入仓库或日志。仅翻译公开品名，失败保留原文并显示译文暂不可用；每次最多一个有界批次，重复品名使用缓存。移除该配置可关闭翻译，税号和税率原文查询仍可用。v2 新增候选 `name_translation`，原始来源字段及正式输出版本不变，v1 仍可读。

人工查询结果使用紧凑三列表格，集中展示税率、进口限制、反倾销、反补贴、认证与清关资料；商品品名草案与中英文税则品名分别标示。参考税率仅在税种、待遇、原产地、原始表达、结构化条件、叠加关系、有效期、匹配方式与来源版本一致时合并摘要，并保留所有所属税目及完整原始依据。候选选择优先显示已有中文原文或参考译文，完整中英文候选可展开对照；缺译文不借用其他国家品名。窄屏概览按行重排，候选对照只在局部横向滚动。

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

[v3 修复与可选检索词服务](../rfcs/2026-09-28-customs-reference-search-v3.md) 保留 v1/v2 接收兼容，只读参考查询改用 v3。仅参考品名允许最多 100,000 字符，界面摘要缩略并保留完整来源原文。父级须为有效同国编码前缀；只允许 GACC 显式八位父项与同年 MOF 对应。可选 `searchTerms` 与 `nameTranslation` 配置形状相同，但外送授权独立；未配置时绝不调用。机器检索词在结果中明确展示，不能提供税号、税率或适用性结论。CLI 关税查询默认等待 40 秒，其他命令保持 15 秒。


[v4 监管参考证据](../rfcs/2026-09-28-customs-compliance-reference-v4.md) 增加可选 `customsReference.compliance:{snapshotFile,sha256}`，JSON 文件同样只读挂载、哈希绑定；响应使用 v4，保留 v1–v3 兼容。开启 searchTerms 已获得本任务 2026-09-28 的明确授权；其他环境不默认开启。

采集命令：`python3 services/customs-native/data_pipeline/compliance_reference.py --directory <已核对的美国 China 案件目录.json> --output <证据目录>`。目录包含公开页面 URL、China 查询、实际观察时间、总数和全部案件 ID。脚本保存两国原件及元数据、过滤撤销记录，按 `import-guidance.json` 的官方出处补充条件型指南；最终 `remedies.json` 通过 TypeScript 合同与哈希验证后装载，不是正式规则发布。遇程序抓取受限但官方页面可通过已授权读取工具核对时，可保留实际读取到的公开页面文本快照；原件元数据必须明确 `retrieval_method` 和 `representation`，不得伪称原始 HTTP 字节或静默替换来源。

加拿大目录计数按反倾销／反补贴分项，已撤销的记录单列 excluded_rescinded。美国目录含调查，缺税号或范围的案件计入 missing_details，无法参加税号匹配。输出范围摘录最长 2,000 字符，不是完整排除清单；Web 可打开完整官方案件页面，API/CLI 保留 URL、时间和来源哈希。未命中不代表免征，查询日期与采集日期不一致须显示。指南的章号只是提示入口，税号不是许可证／认证适用性判定。

追加验证：`npx vitest run tests/customs-native/compliance-reference.test.ts tests/customs-native/data-pipeline.test.ts tests/console/customs-reference.test.ts`；生产切换前以只读容器验证中文品名、精确税号、双反关联与否、指南、翻译和 v4 包络。无需业务数据库迁移；保存旧配置和镜像，恢复它们即可回滚，保留切换后业务数据。

品名检索 v4 在同一次已授权请求中增加最多 3 个 HS6 检索方向，服务只接受当前目的国官方资料实际存在的前缀，再从来源读取候选及税率。结果的 `search.hs6_hints` 和界面均明确机器建议；它不能替代商品归类核验。该项取代 v3 仅使用关键词的限制，外送数据范围仍仅为商品查询名称。
