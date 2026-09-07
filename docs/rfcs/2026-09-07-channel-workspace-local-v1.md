# 渠道配置与 CLI 人员会话：本地实现合同

状态：本地开发实现；生产接入与共享业务权威迁移仍待专项验收。用户已确认原生后台、配置空白开始、前后台打通、所有功能支持 CLI 的产品方向。

## 原因与范围

现有管理界面以接入授权为主，缺少原生渠道配置；查询 CLI 使用应用 Key，无法安全代替人员身份。新增独立渠道元信息资源和具名人员 CLI。没有变更 MCP 工具、价格/关税算法、统一包络或旧 Key 的权限，也没有导入旧业务配置。

## API 和版本

路径前缀 `/console/api/v1`。渠道成功响应使用 `{schema_version:"portal-channels@2026-09-07.v1",status:"success",data:...,reason_codes:[]}`。输入与数据采用 `schemas/access-gateway/portal-channels-*.schema.json` Draft 2020-12 闭合对象；日期先做格式校验，再在服务端验证开始不晚于结束、发布版本未过期。

| API | 行为 |
| --- | --- |
| GET /admin/channels | 当前范围列表，最多 200 条，返回 can_manage |
| POST /admin/channels | 创建空白填写的渠道草稿 |
| GET /admin/channels/:id | 草稿、版本与 active_release |
| POST /admin/channels/:id/save | expected_version + 完整 input；编号固定 |
| GET /admin/channels/:id/preview | 当前草稿预览；仅支持可选 release_id 查询参数用于回退预览 |
| POST /admin/channels/:id/publish | expected_version + preview_hash，发布不可变快照 |
| POST /admin/channels/:id/disable | expected_version，清空当前发布指针 |
| GET /admin/channels/:id/history | 最近 200 条发布与脱敏操作摘要 |
| POST /admin/channels/:id/rollback | expected_version + preview_hash + release_id，切换当前发布指针 |

旧 JSON：不存在该资源。新建 input 示例：

```json
{"code":"CA-SEA","name":"合成渠道","warehouse":"合成仓","origin_country":"CN","destination_country":"CA","service":"ocean_fcl","currency":"CAD","valid_from":"2026-09-01","valid_until":"2027-12-31"}
```

成功 data 携带 `channel_id/version/input/active_release/updated_at/ready_for_quotes:false`。没有运价、Zone 或计费规则，不得用于正式报价。保存只改变草稿；发布和回退必须使用当前服务端预览摘要。并发改动返回版本冲突。

## 权限、持久化与迁移

企业数据按当前有效成员及企业状态实时隔离，owner/admin 可写，其余有效成员只读；平台 operator 的无企业工作区单独分区。不得接受客户端 tenant/actor 覆盖。写入要求会话、CSRF、16–128 位幂等键和版本检查；同键不同内容拒绝。SQLite 事务保存记录、审计和幂等结果，提交后读回。每个范围最多 200 条，每个渠道最多 1000 个对象版本；达到上限显式拒绝。

本地 fixture 启动时创建独立 `business-channels.sqlite`，application id 为 `freightclaw-business-channels`，user_version=1。空白初始化，不迁移原服务配置。超前版本拒绝启动；该文件不与询价、身份库混用。

## CLI 人员登录

仅 fixtures 模式启用，生产 HTTP 返回 `cli_auth_unavailable`。`POST /cli-auth/start {}` 返回设备密钥与 8 位确认码（5 分钟）；客户端把密钥写入私有文件，仅输出确认码和网页登录链接。网页登录后调用 `POST /cli-auth/approve {user_code}`，要求有效人员会话与 CSRF；可用 `/inspect` 读取状态。`POST /cli-auth/poll {device_secret}` 在确认后一次性消费，重新检查原网页登录仍有效，再签发独立 CLI 会话；不返回原浏览器 Cookie。

所有入口有请求体长度、方法、Origin/Host 边界；start 每地址每 10 分钟最多 10 次，进程最多 1000 个未过期请求。待确认状态只驻留进程，重启失效。CLI 会话沿用会话存储及权限检查，文件绑定 origin，响应不输出凭证。退出只撤销 CLI 会话。该机制不作为生产多实例登录或无人值守任务的完成交付。

## CLI 兼容性与范围

旧九条 Key 查询命令不变。新增 `workspace` 下 18 个具名管理操作，登录/退出/目录/渠道输入 Schema 另列；完整命令见 `apps/console/workspace-cli.md`。`cases` 复用已有询价 API，客户永远不读取内部备注。所有业务写入显式幂等键；不提供万能 HTTP 入口，不自动重试或外发邮件。

## 回归与回滚

```sh
npm run typecheck
npm run lint
npm run validate:schemas
npm run validate:agent-standards
npm run build:agent-pack
npm run build
npm run build:cli
npx vitest run tests/access-gateway tests/e2e/freightclaw-cli.test.ts tests/e2e/freightclaw-cli-package.test.ts --maxWorkers=2
```

隔离 fixture 浏览器验收脚本为 `tests/e2e/portal-browser/channels-cli-flow.mjs`；须使用新建的测试数据库目录，因为空白初始状态属于验收条件。覆盖网页创建/发布、CLI 修改发布、网页回退/CLI 读回、草稿未保存、企业越权、客户内部备注过滤及独立退出。

回滚停止本地预览进程，切回上一提交并以原询价库启动；保留新渠道库备份，旧版本不读取它，不降级改写。生产启用前需完成受控持久化/备份恢复、分布式授权请求及限流、真实身份验收、完整 API Schema/运维发布合同，并单独验证来源数据与运价；本 RFC 不授权生产迁移。
