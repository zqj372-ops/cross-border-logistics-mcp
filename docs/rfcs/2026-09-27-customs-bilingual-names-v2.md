# 关税品名中英对照 v2

状态：按用户“中文品名和对应的翻译也要展示出来”实施；生产翻译凭据配置及现有 API 用量另行确认。

问题：v1 只有原文。英文税则没有中文字段时，界面显示待补充，不能提供用户要求的中英对照。不得把另一国家同 HS6 的品名当成本国细分税号的译文。

`customs.query` 输入、权限、访客额度和 CLI 命令不变。参考输出升级为 `portal-customs-reference@2026-09-27.v2`；v1 校验及显示继续兼容。正式 `portal-customs@2026-09-05.v1` 不变。

旧候选形状为 `{"item":{},"hierarchy":[],"rates":[]}`，新候选额外包含：

```json
{"name_translation":{"language":"zh","text":"合成器具 — 其他","status":"machine","model":"configured-model"}}
```

翻译输入由当前候选及直接父级原文去重组合，对应原文仍在 `item` 与 `hierarchy`，不另行复制。原始字段、来源 ID、定位和哈希保持不变。翻译只接收已验证官方参考快照的品名，不接收用户查询、客户资料、材质或用途；中译英、英译中，加拿大英语候选存在时不重复翻译法文。译文只是显示建议，不参与查询匹配、归类、税率、措施或正式发布。Web、API、CLI 返回相同品名。客户填写的品名草案单独展示，不冒充对应译文。

部署可在 `customsReference.nameTranslation` 配置 `model` 和 `apiKeyFile`；凭据沿用现有受保护文件读取，禁止用户指定 URL 或密钥。固定调用 DeepSeek 官方 HTTPS 接口，不接受重定向。每次最多一批 27 个去重品名、24,000 字符输入、4,096 输出 tokens、12 秒超时；最多两个在途批次。校验 JSON、唯一 ID、完整数量、语言、长度及完成状态。重复精确原文使用进程内 512 项缓存，失败冷却 30 秒，无自动重试。不存在新公开接口、模型写权限或日志全文。

未配置、原文过长、超时或输出无效时 `name_translation=null`，页面说明译文暂不可用并保留原文；不影响参考税号和税率查询。状态仍为 `manual_review`、`formal_ready=false`，不生成总税费或免征判断。模型机器译文明确标记参考译文，税则品名仍需结合实物确认后拟定申报名称。

迁移：更新闭合 Draft 2020-12 输出 Schema，部署已验证代码后通过受保护文件配置现有模型凭据；无需业务数据库迁移。回滚：移除 `nameTranslation` 或恢复旧镜像及配置；保留业务数据和参考快照。

验证：`npx vitest run tests/customs-native/name-translation.test.ts tests/customs-native/reference.test.ts tests/console/customs-reference.test.ts tests/console/customs-summary-interaction.test.ts tests/access-gateway/portal-business-access-http.test.ts`，以及类型、lint、Schema/OpenAPI、Agent 标准、构建、发布门禁及 Web/CLI 实际读回。合成测试不证明翻译质量，生产验收须核对实际官方品名及中文对应关系。

接口依据：[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。
