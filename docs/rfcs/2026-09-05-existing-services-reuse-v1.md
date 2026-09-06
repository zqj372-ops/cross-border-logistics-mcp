# RFC：Existing Business Services Reuse v1

- Status: Draft
- Proposed contract version: `2026-09-05.v1`
- Scope: RiskCustoms 完整只读结果投影、既有报价引擎只读预览、后续资料与结果引用交接
- Product basis: `docs/product/2026-09-05-mcp-product-redesign/10-existing-services-reuse.md`

> Scope update: 用户已确认继续跨原服务改造，并明确改为 API 统一工作台、用户管理与 API 申请。新的产品范围见 `docs/product/2026-09-05-mcp-product-redesign/11-api-native-platform-prd.md`。本文报价只读与完整关务投影可继续作为技术输入；网页跳转/跨网页 handoff 不再是主交付。人员、申请、REST/MCP 授权及业务写入需按新范围形成合同切片。本 Draft 的示例字段、币种、工具名和权限尚未冻结，不能因用户确认产品方向直接注册或用于生产。

> 本文是待评审草案，不是已接受合同、发布许可或生产接入证明。它不修改 `t0-v1`，不授权连接生产服务，也不表示本文中的新工具、端点、身份映射或交接接口已经实现。

## Summary

FreightClaw 复用现有报价服务与 RiskCustoms 的业务权威，不再复制报价规则、关税规则或完整业务页面。本草案提出三项独立交付：

1. 保持 `customs.ca.search` 原合同与加拿大语义不变，新增显式多法域只读查询 `customs.trade.search`，完整投影 RiskCustoms 已返回的分类、税率、措施、文件、来源及发布身份。
2. 由原报价服务新增 `POST /quotes/zone-preview` 只读 M2M 入口，复用同一确定性报价引擎，但不得创建报价/销售记录、人工任务、通知、客户文案、订舱或规则变更。
3. 后续以短期 opaque handoff 和结果引用完成跨应用交接；引用是定位符，不是授权、成功状态或结果副本。

Admin 业务入口配置由独立工作流定义。本文只要求它消费服务端给出的受控入口与状态，不规定或锁定 Admin DTO。

## Current facts and gaps

- RiskCustoms M2M query 已有 Bearer、`X-Tenant-Id`、发布快照前后核验、`ready/testData` 门禁，并返回 CN/US/CA 的分类、税率、文件、措施与来源。当前 MCP adapter 固定 `codeCountry=CA`，只映射加拿大分类候选，丢弃其余业务字段。
- `customs.ca.estimate` 没有已核验 M2M 估算 API，继续固定 `unavailable`。RiskCustoms 浏览器计算器不是 M2M 端点。
- 现有报价服务的 `/quotes/zone-calculate` 和 `/quotes/ai-auto-quote` 带业务记录、诊断、人工任务或通知语义，不能直接作为只读 adapter 目标。MCP 当前 Quote V2 是候选合同和禁用 adapter，不证明原服务已有对应生产端点。
- 两个上游的线上构建、正式发布数据、服务凭据、租户映射和实际读回均待授权环境验证。

## Authority and safety boundary

| 事项 | 权威所有者 | FreightClaw 可保存 | 禁止行为 |
| --- | --- | --- | --- |
| Zone、FSA、计费托数、价格矩阵、附加费、报价有效期 | 原报价服务 | opaque quote reference、版本与脱敏状态 | 复制价格表、外推价格、改价 |
| HS 归类、税率、措施、文件要求、汇率与税费估算 | RiskCustoms | opaque query/result reference、发布身份与来源引用 | AI 补税率、把候选升为确认、复制税则库 |
| MCP tenant、actor、精确工具授权、调用审计 | FreightClaw / Access Gateway | 必需的身份与审计引用 | 向上游转发长期浏览器凭据、相信客户端 tenant |
| 客户发送、保存、通知、人工任务、订舱 | 原业务服务各自的写权限 | 无 | 从只读预览继承或推断写权限 |

