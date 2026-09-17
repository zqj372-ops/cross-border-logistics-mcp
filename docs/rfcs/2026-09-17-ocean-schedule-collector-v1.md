# 公开船司点到点船期采集器 v1

状态：`proposed`。尚未接受、批准或进入生产启用流程。

日期：2026-09-17（Asia/Shanghai）

核对基线：`108b11f8a38913ad00036f1378dca18cb6a2d0f3`

用户续做授权：用户于 2026-09-17 明确要求“继续完成”，并说明 K12 的普通操作无需再次确认。该授权允许在当前任务范围内继续独立 collector 的离线合同、受控 transport、纯解析、EvidenceStore、CLI 和测试实现，也允许在已确认官方入口上做有界只读 discovery。它不代表共享 MCP 合同已被接受，不代表生产或部署获批，也不代表任一船司的数据使用许可已经取得。

独立 collector 与对应测试目录的本任务实施，已有上述用户续做授权；2026-09-17 的审核跟进进一步要求完成真实查询与 CLI。当前文档记录已实现的独立合同和窄来源验证，不以 proposed 状态否认这些已有授权。

本 RFC 尚未构成共享 MCP/Portal 合同接受、静态注册表变更、生产构建或部署批准；公开来源技术可查询也不代表取得商业再分发许可。具体运行目标、预算和证据继续由受控 transport 校验。

## 1. 动机

现有船期能力只查询已经由人员核验、保存并发布的快照。它不执行船司官网的点到点查询，也不能表达公开来源返回的内陆交付点、运输分段、date-only 时间和未知时区。业务目标是先建立一个独立、只读、可审计的公开船期采集入口，完成一家船司的真实闭环后再逐家扩展。

本 RFC 解决的是范围、合同和安全门禁，不宣称任何船司已经可采集。没有 live 证据时，能力状态必须保持“待适配验证”或“受阻”。

## 2. 已核实事实

以下内容是当前基线上的代码事实：

1. `services/maritime/contracts.ts` 的 `sailingRow` 把起运地限制为六个代码，把目的地限制为 `CAVAN/CAPRR/CAMTR/CAHAL`，并要求船名、航次、带 offset 的离港和到港时间。
2. 旧合同的 `routing` 仅为 `direct/transshipment`，没有未知 routing、多段 legs、内陆交付点和 date-only 精度。
3. `queryMaritime()` 只筛选已发布数据，不联网；`maritimeSources` 只是导航链接。
4. `src/logistics_mcp/platform/envelope.ts` 提供 `createEnvelope()`、`validateEnvelope()` 和固定包络版本 `2026-08-11.v1`。
5. 统一包络的顶层状态仅为 `success`、`needs_input`、`manual_review`、`blocked`、`unavailable`。
6. `success` 不得包含 blocker；所有非 `success` 必须至少包含一个 blocker。
7. 顶层 envelope 只验证 `data` 是 object 或 null，不验证 collector 的字段闭合或领域语义。
8. `src/logistics_mcp/adapters/http-client.ts` 已有 HTTPS/host allowlist、默认 disabled、拒绝 redirect、超时、取消、响应限额和凭证头脱敏，但它不是完整 DNS 绑定或浏览器出网隔离器。
9. `CapabilityRegistry` 中的 `safe_http` 名称只表示能力声明，不证明已经存在或注入了具体安全客户端。
10. 当前 manifest 加载器是严格静态合同；规范的 v1 manifest 示例不是当前可部署配置。
11. Vitest 默认包含 `tests/**/*.test.ts`；源码位于 `services/**`，根 TypeScript 配置覆盖 `services/**/*.ts` 和 `tests/**/*.ts`。
12. 根 build 使用显式 entry point。新增文件不会自动进入生产制品。

以下内容是拟定或待批准事项，不是已核实能力：

- 超出已授权独立 collector 目录的所有权。
- 候选 module/tool 名。
- T1 隔离运行方案。
- live 出网白名单。
- 来源许可、数据留存期限和脱敏复用许可。

## 3. 目标与非目标

### 3.1 目标

- 对单个受控 carrier code 执行公开点到点船期查询。
- 先确认 carrier 的地点候选，再执行起终点查询并保留实际输入。
- 保留原始时间、日期精度、时区来源、事件类型、全部运输段和字段缺失原因。
- 通过现有统一包络返回结果，同时用独立 `collector_contract_version` 校验领域 data。
- 保存与实际存储脱敏字节对应的 SHA-256 证据。
- 首家通过至少三组真实条件和一个重启复验后，才扩展其他船司。
- 保持 live 默认关闭，未批准时不发起任何业务出网。

