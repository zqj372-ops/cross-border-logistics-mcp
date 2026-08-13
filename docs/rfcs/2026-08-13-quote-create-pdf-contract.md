# RFC：`quote.create_pdf` 内部报价 PDF 创建契约

**日期：** 2026-08-13
**状态：** 基线契约已定义，待任务 05/06 适配与 staging 验收；不代表生产启用或部署完成
**影响范围：** 新增唯一工具 `quote.create_pdf` 的输入 wrapper、独立 write-result v2 输出和 PDF 窄适配边界
**不变范围：** 旧 `$id`、旧 Schema 字节、旧示例数量、统一 envelope 字段、`quote-request-v2`、`quote-result-v2`、`quote.save_draft`、`review.create_task`、平台源码和运行时注册

## 1. 变更原因与事实边界

上游已在隔离环境核验出最小闭环：

- AI Quote v2 的 `/quotes/zone-preview` 是只读报价权威入口；它返回的 quote 结果才可作为 PDF 投影来源。
- PDF `/v2/quote-pdfs` 接受服务端投影的权威 USD line items；`sendable` 必须由服务端固定为 `false`。
- PDF POST 使用 tenant 身份和平台 `Idempotency-Key`；同 key、同 body 可跨重启得到 200 replay。201/200 后还必须 GET metadata 做精确读回。
- 当前 PDF API 只有 loopback HTTP 条件，未满足 HTTPS、allowlist、tenant credential 和 staging 验收，因此 production 默认 disabled；本 RFC 不授权真实调用。

本 RFC 只把上述已核验边界固化为共享契约。MCP 不生成 PDF、不保存 PDF 主表、不计算报价、不接受模型提供的金额或 line items，也不把 loopback 证据描述成 production readiness。

## 2. 新工具与兼容性

新增且仅新增一个业务工具：`quote.create_pdf`。

| 项目 | 约束 |
| --- | --- |
| 语义 | 创建内部报价 PDF 草稿；不发送、不发布、不下载、不删除、不创建 template/status 工具 |
| 类型 | `write`、non-destructive、idempotent、open-world |
| 权限 | `quote:pdf_write`；允许角色 `admin`、`sales`、`operator`，其他角色为 `blocked` |
| 输入 | `quote-create-pdf-request.schema.json`；仅 wrapper，不复制 quote v2 字段 |
| 输出 | 复用既有字段的 `write-result-v2.schema.json`；仅允许 `quote.create_pdf`，不建立 PDF 结果大 Schema |
| 运行时状态 | contract-only；在正式适配和生产资格齐全前不注册/不调用 |

这是 additive Schema 版本：旧 `write-result.schema.json` 的 `$id`、字节和 operation 接受集合完全不变；新增 `write-result-v2.schema.json` 使用 `2026-08-13` `$id`、`version=write-result@2026-08-13.v2`，且 operation 固定为 `quote.create_pdf`。外层使用同样新版本路径下的 `quote-create-pdf-envelope.schema.json`，仍保留统一 envelope 字段和 `schema_version=2026-08-11.v1`。没有把新 operation 加入旧 Schema，也没有修改固定示例数量。

## 3. 输入契约

公开输入只有以下五个字段，根和所有新增 object 都是 Draft 2020-12 `additionalProperties: false`：

```json
{
  "schema_version": "2026-08-11.v1",
  "version": "quote-create-pdf-request@2026-08-14.v1",
  "quote_request": "现有 quote-request-v2 对象",
  "presentation": {
    "customer_display_name": "1..200 字符"
  },
  "write_context": {
    "idempotency_key": "平台幂等键",
    "operation_mode": "preview | commit",
    "preview_ref": "null 或 opaque Identifier",
    "approval": "工具专属最小审批对象"
  }
}
```

`version` 固定为 `quote-create-pdf-request@2026-08-14.v1`。`quote_request` 直接 `$ref` 现有 `quote-request-v2.schema.json`，因此模型不能传 `total`、`line_items`、金额、logo、path、html、url 或任何 quote v2 未声明字段；wrapper 也不公开 `tenant_id`、`actor_id`、`client_id`、`session_id` 或 `tenant_context`。完整地址、logo、附件和敏感正文没有 inline 入口。`customer_display_name` 是唯一公开展示文本，长度为 1–200；不接受 logo、模板、文件路径、HTML、URL 或地址正文。

网关在进入适配器前拒绝总请求体超过 32 KiB。该大小门禁是请求边界而非业务字段，不能通过 Schema 中新增宽松字段绕过。

