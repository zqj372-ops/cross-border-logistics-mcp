# 船期 collector 产品接入 v1

状态：`accepted`。Mac 基线审核于 2026-09-18 接受本文的产品接入边界，接受记录见
`handoffs/schedule-mobile-20260918/mobile-baseline-acceptance-20260918.md`；该记录
覆盖本文原有的 proposed 冲突、缺漏和待决表述。本文按接受记录落地 Portal 路由、人员
CLI 和 `schedule-live-v1` MCP 装配，不涉及生产部署或合并。

日期：2026-09-18（Asia/Shanghai）

实现基线：起始 `e556691951a54262e2c5f2f97d63d994f4f0ceff`，其上叠加本地修订：
全局 deadline/取消覆盖终态审计、`services/maritime/schedule-live/` 产品合同与
tenant/actor/audit/evidence 绑定、Portal 三个路由、人员 CLI 三条 live 命令、以及
`schedule-live-v1` MCP profile（独立 3 工具 provider health）。旧 `business-v1` 的
五工具集合、health `length(5)`、T0 和旧凭证语义保持不变。

相关文件：

- [独立船期采集器 v1](2026-09-17-ocean-schedule-collector-v1.md)
- [独立询价、船期与码头效率工作台 v1](2026-09-08-maritime-workspaces-v1.md)
- `services/maritime/contracts.ts`
- `services/maritime/schedule-collector/contracts.ts`
- `services/access-gateway/portal/http.ts`
- `apps/console/maritime.js`
- `deploy/cli/workspace.ts`
- `services/maritime/schedule-collector/docs/mcp-integration-deferred.md`

## 1. 动机

当前产品已经有两条不同的船期能力：

1. `#schedules`、`ocean.schedules` 和
   `POST /console/api/v1/maritime/sailing-schedules/query` 只读取企业人员已经核验并发布的
   `sailingRow` 快照。
2. 独立 collector 可以通过受控 connector 查询 ONE、COSCO、HMM 等来源，并返回完整的
   `ocean-schedule-collector@2026-09-17.v1` 结果。

两者不能直接拼接。旧 `sailingRow` 要求固定的中国起运港和加拿大目的地、船名、航次以及
带 offset 的离港和到港时间，且 `routing` 只有 `direct/transshipment`。collector 还可能
返回内陆运输段、date-only 时间、未知时区、未知 routing、多个 legs、cutoff 和完整
coverage。把这些数据强行压成旧行会丢失字段并把未知事实补成已确认事实，因此本 RFC
请求增加独立的 live 产品入口，而不是修改旧快照合同。

## 2. 已确认事实和未决边界

已确认：

- `services/maritime/contracts.ts` 的 `MARITIME_VERSION` 是
  `maritime-query@2026-09-08.v1`，旧查询接口、旧页面和旧人员 CLI 已实现并有测试。
- collector 的领域合同是 `ocean-schedule-collector@2026-09-17.v1`，统一包络版本是
  `2026-08-11.v1`。
- collector 已经可以返回 `records`、`coverage`、`provenance`、`quality` 和
  `ScheduleRecord.legs`；它不修改旧 `sailingRow`。
- ONE 和 COSCO 在 2026-09-17 的 K12 独立 live 验证中达到了对应观察范围的
  `live_verified`；HMM 地点查询成功但 P2P 仍为 `access_restricted`，OOCL 仍需要
  受信任浏览器路径或单独批准的官方 API。
- 12 家 carrier 的静态登记、导航链接、合成 fixture、历史 probe 或第三方 demo 都不能
  当作当前 live 覆盖。
- `services/maritime/schedule-collector/docs/mcp-integration-deferred.md` 明确说明当前
  collector 没有注册 MCP、Portal 路由或生产构建入口。

已由接受记录解决：

- 本 RFC 的 Portal 路由、人员 CLI 命令、MCP 工具名和 `schedule-live-v1` profile
  已于 2026-09-18 接受；本轮据此实现，生产默认挂载保持关闭。

剩余外部输入：

- ONE/COSCO 的来源许可、商业再分发和保留期需要单独确认；技术可访问不等于允许扩大
  使用范围。
- 企业 allowlist、viewer 角色边界已按接受记录定为部署注入；具体生产值与安全审批仍
  需在部署前确认。

## 3. 请求批准的范围

建议批准一个“旧快照不变、live 独立入口”的最小接入：

- 保留 `#schedules` 的旧查询按钮和 `sailing-schedules/query` 路径，继续读取企业快照。
- 在同一页面增加明确的 live 查询区域或来源切换，不把 live 记录保存为发布快照。
- 新增三个闭合 REST 路由，供 Web、人员 CLI 和未来 MCP adapter 共用同一个 collector
  service。
