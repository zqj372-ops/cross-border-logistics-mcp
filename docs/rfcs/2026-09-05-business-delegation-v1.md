# RFC：FreightClaw 原服务受控委托 v1

状态：accepted for isolated implementation。用户已批准复用原服务、API 内完成业务，以及独立工作树改造；根代理作为本次合同维护者接受以下明确边界。生产启用需要真实连接与来源发布验证。

## 身份合同

人员通过工作台会话登录，BFF 从当前有效组织、Membership 和原始用户绑定请求，浏览器不提交 actor/tenant/service credential。原服务同时验证两层凭证：

1. `Authorization: Bearer <connection secret>`，映射到服务端已配置企业、service caller 和 application。
2. `X-FreightClaw-Delegation: <RS256 JWT>`，短期逐请求委托，issuer、公钥和 audience 由原服务配置。

JWT claims 闭合为 `iss, aud, sub, actor_type, tenant_id, service_caller_id, application_id, request_id, scope, iat, nbf, exp, jti`。aud 与 scope 都是单字符串；actor_type 为 user/service；sub 是原始 opaque actor。service 的 sub 必须等于 service_caller_id，不能附加人员字段。tenant、service caller、application 必须逐项匹配原服务连接；request_id 必须匹配该次请求。仅接受 RS256，拒绝未知 claims、错误签名、错误 issuer/audience、过期/未来时间和超过 300 秒寿命。

委托 proof 不下发给浏览器，原服务 audit 同时保留 caller 与原始 actor 引用，不保存密钥、原材料、姓名、邮箱或整份请求。

报价使用单实例固定企业绑定，不能把该方案声明为任意多租户共享服务。关务沿用现有 M2M principal 的 tenant/client 映射并绑定 application。任一配置缺失必须失败闭合，无开发默认 secret。

## 业务合同与所有权

- RiskCustoms 保留 `/api/m2m/query` 与 v1；新增 `/api/m2m/v2/query` 和 `riskcustoms-query.v2`，body 复用严格业务字段，scope 为 `customs.query`。复用原完整三国结果、追问、候选和前后发布快照核验；不复制税则算法。
- Quote 新增 `/api/v1/m2m/quote/zone-preview` 和 `/api/v1/m2m/quote/ai-extract-preview`，分别使用 `quote.zone_preview`、`quote.ai_extract_preview`。复用当前引擎及已经修正的学习规则边界；仅提取/试算，不能触发销售记录、人工任务、通知、学习写入。保留必要脱敏安全审计。
- 金额沿用源结果 decimal string 与原币种，不重新标成 CAD，不猜运价、税率和附加费。
- 后续正式保存、复核、记录恢复、税费估算与批量使用单独明确合同；不能让只读路由暗含写操作。

源服务各自隔离工作树实现。MCP 新客户门户通过窄业务 client 调用，不改旧 T0 exchange 或静态工具注册。签名和 client 接口均可注入测试实现；生产配置不得退回 fixture。

## 验证与回滚

覆盖验签、绑定、未知字段、过期、越租户、服务伪装人员、snapshot 变化、ready=false、testData 和断开来源等负例。只读报价按成功/缺项/异常检查所有业务写入都未发生。原 v1/旧报价路径保持回归。

撤回新路由或停用相应连接即可关闭新增能力；保留旧路由、原数据和审计。该 RFC 不授权生产部署、导入规则数据或发送消息。

认证实现依据：[PyJWT API](https://pyjwt.readthedocs.io/en/latest/api.html)、[jose jwtVerify](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md)。

## 已接受的税费估算增量

新增 scope `customs.tax.estimate`，覆盖固定的 `/api/m2m/v1/tariff-estimate` 单项与 `/api/m2m/v1/tariff-estimates/batch` 有界同步批量（最多20行）。规则日期由请求显式给出；HS、目的国、申报金额及币种按source闭合合同传入；请求不得提交税率、汇率、release或actor字段。缺业务证据返回needs_input；从量/复合/未确认税率进入manual_review，未知税项不当作零。FX从source官方通道读取并带日期/来源。发布变化和fixture来源清空金额，批量混合保持manual_review，逐行状态与计数原样返回。MCP旧静态目录不增加工具。

正式报价记录增量另见 [quote-records-v1](2026-09-05-quote-records-v1.md)，仅列明的精确scope可保存/恢复；preview scope仍没有写权限。
# 归类补问兼容补充（已接受，2026-09-05）

当前源服务的已批准补问包括编码所属地区和真空保温结构。工作台 Query 请求使用可选 `attributes.vacuumInsulated`（`yes` / `no` / `unknown`），出站源服务 v2 映射为 `true` / `false` / `"unknown"`，编码所属地区继续使用顶层 `codeCountry`。源服务先部署这一兼容扩展，旧请求可不带该字段；响应和权限范围不变。`contains_steel_aluminum` 同样在工作台使用三态字符串，源 v2 使用 boolean | `"unknown"`；yes/no 必须明确转换，unknown 保留且不得转换为 false。源 v1 继续其原 boolean 合同。工作台不得根据商品文本擅自推断补问答案。回归须证明源问题、用户答案、适配输入和下一次查询一致，未知属性失败闭合。
