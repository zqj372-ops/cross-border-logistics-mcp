# Business REST v2 与精确应用授权

状态：Accepted — 用户已确认所有服务采用 API、用户/应用申请及独立源服务分支改造。2026-09-05 根代理作为基线维护者接受此增量合同；只证明实现授权，不证明生产接入。

## 动机与兼容

已有 `/access/v1/token/exchange`、三个 T0 工具、原 Key/JWT claims 和 MCP audience 不扩张。新的业务只接受 business v2 Key 与独立短 JWT。当前 Portal 的业务 Web 会话不是客户应用的机器授权，二者必须分别验证。

为保持旧记录兼容，业务申请、grant、credential 使用新的版本化命名空间存储，关联已有 Organization/Application/client_id，不创建第二套租户或价格/税则表。旧 T0 记录无需改写。复用既有加密验证方式、签名算法和 provider 模式，不把长期 Key verifier 放进 MCP Runtime。

## 操作与请求

业务能力精确集合：`customs.query`、`customs.tax.estimate`、`quote.zone_preview`、`quote.ai_extract_preview`。源合同尚未就绪或连接未配置时不标正式可用。单项与有界批量税费使用相同 estimate 权限，但各有固定路由。未来写入能力必须单独接受合同。

`POST /access/v2/business/token/exchange`，`Authorization: ApiKey <business key>`，闭合 body：

```json
{"schema_version":"business-exchange@2026-09-05.v1","requested_operations":["customs.query"]}
```

`POST /api/v2/business/customs/query`、`/customs/tax-estimate`、`/customs/tax-estimates/batch`、`/quote/zone-preview`、`/quote/ai-extract-preview` 使用 `Authorization: Bearer <short JWT>`，闭合 body：

```json
{"schema_version":"business-call@2026-09-05.v1","input":{}}
```

`input` 由具体源合同校验，拒绝 tenant、actor、权限或连接地址注入。服务端生成 request ID。输出保持源五状态与证据，不重新标币种、不把部分失败映射 success。来源金额保持 decimal string。

## 人员控制面

`/console/api/v1/business-access` 提供独立 state、requests（草稿/编辑/提交/撤回/补充/批准或拒绝）、grants（开通/暂停/撤销/缩权）、applications/:id/credentials（签发/交付确认/轮换/撤销/状态）。使用同一人员 session/CSRF 和同一 Application 负责人、企业角色与平台 reviewer/operator 权限。不得自审。批准与实际开通分开，必须读回。申请中不产生 Key；只有当前 app owner 可以领取和确认交付。业务 Key 不包含任何 T0 tool scope。

操作提供 Idempotency-Key 和对象 expected_version；同一 actor/object/input 重复返回同一结果，冲突拒绝；Key 明文只首次响应，不写持久日志、浏览器存储或审计。响应丢失后读元数据，撤销重发。审批、状态变化、签发/吊销保留 opaque 事件，不记业务正文。

## JWT 与执行

固定 audience `freightclaw-business-api-v2`，RS256，TTL 最长 300 秒；部署决定 issuer/kid。闭合 claims 包括标准 iss/aud/sub/iat/nbf/exp/jti 与 token_use=business_api、tenant_id、client_id、application_id、credential_id、operations。请求只使用批准 operation 子集，不由调用方指定 audience/TTL/actor/tenant。v1/v2 互拒。

兑换和每次调用均验证 credential 已确认交付、有效未撤销，tenant/client/organization/application active、owner 为当前有效成员、app/client/tenant 绑定一致、当前 business grant 有效且覆盖操作、部署 connection tenant 与 operation 匹配。暂停/撤销/缩权影响下一次请求；复核失败不得签名或调用上游。

源服务的委托仍遵守 business-delegation v1：机器 sub=配置的 service_caller_id，原客户 credential/client/application 与源 request_id 的关系由网关脱敏审计追踪，不伪称 Source 直接识别客户 client。人员调用继续使用已验证人员 sub。

## 环境、迁移、验证、回滚

生产依赖持久凭证/审计存储、私有 pepper、签名与真实 tenant/client provider；任一缺失在启动前失败。SQLite、临时密钥和测试身份仅显式 fixture 模式，不能 fallback。新记录存独立版本表/命名空间并可回读，旧 T0 不需迁移，关闭新路由/签名即可回滚，不删除记录或恢复已撤销授权。

测试：v1 原套件；v2 audience/scope/身份串用；未交付、撤销、过期；企业/应用/当前 owner 和授权变化；不同 tenant/app 猜测；同幂等键冲突与 secret 不重放；source 五状态及绑定；未知字段、重复认证头、Cookie 混用、重定向与 body 上限；审计泄漏；配置失败关闭。


## 最终状态核验与审核队列补充（已接受，2026-09-05）

开通在异步 tenant/client 检查完成后、写入前重读人员平台的应用和企业状态，并核对原申请的 org/application/client/tenant 绑定。等待期间停用不能落为 active。平台审核队列使用独立的只读摘要投影：仅允许已验证的 reviewer/operator 且 organization 为空，返回队列所需的有界名称、标识与状态；暂停对象仍保留可读状态，不得使其他申请整体无法读取。这一投影不用于机器授权，机器入口继续要求有效应用和企业。