- 候选 MCP 工具名保持为：
  - `maritime.schedule.search`
  - `maritime.schedule.locations`
  - `maritime.schedule.carriers`
- 候选 module identity 保持为 `maritime.schedule_collector`。
- 第一阶段只在本地/fixture 和明确启用的企业环境中开放 live；默认关闭。

明确不包含：

- 不修改 `services/maritime/contracts.ts` 的旧 `sailingRow`、旧状态和旧发布流程。
- 不把 collector 结果自动发布、自动合并或自动转换为企业快照。
- 不增加任意 URL、任意 host、任意 headers、原始 HTML、Cookie、CSRF token 或证据字节
  的客户端输入/输出。
- 不把 HMM、OOCL、EMC/EVERGREEN、其他登记 carrier 或 synthetic fixture 声明为 live
  可用。
- 不在本 RFC 中实现生产部署、source license、商业再分发或全量 carrier 覆盖。

## 4. 合同、路由和名称

### 4.1 旧合同保持不变

旧快照请求继续使用：

```http
POST /console/api/v1/maritime/sailing-schedules/query
```

```json
{
  "origin": "CNSHA",
  "destination": "CAVAN",
  "from": "2026-09-17",
  "until": "2026-10-14",
  "carrier": "ONE"
}
```

旧响应继续使用 `maritime-query@2026-09-08.v1`，并保留
`data.records[]`、`data.source`、`data.release` 和 `reason_codes`。旧接口不得返回
collector 的 `legs`、`coverage`、`provenance` 或 `collector_contract_version`。

### 4.2 新 live 路由

建议新增以下 Portal 人员会话路由。它们使用服务端注入的 tenant/actor/audit 上下文，
不接收客户端 tenant 或 actor：

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| `GET` | `/console/api/v1/maritime/schedule-collector/carriers` | 返回受控 carrier registry 和 capability status；不代表 live 可用 |
| `POST` | `/console/api/v1/maritime/schedule-collector/locations` | 解析某个 carrier 的官方地点候选 |
| `POST` | `/console/api/v1/maritime/schedule-collector/search` | 执行点到点船期查询 |

建议的 person CLI 名称：

```text
freightclaw workspace schedules live-carriers --session-file session.json
freightclaw workspace schedules live-locations --session-file session.json --input locations.json
freightclaw workspace schedules live-search --session-file session.json --input search.json
```

旧 `workspace schedules query|get|save|preview|publish|disable|rollback` 保持不变，继续
操作企业快照。`live-*` 命令只调用上述新路由，不执行保存、发布或回退。

### 4.3 新 collector JSON

`search` 请求使用 collector 的闭合输入合同：

```json
{
  "carrier": "ONE",
  "origin": {
    "text": "Shanghai",
    "country_code": "CN",
    "carrier_location_id": "CNSHA"
  },
  "destination": {
    "text": "Vancouver",
    "country_code": "CA",
    "carrier_location_id": "CAVAN"
  },
  "from": "2026-09-17",
  "until": "2026-10-14",
  "routing": "any"
}
```

规则继续由 `CollectorQueryInputSchema` 执行：

- carrier 只能是静态受控 registry 中的规范化值。
- `origin` 和 `destination` 先给文本时，执行前必须由 `locations` 取得唯一
  `carrier_location_id`；多候选返回 `needs_input`，不自动取第一项。
- 查询窗口必须显式给出，最大 90 天；默认未来 42 天只能由可信 runner 注入 clock 生成。
- routing 只能为 `any`、`direct` 或 `transshipment`；来源不足时不能补成 direct。

响应使用统一包络，`data` 使用 collector 合同。下面不是人工拼出的 live 成功示例，而是
在 `e556691951a54262e2c5f2f97d63d994f4f0ceff` 上执行以下 synthetic CLI 后由现有
service 生成的完整脱敏包络；它明确展示非 live 来源只能进入 `manual_review`：

```sh
node --import tsx/esm services/maritime/schedule-collector/cli.ts query \
  --carrier OOCL \
  --origin Shanghai --origin-country CN \
  --destination Toronto --destination-country CA \
  --from 2026-09-17 --until 2026-10-28 \
  --mode synthetic
```