所有对象使用 Draft 2020-12 Schema，`additionalProperties: false`。金额和数值税率使用 decimal string；金额必须带 ISO 4217 三位币种，重量、长度、体积及数量必须带单位或明确的整数计数语义。客户端不得提交 endpoint、credential、tenant override、release、snapshot 或权限字段。

## Proposed customs contract

### Compatibility rule

`customs.ca.search` 的名称、输入、输出、`jurisdiction: "CA"` 和 `tariff:read` 行为保持不变。它不会因本 RFC 自动返回 US/CN、税率、措施或文件。旧客户端、旧 JWT 和旧 schema 不迁移。

新增工具名提案为 `customs.trade.search`，版本 `customs-trade-search@2026-09-05.v1`。该名称和 schema 只有在 RFC 被接受并进入工具目录后才生效。请求必须显式声明 `jurisdictions`，避免把同名加拿大工具悄悄扩展为多国工具。

### Request

```json
{
  "version": "customs-trade-search-request@2026-09-05.v1",
  "query": "stainless steel vacuum bottle",
  "rule_date": "2026-09-05",
  "origin_country": "CN",
  "jurisdictions": ["CN", "US", "CA"],
  "query_kind": "name_search",
  "code_country": null,
  "selected_hs6": null,
  "product_attributes": {
    "material": "304 stainless steel",
    "use": "household beverage container",
    "contains_steel_aluminum": true
  }
}
```

Normative requirements:

- `origin_country` 首版只允许 `CN`；其他原产国返回 `unavailable`，不得忽略后继续计算。
- `jurisdictions` 是去重非空数组，只允许 `CN|US|CA`；响应只能包含请求的法域。
- `query_kind` 只允许 `exact_code|name_search|candidate_selection`。`candidate_selection` 必须有六位 `selected_hs6`。
- `code_country` 只用于解释输入编码属于哪国税则；它不等于商品原产国或目的国。
- `product_attributes` 仅接受合同列出的标量。未知字段、客户端 tenant、URL、credential、release 或 snapshot 字段拒绝。

### Response data

```json
{
  "version": "customs-trade-search@2026-09-05.v1",
  "query_id": "riskcustoms-query-opaque",
  "query_kind": "name_search",
  "rule_date": "2026-09-05",
  "origin_country": "CN",
  "requested_jurisdictions": ["CN", "US", "CA"],
  "selected_hs6": "732393",
  "next_question": null,
  "candidates": [],
  "results": [
    {
      "jurisdiction": "CA",
      "code": "7323930090",
      "display_code": "7323.93.00.90",
      "code_digits": 10,
      "parent_code": "732393",
      "hs6": "732393",
      "classification_status": "candidate",
      "legal_names": [{"language": "en", "text": "source text", "source_ref_ids": ["src:customs:ca:1"]}],
      "classification_reason": "source-backed reason",
      "rate_lines": [
        {
          "rate_id": "ca-mfn",
          "label": "MFN",
          "category": "base_duty",
          "kind": "ad_valorem",
          "rate_expression_raw": "6.5%",
          "display_value": "6.5%",
          "ad_valorem_percent": "6.5",
          "confirmed": true,
          "included_in_confirmed_total": true,
          "effective_from": "2026-01-01",
          "effective_to": null,
          "condition_text": "",
          "source_ref_ids": ["src:customs:ca:1"]
        }
      ],
      "confirmed_total_percent": "6.5",
      "documents": [],
      "measures": [],
      "warnings": []
    }
  ],
  "publication": {
    "service_version": "riskcustoms-service-version",
    "contract_version": "riskcustoms-query.v1",
    "published_at": "2026-09-05T00:00:00Z",
    "release_ids": ["release-id"],
    "snapshot_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "release_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "evaluated_at": "2026-09-05T00:00:00Z",
    "last_source_check_at": "2026-09-05T00:00:00Z",
    "ready": true,
    "test_data": false,
    "reasons": []
  },
  "source_ref_ids": ["src:customs:ca:1"]
}
```

The example is shape-only. Its code, rate, version and hashes are not claims about published upstream data.

