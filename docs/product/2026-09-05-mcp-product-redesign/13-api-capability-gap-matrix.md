# API 能力盘点与改造差距

> 历史基线：本文记录 2026-09-05 API 改造前的缺口，不是当前待办。后续已实现统一身份、企业授权、只读业务适配与人员报价记录接口；当前仍缺少的功能及验收条件见 [18 当前进度与功能缺口](18-current-status-and-gaps.md)，发布证据见 [17 生产交付](17-market-manual-production-delivery.md)。

2026-09-05，只读静态代码核查。[产品规划](11-api-native-platform-prd.md) · [页面规格](12-api-platform-pages.md) · [实施验收](14-api-platform-delivery.md)

本文中的“存在”表示当前本地源码中存在路由/模型，不表示线上可用或符合新平台合同。“待适配”与“必须新增”分别表示已有实现需要改造、当前缺少相应服务器能力。

## 1. 核查基线

| 仓库 | 分支 / HEAD | 本轮工作区观察 |
| --- | --- | --- |
| 物流产品 MCP | `codex/tenant-api-key-control` / `34e1e9567440e768eb9e7a1b6cfe8c2ded70baed` | 包含此前 UI、入口 API、测试与本轮产品文档的未提交改动；另有用户未跟踪文件 |
| AI 自动报价模块 | `main` / `15b55f174d86dc41d487f5592557808a5f9e5a61` | 有未提交源码、测试和文档修改，包含 quote_service.py、AIQuotePage.tsx；按当前工作树核查 |
| 美国、加拿大关务 | `main` / `1cd712b4dfac755998f72d852171530b58d9e827` | 本次观察仅有未跟踪 data/runtime/，未读取该目录 |

工作树状态与上一轮记录不同；不能继续使用“报价仓库干净”等旧描述。这是本地当前基线，不是远端最新提交或生产部署证明。没有读取秘密、业务数据库、未跟踪运行数据或生产服务。

## 2. 报价服务

| 能力 | 当前 API / 权限 | 操作性质 | 新平台处理 |
| --- | --- | --- | --- |
| 普通规则报价 | `POST /quotes/calculate`；admin/operator/sales | 当前函数读取规则并计算，未见显式业务写入 | 有接口可适配；输入是 ShipmentInput，不能替代完整加拿大尾程；仍缺租户、发布证据及统一序列化合同 |
| 加拿大尾程 | `POST /quotes/zone-calculate`；admin/operator/sales | 写审计/诊断，可能建人工任务与通知；可显式发送邮件/企微 | 保留为明确业务动作的基础，补幂等/权限/记录读回；不能直接当只读试算 |
| AI 解析/报价 | `POST /quotes/ai-auto-quote`；admin/sales | auto_submit=false 仍写销售记录，可能有人工任务等副作用 | 在原服务补只读提取与确认后的业务执行接口，不在 MCP 复制解析器 |
| 销售历史 | `GET /quotes/sales-records`；四角色，sales 限制自己 actor | 只读 | 适配企业/成员/应用归属；它主要是 AI 销售记录，不覆盖所有直接尾程调用 |
| 人工任务 | `GET /quotes/manual-tasks`；admin/operator/viewer | 只读 | 可以适配列表；必须补对象级企业权限 |
| 人工处理 | `PATCH /quotes/manual-tasks/{task_id}`；admin/operator | 修改任务，解决后可能学习/通知 | 明确写权限、影响预览、幂等/版本与读回；只读角色不能执行 |
| 报价证据 | `GET /quotes/audits`、`GET /quotes/audit/{quote_id}`、`GET /quotes/error-summary` | 只读 | 只向获准企业/对象投影必要证据，不公开内部全局审计 |
| 用户管理 | `GET/POST /users`、`PATCH /users/{id}`；admin | 创建/修改/停用本服务用户 | 可作下游迁移参考，不作为新平台 IAM |
| API Key | `GET/POST /api-keys`、`PATCH /api-keys/{id}`；admin | 直接发放或修改，创建时一次展示 | 仅作下游服务账号管理基础；不等于客户 API 申请审批 |
| 只读尾程试算 | 未发现 `/quotes/zone-preview` | 不存在 | 必须新增，并证明没有报价/销售记录、人工任务、通知、学习计数等业务写入；保留脱敏安全访问审计 |
| 纯 AI 提取 | 未发现独立无业务写入端点 | 不存在 | 必须新增，复用原提取模块并返回需确认字段与证据 |