### 3.2 非目标

- 不修改现有人工核验、发布、Portal 或 MCP 工具注册。
- 不把抓取结果自动写入现有 publication 或设置 `source.verified=true`。
- 不登录船司后台、不读取用户浏览器 profile、不复用客户会话、不绕过验证码或访问控制。
- 不实现订舱、报价提交、报关、邮件发送或其他第三方写操作。
- 不首期实现定时同步、消息队列、全港口遍历或业务结果缓存回退。
- 不把 fixture、replay 或旧证据冒充本次 live 成功。

## 4. 旧合同与拟议合同示例

### 4.1 旧 `sailingRow`

```json
{
  "id": "row-1",
  "origin": "CNSHA",
  "destination": "CAVAN",
  "carrier": "EXAMPLE",
  "vessel": "EXAMPLE VESSEL",
  "voyage": "001E",
  "departure": "2026-10-01T08:00:00+08:00",
  "arrival": "2026-10-18T09:00:00-07:00",
  "departure_kind": "estimated",
  "arrival_kind": "estimated",
  "routing": "direct",
  "via": null
}
```

上面的结构不能表达：

- 用户查询的“多伦多”与海运卸货港之间的内陆交付段。
- 值仅为 `2026-10-01` 的 date-only 时间。
- 无法确认 offset 或时区的时间。
- 未知 routing、未知中转次数和完整 legs。
- 码头、接货点、交货点及逐字段缺失原因。

### 4.2 拟议 collector data 示例

以下示例是 synthetic fixture 的合同形状，不代表已经采集、实现或验证任何真实航线。它必须通过 `manual_review` 包络返回，不能被复制成 live success：

```json
{
  "collector_contract_version": "ocean-schedule-collector@2026-09-17.v1",
  "query": {
    "carrier": "EXAMPLE_CARRIER",
    "query_origin": {
      "input_text": "上海",
      "country_code": "CN",
      "carrier_location_id": "synthetic-origin-1",
      "mapping_source": "synthetic_fixture"
    },
    "query_destination": {
      "input_text": "多伦多",
      "country_code": "CA",
      "carrier_location_id": "synthetic-destination-1",
      "mapping_source": "synthetic_fixture"
    },
    "departure_from": "2026-09-20",
    "departure_until": "2026-10-31",
    "date_filter_basis": "departure_from_first_ocean_leg",
    "routing_filter": "any"
  },
  "carrier": {
    "id": "EXAMPLE_CARRIER",
    "sales_carrier": "Example Carrier",
    "adapter_version": "synthetic-fixture-adapter@0",
    "capability_status": "synthetic_only"
  },
  "records": [
    {
      "record_id": "record-1",
      "source_itinerary_id": "synthetic-itinerary-123",
      "operating_carrier": null,
      "service_name": "EXAMPLE-SERVICE",
      "routing": "unknown",
      "query_origin": "synthetic-origin-1",
      "query_destination": "synthetic-destination-1",
      "place_of_receipt": null,
      "place_of_delivery": "synthetic-destination-1",
      "pol": {
        "name": "Shanghai",
        "country_code": "CN",
        "carrier_location_id": "synthetic-origin-1",
        "unlocode": null
      },
      "pod": {
        "name": "Vancouver",
        "country_code": "CA",
        "carrier_location_id": "synthetic-pod-1",
        "unlocode": null
      },
      "terminal": null,
      "legs": [
        {
          "sequence": 1,
          "mode": "ocean",
          "vessel_name": "EXAMPLE VESSEL",
          "voyage": "001E",
          "from": "synthetic-origin-1",
          "to": "synthetic-pod-1",
          "events": [
            {
              "event_type": "departure",
              "raw_text": "20 Sep 2026",
              "local_date": "2026-09-20",
              "local_datetime": null,
              "utc_datetime": null,
              "offset": null,
              "timezone": null,
              "precision": "date",
              "event_kind": "estimated",
              "timezone_source": "not_provided"
            }
          ]
        },
        {
          "sequence": 2,
          "mode": "rail",
          "vessel_name": null,
          "voyage": null,
          "from": "synthetic-pod-1",
          "to": "synthetic-destination-1",
          "events": []
        }
      ],
      "cutoffs": {
        "si": null,
        "vgm": null,
        "cy": null,
        "customs": null
      },
      "cargo_available_at": null,
      "transit": {
        "source_total_minutes": "41760",
        "source_total_days": "29",
        "calculated_total_hours": null,
        "source_total_hours": "696",
        "source_ocean_minutes": "25920",
        "source_ocean_hours": "432",
        "source_ocean_days": "18",
        "calculated_ocean_hours": null,
        "basis": "insufficient_time_precision"
      },
      "evidence_ref": "evidence:fixture:sha256:example",
      "observed_at": "2026-09-17T00:00:00Z",
      "parser_version": "example-carrier-parser@1",
      "missing_fields": [
        {
          "field": "legs[1].events",
          "reason": "source_did_not_return_inland_event_times"
        }
      ]
    }
  ],
  "coverage": {
    "requested_from": "2026-09-20",
    "requested_until": "2026-10-31",
    "covered_windows": [
      {
        "from": "2026-09-20",
        "until": "2026-10-31"
      }
    ],
    "uncovered_windows": [],
    "pages_read": [1],
    "complete": false,
    "truncated": false,
    "failure_reason": "synthetic_fixture_not_live"
  },
  "provenance": {
    "kind": "synthetic",
    "fetched_at": null,
    "fixture_generated_at": "2026-09-17T00:00:00Z",
    "source_updated_at": null,
    "parser_version": "synthetic-fixture-parser@0",
    "source_refs": ["source:synthetic-design-example"]
  },
  "quality": {
    "key_fields_complete": false,
    "evaluation_status": "not_evaluated",
    "conflicts": [],
    "warnings": ["synthetic_data_not_for_validation"],
    "missing_field_count": 1
  }
}
```