```json
{
  "schema_version": "2026-08-11.v1",
  "request_id": "schedule-cli-request-57ea5fbb67db400a870c1151779558af",
  "status": "manual_review",
  "data": {
    "collector_contract_version": "ocean-schedule-collector@2026-09-17.v1",
    "run_status": "partial",
    "query": {
      "carrier": "OOCL",
      "query_origin": {
        "input_text": "Shanghai",
        "country_code": "CN",
        "carrier_location_id": "synthetic-oocl-shanghai",
        "mapping_source": "synthetic_fixture",
        "source_full_name": null
      },
      "query_destination": {
        "input_text": "Toronto",
        "country_code": "CA",
        "carrier_location_id": "synthetic-oocl-toronto-ca",
        "mapping_source": "synthetic_fixture",
        "source_full_name": null
      },
      "departure_from": "2026-09-17",
      "departure_until": "2026-10-28",
      "date_filter_basis": "departure_from_first_ocean_leg",
      "routing_filter": "any"
    },
    "carrier": {
      "id": "OOCL",
      "sales_carrier": "OOCL synthetic fixture",
      "adapter_version": "oocl-schedule-parser@1",
      "capability_status": "synthetic_only",
      "last_live_verified_at": null
    },
    "records": [
      {
        "record_id": "oocl-route-9000000001",
        "source_itinerary_id": "9000000001",
        "operating_carrier": null,
        "service_name": null,
        "routing": "transshipment",
        "query_origin": "synthetic-oocl-shanghai",
        "query_destination": "synthetic-oocl-toronto-ca",
        "place_of_receipt": "synthetic-oocl-shanghai",
        "place_of_delivery": "synthetic-oocl-toronto-ca",
        "pol": {
          "name": "Shanghai",
          "country_code": null,
          "carrier_location_id": "synthetic-oocl-shanghai",
          "unlocode": "CNSHA",
          "type": "port"
        },
        "pod": {
          "name": "Vancouver",
          "country_code": null,
          "carrier_location_id": "synthetic-oocl-vancouver-ca",
          "unlocode": "CAVAN",
          "type": "port"
        },
        "terminal": null,
        "legs": [
          {
            "sequence": 1,
            "mode": "ocean",
            "source_leg_id": "synthetic-leg-1",
            "vessel_name": "SYNTHETIC VESSEL ONE",
            "voyage": "SYN001E",
            "from": {
              "name": "Shanghai",
              "country_code": null,
              "carrier_location_id": "synthetic-oocl-shanghai",
              "unlocode": "CNSHA",
              "type": "port"
            },
            "to": {
              "name": "Busan",
              "country_code": null,
              "carrier_location_id": "synthetic-oocl-busan",
              "unlocode": "KRPUS",
              "type": "port"
            },
            "events": [
              {
                "event_type": "departure",
                "raw_text": "20260918033000.000",
                "local_date": "2026-09-18",
                "local_datetime": "2026-09-18T03:30:00.000",
                "utc_datetime": "2026-09-17T19:30:00.000Z",
                "offset": null,
                "timezone": "Asia/Shanghai",
                "precision": "local_datetime",
                "event_kind": "unknown",
                "timezone_source": "oocl_leg_timezone"
              },
              {
                "event_type": "arrival",
                "raw_text": "20260920093000.000",
                "local_date": "2026-09-20",
                "local_datetime": "2026-09-20T09:30:00.000",
                "utc_datetime": "2026-09-20T00:30:00.000Z",
                "offset": null,
                "timezone": "Asia/Shanghai",
                "precision": "local_datetime",
                "event_kind": "unknown",
                "timezone_source": "oocl_leg_timezone"
              }
            ]
          },
          {
            "sequence": 2,
            "mode": "ocean",
            "source_leg_id": "synthetic-leg-2",
            "vessel_name": "SYNTHETIC VESSEL TWO",
            "voyage": "SYN002S",
            "from": {
              "name": "Busan",
              "country_code": null,
              "carrier_location_id": "synthetic-oocl-busan",
              "unlocode": "KRPUS",
              "type": "port"
            },
            "to": {
              "name": "Vancouver",
              "country_code": null,
              "carrier_location_id": "synthetic-oocl-vancouver-ca",
              "unlocode": "CAVAN",
              "type": "port"
            },
            "events": [
              {
                "event_type": "departure",
                "raw_text": "20260921110000.000",
                "local_date": "2026-09-21",
                "local_datetime": "2026-09-21T11:00:00.000",
                "utc_datetime": "2026-09-21T02:00:00.000Z",
                "offset": null,
                "timezone": "Asia/Seoul",
                "precision": "local_datetime",
                "event_kind": "unknown",
                "timezone_source": "oocl_leg_timezone"
              },
              {
                "event_type": "arrival",
                "raw_text": "20260930060000.000",
                "local_date": "2026-09-30",
                "local_datetime": "2026-09-30T06:00:00.000",
                "utc_datetime": "2026-09-30T13:00:00.000Z",
                "offset": null,
                "timezone": "Asia/Seoul",
                "precision": "local_datetime",
                "event_kind": "unknown",
                "timezone_source": "oocl_leg_timezone"
              }
            ]
          },
          {
            "sequence": 3,
            "mode": "unknown",
            "source_leg_id": "synthetic-intermodal-1",
            "vessel_name": null,
            "voyage": null,
            "from": {
              "name": "Vancouver",
              "country_code": null,
              "carrier_location_id": "synthetic-oocl-vancouver-ca",
              "unlocode": "CAVAN",
              "type": "port"
            },
            "to": {
              "name": "Toronto",
              "country_code": null,
              "carrier_location_id": "synthetic-oocl-toronto-ca",
              "unlocode": "CATOR",
              "type": "port"
            },
            "events": []
          }
        ],
        "cutoffs": {
          "si": null,
          "vgm": null,
          "cy": {
            "at": "2026-09-15T12:00:00.000",
            "precision": "datetime",
            "place": null,
            "conditions": [],
            "source_text": "20260915120000.000"
          },
          "customs": null
        },
        "cargo_available_at": null,
        "transit": {
          "source_total_minutes": "1710",
          "source_total_hours": "28.5",
          "source_total_days": null,
          "calculated_total_hours": null,
          "source_ocean_minutes": null,
          "source_ocean_hours": null,
          "source_ocean_days": null,
          "calculated_ocean_hours": null,
          "basis": "source_transit_minutes"
        },
        "evidence_ref": "evidence:schedule-cli-request-57ea5fbb67db400a870c1151779558af:OOCL:sha256:e9960986a757ac028fa48619ce6ffa82c1d5fe9ba88844695a5a8e44d6f67ba1",
        "observed_at": "2026-09-17T18:36:18.921Z",
        "parser_version": "oocl-schedule-parser@1",
        "missing_fields": []
      }
    ],
    "coverage": {
      "requested_from": "2026-09-17",
      "requested_until": "2026-10-28",
      "covered_windows": [
        {
          "from": "2026-09-17",
          "until": "2026-10-28"
        }
      ],
      "uncovered_windows": [
        {
          "from": "2026-09-17",
          "until": "2026-10-28"
        }
      ],
      "pages_read": [1],
      "complete": false,
      "truncated": false,
      "failure_reason": "synthetic_fixture_not_live"
    },
    "provenance": {
      "kind": "synthetic",
      "fetched_at": null,
      "fixture_generated_at": "2026-09-17T18:36:18.936Z",
      "source_updated_at": null,
      "parser_version": "oocl-schedule-parser@1",
      "source_refs": [
        "evidence:schedule-cli-request-57ea5fbb67db400a870c1151779558af:OOCL:sha256:e9960986a757ac028fa48619ce6ffa82c1d5fe9ba88844695a5a8e44d6f67ba1"
      ]
    },
    "quality": {
      "key_fields_complete": true,
      "evaluation_status": "evaluated",
      "conflicts": [],
      "warnings": [],
      "missing_field_count": 0
    }
  },
  "source_refs": [
    {
      "source_id": "carrier-oocl-observation",
      "source_type": "fixture",
      "system": "OOCL synthetic fixture",
      "locator": "evidence:schedule-cli-request-57ea5fbb67db400a870c1151779558af:OOCL:sha256:e9960986a757ac028fa48619ce6ffa82c1d5fe9ba88844695a5a8e44d6f67ba1",
      "version": "oocl-schedule-parser@1",
      "retrieved_at": "2026-09-17T18:36:18.936Z",
      "authority": "supporting",
      "content_hash": null
    }
  ],
  "assumptions": [
    {
      "code": "synthetic_fixture_only",
      "message": "This is a synthetic design fixture and not a live observation.",
      "severity": "info"
    }
  ],
  "warnings": [],
  "blockers": [
    {
      "code": "synthetic_data",
      "message": "Synthetic collector data is not a live carrier result.",
      "severity": "error"
    }
  ],
  "calculation_trace": [],
  "review_status": "manual_review",
  "audit_id": "schedule-cli-audit-57ea5fbb67db400a870c1151779558af"
}
```

