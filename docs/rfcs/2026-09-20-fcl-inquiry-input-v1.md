# RFC: FCL Inquiry 输入合同 v1

Status: FCL.2 input-only implementation candidate, pending merge review.
Revision: FCL.2-R1, adding explicit draft/final schemas and stricter final email validation.

日期：2026-09-20
合同版本：`fcl-inquiry@2026-09-20.v1`
范围：共享 FCL 输入模型、结构/语义校验、三步字段分组和已生成 JSON Schema。

本文是 FCL.2 的单节点实现候选，不代表整个 FCL 报价闭环 RFC 已接受，也不表示公开提交、
Case 持久化、身份、权限、数据库、运价、报价单、PDF、MCP 或生产发布已经实现。

## 变更原因

现有 `apps/inquiry/model.ts` 和
`services/access-gateway/portal/case-contracts.ts` 仍描述旧的混合询价 Draft：单一柜型和单一
目的地字段不能表达多个柜型、独立 POL/POD/最终城市或无确认值。若后续 Web 先切换输入而 Case
服务仍接收旧合同，客户端会生成无法兼容的数据。

本节点先冻结可共享的 FCL 输入边界，供后续 Web/API/CLI 复用；不改旧 Draft 含义，也不切换
任何现有页面或路由。

## 新合同

顶层固定：

```json
{
  "contract_version": "fcl-inquiry@2026-09-20.v1",
  "transport_mode": "FCL"
}
```

完整对象包含 `origin_city`、`pol`、`pod`、`final_destination`、`cargo_name`、
`containers`、`cargo_type`、`estimated_weight`、`cargo_ready_date`、`incoterm`、
`incoterm_other`、`selected_services`、`contact`、`notes` 和 `consent`。所有键均 required；
未确认值使用 `null` 或空数组，不默认 POL/POD、日期、柜量或服务。

- 文本字段拒绝纯空白、控制字符和未声明枚举；POL、POD 与最终城市分别保存，不做城市港口映射。
- `containers` 最多四项，只允许 `20GP`、`40GP`、`40HQ`、`45HQ`，每种柜型最多一次，
  `quantity` 为 `null` 或 `1..9999` 整数。
- `estimated_weight` 为 `null` 或 `{value,unit}`；`value` 是正 decimal string，最多十位整数和
  六位小数，不接受 JSON number、科学记数、逗号、符号或零；`unit` 固定为 `kg`。
- `cargo_ready_date` 为 `null` 或真实日历 `YYYY-MM-DD`；`incoterm_other` 允许在初次询价中
  作为待补说明。
- `selected_services` 最多六项且不得重复；`notes` 最多 4000 字符，允许换行和 tab。
- `contact` 固定包含 `name`、`company`、`email`、`phone`；新草稿允许联系人未填，
  最终提交要求有效姓名、邮箱和 `consent=true`。邮箱复用 Zod email 校验并限制 254 字符，
  拒绝控制字符和连续点号地址。
- 根对象和嵌套对象都拒绝未知字段，包括 `owner`、`tenant`、`org`、`reviewer` 和 `price`，
  不通过 strip 后继续解析。

三步分组为：

1. 路线、柜型、Ready Date、Incoterm。
2. 货物品名/属性、估算毛重、服务和 Notes。
3. 联系人、最终确认。

`buildFclInquirySummary` 只返回 `state="draft"` 的结构化摘要，分别保留 POD 与最终城市及所有
`null`，不生成价格，也不声明已提交、已发送或已报价。

## 结构 Schema 与语义校验

`apps/inquiry/fcl-model.ts` 是唯一共享输入模型，并明确区分两层：

- `fclInquiryDraftSchema` / `createFclInquiryDraft` / `validateFclInquiryDraft`：允许联系人
  未填和 `consent=false` 的三步草稿。
- `fclInquirySchema` / `parseFclInquiry` / `validateFclInquiry` /
  `validateFclInquiryForSubmit`：最终提交合同，要求联系人姓名、合法邮箱和
  `consent=true`。

生成器从最终提交的 `fclInquirySchema` 输出
`schemas/access-gateway/portal-fcl-inquiry-input.schema.json`。Draft 2020-12 负责闭合对象、
required、类型、枚举、上下界、字符串 pattern、`email` format 和数组长度。

Zod refinement 表达但 JSON Schema 不完整表达的规则包括真实日历日期、柜型唯一和 service
唯一。导出的 `fclInquirySchema`、`validateFclInquiry`、`validateFclInquiryStep` 和
`validateFclInquiryForSubmit` 承担这些共享语义，Web/API/CLI 后续不得另造三套校验。

JSON Schema 接受但共享语义校验拒绝的输入必须保留为显式测试，不能把 Schema 编译通过描述成
完整业务校验通过。

## 旧合同、状态与权限

- 旧 `Draft`、`portal-cases@2026-09-07.v1` 和
  `inquiry-quote-link@2026-09-13.v1` 不变。
- 本节点不新增 HTTP 路由、MCP 工具、响应包络状态、permission、scope 或数据库字段。
- 公开提交、固定本人受理、不建公司的身份方向尚未实现；本节点也不实现鉴权。
- `fclInquirySchema` 是输入合同，不是页面启用证明；当前没有运行时调用方消费它。

## 兼容、迁移与回滚

变更为 additive candidate。旧客户端和旧 Case 记录无需迁移；新输入合同也不能直接提交给旧
Case 服务。兼容持久化完成前，Web/API 不切换入口。

回滚方式为移除本节点新增的模型、测试、Schema、生成器增量和 RFC，恢复旧生成器输出；没有
数据库、数据迁移、权限或生产配置需要回退。

## 验收

本节点要求：

- 多柜型和部分输入合法，所有键显式存在。
- 非法枚举、零/负数/小数柜数、非法日期、浮点重量、重复柜型或服务、控制字符和未知字段
  在共享校验器中失败并返回字段路径。
- 旧 Inquiry/Case 测试通过，旧生成 Schema 不变，新 Schema 可编译且重复生成一致。
- 不运行生产 smoke、真实业务调用、公开提交或报价。

回归命令：

```sh
npx --no-install vitest run tests/e2e/fcl-inquiry-contracts.test.ts --maxWorkers=2
npx --no-install vitest run tests/e2e/shipper-inquiry.test.ts tests/access-gateway/portal-cases.test.ts --maxWorkers=2
node --import tsx/esm deploy/scripts/generate-case-schemas.ts
npm run validate:access-gateway-schemas
npm run typecheck
npm run validate:agent-standards && npm run build:agent-pack
git diff --check
```