该示例对应的顶层包络状态必须是 `manual_review`，不是一个 synthetic 的 `success`：

```text
schema_version: 2026-08-11.v1
status: manual_review
data: 上述 synthetic collector data
source_refs: [] 或仅包含 source_type=fixture 的本地设计来源
assumptions: synthetic_fixture_only
blockers: synthetic_data
review_status: manual_review
audit_id/request_id: 明确标记为 local fixture，不得冒充平台审计
```

上述文本只是包络形状说明；实际实现必须构造完整对象并调用 `createEnvelope()` 和 `validateEnvelope()`。

## 5. 拟议所有权和模块身份

### 5.1 所有权申请

拟申请：

- `services/maritime/schedule-collector/**`
- `tests/maritime/schedule-collector/**`
- `services/maritime/schedule-collector/docs/**`

明确不修改：

- `services/maritime/contracts.ts`
- `src/logistics_mcp/{platform,server,control-plane,module-runtime}/**`
- `services/access-gateway/**`
- `apps/**`
- 根包版本、现有 CLI 注册表、MCP 静态 catalog、Portal 路由和生产配置

### 5.2 拟议目录

目录只在所有权获批后创建，不预建空 provider：

```text
services/maritime/schedule-collector/
  contracts.ts
  contracts/
  ports.ts
  service.ts
  locations.ts
  normalize.ts
  evidence.ts
  cli.ts
  carriers/
    registry.ts
  transport/
  docs/
```

实现顺序以首家 carrier 的最小纵向链路为准。只有真实复用被证明后才提取公共 transport、normalization 或 parser helper。

### 5.3 候选 module 身份

以下是未批准的候选名称：

- `module_id`: `maritime.schedule_collector`
- 候选工具名：`maritime.schedule.search`
- 候选地点工具名：`maritime.schedule.locations`
- 候选 carrier 能力工具名：`maritime.schedule.carriers`

本阶段不注册工具，不写 manifest，不生成 digest、签名、SBOM 或 generation。

### 5.4 T1 隔离含义

本能力包含外部只读网络访问，拟按 T1 处理：

- 隔离进程或容器运行。
- 网络端口、clock、request/audit context 和 EvidenceStore 由 runner 注入。
- egress allowlist、总 timeout、取消、响应限额、记录限额和脱敏必填。
- 领域 parser 不直接 fetch，不启动浏览器，不读取全局环境。
- 浏览器路径只有在实际连接同样受控时才能启用。

## 6. 拟议输入合同

业务输入必须闭合，拒绝未知字段：

```json
{
  "carrier": "COSCO",
  "origin": {
    "text": "上海",
    "country_code": "CN",
    "carrier_location_id": null
  },
  "destination": {
    "text": "温哥华",
    "country_code": "CA",
    "carrier_location_id": null
  },
  "from": "2026-09-17",
  "until": "2026-10-28",
  "routing": "any"
}
```