真实 live `success` 的结构仍使用同一 `CollectorResultDataSchema`，但必须同时满足
`provenance.kind=live`、`coverage.complete=true`、`run_status` 为 `ok` 或
`no_results`、以及由 service 生成的非空 evidence refs；`no_results` 也是合法的完整
覆盖结果。本文不再提供伪造成功响应。真实 ONE/COSCO 验收记录单独保存在 handoff 中。
`locations` 成功时返回候选数组和唯一解析结果；`carriers` 成功时只返回 registry
元数据，不能把 `capability_status` 误写成实时可用。

### 4.4 carriers / locations 闭合合同

`carriers` 与 `locations` 的输入输出全部由 Draft 2020-12 Schema 校验，`strict()`
等效 `additionalProperties:false`。实现位于
`services/maritime/schedule-live/contracts.ts`，MCP 目录用 `z.toJSONSchema` 生成
Draft 2020-12 输入/输出；REST、人员 CLI 与 MCP 共用同一份 Zod schema。

`carriers`（无输入）输出 `ScheduleLiveCarriersDataSchema`。下面
`last_live_verified_at` 只是结构示例，不构成新的 live 验证事实；真实状态以
`carrier-matrix.json` 和每个 carrier 的 `capability_status` 为准：

```json
{
  "carriers": [
    {
      "id": "ONE",
      "display_name": "Ocean Network Express",
      "adapter_version": "one-schedule-parser@1",
      "capability_status": "live_verified",
      "last_live_verified_at": "2026-09-18T00:00:00Z"
    }
  ]
}
```

