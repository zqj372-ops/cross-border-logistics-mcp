# 数据权威矩阵

本矩阵定义 API、确定性计算和 MCP 控制层的边界。搜索、地图、承运人门户、聊天、WPS 和公开目录只能提供输入或比较，不能替代权威业务结果。

| 数据类别 | 权威源 | MCP 可做 | MCP 不可做 | 更新/缓存 | 失败策略 |
| --- | --- | --- | --- | --- | --- |
| AI 报价、Zone、价格、附加费 | 经发布且通过合同核验的 Quote API（当前尚未获得生产资格）及其响应中的真实来源/版本证据；v2 还要求 tenant/effective date/ready/test data/origin/billing pallets/release snapshot 证据 | v1 仅保留历史校验；未来 v2 请求时映射金额、canonical origin、source refs、release/snapshot hash 和 trace | 不复制报价代码/数据库，不改价、改 Zone、外推、从省份猜 origin、把 `billing_pallets` 当输入或用聊天/地图替代 | 业务结果不缓存；下一次请求直连并按上游当前响应更新 | v1/v2 当前 `production_eligible=false`，固定 `unavailable`；ready=false 必须 `unavailable/data=null`；版本/来源/价格/hash 冲突为 `manual_review`；不输出可发送结果 |
| 报价草稿与报价审计 | 经发布且通过合同核验的报价 API 草稿/审计端点（当前尚未核验，不具生产资格） | 仅在合同齐全后 preview→approval→commit→readback | 不在 MCP 保存权威草稿，不发布/发送、不覆盖历史 | 不缓存写结果；只保留必要的 opaque record/version/readback ref | 合同缺失保持 disabled；写后读回失败为 `manual_review`/`unavailable` |
| RiskCustoms 状态 | 现有 production `GET /api/status` | 每次 customs search 先读取 `ready`、`reasons` 和状态版本 | 不把 `ready=false` 改为 true，不把 test data 当生产 | 状态不缓存；下一次请求重新读取 | 状态不可达/不合法为 `unavailable` |
| RiskCustoms HS/税率/措施 | 现有 production `POST /api/query` 及 `query.sources` 的真实 release | 发送显式 query，映射候选、next questions、release/source refs 和 response hash | 不复制税则库，不把候选变正式归类，不由 MCP 生成 release/税额 | 业务结果不缓存；更新随下一次 query 生效 | ready=false、query not ready、test data、来源缺失为 `unavailable`；冲突为 `manual_review` |
| customs.ca.estimate | 尚无已核验的 RiskCustoms production estimate API 合同 | 保留工具 Schema 和明确 unavailable 边界 | 不拼造正式估算或税额 | 无 API 合同，不缓存、不计算 | 固定 `unavailable` |
| PDF/文档能力 | 隔离环境已核验 AI Quote `/quotes/zone-preview` v2 只读来源与 PDF `/v2/quote-pdfs` 的 USD lines、`sendable=false`、tenant+Idempotency-Key replay、201/200 后 metadata GET 形状；当前仅 loopback HTTP | 共享契约允许唯一 `quote.create_pdf` 做 preview→candidate hash→approved commit→PDF POST→GET exact readback；只保存 opaque reference 和证据 | 不在本地生成/存储 PDF，不接受模型 total/line_items/logo/path/html/url，不发送/发布/下载/删除，不启用未获资格工具 | 业务请求不缓存；平台幂等沿用原 key；当前 contract-only/production disabled | 输入错误 `needs_input`；权限/审批/tenant/credential/409 `blocked`；Quote 原状态保留；PDF 400/413/503/dispatch 前连接失败 `unavailable`、401/403 `blocked`；已 dispatch 后 response timeout/unknown、POST 不确定、GET404/identity/hash/version mismatch `manual_review` |
| 货物、CBM、体积重、分泡、计费重 | MCP 本地确定性计算及请求提供的版本化规则/证据 | 以 decimal string 和单位计算，返回 trace、来源和证据状态 | 不用 float 猜重量，不把缺证据补成成功，不调用上游价格公式 | 计算结果不缓存；下一次请求按输入和规则重新计算 | 缺证据为 `needs_input`；冲突/规则缺失为 `manual_review` |
| 柜型物理容量与运营目标 | 运营批准的版本化配置；未有统一 API 时由请求携带并验证 | 计算理论/运营装柜摘要，标明 `theoretical_only=true` | 不把物理容量当可承诺装载，不做 3D/现场承诺 | 计算结果不缓存；配置更新随下一次请求生效 | 配置缺失、超方/超重或约束冲突为 `manual_review` |
| 精选知识与系统状态 | 服务端明确注入的精选索引和各 API status | 返回 supporting source refs、版本、ready/reasons | 不让文档覆盖 Quote/RiskCustoms API 结果，不静默回退 archived/fixture | 运行结果不缓存；状态/索引下一次请求重新读取 | 索引/status 不可用为 `unavailable` |
| 租户、身份、密钥 | 服务端真实 token verifier、session binding、受控 secret reference 和 tenant mapping | 重新绑定 tenant/actor/client/role/scope，向 adapter 注入最小权限身份 | 不信任客户端 actor/tenant，不暴露 token、API key、密码、base URL | 不缓存凭证和原文；session 受生命周期限制 | 缺凭证、越权、跨租户或安全策略失败为 `blocked` |
| 审计、幂等、写后读回 | MCP durable audit/idempotency 与目标 API readback | 记录脱敏 audit、request hash、preview/approval、readback evidence | 不以客户端 audit ID 或 `code:0` 代替服务端证据 | 审计/幂等按其生命周期保存，不缓存业务结果 | 平台依赖或 readback 不可用阻断全局或返回 `manual_review` |

AI 报价当前状态：v1 历史契约继续可校验但 `production_eligible=false`；v2 RFC/Schema/示例已补齐最小字段和发布证据门禁，仍未获生产启用资格。`quote.create_pdf` 只允许引用 v2 的权威 quote 结果；candidate/release/snapshot/version 漂移必须 `manual_review`，不会把 quote 金额复制为 MCP PDF 权威数据。当前 PDF 只具隔离 loopback HTTP 证据，尚未满足 production HTTPS、allowlist、tenant credential、staging replay/GET readback 和 deadline，故工具仍 contract-only/disabled。带 quote data 的 `manual_review` 必须来自 `ready=true,test_data=false` 的来源；`ready=false` 只能是 `unavailable/data=null`。

## 全局 readiness 与故障隔离

- quote API、RiskCustoms API、PDF 等单一业务依赖故障只关闭 affected tools；不因一个业务 API 503、timeout 或 `ready=false` 关闭 cargo/container 或其他可用 API 工具。
- MCP identity、真实 token verifier、durable audit/idempotency/session binding 或出站安全策略缺失，才会使生产组合全局 `unavailable`/not ready。
- adapter source 的 `health()` 只证明本地结构和生命周期可用，不主动探测 quote、RiskCustoms 或 PDF；业务健康在对应工具请求时判断。
- 所有业务请求默认请求时直连；MCP 不复制上游业务表、不缓存报价/关务/PDF 结果、不轮询、不排队、不做模块同步。