规则：

- `carrier` 只能来自静态受控 registry。
- `origin`/`destination` 可先给文本，但执行前必须通过该 carrier 的地点解析取得 `carrier_location_id`。
- 多候选返回 `needs_input`，不自动取第一项。
- 默认未来 42 天只能由可信本地 runner 使用注入 clock 生成；规范化请求必须包含实际日期和默认来源说明。
- 最大窗口不超过 90 天，或来源更严格的限制。
- routing 默认 `any`。信息不足不能标记为 `direct`。

业务输入禁止包含：

- tenant、actor、request_id、audit_id 或其他信任上下文。
- token、Cookie、Authorization、API key 或任意凭证。
- 任意 base URL、host、port、path、代理或浏览器连接地址。
- SQL、JavaScript、shell 命令、可执行 selector 或动态 provider 代码。
- 任意文件路径、evidence path 或日志目录。

## 7. 拟议领域 data 合同

`collector_contract_version` 拟定为：

```text
ocean-schedule-collector@2026-09-17.v1
```

它是闭合对象里的领域版本，不改变统一包络的 `2026-08-11.v1`。

顶层 data 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `collector_contract_version` | string literal | collector 专属版本 |
| `query` | object | 规范化后的实际查询条件 |
| `carrier` | object | 静态 carrier 身份、adapter 版本和能力状态 |
| `records` | array | 有界方案记录 |
| `coverage` | object | 窗口、分页、截断和失败覆盖 |
| `provenance` | object | live/synthetic/replay、时间和 parser 版本 |
| `quality` | object | 字段缺失、冲突和 warning 摘要 |

每条 record 至少包含：

- 销售承运人和实际运营承运人。
- 来源 itinerary/route ID。
- service、船名和航次分离字段。
- query origin/destination、receipt/delivery、POL/POD 和 terminal。
- 有序 legs，mode 为 `ocean/rail/truck/barge/unknown`。
- 每个事件的 raw text、local date/datetime、offset、timezone、precision、event kind 和 timezone source。
- `direct/transshipment/unknown` routing。
- 来源给出的时效和自行计算时效分开。
- SI、VGM、CY、customs cutoff 分开保存。
- source/evidence ref、parser version 和 observed time。
- 逐字段缺失或冲突原因。

语义规则：

- date-only 不补 `00:00`。
- 未知时区不补 UTC 或任意 offset。
- 未知船名、航次、码头、cutoff 保持 null。
- estimated、planned、actual 不互相替代；来源未说明时为 unknown。
- 海运换船、挂靠和内陆运输段分开表达。
- 温哥华结果不能替代多伦多查询。
- 无稳定来源 ID 时，去重规则必须版本化并保留匹配不确定性。

## 8. 统一包络和运行时校验

每次 service/CLI 输出必须：

1. 先用 collector 自己的闭合 Schema 验证领域 data。
2. 再调用现有 `createEnvelope()` 构造包络。
3. 最终由 `validateEnvelope()` 校验固定版本和五状态不变量。
4. 不使用泛型断言跳过领域校验。

包络规则：

- `success` 必须有空 `blockers`。
- `needs_input/manual_review/blocked/unavailable` 必须至少有一个 blocker。
- `source_refs` 只能包含实际参与本次结果或失败分类的来源。
- `assumptions` 明示默认 42 天、日期口径、地点映射和 fixture/replay 状态。
- `warnings` 用于可继续但需要注意的字段缺失或来源限制。
- `calculation_trace` 只在确实进行计算时记录可回放步骤，不用来伪造来源权威。
- `audit_id` 和 `request_id` 由可信 runner 提供。本地 fixture 必须标识为 local/fixture，不能冒充生产审计。

## 9. 状态映射和 CLI 退出码

| 情况 | 顶层状态 | data/notice 要求 |
| --- | --- | --- |
| 输入缺失或地点歧义 | `needs_input` | 指出字段、候选和需要用户选择的内容 |
| live 完整读取所有窗口和分页，存在可核对记录 | `success` | `blockers=[]`，coverage.complete=true |
| live 完整读取后来源明确无匹配 | `success` | `records=[]`，warning `no_matching_records` |
| 有候选但窗口或分页不完整 | `manual_review` | coverage 说明未覆盖范围 |
| 来源冲突或关键字段歧义 | `manual_review` | 保留候选和冲突摘要 |
| synthetic 或 replay | `manual_review` | provenance 明示，不得作为 live success |
| 超时、解析失败、未实现 carrier、结构漂移 | `unavailable` | 保留可证实的错误分类 |
| HTTP 403 原因无法确认 | `unavailable` | `access_denied_or_unverified`，不猜验证码或封禁 |
| 明确策略拒绝或未批准出网 | `blocked` | 零上游请求，说明规则或批准缺失 |
| 登录、付费、访问控制明确阻断 | `blocked` | 不尝试绕过 |

