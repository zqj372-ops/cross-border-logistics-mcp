# API-first 适配实施计划

**状态：** 当前唯一权威执行计划（2026-08-12）
**基线：** `1d994500b4387c3cf0424d3f8a94356901a5011b`
**原则：** MCP 是窄 API 适配层，不复制或改造 AI 报价、RiskCustoms、PDF 上游；本计划不调用生产、不写真实 URL/token、不部署。

## 1. 范围与边界

- 报价、RiskCustoms 在各自 API 合同验收通过后直连生产 API；每次业务请求直接调用，不做缓存、轮询或消息队列。
- MCP 只负责输入校验、租户/RBAC、安全 HTTP、字段映射、失败闭合、来源和审计证据；价格、关务数据和业务记录仍由上游权威系统负责。
- 报价 API 自身存在审计/任务副作用，因此不能描述为“纯只读”；`notify_email=false`、`notify_wecom=false` 只关闭通知，不消除上游副作用。合法响应结果固定带 warning `quote.upstream_side_effects`。
- 单个业务 API 故障只能关闭依赖它的工具；不得因为报价、RiskCustoms 或 PDF 任一依赖不可达而让 `/mcp` 全局失败。
- `customs.ca.estimate` 保持 `unavailable`；`quote.create_pdf` 共享契约已定义，但在 production qualification 前不实现、不注册。

## 2. 已确认的 API 合同

| 能力 | 已确认入口和约束 | MCP 处理 | 尚未确认的部分 |
| --- | --- | --- | --- |
| AI 报价 | `POST /quotes/zone-calculate`；请求必须有 `cbm`；`notify_email` 和 `notify_wecom` 必须为 `false`；响应字段已核验，缺口见下 | HTTP adapter 已实现并通过 fake-HTTP/local 组合测试；经 10A 审查发现生产合同阻塞，当前工具路径保持 `unavailable`/fail-closed；合法响应保留 `quote.upstream_side_effects` warning | 实际 base URL、认证 header、输入映射、业务版本/有效期和副作用明细仍须用隔离合同核验 |
| RiskCustoms 状态 | `GET /api/status`；DataStatus 仅有 `evaluatedAt`、`lastSourceCheckAt`、`ready`、`reasons` | 每次 `customs.ca.search` 先检查 status 的 `ready`、`reasons`；不在 status 阶段检查 `testData` | 服务间认证和部署配置须用隔离合同核验 |
| RiskCustoms 查询 | `POST /api/query`；`query` 必须是 trim 后 1–200 字符；响应再检查 `dataStatus.ready=true`、`testData=false` 和完整 `sources.releaseId` | 仅发送显式 `customs.query`；缺失时 `needs_input`，不从 `query_code`、opaque ref 或属性猜造自然语言 | 完整错误/challenge/限流语义及认证，须用隔离合同核验 |
| PDF | 隔离核验 AI Quote `/quotes/zone-preview` v2 只读来源、PDF `/v2/quote-pdfs` 的 USD lines、`sendable=false`、tenant+Idempotency-Key replay 和 201/200 后 metadata GET；当前仅 loopback HTTP | `quote.create_pdf` 只完成 contract-only，保持未注册/disabled | HTTPS+allowlist、tenant credential、正式 POST/GET 错误语义、staging replay/readback 和 deadline |

报价 response 已核验字段为：`quote_id`、`source_type`、`confidence`、`postal_code`、`preferred_city`、`postal_prefix`、`city`、`province`、`origin`、`zone`、`billing_pallets`、`pallet_breakdown`、`base_price_usd`、`fuel_usd`、`accessorials`、`total_price_usd`、`risk_tags`、`manual_review_required`、`matched_rule`、`matched_by`、`candidate_count`、`match_trace`、`sales_note`、`internal_note`。该响应没有 `rule_version`、`data_version`、`valid_from`、`valid_to`。

RiskCustoms 查询只有在 status 的 `ready=true`，且 POST `/api/query` 响应的 `dataStatus.ready=true`、`testData=false` 和来源 `releaseId` 完整时才允许形成成功结果；来源 release ID 从 `query.sources` 提取，不由 MCP 生成。任何缺失或冲突都保持 `unavailable`/`manual_review`。

## 3. 输入映射与契约缺口

