# FCL 成交与执行 v2

Status: **Accepted for isolated implementation**，2026-09-23。用户在审阅本文及配套 Schema 后明确答复：“接受该合同，继续完成三个阶段”。

用户已要求继续完成 `FCL_inquiry_quote_execution_v2.md` 并确认本地实施合同。本文是本次窄基线，不表示实施完成或生产授权。按下列阶段持续实施，不需每个局部改动再次确认。用户在本地验收后另行授权 Git 提交；生产迁移、真实邮件外发、推送和部署均不在本次范围。

## 1. 审查结论与最小计划

基线 `34b90e1e93027a4fadbc8c8121ec86821a900a75` 已实现 Case、报价、批准文件、正式 PDF、内部 handoff；handoff 不是成交事实。保留同一工作区的 v3 批次 1 去重改动。

1. 在 DocumentWorkflowService 的 Case → Rate → Document 锁顺序内复用正式交接校验，增加员工代录客户确认、只读预览与幂等启动。CaseStore 同库保存一条 `fcl_case_progress`，主键仍为 case_id；节点为固定 JSON 数组。保存执行资料不写 case input/version。
2. 固定节点表单、最小节点参与授权、个人通知配置 v2 和同库 outbox。报价权限仍限原 owner，执行参与权不放开 Case/Quote/Document/Rate 原有读取入口。
3. 验证引用漂移、重复/并发、独立版本、隔离、持久化、SMTP 不确定结果与迁移；同页 Web 和 workspace CLI 共用闭合 HTTP 合同。

遗漏处理：delivery 的还柜不自动推定，由本单显式选择。未承接的起运服务不生成任务，目的港操作的外部放行依据在本节点登记。美转加保税不纳入本次六项服务。资料及通知草稿允许缺配置；启动节点必须有有效负责人，启用邮件时必须有 To。邮箱不授予权限。不会生成占位用户或邮箱。

## 2. 权威、目录与影响

由本任务协调基线及集成，修改范围限于：

- Case/权限/执行/HTTP：`services/access-gateway/portal/{cases,fcl-execution*,fcl-http*,http}`。
- 交接编排：`services/quote-documents/workflow.ts`；保留旧 handoff 含义及全部正式文件门禁。
- 配置、发信和组装：`services/access-gateway/portal/{native-admin*,production-fcl,production,fcl-smtp*,fcl_smtp_send.py}`。
- UI：`apps/console/fcl.js` 加小型执行、通知文件；复用现有样式及中文字段。
- CLI、迁移、生成合同与对应测试：`deploy/**`、`schemas/access-gateway/**`、`apps/console/openapi.json`、`tests/**` 的 FCL 相关文件；共享契约仅在本文被接受后由基线更新。

无 MCP 注册或公共工具变更，无新 ERP 主档或数据库服务器，无企业权限体系扩张。原 `owner_id` 不变；`actor_id` 永远为实际操作人。

## 3. 版本与闭合输入输出

新增 `fcl-execution@2026-09-23.v1`；通知新增 `fcl-notification@2026-09-23.v2`。现有 HTTP 五状态 envelope 及原 Case/Quote/Document/Handoff 请求保持原义。所有对象 Draft 2020-12 `additionalProperties:false`，输入有界，金额仍只保留权威引用。

旧 Case 示例保持不变：

```json
{"case_id":"00000000-0000-4000-8000-000000000001","case_version":2,"case_status":"in_review","current_input":"原询价字段"}
```

新执行读模型结构示例（同目录 `2026-09-23-fcl-execution-v2.schema.json` 保留已接受的评审快照；运行字段以 `schemas/access-gateway/fcl/` 生成 Schema 为准，评审快照不由运行时读取）：

```json
{"contract_version":"fcl-execution@2026-09-23.v1","case_ref":"00000000-0000-4000-8000-000000000001","version":1,"state":"executing","owner_id":"实际原owner","coordinator_id":"实际个人账号","acceptances":[],"nodes":[],"shared":{"containers":[],"hbl":null,"mbl":null,"eta":null},"history":[]}
```

该示例仅说明结构，实际已执行记录必须有成交证据与适用节点，不能写入示例用户。

### 3.1 接受与独立版本

成交请求绑定原 handoff 所有 expected version/digest/PDF SHA 字段，再附员工代录客户确认：方式、带时区时间、联系人、说明、可选证据引用。服务端生成接受 ID、actor、登记时间。客户确认时间不得晚于登记时间。预览只读，启动时重验全部门禁。

