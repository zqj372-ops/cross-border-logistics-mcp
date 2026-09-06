# MCP 功能补齐与发布操作

本轮代码基线为 main `68bfa352574b3ccbc9f21ecccec132677011436b`。本说明覆盖已接受的 [功能补齐 RFC](../rfcs/2026-09-06-capability-completion-v1.md)。企业微信不需要。本轮只执行隔离验证，不包含生产部署、税则发布、价格批准或供应商账号操作。

## 功能与实际边界

| 功能 | 当前实现 | 运行条件 |
| --- | --- | --- |
| 五项业务 MCP | 关务查询、税费估算、尾程报价、资料提取、Freightcom；与现有 REST 共用来源适配器 | 显式 `business-v1`、当前应用授权、签名发布、私有 Provider |
| 调用记录 | 当前企业/应用/人员范围、操作/结果/时间筛选、分页、数量与平均耗时 | Portal 与 Runtime 使用同一调用记录库 |
| 关务历史 | 来源列表、单条快照、身份/记录校验、恢复输入表单 | 来源实现新历史合同后显式配置；当前来源未实现，返回 unavailable |
| 模块切换 | Ed25519 签名、制品及 SBOM 摘要、出站域名白名单、挂载验证、持久代次、在途固定、排空、回滚、MCP 目录通知 | 运维发布私有 Provider；不安装或导入任意代码 |
| Portal 多实例 | PostgreSQL 共享账户、授权、凭证、会话、幂等及调用记录；断连重建连接 | 所有副本使用同一权威库、相同签名及 pepper 配置 |
| 原有缺陷 | 实际响应字节限制、最近使用时间、T0 REST 经 Runtime 审计、在线应用权威 readiness | 正式 T0 REST 不在 Portal 内运行领域计算 |

旧 `t0-v1` 的工具、JWT、Agent profile 和权限保持三项精确白名单。新 `business-runtime-caller` 只向明确的业务 MCP 身份提供描述性上下文。读取标准不能获得业务权限。原报价保存、复核和 PDF 流程继续使用人员授权。

## 客户接入

用已保存的统一 Key 请求 `POST /access/v2/application/mcp/token/exchange`，认证为 `Authorization: ApiKey <KEY>`：

```json
{"schema_version":"application-mcp-exchange@2026-09-06.v1","requested_tool_names":["cargo.calculate","customs.query"]}
```

返回的 JWT 最长 300 秒。客户端通过 Streamable HTTP 连接 `/mcp`，使用 `Authorization: Bearer <access_token>`，到期重新兑换。每个 HTTP 请求重新核对租户、应用、Key 和当前授权。长 Key 不转发到 Runtime Provider；私有 Provider 同时检查短 JWT 与独立工作负载密钥。

服务端工具列表包含“当前 Key 获批”与“当前发布启用”两者的交集。收到 `notifications/tools/list_changed` 后重新列工具。不存在的或被停用的业务不会通过直接调用私有路由绕过发布控制。

## 调用记录与来源历史

`GET /console/api/v1/calls` 使用人员会话。客户端只能提供 application_id、operation、status、from、to、cursor、limit；tenant_id 由服务器确定。企业所有者/管理员可查看本企业人员记录，其他角色仅自身人员记录及其有权应用。应用筛选不混入人员调用。

默认24小时，最大30天、每企业10000条、每页最多100条。不存请求、响应、客户地址、金额明细或凭证。统计仅描述保留窗口内记录，不是账单或永久用量。T0 REST 与业务 MCP 的记录来自 Runtime 持久审计；业务 REST 与人员业务来自 Portal。两边必须配置同一库，不能只接通一边便宣称记录完整。

关务来源新增合同位于 `schemas/access-gateway/customs-history-*.schema.json`。来源路由为 `POST /api/m2m/v2/history/list` 与 `/get`，请求包含 `schema_version=customs-history-request@2026-09-06.v1` 和对应请求 Schema 字段；单独委派 scope 为 `customs.history.read`。响应必须绑定当前 request_id、tenant_id、actor_ref、application_id，并返回来源签发的 record_ref、历史版本及闭合的原快照。

Portal 中对相应企业连接设置 `customsHistoryEnabled: true` 才会创建该客户端。未配置、404、来源身份或记录不匹配、超限、异常快照均不会返回恢复成功。现有 RiskCustoms 源码没有这两个端点；本仓库已完成适配与页面，来源实现仍为**待适配验证**。不得用本地复制关税结果替代来源历史。恢复按钮仅填回表单，用户核对日期后重新提交。

## PostgreSQL 迁移与多实例

1. 使用已配置的 Access Gateway PostgreSQL schema，备份并停止旧 Portal 写入。三个 SQLite 源文件及其目录必须为私有本地文件。Runtime 继续使用自己的持久库和实例会话绑定，不在本步骤扩为无亲和的多实例 MCP。
2. 构建后执行：

```sh
node dist/services/access-gateway/portal/postgres-migration.mjs \
  --offline-source /absolute/stopped/portal-state --writers-stopped
```

新安装无历史状态时明确使用 `--empty`。连接设置沿用 `ACCESS_GATEWAY_STORE_BACKEND=postgresql` 和 `ACCESS_GATEWAY_POSTGRES_*`；密码、CA 只用私有文件路径。启动程序不会自动初始化缺失的共享表。