拟议独立 CLI：

```text
carriers
locations --carrier <id> --query <text>
query --carrier <id> --origin <ref> --destination <ref> --from YYYY-MM-DD --until YYYY-MM-DD
```

退出码拟议：

| 码 | 含义 |
| --- | --- |
| `0` | `success` |
| `2` | CLI 语法或本地配置错误，未形成业务查询 |
| `3` | `needs_input` |
| `4` | `manual_review` |
| `5` | `blocked` |
| `6` | `unavailable` |
| `1` | 未分类内部错误；仍应尽可能输出合法包络和脱敏诊断 |

stdout 只输出 JSON。stderr 只输出脱敏诊断。`--mode live` 仅请求 live 模式，不构成出网批准；可信 runner 还必须校验已批准配置。

## 10. 来源权威和访问矩阵

技术可访问、来源权威、数据复用许可和人工发布资格是四个独立状态。页面可打开不等于允许自动采集。

下表记录旧任务的只读观察时间、证据位置和待复核状态。它不是新版 live 策略批准，也不授权新增探测。没有可追溯证据的条款、robots 或反爬原因一律写“旧任务报告、待回读核实”，不能当作当前确认结论：

| Carrier | 候选入口 | 观察时间（UTC） | 已有证据文件/opaque 引用 | 待复核观察 | 许可证据状态 | RFC 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| COSCO | `elines.coscoshipping.com` 公开点对点页 | `2026-09-17T02:50:25Z` | K12 CLI 真实查询证据，见 `.runtime/schedule-collector/evidence/` 与 `cosco-k12-live-probe.json` | K12 已通过受控 Node connector 完成三次公开查询；来源仍仅限单用户内部按需查询 | `live_verified_for_observed_public_path` | `live_verified` |
| OOCL | `www.oocl.com`、`moc.oocl.com` | `2026-09-16T16:18:51Z` 及 Mac `oocl-public-discovery-review.md` | `/tmp/oocl-home.html`、`/tmp/oocl-pbservice.html`；`oocl-public-discovery-review.md` | 公开 UI 观察已记录；解析器已实现但 K12 live 未复现，captcha token 不得复用或伪造 | `pending_k12_live_reproduction` | `blocked_untrusted_browser_connector` |
| ONE | `www.one-line.com` 与 `ecomm.one-line.com` 公开点到点接口 | `2026-09-17T10:27:44Z` | `one-*.json` 与 `one-integration-receipt.json` | K12 已通过受控 Node connector 完成直达、海运中转、内陆交付和三窗口查询；只按需只读查询，不声称商业再分发许可 | `live_verified_for_observed_public_path` | `live_verified` |
| Hapag-Lloyd | `www.hapag-lloyd.com` schedule | `2026-09-16T16:25:39Z` | `/tmp/hapag-schedule.html`；`opaque:hapag-cloudflare-403-observation` | 保存内容显示访问挑战；原因、许可和稳定可访问性待回读核实 | `pending_reread` | `blocked_unapproved_live_policy` |
| ZIM | `www.zim.com/schedules/point-to-point` | `2026-09-16T16:25:37Z` | `/tmp/zim-point.html`；`opaque:zim-403-observation` | 保存内容显示拒绝访问；许可和稳定访问条件待回读核实 | `pending_reread` | `blocked_unapproved_live_policy` |
| Evergreen | `shipmentlink.com` schedule | `2026-09-16T16:25:40Z` | `/tmp/evergreen-schedule.html`；robots 观察 `opaque:evergreen-robots-observation` | 跳转页面已保存；robots 限制为旧任务报告，待回读核实 | `pending_reread` | `blocked_unapproved_live_policy` |

当前 live 验收使用满足 DNS 固定、私网拒绝、redirect 拒绝、响应限额、取消和请求预算的 Node HTTPS trusted connector。OOCL 若要启用仍需要正常官方浏览器流程或单独授权 API，不能复制或伪造 CAPTCHA token。`--mode live` 仍必须通过精确目标配置和可信连接器校验；任何来源都不得因为“页面看起来可访问”而绕过这一门禁。

