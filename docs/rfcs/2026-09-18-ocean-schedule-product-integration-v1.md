# 船期 collector 产品接入 v1

状态：`proposed`。尚未接受，不授权修改共享合同、Portal 路由、人员 CLI 注册表、MCP
静态目录或生产配置。

日期：2026-09-18（Asia/Shanghai）

实现基线：`f0af5ae8b0845340b5b583dc868a031e57295faa`。collector 总 deadline、取消
传播和部分窗口保留的实现已提交为 `3ed794029a9ec26e7660d7e95d7b76ceb77ccdf1`，
位于分支 `codex/schedule-collector-20260917`（PR #30）。本 RFC 提议的 Portal 路由、
人员 CLI 命令和 MCP 工具名仍未实现，状态保持 `proposed`。

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

未决：

- 本 RFC 的 Portal 路由和 MCP 工具名尚未接受，不能先改静态注册表再补合同。
- ONE/COSCO 的来源许可、商业再分发和保留期需要单独确认；技术可访问不等于允许扩大
  使用范围。
- 哪些企业可以获得 live 查询、是否允许 viewer 角色发起外网查询，需要产品和安全
  负责人批准；本 RFC 只能给出候选权限边界。

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

成功或部分结果的响应使用统一包络，`data` 使用 collector 合同。以下为字段级示例，省略的
数组仍必须存在且符合 collector Schema：

```json
{
  "schema_version": "2026-08-11.v1",
  "request_id": "req_schedule_live_001",
  "status": "success",
  "data": {
    "collector_contract_version": "ocean-schedule-collector@2026-09-17.v1",
    "run_status": "ok",
    "query": {
      "carrier": "ONE",
      "query_origin": {
        "input_text": "Shanghai",
        "country_code": "CN",
        "carrier_location_id": "CNSHA",
        "mapping_source": "one_location",
        "source_full_name": "Shanghai"
      },
      "query_destination": {
        "input_text": "Vancouver",
        "country_code": "CA",
        "carrier_location_id": "CAVAN",
        "mapping_source": "one_location",
        "source_full_name": "Vancouver"
      },
      "departure_from": "2026-09-17",
      "departure_until": "2026-10-14",
      "date_filter_basis": "departure_from_first_ocean_leg",
      "routing_filter": "any"
    },
    "carrier": {
      "id": "ONE",
      "sales_carrier": "Ocean Network Express",
      "adapter_version": "one@2026.09.17",
      "capability_status": "live_verified",
      "last_live_verified_at": "2026-09-17T00:00:00Z"
    },
    "records": [
      {
        "record_id": "one-live-001",
        "source_itinerary_id": null,
        "operating_carrier": "ONE",
        "service_name": "PN3",
        "routing": "direct",
        "query_origin": "CNSHA",
        "query_destination": "CAVAN",
        "place_of_receipt": null,
        "place_of_delivery": null,
        "pol": {
          "name": "Shanghai",
          "country_code": "CN",
          "carrier_location_id": "CNSHA",
          "unlocode": "CNSHA",
          "type": "port"
        },
        "pod": {
          "name": "Vancouver",
          "country_code": "CA",
          "carrier_location_id": "CAVAN",
          "unlocode": "CAVAN",
          "type": "port"
        },
        "terminal": null,
        "legs": [
          {
            "sequence": 1,
            "mode": "ocean",
            "source_leg_id": "leg-001",
            "vessel_name": "ONE SYNTHETIC",
            "voyage": "001E",
            "from": {
              "name": "Shanghai",
              "country_code": "CN",
              "carrier_location_id": "CNSHA",
              "unlocode": "CNSHA",
              "type": "port"
            },
            "to": {
              "name": "Vancouver",
              "country_code": "CA",
              "carrier_location_id": "CAVAN",
              "unlocode": "CAVAN",
              "type": "port"
            },
            "events": [
              {
                "event_type": "departure",
                "raw_text": null,
                "local_date": "2026-09-18",
                "local_datetime": "2026-09-18T12:00:00",
                "utc_datetime": null,
                "offset": null,
                "timezone": null,
                "precision": "local_datetime",
                "event_kind": "estimated",
                "timezone_source": "one_source_local"
              }
            ]
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
          "source_total_minutes": null,
          "source_total_hours": null,
          "source_total_days": null,
          "calculated_total_hours": null,
          "source_ocean_minutes": null,
          "source_ocean_hours": null,
          "source_ocean_days": null,
          "calculated_ocean_hours": null,
          "basis": "source_total"
        },
        "evidence_ref": "evidence:req_schedule_live_001:ONE:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observed_at": "2026-09-17T00:00:00Z",
        "parser_version": "one@2026.09.17",
        "missing_fields": []
      }
    ],
    "coverage": {
      "requested_from": "2026-09-17",
      "requested_until": "2026-10-14",
      "covered_windows": [
        {
          "from": "2026-09-17",
          "until": "2026-10-14"
        }
      ],
      "uncovered_windows": [],
      "pages_read": [1],
      "complete": true,
      "truncated": false,
      "failure_reason": null
    },
    "provenance": {
      "kind": "live",
      "fetched_at": "2026-09-17T00:00:00Z",
      "fixture_generated_at": null,
      "source_updated_at": null,
      "parser_version": "one@2026.09.17",
      "source_refs": [
        "evidence:req_schedule_live_001:ONE:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
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
      "source_id": "carrier-one-observation",
      "source_type": "official_source",
      "system": "Ocean Network Express",
      "locator": "evidence:req_schedule_live_001:ONE:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "version": "one@2026.09.17",
      "retrieved_at": "2026-09-17T00:00:00Z",
      "authority": "authoritative",
      "content_hash": null
    }
  ],
  "assumptions": [],
  "warnings": [],
  "blockers": [],
  "calculation_trace": [],
  "review_status": "not_required",
  "audit_id": "audit_schedule_live_001"
}
```