`locations` 输入 `ScheduleLiveLocationsRequestSchema`：

```json
{
  "carrier": "ONE",
  "text": "Shanghai",
  "country_code": "CN",
  "carrier_location_id": null
}
```

唯一匹配输出 `ScheduleLiveLocationsEnvelopeSchema`（下面示例只有 1 个候选，
`resolved` 为 null 仅用于展示 data 形状；唯一匹配时 parser 会要求 `resolved` 非空）。
多候选同样是 `status=needs_input`、`blockers[0].code=ambiguous_location`，但
`candidates` 至少包含 2 个官方匹配项且 `resolved` 必须为 null：

```json
{
  "carrier": "ONE",
  "query": "Shanghai",
  "candidates": [
    {
      "name": "SHANGHAI, SHANGHAI, CHINA",
      "country_code": "CN",
      "type": "city",
      "carrier_location_id": "CNSHA",
      "mapping_source": "one_point_to_point_search",
      "source_full_name": "SHANGHAI, SHANGHAI, CHINA",
      "unlocode": null
    }
  ],
  "resolved": null
}
```

唯一匹配时 `status=success`、`resolved` 为单个候选（`ResolvedLocationSchema`），
`candidates` 仍保留完整候选列表。无匹配时 `status=needs_input`、
`blockers[0].code=location_not_found`、`data=null`。候选数量上限 64，超过即校验失败；
不存在自动选择第一项的降级路径。

三个 REST/CLI/MCP 映射：

| REST | 人员 CLI | MCP 工具 | 输入 schema | 输出 schema |
| --- | --- | --- | --- | --- |
| `GET .../schedule-collector/carriers` | `schedules live-carriers` | `maritime.schedule.carriers` | 无 | `ScheduleLiveCarriersEnvelopeSchema` |
| `POST .../schedule-collector/locations` | `schedules live-locations` | `maritime.schedule.locations` | `ScheduleLiveLocationsRequestSchema` | `ScheduleLiveLocationsEnvelopeSchema` |
| `POST .../schedule-collector/search` | `schedules live-search` | `maritime.schedule.search` | `CollectorQueryInputSchema` | `ScheduleLiveSearchEnvelopeSchema` |

### 4.5 MCP 版本与装配策略

现状是 `business-v1` 的静态集合：`src/logistics_mcp/platform/application-tools.ts`
的 `BUSINESS_MCP_TOOLS` 固定 5 个工具，
`src/logistics_mcp/server/composition.ts` 用 `assertExactStringSet` 精确校验，
`src/logistics_mcp/server/managed-business-provider.ts` 的 health
`operations` 固定 `length(5)`。因此不能把三个船期工具直接追加到旧数组，否则：

1. 旧 provider health（5 项）会与新集合不等，所有 `business-v1` 部署直接不健康。
2. 旧 Key/JWT 的 scope 枚举会被扩大，违反“旧 Key 不自动扩权”。
3. `BusinessAccessService`、`business/contracts.ts` 的 `BUSINESS_OPERATIONS` 和
   `schemas/access-gateway/*` 会同时漂移，回归范围不可控。

建议采用“新 profile + 窄可选模块”，而不是改旧数组：

- 保留 `APPLICATION_MCP_PROFILE='business-v1'`、`BUSINESS_MCP_TOOLS`（5 个）、
  `business-mcp-result@2026-09-06.v1` 和 provider health `length(5)` 完全不变。
- 新增 `SCHEDULE_MCP_PROFILE='schedule-live-v1'`，其工具集合为三个
  `maritime.schedule.*`，独立 health contract
  `schedule-provider-health@2026-09-18.v1`（`operations` 精确为 3 个）。
- identity 校验按 `mcp_profile` 分派：`business-v1` 走
  `isApplicationMcpIdentity`，`schedule-live-v1` 走新增的
  `isScheduleMcpIdentity`（role 为 `service`、roles 为 `["service"]`、scopes 为
  `tool:maritime.schedule.{carriers,locations,search}` 的子集且非空、无重复）。
