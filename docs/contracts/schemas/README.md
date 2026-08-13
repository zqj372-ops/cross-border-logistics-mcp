# Schema 约定

这些文件使用 JSON Schema Draft 2020-12。每个可实例化的 object 都显式声明 `additionalProperties: false`；v1 工具数据通过 `envelope.schema.json` 的 `data` 承载位返回，报价 v2 使用独立的 `quote-envelope-v2.schema.json`，两者都必须由 `tool-catalog.md` 指定的专属 Schema 单独校验。

共享定义位于 `common.schema.json`：

- `Money`：`amount` 是 decimal string，`currency` 是三位大写币种。
- v2 业务日期：由 v2 Schema 内联 `YYYY-MM-DD` 约束；需要时区的时间戳使用 `DateTime`，不能互换。旧 `common.schema.json` 不注册 `Date`，避免旧 `$id` 消费者缓存到变更后的定义。
- `Measurement`：所有重量、长度、体积和数量派生值都带 `unit`。
- `SourceRef`、`CalculationStep`：形成可追溯来源与回放轨迹。
- `WriteContext`、`ReadbackEvidence`：约束窄语义写工具的租户/演员、幂等、审批和写后读回。
- `OpaqueReference`：敏感原文、凭证、附件和外部响应只通过引用传递。

报价 v1 的 `quote-result.schema.json`、旧 `envelope.schema.json` 与历史示例继续保留。报价 v2 使用独立的 `quote-request-v2.schema.json`、`quote-result-v2.schema.json` 和 `quote-envelope-v2.schema.json`；v2 data 只接受 `ready=true`、`test_data=false` 的 active manifest，`valid_from`/`valid_to` 是必需非空 Date；v2 输出的 release hash 必须由 adapter 校验与 snapshot hash 相等，ready=false 不进入 quote data。旧 envelope `$id` 不引用 v2。

`quote.create_pdf` 使用独立的 `quote-create-pdf-request.schema.json`、`write-result-v2.schema.json` 和 `quote-create-pdf-envelope.schema.json`；它们使用 `2026-08-13` 的新 `$id`，不扩展旧 `write-result.schema.json` 或旧 `envelope.schema.json` 的接受集合。PDF 输出只复用既有 WriteContext、ReadbackEvidence 和 write-result 字段。

`CargoLine` 的三种重量证据 `unit_weight`、`piece_weights`、`line_total_weight` 通过 `oneOf` 互斥；三者都缺失时 Schema 允许承载不完整输入，但工具必须返回 `needs_input` 或 `manual_review`，不能计算出可信金额。
