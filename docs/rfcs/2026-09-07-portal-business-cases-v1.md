# RFC：前后台共享询价受理 v1

Status: Accepted for the first local implementation slice under the user's 2026-09-07 instruction to plan and execute a connected frontend/backend. This acceptance covers the narrow resources below, not the unfinished native-engine migration RFC or new MCP tools.

## 问题与结果

此前 `/inquiry/` 只生成邮件草稿，后台没有同一票需求。现在登录后可提交结构化需求，取得服务端生成的 `case_id`；客户与处理人员读取同一条记录。邮件草稿保留为可选方式，不自动发送。配置与历史从空白开始，不导入旧业务数据。

新权威只管理“询价需求与受理进展”。价格、关税、承运商报价仍由其领域权威产生；需求结束不表示已订舱、已付款或已发运。本版本不新增机器写权限，不改变既有工具目录、Access Gateway entitlement 或 API Key。

## HTTP 与兼容性

路径前缀 `/console/api/v1`，版本 `portal-cases@2026-09-07.v1`。登录、来源检查、CSRF、响应 no-store 复用 Portal；所有 POST 要求 Idempotency-Key。

| 方法与路径 | 输入 | 结果 |
|---|---|---|
| POST /cases | `portal-cases-input.schema.json`，原询价表单的严格字段集合 | 完整需求 |
| GET /cases | management、status、cursor、limit；严格拒绝未知、重复参数 | 最多 50 条、下一页游标 |
| GET /cases/{case_id} | 无查询参数 | 需求与允许查看的进展 |
| POST /cases/{case_id}/update | expected_version、status、public_note、internal_note | 写后读回 |
| POST /cases/{case_id}/reply | expected_version、message | 写后读回 |

首次提交结果的关键字段从不存在变为：

```json
{"schema_version":"portal-cases@2026-09-07.v1","status":"success","data":{"case_id":"<server UUID>","status":"submitted","version":1,"can_manage":false,"can_reply":false},"reason_codes":[]}
```

该片段仅说明新增字段，完整响应还包含 input、created_at、updated_at、events，以 `schemas/access-gateway/portal-cases-response.schema.json` 为准。输入、更新、回复、列表、成功响应均有 Draft 2020-12 Schema，对象 additionalProperties=false。表单数量保持字符串，运输量单位沿用明确的 kg / m³ / 柜数；本资源不存费用或税率。跨字段校验由共用询价模型执行，JSON Schema 只表达结构约束。

失败复用 Portal 原错误包络和五种状态。未登录 401；无权限 403；无权读取对象与不存在均 404；版本/幂等/状态冲突 409；创建限额 429；未启用 503。对象的 submitted/in_review/needs_input/closed/cancelled 是业务状态，不是包络状态。

## 权限与事务

- 已验证邮箱的普通账号可提交；owner_id、organization_id、actor_id 来自服务端会话，拒绝请求伪造。
- 客户查看自己在当前企业的需求及自己无企业的需求；读取企业记录必须处在有效的当前企业上下文。其他企业不可借所有权绕过上下文。
- 当前企业 owner/admin 可处理该企业需求；平台 operator 在平台上下文可处理全队列。reviewer 不取得处理权限。
- 普通客户只收到 customer 进展；internal 备注在服务端过滤。被授权处理需求的 owner/admin 可以看到内部备注。
- 每次写入、幂等重放都重新检查权限。保存 expected_version，防止旧页面覆盖。key 按用户、组织、操作隔离，内容变化返回冲突。
- 创建、事件及幂等记录同一 SQLite 事务提交，提交后重新读取。业务事件保留服务端 actor_id；该字段不返回普通界面。不记录原始请求到日志。
- 每用户滚动 24 小时最多创建 50 票，每票最多 500 个版本，列表分页。该限额独立于游客关税每日 20 次。
- submitted → in_review / needs_input / closed / cancelled；in_review、needs_input 可继续更新或结束；客户只在 needs_input 时回复并进入 in_review；closed、cancelled 为终态。

## 初始化、发布与回退

生产使用 `PORTAL_CASES_ENABLED=true` 显式启用，默认关闭；启用前核对单实例、Portal 持久化目录权限和备份。单独的 `business-cases.sqlite` 保存需求，不访问旧业务库。数据库初始化建立三张窄表、索引与 user_version=1；不兼容的既有事件表拒绝运行。使用项目 Node SQLite 版本备份与恢复。

当前实现只支持单实例 SQLite；Postgres/shared 模式开启此功能会拒绝启动 `cases_shared_store_unavailable`，不能假装跨实例共享。启用时 readyz 纳入 cases_database。回退先停止新提交并备份文件，再关闭开关或退回前版；保留该库，不删除客户需求。前版表单可继续邮件询价。

## 验证

`npx vitest run tests/access-gateway/portal-cases.test.ts tests/access-gateway/portal-cases-http.test.ts` 验证角色、企业隔离、权限撤销、分页、严格输入、CSRF、幂等、版本冲突、内部备注过滤、重启持久化与写后读回。浏览器合成验收覆盖未登录保留表单、提交、后台要求补充、客户回复、后台读回、账号入口及桌面/手机布局。

未启用到生产不等于已上线；OCR、报价导出、邮件订舱、SO 识别与原生计价/关务迁移仍按各自 RFC 实施。