- `authorizeTool` 的 exact-entitlement 分支按 profile 选择允许集合；
  `schedule-live-v1` 的 scope 名与工具名一致的 `tool:<name>` 形式。
- `createProductionComposition` 对 `business-v1` 仍执行
  `assertExactStringSet(..., BUSINESS_MCP_TOOLS)`；只有
  `profile==='schedule-live-v1'` 时才挂载 schedule provider，两个集合不得混装。
- provider 撤销/关闭后，authority 重新读取授权结果；旧五工具 provider 的
  健康、调用与目录回归必须保持通过。
- T0 原工具集合（`APPLICATION_MCP_TOOLS`、`T0_TOOL_NAMES`）不变；旧 Key/JWT 与旧目录
  不自动获得新工具。OpenAPI、`schemas/access-gateway/*` 新增文件而不是改写旧枚举。

三个新 MCP 工具分别使用 exact scope：`tool:maritime.schedule.carriers`、
`tool:maritime.schedule.locations`、`tool:maritime.schedule.search`；未授权时
`blocked`，不得回退到 `customs.query` 等旧权限。

### 4.6 live service 的 tenant/actor/audit/evidence 绑定

本 RFC 不在文字上“声称”隔离，而是要求实现满足以下可执行绑定，测试也按此验收：

- service 只接受服务端 `PortalContext`（`identity`、`organizationId`），不接收客户端
  tenant/actor 字段；REST 从会话构造 `ctx`，人员 CLI 复用同一会话，MCP 从
  authority 返回的 `tenantId`/`credentialId` 构造。
- 每次调用在 service 内解析 `Organization.tenantId`，并把它写入 collector 的
  `RequestContext` 包装、audit sink 和 evidence 根目录；调用方无法指定其他 tenant。
- audit sink 至少记录 `tenant_id`、`actor_id`、`action`、`request_id`、`audit_id`、
  `carrier`、`status`、`issue_code`、`at`；拒绝路径（角色、租户、carrier、引用）也要
  记录 `blocked`。
- evidence 根为 `<root>/<tenantId>/...`；一个租户的 `evidence:` 引用在另一个租户下
  必须返回 `evidence_not_found`/`evidence_reference_invalid`，不得通过路径穿越读取。
- 回滚只关闭新查询入口，不清空已写 evidence/audit；不得把这些材料默认删除。

部署开关与失败语义：

- `locations`/`search` 的租户 allowlist 缺失、为空或不匹配时返回 `blocked`，
  `reason_codes` 含 `schedule_live_disabled`，且不发起任何出网请求。
- viewer 调 `locations`/`search` 返回 `blocked`/`schedule_live_role_denied`；
  `carriers` 与 `evidence_read` 对 active 成员开放。
- allowlist 只收窄权限；即便企业已启用，per-carrier 子集之外仍返回
  `schedule_live_carrier_denied`。

## 5. 状态、权限和权威

### 5.1 状态映射

collector 的内部 `run_status` 通过 service 映射为统一包络状态：

| collector 状态 | 包络状态 | 必须保留的信息 |
| --- | --- | --- |
| `ok` | `success` | records、完整 coverage、live provenance、evidence refs |
| `no_results` | `success` | 空 records、完整 coverage、`no_matching_records` warning |
| `partial` | `manual_review` | 已完成 records、未覆盖窗口、failure_reason、证据 |
| `failed` | `unavailable` | 结构化失败原因；不得返回空数组冒充成功 |
| `unsupported` | `blocked` | unsupported filter 或 carrier 状态 |
| `not_run` | `blocked` | live policy、授权或 connector 未启用 |
| `synthetic` / `replay` provenance | `manual_review` | 明确标记非 live；不得进入 live success |

取消和总 deadline 的实际行为按已完成窗口区分（实现见
`3ed7940` 之后的本地修订与 `tests/maritime/schedule-collector/carriers/one.test.ts`
的两窗口用例）：

- 已有至少一个窗口完成并写入 evidence 时，adapter 在收到 abort 后有 250ms
  settlement grace，把已完成窗口合并为 `run_status=partial`，service 返回
  `manual_review`；`coverage.covered_windows` 只列已完成窗口，
  `coverage.uncovered_windows` 列其余窗口，`failure_reason` 为
  `collector_deadline_exceeded` 或 `collector_aborted`，已完成的
  `records[].evidence_ref` 保留且可读回。
- 没有任何窗口完成时仍返回 `unavailable`；`blockers[0].code` 为 `timeout`，
  `blockers[0].message` 为 `collector_deadline_exceeded` 或 `collector_aborted`。
