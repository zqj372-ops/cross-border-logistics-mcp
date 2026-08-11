# Schema 约定

这些文件使用 JSON Schema Draft 2020-12。每个可实例化的 object 都显式声明 `additionalProperties: false`；工具数据通过 `envelope.schema.json` 的 `data` 承载位返回，但必须由 `tool-catalog.md` 指定的专属 Schema 单独校验。

共享定义位于 `common.schema.json`：

- `Money`：`amount` 是 decimal string，`currency` 是三位大写币种。
- `Measurement`：所有重量、长度、体积和数量派生值都带 `unit`。
- `SourceRef`、`CalculationStep`：形成可追溯来源与回放轨迹。
- `WriteContext`、`ReadbackEvidence`：约束窄语义写工具的租户/演员、幂等、审批和写后读回。
- `OpaqueReference`：敏感原文、凭证、附件和外部响应只通过引用传递。

`CargoLine` 的三种重量证据 `unit_weight`、`piece_weights`、`line_total_weight` 通过 `oneOf` 互斥；三者都缺失时 Schema 允许承载不完整输入，但工具必须返回 `needs_input` 或 `manual_review`，不能计算出可信金额。