| MCP 字段 | API 字段/动作 | 规则 |
| --- | --- | --- |
| `quote...calculate.cargo.total_volume` | `cbm`（fake/local 合同投影） | 仅用于 fake/local 请求形状和响应核对；当前生产零调用，不能作为启用资格；正式输入到 `cbm` 的映射仍未闭合 |
| `quote...calculate` 的地址、托数、重量、件数、包装、服务 | `/quotes/zone-calculate` 的响应核对投影 | 显式映射仅用于 fake/local 响应核对；`origin` 尚未进入已核验上游请求，生产零调用，不能作为启用资格 |
| `quote...calculate.effective_at` | 不发送给 `/quotes/zone-calculate` | 只接受等于服务端 `clock().toISOString().slice(0,10)` 的当天日期；历史/未来/缺失均零调用并返回 `manual_review` blocker `quote.effective_date_unsupported` |
| 报价通知选项 | `notify_email=false`、`notify_wecom=false` | 固定由服务端写入，客户端不能覆盖 |
| `customs.ca.search.query` | `/api/query.query` | 可选以保持旧客户端兼容；输入先 trim，再校验 1–200；生产适配缺失时返回 `needs_input` |
| 既有 `query_kind`、`query_code`、`product_attributes`、`product_description_ref` | RiskCustoms 业务上下文 | 保留现有字段；不得把它们拼成未获授权的 query 文本 |

已核验报价响应缺少 `rule_version`、`data_version`、`valid_from`、`valid_to` 四个证据，所以在现行 `quoteResultSchema` 下不能映射为 `success`。11B 的 `rule_version=upstream-rule-version:not-provided`、`data_version=response-sha256:<64hex>` 和空有效期只是 fake/local 合同投影证据；当前生产零调用，不能作为启用资格，也不是上游业务规则、价格版本或有效期。

## 4. 版本、来源和哈希

- 每次请求直连当前 API，不缓存旧响应，不轮询、不排队；重试只服从安全 HTTP 客户端和上游明确合同。
- 报价 source ref 在 fake/local 合同投影中使用 `version=quote-zone-api.v1` 和 canonical response SHA-256；QuoteResult 使用上述 sentinel。当前生产零调用，这些投影证据不能作为启用资格，也不代表上游业务 `rule_version`、`data_version` 或有效期。
- RiskCustoms 结果记录从 `query.sources` 读取的真实 `releaseId`，并记录 canonical response SHA-256；不得把 MCP 时间戳或适配器版本伪装成 release。
- canonical JSON、hash、release/source refs 只保存脱敏关联；日志不保存客户地址、报价明细、query 原文、税务材料或 token。

## 5. 配置边界

代码和文档只声明引用名，运行时注入实际值；仓库不得出现真实 endpoint、token、API key 或密码。

| 配置引用 | 用途 |
| --- | --- |
| `quote_api_base_url_ref` | 报价 API base URL 的受控引用 |
| `quote_api_auth_secret_ref` | 报价服务认证 secret 的受控引用 |
| `riskcustoms_api_base_url_ref` | RiskCustoms base URL 的受控引用 |
| `riskcustoms_api_auth_secret_ref` | RiskCustoms 服务认证 secret 的受控引用 |
| `pdf_api_base_url_ref`、`pdf_api_auth_secret_ref` | `quote.create_pdf` 的受控 PDF API 引用；当前 loopback HTTP 不满足生产资格，未验收前不得配置为可用 |

租户到上游身份的映射由服务端完成；客户端不得传上游账户、token、base URL 或 secret reference 以外的凭证内容。

## 6. 失败状态

| 情况 | MCP 状态 | 处理 |
| --- | --- | --- |
| 缺 `total_volume`/`cbm`、缺显式 `query`、trim 后 query 为空或超过 200 | `needs_input` | 返回字段路径；零上游调用 |
| 输入/响应字段冲突、报价真实版本/有效期缺失、RiskCustoms releaseId 不完整或 hash 不一致 | `manual_review` | 保留可验证的来源和 blocker，不输出伪成功 |
| 缺认证、跨租户、SSRF/非 allowlist、通知覆盖、越权或试图调用未注册 PDF | `blocked` | 安全门禁先拒绝，零上游调用 |
| API 5xx、RiskCustoms status `ready=false`、query 响应 `dataStatus.ready=false`/`testData=true`、状态/查询来源缺失、PDF dispatch 前连接失败或 production qualification 未完成 | `unavailable` | 只关闭相关工具，不影响 `/mcp` 和其他已就绪工具 |
| PDF 已 dispatch 后 response timeout/unknown、POST 丢响应、GET 404 或 identity/hash/version mismatch | `manual_review` | 可能已写入；按同 key recovery/readback 处理，不盲目重发 |
| 合同、来源、权限和响应字段均通过校验 | `success` / `manual_review` | 报价当前保持 `unavailable`/fail-closed；待三项生产合同问题闭合后才重新评估，关务仍是候选，不是正式归类 |

