# 固定 FCL 受理人的个人船期查询

状态：用户在本任务明确授权“允许个人直接调用”（2026-09-21）；按该授权实施窄权限扩展。

## 原因与范围

整柜报价工作台需要复用现有船期查询，固定受理人采用个人身份，不创建企业。原有 schedule live 服务只接受企业成员。

允许既有 FCL 固定受理人调用现有 carriers / locations / search；每次请求核对服务端固定身份、邮箱验证和当前身份服务有效状态。匿名、其他个人、失效身份及普通平台管理员不因此获权。MCP/API Key 的企业权限不变。

## 兼容性与权限

HTTP 路径、旧/新输入输出 JSON 完全一致，例如查询仍为 `{ "carrier": "COSCO", "origin": { "text": "Shanghai", "country_code": "CN", "carrier_location_id": null }, "destination": { "text": "Vancouver", "country_code": "CA", "carrier_location_id": null }, "from": "2026-10-01", "until": "2026-10-28", "routing": "any" }`。success / needs_input / manual_review / blocked / unavailable 保持原含义。

新增可选服务端授权端口和部署开关 `PORTAL_FCL_SCHEDULE_LIVE_ENABLED=true`；默认关闭。开关要求既有 FCL 功能及受理人权威服务。个人查询使用从受理人 ID 派生的独立 evidence/audit scope，不创建企业或修改任何租户数据。按用户后续要求“先以 COSCO 的船期为准”，个人 scope 固定限制为 COSCO，并与部署船公司白名单取交集；受控网络出口保持不变。企业和 MCP 船公司权限不受影响。

## 迁移、验证、回滚

无数据迁移、无 schema 或 API JSON 变更。部署时显式启用个人开关，并按业务需要配置该个人 scope 的船公司白名单。运行 `npx vitest run tests/maritime/schedule-live tests/console tests/access-gateway/portal-fcl-production-composition.test.ts`，验证本人成功、他人/未验证/撤销失败、开关关闭失败、企业回归及审计隔离。关闭该开关即可撤销个人访问；不删除历史审计和证据。