### 10.1 OOCL 已观察到的最小候选路径

Mac 的 `oocl-public-discovery-review.md` 记录了一次普通公开 UI 查询，无登录、无手动验证码，也没有复制或转交 Cookie/CAPTCHA token。它只作为 K12 复验前的审阅材料：

- GET `https://moc.oocl.com:443/nj_prs_wss/mocss/secured/supportData/gsp/locationDetails?id=<id>&bound=OB|IB`
- POST `https://moc.oocl.com:443/nj_prs_wss/mocss/secured/supportData/nsso/searchHubToHubRoute`
- 官方入口页面：`https://www.oocl.com/eng/ourservices/eservices/sailingschedule/Pages/default.aspx`

该观察还表明，页面的正常查询请求带有非空是必填的动态 CAPTCHA token。采集器不将该 token 放入业务输入，不重放 Cookie，也不伪造或去掉挑战。K12 只有在具备可信浏览器连接器和官方流程时才能把该路径视为可执行 live 候选；当前默认配置只登记精确 host/path/method，不发送请求。

同一观察记录了 `RouteId`、`TransitTimeInMinute`、`standardRoutes[]`、当地/GMT 时间、`OutboundDoor`、`Voyage`、`InboundIntermodal` 等字段。解析实现必须保留查询目的地和海运 POD 的分离，不能把上海到多伦多的查询写成 POD=Toronto；`nearby=true` 也只是来源标记，不能无条件作为严格匹配已证明。

### 10.2 外部参考仓库的边界

用户提供的 `ocean-pp-cli`、`get-schedule-data`、`maersk-mcp`、`COP` 和 `schedulesmcp-mcp` 材料已由 `reference-repo-review.md` 记录为参考资料，不整体导入或安装：

- `ocean-pp-cli` 的 carrier 过滤不能证明航次归属，且缺少 ETA/完整 legs。
- `get-schedule-data` 可能丢失共舱销售承运人，测试数据缺失时的真实请求回退不可接受。
- `maersk-mcp` 是 deadlines/portcalls 用途，不是完整 P2P schedule。
- `COP` 的 COSCO 官方接口需要当前有效的商业权限和凭证。
- `schedulesmcp-mcp` 公共 demo 返回合成数据，不能计入 live success。

候选结果合同中的 capability 状态必须区分：

- `not_probed`
- `probed`
- `implemented_unverified`
- `synthetic_only`
- `live_verified`
- `blocked`
- `unsupported`

只有 `live_verified` 且 `last_live_verified_at` 有证据的 carrier 才能出现在“已支持”列表。

## 11. 受控出网策略申请

### 11.1 当前批准状态

用户已授权 K12 在精确、可审计的范围内评估并实现 live 入口；实现层面的 OOCL 候选目标已固定为上述 host/path/method。live 仍默认关闭，且没有 trusted browser connector 时不发送请求。

`--mode live`、CI 变量、本地开关或 fixture 配置不能替代精确目标校验和 trusted connector。没有 connector 时返回具体阻塞，而不是声称来源查询已验收。

### 11.2 未来允许的申请形式

每项 live 规则必须包含：

```json
{
  "carrier": "CARRIER_ID",
  "host": "exact.example",
  "port": 443,
  "scheme": "https",
  "methods": ["GET"],
  "path_patterns": ["/exact/public/path"],
  "redirect_policy": "deny",
  "source_permission_ref": "traceable-reference",
  "live_policy_approval_ref": "traceable-reference",
  "expires_at": "2026-12-31T00:00:00Z"
}
```

如果来源确实需要 POST 或动态查询参数，必须单独列出精确 path、参数白名单、方法和来源许可。不得用 `*.domain`、任意 path、模型生成 host 或通用代理代替。

### 11.3 运行预算

以下是待批准开发上限，不是船司允许额度：

- 单 carrier 并发：1。
- 安全重试：最多 2 次。
- 整体 deadline：120 秒。
- 请求、页数、记录数和解压后响应体均有配置上限。
- 429 尊重 `Retry-After`；超过 deadline 返回结构化失败。
- 403 不循环重试。原因不明确时返回 `unavailable`。
- 不采用代理池、验证码破解、账号池或指纹规避。

### 11.4 DNS、连接和浏览器