接受记录冻结 Case、Quote、Document、批准版本、PDF、handoff 引用与摘要、customer_scope 及配置版本。priced/included/free 生成节点，pending 阻断，out_of_scope 不生成。零价格不决定服务范围。

同 case 唯一约束与事务串行化保证跨 key 启动不重复；同 key 不同 body 冲突。重复启动打开已有执行，不能通过再次启动更换成交依据；不同成交依据需商业变更动作。已执行重放先校验当前对象权限，然后读回原记录，不重新要求旧报价仍有效。

商业变更是追加新的客户确认、原因及重新批准报价引用；原接受记录和已完成节点不改。新增服务创建未启动节点；移除服务只将对应未完成节点显式标为取消，保留历史。完成过的节点不自动重做；确需重做由授权人员注明原因开启下一周期。

执行柜号、封条、HBL/MBL、ETA、人员、截止与节点资料使用独立 expected_version CAS。不会回写已确认询价字段或报价。若同票并行编辑冲突，返回 version_conflict 保留草稿，用户重新核对差异。

### 3.2 固定节点

| 服务 | 节点 | 完成所需依据 |
| --- | --- | --- |
| ocean_freight | booking、shipping_documents | Booking/SO 及订舱依据；提单号与核对/交接依据 |
| pickup | pickup | 实际完成时间、作业依据；共享柜号/封条 |
| export_customs | export_customs | 申报参考、人工确认放行与依据 |
| canada_customs | canada_customs | 进口商、申报参考、人工确认放行与依据 |
| devanning_storage | devanning_storage | 仓库、实际交接时间、差异记录与交接依据 |
| delivery | delivery | 放行依据来源、实际派送/签收时间、POD；显式承接还柜时追加还柜时间与凭证 |

所有节点允许保存缺字段草稿；完成才核验必填。资料准备、预约允许并行，不增加统一串行依赖引擎。目的港节点可记录客户/外部提供的放行与交接依据，不生成公司未承接的订舱任务。固定字段及状态不可由客户端扩展。

节点状态为 not_started、active、exception、completed、skipped、cancelled。后三种为本周期终结；重开产生新的 cycle。保存不推进状态；完成、异常、退回、改派、重开和跳过都有单独窄动作。跳过/取消/重开必须记录原因，不删除原事实。

### 3.3 拟新增 Portal / CLI 动作

| 动作 | 权限 / 效果 |
| --- | --- |
| execution-preview / execution-start | 原 owner；复用正式交接验证，启动需要确认及幂等 key |
| execution-get / execution-list | 原 owner 或当前有效执行参与人；按对象和节点裁剪投影 |
| execution-shared-save | owner/协调人；独立版本，不触及询价 |
| execution-node-save / start / complete / exception / return | 本节点有效参与人；expected_version、幂等、完成条件 |
| execution-node-assign / reopen / skip | owner/协调人；实际账号、原因、立即撤权 |
| execution-amend-preview / amend | 原 owner；新成交证据及原因 |
| execution-defaults-preview / apply | owner；仅更新未开始节点，确认 preview digest 与配置版本 |
| notification-v2-get / save | 本人默认配置，复用 native-admin CAS/审计/幂等/读回 |
| notification-preview / test | 固定投影；测试只含合成业务文本、显式确认和限流 |
| execution-mail-resolve / retry | owner/协调人；明确结果核实或安全重试，写审计 |

具体动作均走人员 workspace session、CSRF 与现有请求/响应校验；CLI 与 Web 使用同一 action/method/schema map。查询 Key 不新增权限。测试邮件内容不能由调用方自由指定。

## 4. 事务与读回

首次启动在 Case → Rate → Document 已有同步锁内，保存 handoff（相同正式版本已有则复用）、执行、审计及 outbox；成功前全部读回。报价和文档存储只读持锁，不新增分布式提交。旧 handoff 不自动回填执行。

`fcl_case_progress` 一票一行，含独立 version、闭合 JSON 与持久化审计；`fcl_execution_outbox` 同库第二表。幂等复用 business_case_idempotency 的动作/实际 actor scope。拒绝超出有界历史容量，不静默截断证据。

事务失败回滚新事实；COMMIT 后读回不确定返回明确不可伪称成功的错误，同 key 重试读回已提交数据并收敛。SMTP 在提交后运行，不占用业务锁。

## 5. 权限与通知

原 owner 管理执行；有效协调人和被分派人员只读执行投影。普通参与人仅能看本节点资料及所需共享运输字段，不能读其他节点备注/附件、客户确认私人联系信息或成交金额。原报价及完整 Case 服务继续拒绝非 owner；配置页明确报价仍由 owner 处理。