## 7. 分步实施：11A → 11E

### 11A：兼容契约（本次）

1. 在正式报价输入 `cargo` 增加可选 `total_volume`，复用 Measurement 结构，单位只允许 `m3`/`cbm`。
2. 在 `customsSearchInputSchema` 增加可选 `query`，trim 后 1–200；保留既有字段。
3. 增加合法/非法边界测试，更新 tool catalog；不实现 HTTP 客户端，不接生产。

### 11B：报价 API 窄适配（生产资格阻塞）

1. HTTP adapter 已实现并通过 fake-HTTP/local 组合测试；禁止真实 URL/token。
2. 经 10A 审查发现生产合同阻塞，未获生产启用资格，当前工具路径保持 `unavailable`/fail-closed。
3. 三项未决合同问题：上游端点存在非零业务写副作用；正式输入到 `cbm`/`origin` 的映射不成立；真实响应缺业务版本/有效期证据。
4. 在上述问题闭合前，不以 `manual_review`、sentinel、fixture 或本地规则表代替生产资格；保留 `sendable=false` 和 `quote.upstream_side_effects` warning。
5. 既有 fake HTTP 行为测试覆盖超时、4xx/5xx、字段缺失、响应 hash 和安全 URL；不代表生产连通。

### 11C：RiskCustoms API 窄适配

1. 每次搜索先 GET `/api/status`；只有 status `ready=true` 才允许 POST `/api/query`，status 阶段只使用 `ready` 和 `reasons`。
2. 只发送 trim 后合法的显式 query；校验 query 响应 `dataStatus.ready=true`、`testData=false`，再从 `query.sources` 提取完整真实 releaseId，保存 canonical response SHA-256。
3. status/query ready、test data、release 缺失/冲突、challenge/限流、超时和 query 零调用均用假 HTTP 测试覆盖。
4. `customs.ca.estimate` 继续返回 `unavailable`，不拼造税额。

### 11D：API 适配器组合与隔离（组合测试完成，生产资格阻塞）

1. `createProductionApiAdapterSource` 当前只允许显式注入经核验的 RiskCustoms 适配器；quote 在生产组合中强制保持失败闭合，PDF 不注册。缺少获准适配器时返回结构化不可用。
2. source health 只表示本地结构/生命周期可用；单一上游故障只让对应工具不可用，平台依赖缺失才阻断全局。
3. `quote.create_pdf` 只通过未来已核验生产 API 的窄适配器接入；必须先完成 AI Quote candidate hash、PDF HTTPS+allowlist、tenant credential、POST/replay/GET exact readback、`sendable=false`/version 校验和 deadline，当前不注册。

### 11E：验收与发布决策（生产资格阻塞）

1. 已用 fake HTTP 覆盖 source health 不探测上游、quote/customs 局部故障和缺少适配器的 fail-closed 状态。
2. HTTP adapter/local 组合证据已收集，但 quote 仍因 10A 的三项生产合同阻塞保持 `unavailable`/fail-closed；未获生产启用资格。
3. 当前 PDF 只有 loopback HTTP 证据；若 HTTPS、allowlist、tenant credential、staging POST/replay/GET exact readback 或 deadline 任一缺失，明确保持 contract-only/disabled，不注册工具、不声称生产接通。

## 8. 验收命令

11A 当前变更至少通过：

```bash
npm test -- --run tests/domains/phase1-tools.test.ts
npm run validate:schemas
npm run typecheck
npm run lint
git diff --check
```

本基线另运行 `node docs/contracts/quote-create-pdf-contract.test.mjs`；该自包含负测尚未接入 `npm run validate:schemas`，由任务 06 接线后纳入正式 gate。旧 `write-result.schema.json` 和旧 examples 数量保持不变。

11B–11E 额外通过相关 `tests/adapters`、`tests/domains`、`tests/e2e` 的 fixture/fake-HTTP 测试，并复核无真实 URL、token、客户数据和生产网络请求。