- 域名检查和实际连接目标必须一致，避免解析后重绑定。
- 默认拒绝 redirect。必要跳转逐跳校验并重新做 host/path 策略检查。
- 浏览器必须使用受控代理、容器或等效实际出网隔离。
- Playwright route 拦截不能单独证明所有出口受限。
- BrowserContext 必须隔离，默认阻止 Service Worker、弹窗和新页面绕过。
- document、XHR/fetch、子资源、redirect、WebSocket 和下载都受同一策略约束。
- 浏览器端口无法提供实际连接隔离时，浏览器路径保持不可用。

## 12. 证据保留和脱敏

- EvidenceStore 由 runner 注入。业务输入不接收目录或任意路径。
- 输出只返回 opaque evidence ref。
- 开发证据根目录位于未被 Git 跟踪的受控目录。
- 只保存必要响应、DOM 或截图，不保存整站 HAR。
- Cookie、Authorization、Set-Cookie、CSRF token、个人资料和敏感查询参数必须剔除。
- SHA-256 对脱敏后的实际存储字节计算，并记录脱敏方式和 parser version。
- 普通日志只记录 request ID、carrier、状态、耗时、计数和 evidence ref。
- 不做首期业务结果缓存回退。旧 evidence 只用于显式 replay 或复核。
- 拟议开发保留期为 7 天；这是待批准默认值，不是公司既定政策。
- 不实现自动删除，不提交原始 live 证据，不把真实响应命名为 synthetic fixture。

## 13. 依赖注入和生命周期

拟议端口：

- `Clock`
- `RequestContext`
- `AuditPort`
- `EvidenceStore`
- `CarrierHttpPort`
- `CarrierBrowserPort`
- `CancellationSignal`

约束：

- parser 是纯函数，不 fetch、不启动浏览器、不读取环境变量。
- carrier adapter 只获得实现该 carrier 查询所需的窄端口。
- import 阶段不联网、不创建目录、不启动浏览器、不挂全局 timer。
- service 不依赖 MCP SDK、Portal session、Gateway 全局状态或生产数据库。
- page/context/browser、timer、listener、临时文件和 socket 都有明确 owner。
- dispose 幂等；取消贯穿 HTTP、浏览器和 EvidenceStore。

## 14. 兼容性和迁移

- 现有 `services/maritime/contracts.ts` 不修改。
- 统一包络版本不修改。
- 不改变现有 Portal publication、CLI 和 MCP 权限。
- 新 collector data 不直接转换成旧 `sailingRow` 后发布。
- 未来 converter 必须是纯转换并逐条报告拒绝原因。
- 缺时区、内陆 legs、未知 routing 等字段无法无损映射时，不得补值。
- 空结果不能伪造一条记录来满足旧 dataset 的 `records_required`。

## 15. 拟议测试设计

测试目录拟为 `tests/maritime/schedule-collector/`，默认不访问真实船司。

合同测试：

- 输入未知字段和禁止字段拒绝。
- date window、最大 90 天和默认 42 天。
- collector data 闭合。
- Ajv 2020 编译本地 JSON Schema。
- Zod refine 与导出的 JSON Schema 语义差异有单独回归。
- `success` 无 blocker、非 success 有 blocker。

地点和规范化测试：

- 唯一匹配、多候选、无匹配。
- carrier-specific location ID。
- date-only、未知时区、DST 歧义、非法时间顺序。
- 计划、预计、实际、未知不混用。
- 内陆联运、直达、中转、中间挂靠和 unknown routing。
- 缺船名、航次、cutoff 时保持 null。

失败闭合测试：

- 真无匹配与解析空列表不同。
- 登录页、挑战页、HTTP 200 错误页不能产生成功空数组。
- 分页失败、窗口截断和数据超限进入 partial/manual_review。
- timeout、429、403 未知原因、5xx 和 schema drift。
- synthetic/replay 不能成为 live success。

安全测试：

- SSRF、私网、loopback、metadata、redirect 外逃。
- 用户路径和 host 注入拒绝。
- 凭证头、Cookie 和敏感 query 脱敏。
- 请求和解压后响应大小限制。
- 取消和异常后无活动资源、timer、socket 或浏览器进程。

生命周期测试：

- import 无 I/O 和全局副作用。
- 重复 close/dispose 幂等。
- 取消期间仍能清理 EvidenceStore 和 transport。

## 16. 真实验收要求

同一家 carrier 至少完成：

1. 上海到温哥华。
2. 宁波到温哥华。
3. 另一个日期窗口或到多伦多的点对点查询。