实际响应的 `source_refs`、`assumptions`、`warnings` 和 `blockers` 由统一包络构造器
填充；示例只展示最小来源引用，不改变其他字段的必填和闭合要求。
`locations` 成功时返回候选数组和唯一解析结果；`carriers` 成功时只返回 registry
元数据，不能把 `capability_status` 误写成实时可用。

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

取消和总 deadline 统一映射为 `unavailable`，原因必须是 `collector_aborted` 或
`collector_deadline_exceeded`。单个 HTTP 请求返回 200 不等于整个查询 complete；只有
所有请求窗口和分页都在 coverage 中闭合时才能是 `success`。

### 5.2 人员权限

建议保留旧快照的现有成员读取规则，并为 live 增加独立的服务端启用开关：

- 有效的企业成员会话可以查看旧企业快照。
- live `carriers`、`locations` 和 `search` 只有在企业级 live flag 和部署级 connector
  policy 同时启用时可用。
- live flag 的写入仍只允许 owner/admin；本 RFC 不新增普通配置写入。
- API Key、旧的 broad JWT 或 MCP scope 不能自动获得 live 权限。
- 所有 live 请求必须使用服务端 tenant/actor/audit 上下文；客户端不得传入或覆盖这些
  字段。

如果产品要求 viewer 不得发起外网 live 查询，应在接受本 RFC 时把角色白名单写成独立
合同；不能仅在 UI 隐藏按钮。

### 5.3 MCP 权限

候选工具按窄权限分别授权，权限名与工具名一致，使用现有 `tool:<name>` scope 形式：

- `tool:maritime.schedule.carriers`：只读 registry 元数据。
- `tool:maritime.schedule.locations`：只读官方地点候选。
- `tool:maritime.schedule.search`：只读船期查询，包含受控外网访问。

现有 Key 不因新增工具自动扩权。需要 live MCP 的应用必须通过服务端授权的更新/轮换流程
显式取得对应 scope；旧 Key、旧 JWT 和旧客户端目录继续按当前行为工作。未批准前不得把
这些工具写入静态 catalog、T0 profile 或生产 provider。

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
   - 第一步：仅本地/fixture，验证 collector service、路由和 Web/CLI 投影。
   - 第二步：在明确企业内部启用 ONE 或 COSCO 的受控 live，完成真实查询和进程重启
     复验。
   - 第三步：逐家验证 HMM、OOCL、EMC/EVERGREEN 等；未通过时继续显示准确阻塞。
   - 第四步：经 Mac/基线审核接受后，才变更共享 manifest、MCP 静态 catalog、Portal
     权限和 OpenAPI。

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
- 不得访问真实来源的 CI fixture 测试；真实 live 验收必须单独记录来源、日期、时区、
  查询范围、parser version、evidence hash 和人工核对结果。

当前独立 collector 已有证据覆盖 ONE 和 COSCO 的有限 live 查询；该证据不能替代产品
路由、MCP 或商业使用验收。

## 8. 回滚

本 RFC 不涉及数据库写迁移。回滚步骤必须保持旧快照可用：

1. 关闭 live flag、Portal 新路由和三个 MCP scope。
2. 停止注入 live connector，保留旧 `sailing-schedules/query` 和快照发布流程。
3. 丢弃或按已批准保留期处理 live evidence；不回写、不发布为快照。
4. 恢复上次已接受的静态 catalog、Portal 路由和 CLI 注册表。
5. 验证旧页面查询、旧人员 CLI、企业快照读回和跨租户隔离仍通过。

## 9. 接受前需要补齐的输入

- Mac/基线维护者对本 RFC 的路由、工具名、权限和响应版本作出接受/修改决定。
- 安全负责人确认 person live 查询的角色白名单和外部网络启用边界。
- source owner 确认 ONE/COSCO 的允许使用范围、保留期和再分发边界。
- 其余 carrier 的官方 API/公开页面、所需权限或准确阻塞原因。
- 生产部署窗口、回滚批准和任何 API Key scope 变更的单独授权。

在接受前，collector 继续只通过独立 CLI/服务和测试验证，不注册 MCP、Portal 路由或生产
构建入口。