3. 迁移先检查数据库身份及版本，保留账户、授权、撤销 Key、摘要、会话和幂等结果；逐项核对写后的账户/授权、幂等、会话和调用记录，以及来源未变化后提交。目标非空或迁移指纹不匹配时拒绝覆盖。成功只输出指纹和状态，不输出凭证。保留源库及备份。
4. 设置 `PORTAL_STORE_BACKEND=postgresql`，先启一个副本核对，再使用 `compose.yml` 加 `compose.shared.yml` 扩为两个 Portal 副本。需要支持 `!reset` 的 Docker Compose；入口改用 `portal-shared-locations.nginx`（替换原 locations include），通过 `portal` 服务名与 Docker DNS 每10秒更新副本地址；该示例仅适用于同一 Docker 网络。
5. 每个副本使用同一发行配置、同一 Gateway JWT 和 Business JWT、同一 pepper 版本与历史。密钥轮换必须作为协调发布执行。JWT 历史文件仍按现有配置使用可写私有状态路径，不把不同副本生成的材料混在一起。
6. Runtime 设置 `MCP_CALL_LOG_BACKEND=postgresql`，配置相同 schema 的调用记录表。运行角色只需调用记录表访问权，不需要 Portal 授权表的修改权。迁移角色先建表。

兼容现有同步 Portal 事务接口的 PostgreSQL 连接在独立 Worker 中运行；事务回调不可等待 I/O。每次读取都从共享库取得当前状态，没有进程内授权缓存。同步桥的单次控制面状态上限为8 MiB，连接/语句/RPC超时有界；超时返回不可用，连接中断后会重建 Worker。此模式已验证并发与恢复，但不是未经测量的吞吐量或 SLA 承诺。调用记录使用独立异步 PostgreSQL 客户端。

共享模式开始接受新写入后，禁止将流量切回旧 SQLite 副本。回滚镜像必须继续读取当前共享权威；如需更换存储，停写后另做带完整撤销状态的迁移。

## 签名模块发布

示例环境在 `deploy/portal/capabilities.env.example`，Runtime overlay 在 `compose.business-runtime.yml`。一个发布目录包含 provider.json、sbom.json、payload.json、release.json、trusted-signers.json。发布目录只读挂载；工作负载密钥独立挂载；激活日志在 Runtime 自己的私有持久目录。

`provider.json` 只描述受控 HTTP Provider，不包含可执行代码：

```json
{"schema_version":"private-provider@2026-09-06.v1","base_url":"https://provider-version.example.invalid/","contract_version":"business-mcp-result@2026-09-06.v1","tools":["customs.query","customs.tax.estimate","quote.zone_preview","quote.ai_extract_preview","quote.freightcom_ltl.preview"]}
```

Provider 必须通过 TLS 和白名单限制，健康路由为 `/access/v2/application/mcp/provider/health`，需要工作负载密钥。为不同实现版本使用独立部署和明确的版本路由；旧版本在排空完成前继续存在。签名证明描述文件、SBOM 和所声明源码身份获批，不是远端进程镜像或业务数据的独立证明，发布前仍需核对目标实际部署。

payload 的完整闭合 Schema 是 `provider-release.schema.json`：版本、递增 revision、enabled、两个文件的 SHA-256 摘要、source_commit、签发/到期时间。有效期最多31天；签名使用 schema 顺序的紧凑 payload JSON 字节。`trusted-signers.json` 为 key_id 到 Ed25519 公钥 PEM 的对象；私钥只在发布机。

```sh
node dist/src/logistics_mcp/module-runtime/provider-release-cli.mjs \
  --payload /absolute/release/payload.json \
  --key-file /private/release-signing-key.pem \
  --key-id reviewed-release-key \
  --allowed-host provider-version.example.invalid \
  --output /absolute/release/release.json
```

签名工具检查文件权限、摘要、SBOM、出站主机、有效期和递增序号，并原子写入后读回。Runtime 每3秒检查发布文件：先验签与挂载/健康验证，再持久写入激活序号并切换。无效候选保留原有效版本。停用使用新 revision 的 `enabled=false`；回滚使用更大 revision 指向原获批制品。旧序号不能重放。

切换后新调用进入新代，旧代在途调用继续完成；默认30秒排空期限后发出取消。即使 Provider 忽略取消，也保留其资源到实际结束，并限制未排空代数，防止释放在途资源或无限积累。关闭和清理幂等。当前批准的五项只读业务按 business-api 与 freightcom-ltl 模块登记；其他模块需要对应合同与受控客户端，不提供万能安装或业务写入口。

## 验证

构建、全量测试、类型、lint、Schema、Agent Pack 和适配器验证结果记录在 [当前状态](../product/2026-09-05-mcp-product-redesign/18-current-status-and-gaps.md)。PostgreSQL 测试必须使用隔离数据库；`PORTAL_TEST_POSTGRES_PORT` 只指向本地 `capability_fixture` 库/用户。新增测试覆盖跨实例可见、会话消费、退出竞争、并发更新、来源保留迁移、断连重建、调用日志隔离、签名与排空、生产 MCP 调用和目录通知。

真实税则发布、当前报价批准、Freightcom 企业凭证、实际客户 Key 和真实来源历史仍需来源负责人及具体环境验收。本轮本地测试不关闭这些业务条件。
