# FreightClaw 新服务接入指南

适用范围：已有业务系统接入统一工作台、开放 API 和 MCP。本文的接入方式需要实现和验证适配器，不代表已经完成无代码热插拔。模块平台另遵循 MODULE_DEVELOPMENT_STANDARD.md。

## 接入后用户怎样操作

企业管理员邀请成员；普通业务成员直接在线使用企业已开放的服务。开发者或应用负责人在一张表单申请所需服务，系统复用现有应用；平台审核并开通后，负责人领取一把统一 API Key。REST 接口直接使用同一把 Key，MCP 使用这把 Key 兑换短期 Token。人员在工作台使用同一业务服务，不跳到原业务站点。暂停成员、应用、授权、Key 或企业后，下一次操作重新检查当前权限。

企业微信登录可以作为以后增加的身份入口。本轮主登录采用邮箱与密码，目录身份由现有 Authentik 管理。企业微信机器人凭据不能替代企业网页登录应用；扫码来源以后必须绑定经过验证的企业 ID 与成员 ID。

## 第一步：确定由谁负责数据

接入前填写下表，并由业务负责人确认：

| 项目 | 必须写清楚的内容 |
| --- | --- |
| 业务系统 | 系统名称、负责人、测试与正式地址 |
| 权威数据 | 哪个系统负责价格、税率、规则、业务记录和版本 |
| 操作 | 分别列出查询、试算、保存、审批、导出和其他动作；每项独立权限 |
| 人员与程序 | 哪些动作允许应用调用，哪些必须由具备角色的人员确认 |
| 租户 | 上游如何绑定 tenant、application、service caller 和原始人员 |
| 正式数据 | 就绪检查、版本、来源、有效日期、测试数据标记和不可用原因 |
| 业务完成 | 返回哪些对象、在哪里读回、什么状态表示仍待处理 |
| 运营责任 | 失败由谁处理、如何重试、数据多久更新、服务如何回滚 |

已有系统继续保存自己的业务记录。平台只保存接入身份、授权、操作审计和必要的上游引用；不复制一套可改写的价格或税率库。

## 第二步：提交窄接口合同

每个动作提供 OpenAPI、JSON Schema 与脱敏样例。使用明确版本；未知输入字段拒绝；增加字段时注明兼容规则。HTTP 200 只表示请求有响应，业务必须另有结果状态。

平台使用五种结果：success、needs_input、manual_review、blocked、unavailable。缺资料要求补齐；需要人工判断就进入复核；未配置或正式数据未就绪时返回不可用。下游 ready=false 或 testData=true 不能被平台改成正式成功。

金额使用十进制字符串和三位币种；重量、尺寸、数量和体积携带单位。返回来源引用、规则/数据版本、有效期和计算轨迹。不要通过AI补价格、税率或缺失收费项。

写操作必须有独立端点和权限，以及幂等键、必要的预览引用/预期版本/人员确认。上游完成事务后，平台重新读取目标对象，核对版本和摘要；只有读回通过才能显示完成。网络中断或读回未确认时，保留原幂等键重试，不创建第二笔业务。

## 第三步：配置身份与服务连接

浏览器登录会话、应用长期Key、短期调用Token和上游连接密钥彼此分开。上游连接只能由服务器配置，浏览器不能传入任意 URL、tenant 或凭据。

- 人员：受验证身份 + 当前企业成员关系 + 操作角色。
- 应用：当前 tenant/client/application + 精确授权 + 已确认交付且未撤销的 Key。
- 上游：服务端 Bearer 连接凭据 + 短期 RS256 委托，带 actor_type、sub、tenant_id、service_caller_id、application_id、request_id、单一 scope、时间和 jti。
- 不转发浏览器 Cookie；不把上游长期密钥返回前端；公钥与私钥分开，轮换时保留旧公钥至已发 Token 过期。

当前配置入口是 PORTAL_BUSINESS_CONFIG_FILE。配置文件只引用服务器上的密钥文件；不同企业显式绑定，不能使用默认租户回退。新增服务通过自己的配置校验器和客户端接入，不能借现有服务名称偷接新语义。