证据：

- [路由和基础权限](/Users/autumn/Documents/AI自动报价模块/apps/api/routes/quotes.py:32)、[身份模型](/Users/autumn/Documents/AI自动报价模块/apps/api/auth.py:14)。现有 User/API Key 身份没有 tenant，角色为 admin/operator/sales/viewer。
- [计价入口](/Users/autumn/Documents/AI自动报价模块/apps/api/services/quote_service.py:39)、[副作用流程](/Users/autumn/Documents/AI自动报价模块/apps/api/services/quote_service.py:219)。
- [AI 提取和自动提交开关](/Users/autumn/Documents/AI自动报价模块/apps/api/services/ai_quote_service.py:197)、[销售记录写入](/Users/autumn/Documents/AI自动报价模块/apps/api/services/ai_quote_service.py:281)。
- [尾程输入输出模型](/Users/autumn/Documents/AI自动报价模块/packages/quote_engine/zone_models.py:26)、[通用模型](/Users/autumn/Documents/AI自动报价模块/packages/quote_engine/models.py:110)。

**租户隔离是接入前置条件。** 不能把共享 admin Key 包装在 BFF 内，就声称客户数据已经隔离。原服务必须验证受控企业/应用映射，并对列表、单条记录、修改和导出执行对象权限；过渡期若只能提供单租户实例，需明确一实例一企业绑定，不能由客户端 tenant 标签冒充多租户。缺少这些条件时外部企业报价仍阻断。

**原始操作者必须保留。** 人员业务调用由 BFF 从受验证会话解析 tenant、user/actor、Membership、角色与渠道；原服务通过受认证的委托合同验证并记录这些身份。浏览器不能自填身份头/字段，机器请求也不能伪造人员 actor。只记录共享服务账号不满足销售记录归属与逐人审计；验证失败返回 blocked，缺少合同的路径不开放。

报价当前结果以 USD 为准，新合同的示例金额/币种必须以源代码与实际引擎证据修订；不能照搬旧 RFC 的说明性 CAD 示例或补造有效期与 release hash。

## 3. RiskCustoms

| 能力 | 当前 API | 认证 / 行为 | 新平台处理 |
| --- | --- | --- | --- |
| 浏览器查询 | `POST /api/query` | 匿名大小/频率限制，发布模式查询审计 | 不作为正式服务器集成边界 |
| M2M 状态 | `GET /api/m2m/status?ruleDate=...` | Bearer＋精确 x-tenant-id，必要审计 | 复用，核验当前 ready/testData 与发布身份 |
| M2M 查询 | `POST /api/m2m/query` | Bearer＋tenant 绑定，拒绝浏览器 Cookie/挑战状态，快照前后比较，审计失败闭合 | 保留完整分国结果、追问、税率、措施、文件、来源，扩展 MCP 当前窄投影 |
| 公开状态 | `GET /api/status` | 无身份 | 不能代替 M2M 就绪证据 |
| 来源详情 | `GET /api/sources/{releaseId}` | 公开的已发布来源元数据 | 页面优先使用查询内 source refs；详情经统一服务层校验范围 |
| 汇率 | `GET /api/exchange-rates?asOf=...` | 公开接口，服务器调用 CBSA/BoC | 复用取数与来源逻辑，补受控 M2M 汇率/估算边界，不在 BFF 随意换汇 |
| 单项估算 | 无服务器端点 | 浏览器纯计算 | 必须新增 M2M estimate；同一 Decimal 核心服务端执行 |
| 批量估算 | 无 query-batch / M2M batch | 浏览器按唯一编码逐个查询，当前最多 50 个 | 必须定义有界批量任务/行级结果和限流；50 是当前浏览器实现限制，不自动当作新 API 合同 |
| 查询/估算历史恢复 | 无面向用户的恢复 API | 内部审计不是业务历史 | 必须在 RiskCustoms 明确记录、保存动作、保留策略与授权读回；不暴露内部审计表 |

