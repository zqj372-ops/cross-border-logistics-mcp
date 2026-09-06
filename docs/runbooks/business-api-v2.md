# Business API v2 部署边界

最新统一 Key 与发布身份见 [2026-09-06 交付](../product/2026-09-05-mcp-product-redesign/17-market-manual-production-delivery.md)。当前固定 REST 路由可直接使用同一把 `flcbk_` Key；MCP 使用该 Key 兑换独立 audience 的短期 JWT。

以下保留 Business API v2 初次装配和验收边界。最近保存的回执已确认 Portal、生产身份适配、持久仓储及机器路由部署到 `https://www.freightclaw.net`；现有租户与应用 authority 复用 PostgreSQL，T0 密钥继续使用 OCI。真实企业所有者、应用、授权和统一 Key 状态已读回；公网 service actor 只读来源调用已验证加拿大尾程 Zone 与 AI 提取。关务正式快照、Freightcom 企业凭证、客户 Key 实际调用和报价人员业务全流程仍待验收。详见[生产交付台账](../product/2026-09-05-mcp-product-redesign/15-implementation-delivery.md)与[当前功能缺口](../product/2026-09-05-mcp-product-redesign/18-current-status-and-gaps.md)。

## 必需装配

- production 必须注入 `kind: production` 的 `BusinessAccessRepository`。`production-persistence.ts` 的生产 SQLite 适配使用独立持久卷和存储身份校验；合成 fixture 使用独立实现，不能注入生产。Portal、session、business-access 三个生产数据库必须一起纳入一致备份，私有配置和密钥历史也要保留。当前是单实例部署，不支持把同一个 SQLite 卷给多台主机并发写入。
- 必须注入 `tenantClientAuthority.requireActive(tenantId, clientId)`，在 Grant 开通、Key 签发或轮换、换票和每次业务调用前读取当前租户与 client 状态。
- 必须注入可审查的 operation authority。尚未配置或未就绪的 operation 必须失败闭合，尤其 `customs.tax.estimate`。
- Credential 哈希 pepper、RS256 私钥和验证公钥必须来自部署方的秘密或密钥 provider，不得放入静态页面、日志或仓库配置。
- machine handler 的 production 模式必须配置 HTTPS 终止边界、精确允许的 Host/Origin 和可信代理地址。它只接受可信代理传入的单一 `X-Forwarded-Proto: https`。
- fixture 模式只允许 loopback，并且只接受 synthetic repository。

## 固定入口

- `POST /access/v2/business/token/exchange`：长期 Business Key 换取最长 300 秒的 `freightclaw-business-api-v2` JWT。
- `POST /api/v2/business/customs/query`
- `POST /api/v2/business/customs/tax-estimate`
- `POST /api/v2/business/customs/tax-estimates/batch`
- `POST /api/v2/business/quote/zone-preview`
- `POST /api/v2/business/quote/ai-extract-preview`
- `POST /api/v2/business/quote/freightcom-ltl-preview`：读取 Freightcom 正式账号的承运商预估费用、附加费和有效期；不保存、发送或订舱。

Freightcom 操作必须由部署方按企业配置独立正式凭证；未配置时仅该操作返回 `unavailable`，测试账号不得作为生产回退。金额保留承运商原币种和整数最小货币单位，结果固定 `saved=false`、`sendable=false`、`bookable=false`。

税费批量标识由固定路由注入，客户请求不能覆盖。机器接口拒绝 Cookie，并在读取 JSON 前验证唯一 Authorization。执行结果必须通过已知 Portal 业务包络、操作对应关系、request ID、闭合顶层字段及敏感字段检查。

## 发布验收

生产发布前至少验证：真实持久仓储与备份恢复、密钥轮换、tenant/client 停用即时生效、Grant 暂停或撤销即时生效、旧 JWT 被当前授权拒绝、一次性 Key 不可重放、幂等重放返回当前对象状态、跨组织拒绝、代理来源伪造拒绝、上游 readiness 与版本变化失败闭合。

已取得的生产证据包括：Portal 的五项依赖 readiness、三个 SQLite 的一致备份和隔离恢复、现有三个 PostgreSQL 的隔离恢复，以及本机、Oracle、广州使用标准 Python 客户端访问正式 API 的结果。Cloudflare 仅对指定机器路径关闭 Browser Integrity Check，未关闭其他防护。

最新企业回执已覆盖真实所有者入组、有效应用、审批开通和 Key 交付；原有 Key 保留且显式启用基础工具。但 `last_used_at=null`、`production_customer_key_invoked=false`，仍需使用客户实际保存的 Key 验证直接 REST、MCP 换票及调用，并核对停用和撤销。不得用技术 service actor 或合成人员冒充此验收。报价保存、人工审核与 PDF 使用人员业务 API，机器预览权限不会自动获得写入权；其真实人员流程仍待验收。