`write_context` 是本工具 wrapper 内定义的闭合对象，只含平台 idempotency key、`operation_mode`、`preview_ref` 和最小 approval；它不复用含 `tenant_context` 的 common `WriteContext`。`preview` 时 `preview_ref` 必须为 `null`；`commit` 时必须是 Identifier，且 approval 必须为 `required=true`、`status=approved`、`approval_id` 为 Identifier。后续 task02 必须从服务端认证的 `ExecutionContext` 注入并校验 tenant、actor、client、session 和 RBAC；不得从客户端 wrapper 读取这些身份字段。旧 `quote.save_draft` 等 legacy 工具继续使用旧 `WriteContext`，不受本输入版本改变。

## 4. Preview → commit

### Preview

1. 服务端校验 Schema、请求大小、tenant/RBAC、`quote:pdf_write` 和敏感输入边界。
2. 仅调用 AI Quote `/quotes/zone-preview` v2；该调用是只读报价预览。Quote 返回 `needs_input`、`manual_review` 或 `unavailable` 时原样保留状态，零 PDF POST。
3. Quote success 后，服务端对同 tenant、quote request、presentation 和权威 Quote 响应的身份/版本/hash 形成 candidate hash。hash 和候选证据只通过现有平台 preview/idempotency 机制关联，不把金额或 line items 回显给模型。
4. 返回 outer `status=success` 和 `write-result-v2`：`operation=quote.create_pdf`、`version=write-result@2026-08-13.v2`、`operation_status=previewed`、`record_id=null`、opaque `preview_ref`、`readback_evidence=null`；preview approval 固定为 `required=false/status=not_required/approval_id=null`。这是稳定 preview_ref 的成功生成，不代表 PDF 已创建；此阶段绝不调用 PDF POST。

### Commit

1. `operation_mode=commit` 必须绑定服务端 `ExecutionContext` 中的同一 tenant、原始 quote request、presentation 和 `preview_ref`，并通过服务端校验的 `approval.status=approved` 与 `approval_id`；这些身份不来自客户端 wrapper。
2. 服务端重新调用 AI Quote `/quotes/zone-preview` v2，不信任 preview 中缓存的金额或 line items。候选 hash、tenant、request、presentation、Quote release/snapshot/version 任一漂移均返回 `manual_review`，零 PDF POST。
3. 仅在重新读取的 Quote 仍为可用权威 success 后，由服务端投影 quote 的 authoritative USD line items，并固定内部草稿字段 `sendable=false`。金额、line items、logo、path、html、url 都不来自模型输入。
4. Preview 和 commit 使用两个不同的平台幂等键：preview 使用 `P`，commit 使用 `C`，且 `P ≠ C`。只有 commit 的 `C` 才能原样作为 PDF `Idempotency-Key` 转发；同一 commit 重试必须复用 `C` 和同一投影 body，不能把 `P` 用于 commit，也不能在重试时新生成 `C`。两者都由平台按完整输入分别做幂等关联。
5. PDF POST 返回 201 或 200 后，服务端按返回的 opaque document reference GET metadata，并精确核对 tenant、request/presentation 关联、candidate/quote hash、quote version、`sendable=false`、document reference 和 PDF observed version。只有 exact readback 才返回 success。
6. 返回 outer `status=success` 和 `write-result-v2`：`operation_status=committed`（同一平台/PDF幂等重放可为 `already_committed`），approval 固定为 `required=true/status=approved/approval_id=Identifier`，`record_id` 为 document reference，`readback_evidence.verified=true`。只有该 commit/already_committed 形态同时满足 approved 和 verified readback，才表示 PDF 已创建；outer `source_refs` 与 `calculation_trace` 必须同时闭合 AI Quote 权威来源和 PDF readback 来源；不把金额复制到新的 MCP data 模型。

PDF POST 丢响应、已 dispatch 后 response timeout/unknown、GET 404、identity/hash/version 不一致或最终状态未知均为 `manual_review`；dispatch 前连接失败才是 `unavailable`。同 key、同 body 的已知 replay 可按 exact GET readback 返回既有 success。当前 composition 实际 deadline 为 10s，start 的 15s 没有传入 composition；这不足以覆盖 re-quote、renderer 8s、一次恢复和 GET。后续 task02 必须由 start 显式传入单一约 30s 的 absolute deadline，composition 与 adapter 各阶段共享同一 remaining，不得每阶段重置；这是 task02/06 的实现资格门，本分支不改代码。整个 Quote preview + PDF recovery + GET readback 必须在该平台 deadline 内完成；不引入队列、后台清理器或异步任务。

## 5. 状态映射