验收条件：

- 至少一组返回完整非空结果。
- 三组均记录输入、实际日期、时区、入口、coverage、条数、parser version、evidence ref 和 hash。
- 对官网逐项核对地点、船名、航次、关键时间、直达或中转。
- 另一个输入歧义或错误路径。
- 进程重启后使用同一 CLI 复验，不依赖一次性手工注入。
- 无结果必须确认查询终态、全部窗口和分页完整。
- 来源没有返回中转或内陆路线时标记未覆盖，不用合成结果代替 live。

## 17. 回滚

本 RFC 描述的第一阶段没有数据迁移、共享合同变更或生产部署，因此回滚为：

1. 关闭 live 配置和 live runner。
2. 停止并删除独立 collector 进程/容器。
3. 删除或停用独立 CLI 入口。
4. 保留证据，直到审批的保留期或人工删除流程执行。
5. 不触碰现有 maritime publication、Portal、MCP catalog 或数据库。

如果未来实现修改共享文件，必须另行 RFC 并定义迁移和回滚，不能沿用本 RFC 自动授权。

## 18. 分离的审批状态

| 审批域 | 当前状态 | 可接受审批证据 | 未获批准时的行为 |
| --- | --- | --- | --- |
| 目录所有权 | `user_authorized_task_scope` | 用户 2026-09-17 续做指令 | 超出该独立目录时停止 |
| collector 候选合同 | `implemented_independently_pending_shared_acceptance` | 合同审查记录 | 不注册共享契约 |
| live 出网策略 | `narrow_cosco_and_one_paths_verified` | trusted connector + 精确 host/path/method/query allowlist | 未登记目标保持 blocked |
| COSCO 来源许可 | `pending_reread` | 回读现有条款证据并取得可追溯许可结论 | 不自动采集 |
| OOCL 来源访问/许可 | `official_terms_reviewed_internal_use_only` | 不做商业聚合/再分发；K12 live 仍待复现 | 不自动采集 |
| ONE 来源复用许可 | `public_on_demand_read_only_verified_no_redistribution_license` | 官方公开接口按需查询；未取得再分发许可 | 不自动批量采集或发布 |
| Hapag-Lloyd 来源访问/许可 | `pending_reread` | 回读访问证据并取得可追溯许可结论 | 不自动采集 |
| ZIM 来源访问/许可 | `pending_reread` | 回读访问证据并取得可追溯许可结论 | 不自动采集 |
| Evergreen 来源访问/许可 | `pending_reread` | 回读 robots 证据并取得可追溯许可结论 | 不自动采集 |
| MCP/Portal 接入 | `deferred` | 后续独立 RFC 和发布批准 | 不注册、不修改 |

任何一项批准都不能自动推导其他项。目录批准不等于合同批准，合同批准不等于 live 批准，live 批准不等于某船司许可。

## 19. 待审问题和下一门槛

完成共享合同接受或 live 验收前需要回答：

- collector data 的字段是否满足后续 MCP 适配和业务查询。
- 第一个 carrier 是否能提供明确允许自动访问和必要证据留存的来源。
- 是否具备受控 DNS、实际连接固定和浏览器 egress 隔离。
- EvidenceStore 的开发根目录、权限和保留删除责任人。
- live 配置的精确 host/port/path/method、预算和过期时间。

当前用户授权已允许本任务目录内实现和离线验证，以及在精确、可审计范围内评估 live 入口。仍保持：

- 共享 MCP/Portal 合同仍为 proposed，不注册。
- live 默认关闭，不得绕过 trusted connector、精确目标或官方 CAPTCHA 流程。
- 用户于 2026-09-17 明确授权提交、推送当前船期分支并新建 PR（期望编号 #30，实际由 GitHub 分配）；合并或部署仍需后续明确授权。

不允许：

- 注册 MCP/Portal。
- 保存或提交原始 live 证据。
- 在缺少 K12 复现证据时声称任何船司已完成真实采集。

## 20. 验收材料

本 RFC 的审阅材料必须最终包含：

- 旧/新 JSON 示例。
- collector 闭合 Schema 草案。
- 五状态和 CLI exit code 映射。
- carrier 访问和许可矩阵。
- 精确出网白名单申请表。
- EvidenceStore 脱敏和 hash 规则。
- 测试矩阵。
- 三组 live 验收表和重启复验。
- 代码、采集、PR、部署各自独立的实际状态。