`next_question`, when present, retains `question_id`, `label`, `attribute` and at most three typed options; it must not be reduced to display text. Each candidate/result retains national code hierarchy, legal names, translation status, classification sources and status. Each document retains side, state, conditions, reason, effective dates and sources. Each measure retains type, origin, match status, legal scope, exceptions, case/exporter/rate evidence when supplied, effective dates and sources.

`ad_valorem_percent` is present only when the upstream authoritative expression can be losslessly represented as one percentage. Specific, compound and text rates keep `ad_valorem_percent: null`; MCP never parses display text into a numeric rate. `confirmed_total_percent` is nullable and only mirrors the upstream confirmed total. This search contract contains no monetary tax estimate.

### Customs status mapping

- `success`: publication is ready, non-test, identity stable, all requested jurisdictions and every referenced source validate.
- `needs_input`: query, rule date, code country, selected HS6 or explicit product attribute is missing/invalid.
- `manual_review`: candidates remain unconfirmed, sources conflict, response/request correlation differs, or a rule explicitly requires review. It never becomes `success` merely because some fields exist.
- `blocked`: authenticated execution context, tool entitlement, M2M credential or tenant authorization is missing/rejected.
- `unavailable`: upstream disabled, timeout/rate limit/dependency failure, unsupported origin, `ready=false`, `testData=true`, incomplete or changing publication identity, or invalid response contract.

## Proposed quote read-only contract

### Endpoint and authentication

The proposed upstream endpoint is `POST /quotes/zone-preview`. It is not currently implemented in the audited quote service. It must use a server-owned service credential and an `X-Tenant-Id` assertion derived from the MCP execution context. Browser cookie, user-supplied API key and body-level tenant override are rejected.

Until the quote service implements tenant isolation, production enablement requires an explicit one-to-one server mapping:

```text
MCP tenant -> enabled M2M client -> one quote-service account/instance
MCP tenant + warehouse_code -> canonical quote origin
```

Wildcards, default tenant, default warehouse and cross-tenant fallbacks are forbidden. A tenant with no exact mapping returns `blocked`; a warehouse with no exact origin mapping returns `needs_input`. Merely adding a tenant label to a shared legacy call does not establish isolation.

### Request

```json
{
  "version": "quote-zone-preview-request@2026-09-05.v1",
  "request_id": "req-opaque-001",
  "effective_date": "2026-09-05",
  "origin": {"warehouse_code": "warehouse-ont-01"},
  "destination": {
    "country": "CA",
    "province": "ON",
    "city": "Toronto",
    "postal_code": "M5V 2T6",
    "address_type": "commercial",
    "full_address_ref": null
  },
  "cargo": {
    "pieces": 2,
    "package_types": ["pallet"],
    "explicit_pallet_count": 2,
    "total_weight": {"value": "100", "unit": "kg"},
    "total_volume": {"value": "1.25", "unit": "cbm"},
    "longest_side": {"value": "1.20", "unit": "m"},
    "is_stackable": false
  },
  "services": {
    "appointment": true,
    "liftgate": false,
    "pallet_jack": true,
    "detention": {"value": "0", "unit": "minutes"},
    "limited_access": false,
    "remote_area": false
  }
}
```

The request does not contain `tenant_id`, canonical origin, endpoint, credential, rule/data version, price or notification fields. `full_address_ref` is an opaque, tenant-scoped reference; raw full address is not logged. Unit conversions occur deterministically and remain in the calculation trace.

### Response

```json
{
  "version": "quote-zone-preview@2026-09-05.v1",
  "quote_id": "preview-opaque-001",
  "quote_status": "calculated",
  "currency": "CAD",
  "total": {"amount": "245.00", "currency": "CAD"},
  "line_items": [
    {
      "line_id": "base",
      "label": "Base charge",
      "amount": {"amount": "200.00", "currency": "CAD"},
      "pricing_basis": "authoritative upstream basis",
      "source_ref_ids": ["src:quote:release:1"]
    },
    {
      "line_id": "fuel",
      "label": "Fuel surcharge",
      "amount": {"amount": "45.00", "currency": "CAD"},
      "pricing_basis": "authoritative upstream basis",
      "source_ref_ids": ["src:quote:release:1"]
    }
  ],
  "origin": "toronto",
  "billing_pallets": 2,
  "effective_date": "2026-09-05",
  "valid_from": "2026-09-01",
  "valid_to": "2026-09-30",
  "rule_version": "rule-version",
  "data_version": "data-version",
  "service_version": "service-version",
  "contract_version": "quote-zone-preview.v1",
  "release_id": "release-id",
  "snapshot_hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  "release_hash": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  "published_at": "2026-09-05T00:00:00Z",
  "ready": true,
  "test_data": false,
  "sendable": false,
  "bookable": false,
  "source_ref_ids": ["src:quote:release:1"]
}
```

