# 个人整柜受理人查询船期

本开关配合已有 FCL 固定受理人配置使用，不创建企业。HTTP 请求和响应、报价及运价 Schema 均不变。授权决定来自服务端身份权威，每次查询重新检查；前端显示入口不构成权限。

## 发布配置

1. 使用包含本变更的 Portal 构建，按现有生产发布流程部署。
2. 在服务器私有环境配置中保留已验证的 FCL 固定受理人设置，设置 `PORTAL_FCL_SCHEDULE_LIVE_ENABLED=true`。要求 `PORTAL_FCL_ENABLED=true` 和现有身份权威配置有效，否则启动失败。
3. 企业 `PORTAL_SCHEDULE_LIVE_TENANT_ALLOWLIST` 可以为空。个人查询使用 `fcl-personal-` 加固定受理人 subject 的 SHA-256 前 32 位作为独立证据/审计目录，不把个人账号伪装为企业。
4. 个人 FCL 船期目前固定为 COSCO。服务端即使收到其他船公司请求也会拒绝；现有 `PORTAL_SCHEDULE_LIVE_CARRIER_ALLOWLIST` 继续作为额外限制，个人 scope 应包含 COSCO（例如 `scope=COSCO`），旧配置中的 ONE 等条目不会扩大个人权限。企业原有船公司策略保持不变。
5. 证据与审计继续使用 `PORTAL_SCHEDULE_LIVE_EVIDENCE_ROOT` / `PORTAL_SCHEDULE_LIVE_AUDIT_PATH`，或现有生产数据目录中的默认位置。不得把身份 subject、会话或证据正文写进交付文档。

## 验收

- 固定受理人正常登录，无企业，能读取船公司能力并查询港口、船期。
- 其他个人、邮箱未验证或已撤销身份不能使用该个人权限；原有企业成员权限不变。
- `needs_input` 时确认准确港口；`manual_review` / `blocked` / `unavailable` 如实展示，不能回填。
- 仅 COSCO 来源、完整且无冲突的实时成功结果允许“使用此船期”。报价船公司采用 COSCO 销售来源；官方未提供的实际承运人保持未知，不根据船名推断。非 COSCO 海运费不关联 COSCO 船期。核对船名、航次、开船/到港日期；回填前后的金额和价格来源必须一致。原有航程字段仅支持整数天，不将小数天擅自取整。
- 保存并发布后重新计算报价，核对版本、来源、审核及正式 PDF。
- 查询审计和证据应属于该个人 scope，其他身份不能读回。

## 回滚与验证范围

将 `PORTAL_FCL_SCHEDULE_LIVE_ENABLED=false` 后重启即可撤销新增个人访问；无需数据库迁移，不删除历史记录。此开关不授予个人 API Key/MCP 权限。

本地可丢弃 fixture 和假适配器测试不访问船公司。它们验证界面、权限、证据隔离和报价回归；不能代替上线后的真实船期连通验收。
