# 统一响应包络

所有 MCP tool 都返回同一层结构。客户端先按包络处理状态，再按工具目录中声明的 `data` 模型解析业务数据；不能只读取一段自然语言文本，也不能把 `data` 中的金额当作未经版本绑定的报价。

## 顶层字段

| 字段 | 类型 | 要求 |
| --- | --- | --- |
| `schema_version` | string | 必填，当前基线为 `2026-08-11.v1`；决定字段、状态和金额语义。 |
| `request_id` | string | 必填，由网关生成或校验客户端传入的幂等关联 ID；不得包含地址、报价或税务全文。 |
| `status` | enum | 只能是 `success`、`needs_input`、`manual_review`、`blocked`、`unavailable`。 |
| `data` | object/null | 工具专属结构化结果；状态不允许时可以是 `null` 或非最终结果。 |
| `source_refs` | SourceRef[] | 必填，列出实际参与结果的权威/支持/用户输入来源及版本。 |
| `assumptions` | Notice[] | 必填，所有计算假设；不能把未确认事实写成事实。 |
| `warnings` | Notice[] | 必填，非阻断风险、过期、估算或人工注意事项。 |
| `blockers` | Notice[] | 必填，导致不能继续、不能报价或不能写入的原因；`success` 时为空。 |
| `calculation_trace` | CalculationStep[] | 必填；金额、重量、容量、规则命中均要能回放到输入和版本。 |
| `review_status` | enum | `not_required`、`pending`、`approved`、`rejected`、`manual_review`。 |
| `audit_id` | string | 必填，服务端审计关联 ID；客户端不得自行伪造审计结论。 |

`data` 是按工具扩展的承载位，顶层包络 Schema 只验证其为对象或 null；工具专属 Schema 由 `tool-catalog.md` 绑定。所有工具专属对象仍必须显式设置 `additionalProperties: false`。

## 五种状态

### `success`

结果在当前权威版本和权限范围内可使用。计算、来源、假设和警告完整；不代表允许对外发送或发布报价。Phase 1 的报价计算成功后仍只能保存为草稿或创建复核任务。

### `needs_input`

缺少由用户/业务人员补充的字段，例如完整邮编、地址类型、每件重量、原产国、货值或装柜约束。`blockers` 要逐项给出字段路径和补充问题，不能以默认商业地址、默认 Zone、默认汇率或模型猜测替代。

### `manual_review`

存在冲突、歧义、人工确认门槛、供应商确认或法规/业务判断，结果可能有候选或估算但不能被当作最终结论。必须提供复核原因、责任角色和可接受的证据类型。

### `blocked`

动作被权限、产品阶段、审批策略或安全策略明确禁止，例如尝试发送报价、修改 Zone、正式报关、订舱/SO、跨租户读取或使用通用写入口。补充字段不能解除政策禁止，除非工具目录中的批准流程允许。

### `unavailable`

权威数据源、适配器或就绪门禁不可用，例如 RiskCustoms `ready=false`、源版本缺失、服务超时或凭证未配置。必须原样说明不可用原因，不得降级到非权威文档、旧价格、模型估值或另一个未经授权的数据源。

## 失败闭合规则

- 任何字段校验失败都在包络中返回结构化 `needs_input` 或 `blocked`，不返回半可信金额。
- 权威来源冲突、唯一锚点不足或单件重量证据不足时，返回 `manual_review`；不进行线性 Zone 外推或重量摊派。
- 外部系统返回成功码但写后读回缺失/版本不一致时，返回 `manual_review`，并保留目标系统响应的脱敏 opaque reference。
- `source_refs` 必须包含实际使用的版本；只有搜索到的资料但未参与计算，不得冒充计算来源。
- `audit_id` 在异常路径也必须生成；敏感原文通过 `opaque_reference` 关联，不写入日志。

## 写工具附加约束

写工具请求必须有服务端注入的 `tenant_context`、`actor_context`、`idempotency_key` 和 `operation_mode`。`operation_mode=preview` 只产生预览和哈希，不产生外部写入；`operation_mode=commit` 必须引用同一预览、通过工具目录规定的审批策略，并在包络 `data` 中返回 `readback_evidence`。

`quote.save_draft` 只允许把结果保存到现有报价系统的草稿/记录边界；`review.create_task` 只允许创建人工复核任务。二者都不具备发布、发送、改价、订舱或提交报关的能力。

JSON Schema：[`envelope.schema.json`](schemas/envelope.schema.json)。共享类型：[`common.schema.json`](schemas/common.schema.json)。