| 条件 | MCP 状态 | 上游行为 |
| --- | --- | --- |
| 公开输入缺失、格式错误、请求超过 32 KiB | `needs_input` | 零上游写调用；Schema/网关拒绝 |
| 权限、审批、tenant、credential 不满足；PDF 409 冲突 | `blocked` | 安全门禁；不伪造 PDF 成功 |
| Quote 原始 `needs_input`、`manual_review`、`unavailable` | 原样保留 | 不 POST PDF |
| candidate hash、tenant、request、presentation、Quote release/snapshot/version 漂移 | `manual_review` | 不 POST PDF |
| PDF 201/200 + exact GET metadata | `success` | 返回 write-result，document ref 和 verified readback |
| PDF 400/413，证明服务端内部投影或大小错误 | `unavailable` | 不把模型输入错误伪装成成功 |
| PDF 401/403 | `blocked` | credential/权限门禁失败 |
| PDF 503；dispatch 前连接失败/连接超时 | `unavailable` | 只关闭 PDF affected tool；未确认写入 |
| PDF 已 dispatch 后 response timeout/unknown | `manual_review` | 可能已写入；保留恢复所需 opaque reference，禁止盲目重发 |
| POST 不确定、GET 404、readback identity/hash/version mismatch | `manual_review` | 保留 opaque reference；禁止重复未知写入 |

状态仍只使用统一五状态；不新增 PDF 专属状态。`sendable=false` 是内部固定草稿约束，不是可由模型覆盖的输入字段。

## 6. 来源、审计与安全边界

- AI Quote 权威 source ref、release/snapshot hash、版本和 calculation trace 必须进入外层证据；PDF GET readback source ref、observed version 和 document reference 也必须进入同一 envelope。
- 只记录 opaque reference、request/audit ID、状态、版本、hash 和脱敏摘要；不记录客户地址、报价明细全文、原始聊天、logo、HTML、URL、凭证或 token。
- PDF 是 non-destructive 内部草稿创建；本工具没有 send/publish/download/template/status/delete/overwrite 语义，也不复用 `quote.save_draft`。
- 不允许模型选择 PDF endpoint、tenant credential、Idempotency-Key 的转发目标或服务端 tenant mapping；所有出站目标必须由 HTTPS + allowlist 配置控制。

## 7. 生产资格与实施边界

production 默认 disabled。只有以下证据全部具备，才可由后续任务实现窄适配并评估注册：

1. AI Quote `/quotes/zone-preview` v2 正式 API、tenant mapping、版本/发布 hash 和 read-only 语义通过正式合同验收；
2. PDF API 提供 HTTPS、allowlist、tenant credential、正式输入/输出、201/200 replay、metadata GET 和错误语义；
3. staging 已覆盖 POST、丢响应 recovery、同 key replay、GET exact readback 和 deadline；
4. 服务端能验证 `sendable=false`、candidate/quote hash、tenant、request/presentation 和版本闭合；
5. 平台身份、RBAC、durable idempotency/audit、审计脱敏和失败闭合均已通过验收。

当前只有 loopback HTTP，不满足上述生产资格；本 RFC 不连接、不部署、不写入生产，也不把 self-contained contract test 当作 staging 或 production 证据。

## 8. 迁移、验证与回滚

### 客户端迁移

1. 只发送 `schema_version`、`version=quote-create-pdf-request@2026-08-14.v1`、完整 `quote_request`、`presentation.customer_display_name` 和本工具专属 `write_context`；tenant/actor/client/session 由平台 `ExecutionContext` 注入。
2. Preview 只保存 opaque `preview_ref`；不期待金额或 PDF URL 出现在模型可见结果中。
3. Commit 必须复用绑定的 tenant/request/presentation/preview ref，且提供 approved approval；处理 `manual_review`/`unavailable`/`blocked`，不得自动降级。
4. 将 `record_id` 解释为 PDF document reference；仅在 `readback_evidence.verified=true` 时展示内部草稿创建成功。

### 本基线验证

- `node docs/contracts/quote-create-pdf-contract.test.mjs` 是自包含契约检查，覆盖合法 preview/commit、`P ≠ C`、工具专属输入生命周期、拒绝 quote 输出/敏感字段/tenant/actor 注入、旧 write-result v1 不接受新 operation、write-result v2 生命周期和 success envelope 证据闭合；它不是当前正式 gate。正式 gate 仍由任务 06 接入 `npm run validate:schemas`，在任务 06 接线前不得宣称该 gate 已闭合。
- `npm run validate:schemas` 负责现有官方 envelope examples 和所有 Schema 编译；不增加旧 examples 数量。
- `git diff --check` 必须通过；本分支不修改 `package.json`、源码、测试、deploy 或 runbooks。

### 回滚

回滚本 RFC、wrapper/v2 Schema、tool catalog/authority/product/plan 更新即可。旧 write-result v1 `$id`、字节、operation 接受集合、旧 examples、`quote.save_draft`、`review.create_task` 与现有 v1/v2 quote 契约不删除、不降级、不迁移。
