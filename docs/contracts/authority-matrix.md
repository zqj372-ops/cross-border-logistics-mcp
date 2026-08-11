# 数据权威矩阵

本矩阵把“权威来源”“MCP 能做什么”和“客户端看到什么”分开。搜索、地图、承运人门户、聊天、WPS 和公开目录只能提供比较/线索，不能替代内部计算或权威记录。适配器尚未确认的端点标为“待适配验证”，不在基线中虚构调用方式。

| 数据类别 | 当前核验到的权威源/证据 | MCP 可做 | MCP 不可做 | 缓存策略 | 失败策略 |
| --- | --- | --- | --- | --- | --- |
| 加拿大尾程规则、Zone、价格矩阵 | `AI自动报价模块/reference/canada-final-mile/`；数据库模型 `ZoneLookupRule`、`ZonePriceMatrix`；`tests/quote-engine/` | 通过窄适配器读取版本并调用确定性计算；返回来源与 trace | 不复制价格/Zone 表；不线性外推、改价或默认地址类型 | 查询可按 `rule_version + data_version + lookup_key` 短缓存；版本变化立即失效 | 缺失、冲突或未覆盖范围转 `needs_input`/`manual_review`；无数据不得报价 |
| 报价草稿、报价审计、人工任务 | `AI自动报价模块` 的 `SalesQuoteRecord`、`QuoteAuditLog`、`ManualQuoteTask` 和对应 routes | 预览、保存现有系统草稿、创建复核任务，并读回确认 | 不发布/发送报价，不覆盖历史版本，不直接写价格或 Zone | 不缓存写结果；只保存 `record_id/version` opaque readback ref | 写后读回失败、版本不一致、幂等冲突转 `manual_review` |
| 现有报价系统身份/角色 | `apps/api/auth.py`：Bearer、`X-API-Key`、`admin/operator/sales/viewer` | 网关校验短期凭证并映射角色；服务端注入 actor/tenant context | 不让模型自报 actor/tenant，不转发环境变量，不绕过角色 | 凭证不落缓存；会话/令牌短期有效，具体 TTL 待适配验证 | 缺凭证 `blocked`；角色不足 `blocked`；租户映射不明 `manual_review` |
| 精选 SOP、规则说明、异常案例、模板 | `AI自动报价模块/reference/canada-final-mile/` 中 `SOP_QUICK.md`、`RULES.yaml`、`QUOTE_TEMPLATE.md`、`EDGE_CASES.md`；旧长 SOP 仅历史 | 只搜索当前启用/精选内容，返回 source refs 和版本 | 不让解释性文档覆盖可执行价格、税率或 Zone；不混入 archived 文档 | 内容按 checksum/version 缓存；`status=archived` 永不参与运行计算 | 索引不完整返回 `unavailable`/`manual_review`，不凭相似文档补齐 |
| RiskCustoms HS/税率/贸易措施 | `美国、加拿大关务` 的 published snapshot、release manifest、Schema、官方 release 记录 | `customs.ca.search` 查询候选；`customs.ca.estimate` 只做带版本的估算 | 不把候选变正式归类；不绕过 `ready` 门禁；不输出正式报关结论 | 只按 release/version 缓存；不得用新数据覆盖历史结果 | `ready=false` 原样映射 `unavailable` 或 `manual_review`；来源不全时不估算 |
| RiskCustoms 就绪状态 | `/api/status`、`DataStatusSchema`、`data-readiness.test.ts` | `system.get_data_status` 查询并暴露 `ready`、原因和 release IDs | 不把 fixture/testData 当生产就绪；不把 `ready=false` 改成 true | 可缓存不超过状态声明的短 TTL；状态响应当前公开缓存 300 秒仅供参考，MCP 写入前必须复查 | 状态端点不可达 `unavailable`；快照与来源不匹配 `manual_review` |
| 公开服务目录/参考费用 | `物流LCP服务/canada-logistics-records/app/lib/quote-data.ts`、`public/pricing/catalog.json`、`admin-server/server.mjs` | 查询公开参考服务项；把人工报价项标为需确认 | 不把公开目录当加拿大尾程权威价；不把“待报价/据实”虚填小计 | 按 `schemaVersion + revision` 缓存；读取失败时禁止使用内置旧费率 | 目录不可读保持清单可用但价目 `unavailable`/`manual_review` |
| 公开目录发布状态 | LCP 单管理员 draft→publish、revision、备份和审计测试 | 读取已发布 revision 和脱敏字段 | 不直接编辑私有 JSON，不泄露成本、vendor、margin、内部备注 | 只缓存发布 revision；草稿不对外缓存 | 读回不一致 `manual_review`；公开字段含内部字段则 `blocked` |
| 货物输入、尺寸、重量、包装和地址 | 当前请求、现有报价记录（若有）及用户提供的 opaque reference | 校验字段、计算 CBM/体积重/分泡/计费重；保留证据模式 | 不把自然语言原文直接作为权威数值；不混用 `unit_weight`、`piece_weights`、`line_total_weight` | 默认不缓存客户原文；结构化结果只绑定 request/quote ID 和版本 | 缺单件重量或证据冲突 `needs_input`/`manual_review` |
| 容器物理容量与可操作容量 | 基线尚未在现有系统核验到统一权威表；由运营批准配置定义 | 展示理论容量与可操作目标的差异，做确定性汇总 | 不把物理容量当可承诺装载量；不做 3D 装箱承诺 | 配置必须版本化；无批准版本不缓存为可用 | 缺配置 `manual_review`；超方/超重不自动承诺 |
| 审计关联、幂等、写后读回 | 现有系统各自有审计/版本机制；MCP 全局 audit 结构待实现 | 生成 `audit_id`、记录 source/version/action outcome、保存 readback evidence | 不记录敏感全文；不以客户端回传 audit_id 代替服务端审计 | 审计不可缓存；幂等键按租户/工具/请求窗口保存 | 审计或读回失败优先 `manual_review`，不静默成功 |
| 凭证、密钥、内部地址、报价/税务全文 | 现有系统密钥存储和环境变量；本基线只确认存在，不读取真实值 | 只传递短期、最小权限的服务端引用 | 不向模型暴露密钥、环境变量、SSH、邮箱密码、API key 或原文 | 不缓存、不写日志、不进入 Resource | 发现泄露风险立即 `blocked`，需安全处置 |

## 缓存与版本原则

1. 每个缓存键必须包含租户（如果数据按租户隔离）、工具、输入规范化摘要、权威源版本和规则版本。
2. 价格、Zone、税率、贸易措施和公开目录都不能用“最新”这个无版本指针代替版本 ID。
3. 历史报价回放必须读取原来绑定的版本；新规则上线不能改变旧结果。
4. 对不可变官方 release 可以缓存内容，对 mutable status 只能短缓存，并在写工具前重新读取。
5. 任何缓存命中都要在 `source_refs` 标注来源版本和 retrieved/cache time；命中旧版本但输入要求当前版本时返回 `unavailable` 或 `manual_review`。