- 取消后的审计只写 `query_failed`，`issue_code` 为 `timeout`；不得写
  `query_completed`。`signal.aborted` 为真时不得再产生新的窗口查询或 evidence 写入。

未使用取消/deadline 的普通结果仍按上表映射。单个 HTTP 请求返回 200 不等于整个查询
complete；只有所有请求窗口和分页都在 coverage 中闭合时才能是 `success`。UI 必须读取
`envelope.status` 与 `data.coverage.complete`，不能把 `records.length>0` 当作 complete。

### 5.2 人员权限

`carriers` 是只读 registry 元数据，`locations` 和 `search` 会触发受控外网访问，因此
两者权限不同。服务端复用现有 Portal 身份与成员检查：`PortalIdentity.emailVerified`、
`state.current_organization.status==='active'`、以及当前组织中
`status==='active'` 的 `Membership`；客户端不能传入或覆盖 tenant/actor。

| 操作 | owner | admin | developer | viewer | 企业外网开关 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 旧 `sailing-schedules/query` 快照 | allow | allow | allow | allow | 不适用 | 行为不变，只读企业已发布快照 |
| live `carriers` | allow | allow | allow | allow | 不要求 | 只读静态 registry，不出网 |
| live `locations` | allow | allow | allow | deny | 必须启用 | 触发 carrier 官方地点查询 |
| live `search` | allow | allow | allow | deny | 必须启用 | 触发 carrier 官方船期查询 |
| live `evidence_read`（内部验收用，不新增公开路由） | allow | allow | allow | allow | 不要求 | 只读本租户已存 evidence，校验 SHA-256 并返回 ref/sha256/byte_length |

- 企业外网开关不新增通用配置写接口：第一阶段只接受部署时注入的
  `tenant allowlist`（例如 `SCHEDULE_LIVE_TENANT_ALLOWLIST`）。缺失、为空或不含当前
  `tenantId` 时，`locations`/`search` 一律返回 `blocked`，`reason_codes` 为
  `schedule_live_disabled`；`carriers` 仍可用。
- 如需进一步收窄 carrier，可注入 per-tenant carrier 子集；默认沿用整个 registry。
  未列出的 carrier 返回 `blocked`，不得静默回退到其他来源。
- 现有 `NativeAdminService.scope` 的只读规则（active owner/admin/developer/viewer）继续
  用于旧快照查询；配置写仍只允许 owner/admin。RFC 不新增 live 配置写入口。
- API Key、旧的 broad JWT 或 MCP scope 不能自动获得 live 权限。旧快照、旧 Key 和旧
  MCP 目录的行为不变。
- 每个 live 请求在 service 内绑定 `tenantId`（`Organization.tenantId`）、`actor`
  （`PortalIdentity.userId`）、`auditId` 和 evidence 根目录；evidence 按
  `root/<tenantId>/<requestId>/<carrier>/<sha256>.<ext>` 存储，跨租户引用读回必须失败。

### 5.3 MCP 权限

候选工具按窄权限分别授权，权限名与工具名一致，使用现有 `tool:<name>` scope 形式，
并挂载在 4.5 定义的 `schedule-live-v1` profile 下（不改 `business-v1` 的 5 工具集合）：

- `tool:maritime.schedule.carriers`：只读 registry 元数据。
- `tool:maritime.schedule.locations`：只读官方地点候选。
- `tool:maritime.schedule.search`：只读船期查询，包含受控外网访问。

现有 Key 不因新增工具自动扩权。需要 live MCP 的应用必须通过服务端授权的更新/轮换流程
显式取得对应 scope；旧 Key、旧 JWT 和旧客户端目录继续按当前行为工作。本轮已实现
`schedule-live-v1` 的独立 provider 装配；生产默认配置不得自动挂载它，仍需部署显式
提供 release、signer 与 runtime secret。

### 5.4 权威和证据

- 来源权威是实际被允许访问的公开 carrier 页面/API；collector 只是读取适配器，不是
  船期业务真相的新主库。
- live 结果不回写 `native_configs`、不自动生成 `MaritimePublication`、不自动变成企业
  已核验快照。
- 每次结果只返回 opaque evidence reference；原始响应、Cookie、Authorization、CSRF
  token 和敏感 query 不进入日志或客户端输出。
- `capability_status=live_verified` 只描述已完成的观察范围和日期，不证明所有航线、
  日期或商业使用范围均可用。

## 6. 兼容性和迁移

1. 旧 `sailing-schedules/query`、旧 `maritimeResponseSchema`、旧 `sailingRow` 和旧人员
   CLI 保持不变，至少保留一个发布周期。