所有执行服务入口验证实际身份和当前参与关系，禁止 owner 身份替换。账号停用、改派、撤销立即影响 API 和引用读取。这里只支持授权证据引用，不新增任意文件访问能力；外部 URL 引用不由服务器抓取，不嵌入登录密钥。

现有 `production-fcl.ts` 的 `receiverIsActive` 对非公共 receiver 直接返回 true，依赖当前 Portal session，**不能**当后台人员目录使用。补一个窄的个人账号校验 port，通过现有 IdP 服务端权威查询分派对象与 worker 目标；只返回实际 user ID、显示名、已验证邮箱和 active 状态。生产未提供可验证目录时，跨人分派及后台发信必须返回 unavailable，不以任意输入 ID 或过期登录快照当活动账号。fixture 使用固定合成账号目录，与生产验收分开。

通知 v2 固定十行：intake、quote、customer_followup、booking、pickup、export_customs、shipping_documents、canada_customs、devanning_storage、delivery。每行含真实个人负责人、To、最多十个 Cc、启用开关、固定受众、固定模板版本、有限字段白名单。邮箱不等于人员账号。intake 的公共受理权威保持原配置；quote/followup 不伪称支持任意报价转派。

旧 v1 读取保持 v1 投影；v1 enabled/recipient/cc 仅迁移 intake 行，其他行为空。已有 v2 后的 v1 保存只更新 intake，不覆盖其他行，并共用版本冲突检查。读取不写库。默认配置在成交时快照；显式应用新配置仅限本单未启动节点，先预览差异及 digest。

普通保存、浏览、刷新不产生通知。启动、明确交接、退回、改派、异常、授权提及和完结使用真实服务器事件 ID、节点周期、受众去重。同次完成与下一待办提醒合成一条事件。各邮件受众分别入队，不能把外部联系人加入内部正文的 Cc。

worker 不持用户会话，用记录定位个人 scope，检查账号、当前分派和受众再 claim/发送；多 worker CAS claim，带 lease。状态 pending、sending、smtp_accepted、failed、unknown、cancelled。timeout、丢失确认、部分拒收、sending lease 过期均为 unknown，不自动重发；明确失败可人工重试；unknown 需有权人员确认未发送并写原因才能重试。外发前再检查旧分派/过期事件并取消。

内部/外部模板独立固定投影。外部不含内部备注、附件、价格、利润、客户恢复凭证或内部详情令牌；内部链接只到需要重新登录的 Console。本轮维持纯文本 To/Cc，不增加 HTML 或附件能力。From 仍由受保护 SMTP 配置决定。

## 6. 迁移、兼容与回滚

CaseStore execution schema v3 需显式 fresh fixture 或 exclusive_verified 离线升级；reopen 不迁移，旧 v2 reader 拒绝 v3。新增两张表，不回填旧 handoff，不改原询价/报价/文档数据。生产 composition 只打开已经升级的库。

迁移前必须停旧 writer，备份 Case/Native/Document SQLite 与 WAL，校验 exclusive lock、原 schema、业务记录数和完整性。fresh_fixture 只能用于无业务数据的临时库。迁移后核对旧记录摘要不变、两表布局/约束及新旧 reader 行为。

上线前回滚通过完整备份恢复配套旧程序；产生执行数据后不得降 user_version 或删表，须停写导出并核实新事实后安排恢复。此任务只在可丢弃 fixture 验证迁移，不运行生产迁移。

## 7. 验证与接受请求

先失败测试再实现：主链路及指定引用门禁；多 key 与多连接重复启动；rollback 与 post-COMMIT 重放；服务映射、零价和仅目的港；独立版本与价格过期；跨用户/节点撤权及敏感字段；配置继承/v1兼容；SMTP timeout/partial/lease/restart；Schema 和旧报价/审批/PDF/handoff 回归。

完成后实际运行相关 console/access-gateway/quote-documents/e2e、typecheck、lint、schema、agent standards、构建，以及桌面/手机本地浏览器。命令、输出及截图记入 runbook。真实 SMTP、收件箱投递和生产上线单独标记待验证。

本文及配套 proposal Schema 已获用户明确接受，可由本任务协调基线和上述相关目录，推广为运行合同并按三阶段实施；不包含发布或外发。

实施与验证记录见 [三个阶段本地验收 runbook](../runbooks/2026-09-23-fcl-execution-v2-acceptance.md)。运行合同包含固定阶段列表、分页历史、询报价通知核实和节点通知动作；未扩大公共 API Key 或 MCP 权限。