M2M 请求严格只允许 `query/ruleDate/codeCountry?/selectedHs6?/attributes`，attributes.originCountry 当前固定 CN。**querySessionId 只存在公共浏览器合同，不能向 M2M 发送。** 候选确认重发同一查询与属性，再附 selectedHs6；响应 queryId 只是引用，不自动成为历史恢复句柄。

M2M 输出已包含 candidates、CN/US/CA results、rates、documents、measures、sources 与发布身份。当前信息损失主要在 MCP 固定加拿大的映射；新多法域能力必须保留原 `customs.ca.search` 兼容语义，使用新合同与精确授权。

证据：

- [M2M 严格请求](/Users/autumn/Documents/美国、加拿大关务/src/shared/contracts/m2m.ts:89)、[输出](/Users/autumn/Documents/美国、加拿大关务/src/shared/contracts/m2m.ts:97)、[公共浏览器会话字段](/Users/autumn/Documents/美国、加拿大关务/src/shared/contracts/query.ts:186)。
- [税率与结果结构](/Users/autumn/Documents/美国、加拿大关务/src/shared/contracts/query.ts:43)、[来源与分国结果](/Users/autumn/Documents/美国、加拿大关务/src/shared/contracts/query.ts:142)。
- [M2M tenant 绑定](/Users/autumn/Documents/美国、加拿大关务/src/worker/security/m2m.ts:98)、[拒绝浏览器状态](/Users/autumn/Documents/美国、加拿大关务/src/worker/http/m2m-query-route.ts:41)、[发布快照比较](/Users/autumn/Documents/美国、加拿大关务/src/worker/http/m2m-query-route.ts:185)。
- [浏览器估算入口](/Users/autumn/Documents/美国、加拿大关务/src/client/features/tariff-calculator/TariffCalculatorPage.tsx:98)、[批量](/Users/autumn/Documents/美国、加拿大关务/src/client/features/tariff-calculator/TariffCalculatorPage.tsx:193)、[Decimal 核心](/Users/autumn/Documents/美国、加拿大关务/src/client/features/tariff-calculator/tariff-calc.ts:170)、[需复核税率](/Users/autumn/Documents/美国、加拿大关务/src/client/features/tariff-calculator/tariff-calc.ts:319)。

浏览器客户端另引用 feedback/quota/redeem，但当前 Worker 入口未注册对应路由；不能据此纳入已实现额度或反馈功能，其他部署层是否提供待验证。

## 4. MCP 与接入控制面

| 能力 | 当前实现 | 产品差距 |
| --- | --- | --- |
| 货物、装柜、Agent 上下文 | T0 三工具，静态模块与确定性实现 | 可复用作为第一条受控 API 闭环；Web REST 映射和人员会话仍需合同 |
| 加拿大关务 | 现有窄 adapter，严格 M2M 门禁 | 未完整投影分国税率/措施/文件；不默认扩大同名工具 |
| 正式报价 | Quote V2 候选合同，生产资格关闭 | 上下游路径/身份/响应不匹配，不能只启用环境变量 |
| 估算、报价保存、文档 | 未核验的生产合同或固定 unavailable | 必须逐项补齐原业务 API，不用页面与注册项充当可用性 |
| Freightcom | 当前仅测试费率，production 禁用 | 单独正式合同/账号/源币种/结果读回验收；不能复用测试报价作正式结果 |
| 企业 tenant | `POST /admin/api/v1/access/tenants`、对应 status；GET state | 只有 active/suspended 与显示名，没有企业成员 |
| client | 首次签发隐式创建，支持 status | 需显式应用创建、负责人、环境与申请归属；不新造并行机器身份 |
| credential | POST credentials、rotate/revoke/acknowledge-delivery | 复用一次展示/交付/轮换/读回；增加企业开发者权限入口，不开放原管理 API |
| token exchange | `POST /access/v1/token/exchange`、JWKS | 当前仅三个 T0 tool 和 MCP audience；REST、多业务操作需新版本，不放宽旧 v1 |
| Admin 身份 | 管理 tenant＋admin＋platform:admin＋tenant:admin | 是平台管理身份，不能用于客户人员会话与业务请求 |
| User / Membership / Invitation | 未实现 | 新增人员与组织域，并接身份 provider |
| API 申请、审核、服务授权 | 未实现 | 新增版本化对象与专用审批，不复用模块发布审批冒充 |
| 技术限流 / 日志 | tenant/client/credential/IP 分层限流、脱敏审计和 overview | 可复用；不是企业套餐/余额，也没有客户侧完整调用记录视图 |