The example values are illustrative, not audited prices or release data. The upstream owner must define and publish the canonical fee taxonomy, inclusion/exclusion rules, rounding, currency policy, origin mapping, service-option behavior, validity window, rule/data versions and release evidence. Until each is defined and verified, the corresponding integration stays `unavailable` or `manual_review`; MCP must not infer them from labels or UI totals.

The endpoint may write a minimal security audit containing hashed principal, tenant, request ID, operation, status and release identity. It must not create or mutate a quote record, sales record, manual task, notification, customer reply, booking, tariff/price rule, or learning feedback. A test must compare all business stores and outbound notification fakes before/after each outcome.

### Quote status mapping

- `success`: `quote_status=calculated`, release ready/non-test, total equals same-currency line sum, validity covers effective date, source and tenant/origin correlation pass; result remains `sendable=false`, `bookable=false`.
- `needs_input`: required shipment evidence, explicit unit, destination evidence or warehouse mapping is missing/invalid.
- `manual_review`: upstream explicitly cannot calculate safely, unsupported accessorial/remote condition, ambiguous pallet/rate evidence or partial fee coverage. `total` must be null when completeness is not established.
- `blocked`: entitlement, service credential, tenant binding or upstream authorization fails.
- `unavailable`: endpoint disabled, timeout/rate limit/dependency failure, no active release, test data, invalid evidence/hash/version, or response contract mismatch.

HTTP 200 alone never maps to `success`.

## Old and new behavior

### Customs

Old compatible output remains:

```json
{"version":"customs-search@v1","jurisdiction":"CA","candidates":[{"hs_code":"7323930090"}],"next_questions":[]}
```

New callers explicitly invoke a different tool and receive requested jurisdictions plus complete result fields:

```json
{"version":"customs-trade-search@2026-09-05.v1","requested_jurisdictions":["US","CA"],"results":[{"jurisdiction":"US","rate_lines":[]},{"jurisdiction":"CA","rate_lines":[]}]}
```

### Quote

The old audited route may cause business writes and is not an adapter target:

```json
{"route":"/quotes/zone-calculate","quote":{"postal_code":"M5V2T6"},"notification_fields":"legacy-specific"}
```

The proposed route is explicit preview-only and excludes notification/write fields:

```json
{"route":"/quotes/zone-preview","version":"quote-zone-preview-request@2026-09-05.v1","request_id":"req-opaque-001","effective_date":"2026-09-05","origin":{"warehouse_code":"warehouse-ont-01"},"destination":{},"cargo":{},"services":{}}
```

## Handoff and result-reference proposal

This is a later contract slice and does not block simple trusted top-level links.

- The data-owning service issues a random, single-use `handoff_id` bound server-side to issuer, recipient, tenant, actor reference, purpose, allowed fields, source business reference, issued/expiry times and state.
- Browser URLs carry only `handoff_id`; address, customer text, declared value, dimensions, credential and result payload are prohibited in URLs.
- The recipient claims the handoff through an authenticated server endpoint. Claim is atomic; states `pending|claimed|expired|revoked` belong to the handoff object and do not extend the MCP five-status envelope.
- Prefill always requires user confirmation and never auto-quotes, auto-classifies, sends, saves, notifies or books.
- A returned result reference contains `system`, `reference_id`, `result_kind`, `result_status`, `version`, `source_snapshot`, `valid_until`, `handoff_id` and `source_ref_ids`. It contains no copied business result.
- Display requires a fresh, authorized read from the owning service. Missing readback API, expiry, changed inputs or authorization failure prevents display as a current result.
- `quote_id`, RiskCustoms `queryId`, handoff ID and snapshot hash are separate namespaces. None is access authority; current RiskCustoms `queryId` is not a result-recovery handle.

