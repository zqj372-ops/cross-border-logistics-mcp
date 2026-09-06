# FreightClaw 统一工作台：生产交付台账

更新时间：2026-09-06。最近保存的发布与验收详见 [Wind 风格市场、手册与统一 Key 生产交付](17-market-manual-production-delivery.md)；本轮 main 集成、核查范围和缺口优先级见 [18 当前进度与功能缺口](18-current-status-and-gaps.md)。下表区分界面、生产连接和正式业务完成；全业务闭环仍有实际来源与企业凭证缺口。此处引用历史回执，不表示每次文档更新均重新探测生产。

## 当前生产状态

正式入口：[FreightClaw](https://www.freightclaw.net/console/#home)。Portal 与 MCP Runtime 均已发布 `a42849576004`；源码身份来自工作区逐文件清单，不等于已合并到主分支。

| 范围 | 已完成并验证 | 仍待完成 |
| --- | --- | --- |
| 界面、市场、手册 | 按 Wind 参考重做首页/市场/个人中心，七章手册和公开 Agent 指南上线；桌面、平板、手机及新旧角色流程通过 | 后续服务按真实协议和可用条件更新目录 |
| 邮箱身份 | Authentik 中文登录/注册/找回、QQ SMTP、真实邮箱验证；聚仓科技所有者已加入且能恢复正式登录 | 无新增登录前置步骤 |
| 企业与持久化 | 企业、应用均 active，有效所有者 1；Portal 三个 SQLite、既有租户/应用 PostgreSQL 与 OCI 保留 | 未来正式业务写入后按数据保留策略备份 |
| 一把 API Key | 原 NY6A Key 保留，密钥与有效期未改变，仍仅 1 枚有效 Key；已显式启用基础工具；直接 REST 与 MCP 短 JWT 适配已部署 | 本轮未读取或调用用户保存的完整 Key，真实客户机器调用仍未独立验收 |
| 授权与失败状态 | 同一 Key 的 T0/Business、当前授权、撤销后的旧 JWT、viewer 门禁等隔离验证通过；旧业务入口兼容 | 不以隔离结果冒充真实客户交易 |
| 备份与部署 | Portal 发布前/交付后均完成三库一致备份和恢复检查；Runtime 使用同版本 SQLite 完成实际恢复验证；两服务健康，12 项公网检查通过 | 保留前版本和配置供回滚 |
| 加拿大尾程来源 | 既有生产候选与迁移、M2M、真实租户连接已验证，Zone 与提取服务有实际只读回执 | 当前来源价格复核、人员保存/审核/PDF及客户业务验收 |
| 关务来源 | 独立候选、固定 M2M 路由和真实租户连接已验证；未发布数据如实返回 data_not_ready | 正式 release review、复合 snapshot 与动态措施依赖；15 个 staged 候选不能称 published |
| Freightcom | 客户端、固定接口、授权、Schema 和界面已实现 | 企业正式凭证、账号映射与实际生产 rate 读回 |
| 新服务资料 | [新服务接入指南](../../integrations/new-service-onboarding.md)、公开 OpenAPI、七章手册和 Agent 指南同步 | 每个来源仍需其业务权威、正式连接和验收证据 |

## 证据与边界

- [最新 UI/统一 Key 交付](17-market-manual-production-delivery.md)：当前 build ID、镜像、资产哈希、角色、原 Key 保留、浏览器回归、12 项公网检查与恢复记录。
- [Quote Candidate](../../runbooks/quote-candidate-production-api.md)：原服务保留、M2M、迁移、来源版本与负向验证。Zone 来源版本 2026-06-03 不能推断为当前客户正式价格已批准。
- [ClearDDP](../../runbooks/customs-candidate-production-api.md)：真实委托、未发布阻断与独立候选。官方来源逐项核验还发现动态措施候选缺口，不能直接发布。
- [生产登录历史](../../runbooks/portal-production-acceptance.md)与[国内邮箱登录](../../runbooks/portal-login-cn.md)：登录修复和 QQ 发信依据。历史 pending 邀请已被当前 active owner 状态替代。
- [Cloudflare Python 客户端](../../runbooks/cloudflare-python-api-acceptance.md)：仅机器路径关闭浏览器签名检查，API 自身认证与授权继续执行。

状态 `success` 仅表示该操作满足合同条件。试算、保存、价格批准、PDF、发送、订舱和支付是不同动作。本次没有客户发送、订舱或付款，也没有替业务人员批准价格或税则。

普通业务人员使用网页登录。系统使用统一 Key 直连固定 REST 接口；MCP 仍使用短期 JWT，每次核对当前企业、应用、负责人、授权和凭证。后台不会因页面简化而放宽来源与租户边界。

正式关务数据、Freightcom 企业凭证与有效报价来源仍是业务闭环限制；页面明确保留 `needs_input`、`manual_review`、`blocked`、`unavailable`，不通过填充样例消除这些限制。
