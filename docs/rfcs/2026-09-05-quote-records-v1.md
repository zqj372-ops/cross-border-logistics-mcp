# 报价原记录保存、恢复与人工复核任务 v1

状态：Accepted — 2026-09-05 根基线依据当前报价独立工作树核查接受。用户要求原服务复用和正式询价，明确写按钮只能保存原系统记录，不自动发消息或猜造正式价格。此合同不宣称当前费率具备正式发布资格。

## 边界

原 `sales_quote_records` 与 `manual_quote_tasks` 保留业务权威。旧记录默认 legacy，M2M 行增加严格 tenant/application/actor 隔离，不读取 legacy 全局列表。新保存事务不调用自行 commit、自动通知、Hermes 学习写入或把 confidence 升为100的旧封装。原流程兼容回归。

本切片保存待复核记录，明确 `sendable:false`。`supporting` 或 `fixture` 价格来源永远不因保存变成正式权威价格。当前不得远程改价、批准、发报价、通知或写学习规则。`needs_input`、`blocked`、`unavailable` 不保存记录或任务。

## 路由与委托

新增 scope `quote.record_save`、`quote.record_read`、`quote.review_read`，仍精确校验连接密钥及 business-delegation v1 RS256 人员/机器委托。当前 Portal 仅开放人员显式保存与本人恢复；客户机器写授权须单独申请合同，不能继承只读 preview 权限。

人工闭环增量使用三个单操作委托 scope：`quote.review_manage`、`quote.document_generate`、`quote.document_read`。每次请求仍绑定原始人员 actor、固定 tenant/application/service caller 和 request ID。Portal 只允许当前企业的 owner/admin 请求人工复核，源报价服务的 reviewer allowlist 继续最终判权；记录与文档读取仍按源系统 tenant/application/创建 actor 隔离。这三个 scope 仅供人员浏览器会话经 BFF 调用，不进入 machine v2 的四项业务 operation，也不授予客户 Key 写权限。

人工复核新增有界队列、重新计算预览与显式处置：`GET /api/v1/m2m/quote/review-queue`、`GET /api/v1/m2m/quote/review-tasks/{task_ref}/resolution-preview`、`POST /api/v1/m2m/quote/review-tasks/{task_ref}/resolve`。批准使用 v2 合同，必须同时提交逐项 decimal string USD 费用、相等总价、证据引用与版本、带时区生效/截止时间、中文客户条款、复核说明和 `human_verified_price_and_source` 明示确认；服务端冻结全部货物与卸货条件及实际来源快照哈希。写后读回成功且仍在有效期内才可返回 `quote_ready:true`。保留待复核不会写正式价格，不触发通知或学习写入。

文档闭环新增 `POST /api/v1/m2m/quote/records/{record_ref}/documents`、metadata 与私有 content 读取。正式 PDF 只能从 `quoted + quote_ready + 已读回人工证据 + 当前有效` 的源记录生成，并显示出具时间、有效期、逐项费用、货物与卸货条件、中文条款、记录版本和来源快照；有效期最长 366 天。过期后拒绝新建正式 PDF，既有文件仅作为 `valid_now=false` 的历史快照读取。草稿必须带 `DRAFT - NOT A FORMAL QUOTE` 水印。Portal BFF 在向浏览器传送前复核 metadata、来源/条款哈希、长度、PDF magic bytes 与 SHA-256；文档生成和下载不发送客户消息、不订舱。

保持现有 preview v2 完全兼容；新增 `POST /api/v1/m2m/quote/records/prepare`（scope quote.zone_preview），闭合 body `schema_version:quote-record-prepare@2026-09-05.v1, request:<同ZoneRequest>`。返回源 v2 preview、仅在可保存时提供 preview_handle，不写业务记录、任务或通知。

`POST /api/v1/m2m/quote/records`（record_save）需要 Idempotency-Key、闭合 body `schema_version:quote-record-write@2026-09-05.v1, preview_handle, request:<同ZoneRequest>, intent:save_draft`。

`GET /api/v1/m2m/quote/records/{record_ref}` 和有界列表 `GET /api/v1/m2m/quote/records?cursor=&limit=&status=`（record_read）；`GET /api/v1/m2m/quote/review-tasks?record_ref=`（review_read）。限制最多100行，opaque cursor，精确tenant/application/创建actor过滤，不暴露其他用户或客户应用的记录。未知/无权限引用返回同一不可见状态。不得返回数据库自增ID。

## 预览、幂等与读回

preview_handle 是签名opaque locator，只含随机ID、绑定hash和iat/exp；不得携带原始地址、客户正文、金额或密钥。独立私有 handle secret，最长10分钟，不复用连接Key。保存时核验tenant/application/servicecaller/actor绑定、完整规范输入hash、有效期，再调用同一只读引擎重算，核对稳定结果hash和来源hash（不包含易变retrieved_at）。变化则 `manual_review + preview_changed`，未保存，返回可确认的新预览；过期 `needs_input + preview_expired`。

原记录、对应人工任务、operation幂等完成记录在一个事务提交。复用原表并新增namespace/scope字段与opaque refs；新增 `m2m_quote_operations` 仅用于幂等与恢复，不复制报价权威。幂等键按tenant/application/actor/action隔离，相同输入返回同记录，冲突拒绝；先查询已提交操作再校验重试handle过期，保证提交后可恢复。

提交后新Session按记录ref+tenant+application+actor读回，核对版本、输入/结果/来源hash和任务；才返回 `saved:true,readback_verified:true`。未完成读回返回 `manual_review,reason_codes:[write_readback_pending]` 和真实operation_ref；重试收敛，不重复记录、任务或消息。固定输出五状态，decimal string+USD沿用source。

## 当前返回语义

保存完成但价格需复核：`status:manual_review`，data包含 `operation_ref,record_ref,record_version:1,record_status:manual_required,review_task_ref,currency:USD,saved:true,sendable:false,readback_verified:true,source_refs`。页面使用“已保存，等待人工复核”，不能用状态非success笼统误报保存失败。

## 迁移与验证

只操作隔离工作树和合成测试数据库；旧表默认scope_kind=legacy，新增字段nullable，M2M行必须完整绑定。迁移版本可重复应用，不更新旧金额/归属。回滚关闭新路由，保留已保存记录和幂等审计。不开生产迁移。

验证：原引擎全回归、preview无业务副作用、handle篡改/过期/输入变更/来源变化/actor串用、固定五状态、首次提交与重复/冲突、事务回滚、提交后读回失败恢复、跨tenant/application/actor记录/任务不可见、全部异常日志无正文/SQL/secret、无通知/学习写入。