## Permission and profile changes

- `t0-v1` remains exactly unchanged. No new adapter, endpoint, secret, egress host, scope or tool is constructed in that profile.
- `customs.trade.search` requires a new exact tool entitlement and a separately reviewed production profile after its schema and adapter are accepted.
- Quote preview keeps the existing `quote:calculate` business scope only if the entitlement RFC explicitly binds it to the exact new tool; a broad scope alone does not expose an absent tool.
- Handoff create/claim/readback use separate exact permissions. They do not grant quote send/save, notification, booking, customs write or Admin rights.
- Browser entry visibility, MCP tool visibility and upstream business authorization remain independent signals.

## Migration and compatibility

1. Accept this RFC before changing shared contracts or static registration.
2. Add new schemas and examples without editing old `customs.ca.search` artifacts.
3. Implement and test RiskCustoms projection behind a non-production profile; compare projected data field-by-field with a fixed M2M fixture.
4. Implement the quote preview inside the quote service, prove zero business writes, then update the MCP adapter to the accepted request and response. Do not point it at the old calculate route.
5. Add exact entitlements and a new profile only after contract, security and deployment reviews.
6. Enable one explicitly mapped tenant in staging, verify status/release/tenant/readback, then expand by explicit mapping.
7. Treat handoff as a later versioned delivery; simple links remain labeled as links until it exists.

No data migration is required. Existing client tokens, stored grants and `t0-v1` descriptors do not gain new tools.

## Rollback

1. Disable the new non-T0 profile or remove the exact new tool entitlements.
2. Restore the previous MCP build and adapter configuration; keep `customs.ca.search` active with its unchanged schema.
3. Disable `/quotes/zone-preview` without redirecting it to `/quotes/zone-calculate`.
4. Retain audit and release evidence; do not delete handoff or preview records to conceal partial attempts.
5. Verify tool/resource inventory, zero construction of new adapters in `t0-v1`, and original service UI behavior.

Rollback never changes upstream price/customs data and never converts failed handoffs into completed results.

## Required acceptance evidence

- Closed schemas and positive/negative examples validate under Draft 2020-12.
- Customs tests cover CN/US/CA selection, no silent jurisdiction expansion, exact/candidate flows, structured questions, every rate/document/measure/source field, numeric-vs-text rates, identity mismatch and `ready/testData` failures.
- Quote tests cover exact tenant and warehouse mapping, all unit conversions, decimal strings, currency consistency, total/line reconciliation, date validity, release/hash evidence and every five-state mapping.
- Quote side-effect tests prove no record/task/notification/customer reply/booking/rule/feedback mutation for success and all failures; security audit is separately asserted and contains no request body or customer data.
- Security tests cover missing/invalid credentials, cross-tenant assertion, broad JWT, absent exact entitlement, URL/credential injection, timeout, response size, rate limit and log redaction.
- Profile tests prove `t0-v1` inventory and zero-construction invariants are byte-for-byte unchanged.
- Staging acceptance requires authorized status then query/preview readback against explicit tenant mappings and active non-test releases. Local fixtures and green CI alone do not satisfy this gate.

## Open upstream definitions

The RFC cannot be accepted for production enablement until the appropriate service owner supplies:

- Quote fee taxonomy, coverage, rounding, currency and validity rules.
- Quote canonical origin/warehouse mapping and tenant isolation model.
- Quote release creation, approval, hash construction and active-readback procedure.
- RiskCustoms production endpoint, tenant credential mapping and current non-test publication evidence.
- Result recovery semantics for quote and customs; RiskCustoms currently has no query-result recovery contract.
- Handoff issuer/recipient API ownership, payload classification, maximum TTL and revocation policy.

These are `待适配验证`, not implied defaults.