2. 新 collector 路由使用新路径和新响应 data 合同，不把两种 data 放在同一个判别字段
   里；Web 页面必须明确显示“企业快照”或“官方 live 查询”。
3. 不迁移历史快照。旧快照不自动转成 collector record，collector record 也不自动转成
   旧行。
4. 新 live 结果默认不缓存、不持久化为业务权威；如需 replay，必须使用显式 request
   reference 并继续标记为 `replay`。
5. `carrier` 的 `capability_status`、`last_live_verified_at` 和 coverage 必须在每次
   查询中显示；未验证来源保持 `not_probed`、`implemented_unverified`、`blocked` 或
   `unsupported`。
6. 迁移顺序：
   - 第一步：本 RFC 连同 `services/maritime/schedule-live/contracts.ts` 的
     carriers/locations/search 合同、权限矩阵和 MCP `schedule-live-v1` 装配策略一并
     提交 Mac/基线审核；该接受已完成（见接受记录）。
   - 第二步（合同接受后）：仅本地/fixture，接入 Portal 路由、Web 投影和人员 CLI，
     验证三者共用同一 service 与同一 schema。
   - 第三步：在明确企业 allowlist 内启用 ONE 或 COSCO 的受控 live，完成真实查询、
     evidence 读回和进程重启复验。
   - 第四步：按 `schedule-live-v1` 挂载新 MCP provider，验证 tools/list、tools/call、
     exact scope、撤销拒绝和旧五工具 provider 回归；未通过时不得写入生产 catalog。
   - 第五步：逐家验证 HMM、OOCL、EMC/EVERGREEN 等；未通过时继续显示准确阻塞。

## 7. 回归和验收

实现本 RFC 前必须保持或新增以下检查：

```sh
npx vitest run tests/maritime/schedule-collector
npx tsc --noEmit
npx eslint services/maritime/schedule-collector tests/maritime/schedule-collector
git diff --check
```

接入 Portal/CLI/MCP 后还必须新增：

- 旧快照路由与新 live 路由的合同隔离测试。
- `locations` 唯一、多候选、无匹配和 carrier location ID 测试。
- live `search` 的 complete、no_results、partial、failed、timeout、caller cancel 和
  restart 测试。
- Portal 端 tenant/actor/cross-tenant、CSRF、live flag 和旧 API Key 不自动扩权测试。
- CLI 与 Web 共享同一 service 的输入/输出一致性测试。
- 新 MCP scope 的 allow/deny、旧 scope 拒绝、工具目录刷新和 envelope/Schema 测试。
- live service 的 tenant/actor/audit 绑定：viewer/缺失开关/未列入 carrier 的
  `blocked` 路径，以及跨租户 evidence 引用读回拒绝（同一引用在另一租户下
  `evidence_not_found`）。
- `schedule-live-v1` 与 `business-v1` 的互斥装配：两个 profile 的 tools/list、
  provider health 和 exact scope 分别回归，任一 provider 缺失时对应 profile
  关闭而不影响另一个。
- 不得访问真实来源的 CI fixture 测试；真实 live 验收必须单独记录来源、日期、时区、
  查询范围、parser version、evidence hash 和人工核对结果。

当前独立 collector 已有证据覆盖 ONE 和 COSCO 的有限 live 查询；该证据不能替代产品
路由、MCP 或商业使用验收。

## 8. 回滚

本 RFC 不涉及数据库写迁移。回滚步骤必须保持旧快照可用：

1. 关闭 live flag、Portal 新路由和三个 MCP scope。
2. 停止注入 live connector，保留旧 `sailing-schedules/query` 和快照发布流程。
3. 保留已完成查询的 evidence、audit 和 opaque refs；只停止新查询，不回写、不发布为快照，
   也不默认删除历史材料。实际保留期以后续明确授权的配置为准。
4. 恢复上次已接受的静态 catalog、Portal 路由和 CLI 注册表。
5. 验证旧页面查询、旧人员 CLI、企业快照读回和跨租户隔离仍通过。

## 9. 接受记录与剩余外部输入

- Mac/基线维护者已于 2026-09-18 接受本文的路由、工具名、权限、Schema 和
  `schedule-live-v1` 装配策略（见接受记录）。
- 安全负责人确认 person live 查询的角色白名单和外部网络启用边界。
- source owner 确认 ONE/COSCO 的允许使用范围、保留期和再分发边界。
- 其余 carrier 的官方 API/公开页面、所需权限或准确阻塞原因。
- 生产部署窗口、回滚批准和任何 API Key scope 变更的单独授权。

本轮已按接受记录落地 Portal 路由、人员 CLI、`schedule-live-v1` MCP 装配以及本地、
fixture 和真实 ONE/COSCO 验收；生产部署、目录默认挂载和合并仍需单独授权。