证据：

- [Tenant Access 路由](/Users/autumn/Documents/ChatGPT/物流产品MCP/src/logistics_mcp/server/admin-tenant-access-api.ts:101)、[管理权限](/Users/autumn/Documents/ChatGPT/物流产品MCP/src/logistics_mcp/server/admin-tenant-access-api.ts:254)、[生产写开关](/Users/autumn/Documents/ChatGPT/物流产品MCP/src/logistics_mcp/server/admin-tenant-access-api.ts:562)。
- [现有组织与凭证合同](/Users/autumn/Documents/ChatGPT/物流产品MCP/src/logistics_mcp/control-plane/tenant-access-contracts.ts:121)、[Gateway 机器主体](/Users/autumn/Documents/ChatGPT/物流产品MCP/services/access-gateway/contracts.ts:22)。
- [换票与 JWKS](/Users/autumn/Documents/ChatGPT/物流产品MCP/services/access-gateway/http.ts:169)、[T0 工具 allowlist](/Users/autumn/Documents/ChatGPT/物流产品MCP/services/access-gateway/service.ts:49)。
- [现有管理员身份 provider](/Users/autumn/Documents/ChatGPT/物流产品MCP/services/access-gateway/production-identity.ts:101)、[技术限流](/Users/autumn/Documents/ChatGPT/物流产品MCP/services/access-gateway/production-store.ts:357)。
- [Authentik 部署草稿](/Users/autumn/Documents/ChatGPT/物流产品MCP/deploy/self-hosted-authentik/README.md:1)：未跟踪 candidate，仅证明准备过管理员身份接入，不证明客户 IdP 或生产部署完成；本轮未修改。

## 5. 目标 API 面与明确缺口

以下是产品所需操作分组，具体路径、Schema、claim 和错误码在实现合同中冻结，不将建议名称注册为现有能力：

| API 面 | 需要的动作 | 主要所有者 |
| --- | --- | --- |
| 人员会话 | 登录回调、当前用户/企业、切换企业、退出与会话撤销 | 统一平台＋身份 provider |
| 企业与成员 | 企业申请/审核、成员邀请/领取、列表/改角色/暂停/移交 | 统一用户域 |
| 应用与申请 | 显式创建应用、负责人管理、申请草稿/提交/补充/撤回、审核、授权与读回 | Access Gateway 扩展 |
| 凭证与机器接入 | 按 active 授权签发、交付、轮换/吊销、REST/MCP 精确短期令牌 | Access Gateway；保留原 v1 |
| 业务查询计算 | 关务、报价试算、AI 提取、税费单项/批量、货物/装柜 | 原业务服务＋共同应用层 |
| 业务写入与记录 | 明确保存、原记录读取、复核创建/处理/读回 | 原记录与复核所有者；不落 MCP 权威业务表 |
| 运行诊断 | 企业/应用范围调用记录、真实用量、连接与版本证据 | 统一平台脱敏投影 |

不能使用 generic commit_operation、任意 proxy URL 或“调用任何上游接口”的万能入口。写操作必须按资源、动作和权限具体定义。网页、REST、MCP 可以呈现不同交互形式，但它们不能绕过相同的企业、版本、数据与副作用检查。