## 第四步：实现适配与界面

参考 services/access-gateway/portal/business 下的 customs-client、tax-client、quote-client 和 quote-record-client。为新服务建立独立客户端、严格响应校验、受控超时、禁止自动跳转、允许主机检查和错误映射。业务工作台与程序 API 共享相同领域服务，分别检查人员和应用权限。

界面至少包含：输入校验、执行中、缺资料、人工复核、不可用、结果来源、历史读回、重试与恢复。编辑输入后使旧预览失效。确认写入前显示目标和后果；一次性凭据确认保存后立即从页面清除。

新增程序权限需同步统一申请表、审核摘要、Grant、Token scope、服务目录、操作手册和公开 Agent 接入文档。新增服务复用已有应用和统一 Key，不另建登录或要求再领一套凭证。当前已签发 Key 不自动扩大权限：业务操作按其 scope 签发；T0 使用显式 current_grant 模式，旧业务 Key 由负责人明确启用。新增业务服务后，负责人在原 Key 列表选择“更新服务”，明确轮换为包含当前授权的新 Key 并替换调用端保存值，旧 Key 立即撤销；普通轮换不隐式增权。不能只增加一个可点击按钮。报价人工复核和PDF属于独立人员操作，不能因拥有查询Key就自动取得审批/导出权限。

## 第五步：验证并留下证据

先用隔离的 HTTP/仓库验证这些情况：正常流程、跨企业、普通成员越权、自审、旧版本、重复幂等、超时、畸形结果、源数据未发布、权限在调用期间变化、保存成功但读回失败、同一请求重试、Key轮换和撤销。

正式环境验证独立执行：读取实际release/build身份、数据库迁移版本、实际来源版本与有效期，使用指定验收记录执行允许的业务动作并读回，重启后再验证持久化。API、桌面和手机界面都要走实际流程。记录 passed/blocked/unverified，不把本地fixture、截图或健康检查当作正式业务证明。

每次变更前备份；保留旧服务和反向代理配置；验证备份可读取并演练恢复。发布先启动候选实例，通过检查后切换对应路由。失败时恢复上一健康实例，保留新审计和未确认业务记录，不使用会删除业务数据的降级迁移。

## 第六步：交付接入包

接入包包含：业务负责人、接口合同/Schema、错误码、权限矩阵、配置模板、密钥轮换、测试命令、验收证据、部署步骤、回滚步骤和示例客户端。示例只放占位符，不放真实地址、客户材料、密码或Token。

开发入口：docs/agent/index.json。开发时运行 npm run validate:agent-standards 与 npm run build:agent-pack；运行时读取生成的 dist/standards/agent-standard-pack.json。共享 MCP 合同变更先走 RFC；对接新服务不等于直接修改静态工具注册表。

## 统一 Key 与 MCP 运行适配

统一 Key 由 Portal 管理；长期 Key 校验器不能移入 MCP Runtime。`POST /access/v2/application/token/exchange` 仅为已授权的三个 T0 工具签发 MCP audience 短期 JWT。Runtime 的每次认证调用通过 `POST /access/v2/application/token/authority` 核对当前 Key、模式、授权、应用、成员和租户状态。换票端点见公开 OpenAPI；内部 authority 的请求/响应见 `schemas/access-gateway/application-authority-*.schema.json` 和已接受 RFC `2026-09-06-unified-application-key-v1`。内部 authority 不列为客户调用操作。

Runtime 需要设置 `MCP_APPLICATION_AUTHORITY_URL=https://www.freightclaw.net/access/v2/application/token/authority` 和 `MCP_APPLICATION_AUTHORITY_ALLOWED_HOSTS=www.freightclaw.net`。反向代理为 authority 使用只读调用限流，不应套用低频 Key 换票限流。缺少 authority 或返回畸形/超时结果时拒绝 bkey 令牌。新业务 REST 能力不会自动注册为 MCP 工具；扩展 MCP 合同必须另走平台 RFC。
