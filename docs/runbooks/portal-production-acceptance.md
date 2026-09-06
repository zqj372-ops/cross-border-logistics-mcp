# Portal 生产登录与运行验收

最新状态（2026-09-06）：[市场、手册与统一 Key 生产交付](../product/2026-09-05-mcp-product-redesign/17-market-manual-production-delivery.md)。Portal 与 Runtime 已发布 `a42849576004`，聚仓科技所有者和原有 Key 已读回。下面保留 2026-09-05 登录修复与企业准入的历史检查，不能把其中的 pending 邀请或旧镜像当作当前状态。

验收日期：2026-09-05。入口为 <https://www.freightclaw.net/console/>；原域名根路径的其他业务应用不属于本次门户切换。

## 已实际完成

- QQ SMTP 显式认证成功后才写入配置。找回邮件任务完成，重试为 0；真实账号完成密码找回和邮箱验证。
- 修复 OIDC issuer 尾斜杠丢失问题。配置、discovery 与 ID Token 的 issuer 精确匹配；签名、audience、nonce、PKCE、state 及邮箱验证检查仍执行。
- 真实 Edge 浏览器通过新发起的 OIDC 登录进入正式工作台，角色为平台运维管理员；刷新页面后会话仍有效，企业准入页正常读回。
- 浏览器过期或失效的登录事务通过固定中文提示回到登录入口；API 仍返回结构化错误，非法 Host 与传输请求不会变成跳转。
- 专用 FreightClaw 身份页品牌、简体中文及国内邮箱输入已应用。品牌配置只作用于 `www.freightclaw.net`，没有替换其他应用的身份设置。

## 发布身份

该轮生产镜像：`freightclaw-portal:31235bfaba58`，包含登录修复、管理员职责提示与前端资源版本标识。

源文件清单 build ID：`31235bfaba58ab7a6ea462041ca49c4a1904d746b662188a6a557c50a831e99a`。镜像 manifest list SHA-256：`ce42281c14f4f3f789ebd205fc95c3deb7efa68abd468d5f3e3bdc2696a81b85`。

前一镜像 `freightclaw-portal:c72e82f18093` 与配置备份 `portal-promotion-20260905T152333Z` 已保留；登录修复最初在 `4d6f767b0c5e` 完成真实验证。

源清单来自工作区，基线 HEAD 为 `34e1e9567440e768eb9e7a1b6cfe8c2ded70baed`；工作区包含未提交改动，HEAD 不单独代表镜像内容。候选包逐文件记录 SHA-256，上传后再次核对压缩包 SHA-256，再在生产 Node 22.13 环境构建和检查类型。

本次运行检查：Portal 数据库、会话数据库、业务授权数据库、身份服务及业务配置均通过。`ready=true` 只证明这些运行依赖，不证明企业授权、当前价格或正式关税数据已经完成验收。

## 已执行的验证

| 检查 | 实际结果 |
| --- | --- |
| `npx vitest run tests/access-gateway/portal-production-identity.test.ts tests/access-gateway/portal-session.test.ts tests/access-gateway/portal-http.test.ts tests/access-gateway/portal-http-auth-recovery.test.ts` | 4 个文件、13 项通过 |
| `npm test`，登录修复后全量重跑 | 159 个文件、1616 项通过；1 个文件、1 项条件式 PostgreSQL 集成测试跳过 |
| `npm run lint` / `npm run typecheck` / `git diff --check` | 通过 |
| `npm run validate:agent-standards` / `npm run build:agent-pack` | 13 项标准、5 个 profile、4 个模块、5 个资源验证通过；生成 13 项标准包 |
| `npm run build`，本地及生产候选镜像 | 通过；T0 模块制品验证通过 |
| `python3 deploy/scripts/verify-public-python-api.py` | readyz 与 OpenAPI 200 JSON；无认证换票与工具调用 403 JSON，4 项通过 |
| 登录恢复 Chromium 回归 | 已知错误正常显示；未知类别和对象原型属性均不显示；无页面错误 |
| 平台首页 Chromium 回归 | 1440、390 宽度无横向溢出；企业准入 CTA 正确；普通企业成员原流程保留 |
| 后续构建缓存、生产入口、fixture、品牌及 Admin 制品回归 | 5 个文件、12 项通过；随后静态检查、类型检查及差异检查通过 |

全量测试第一次运行遇到一个临时端口占用，目标文件单独重跑 2 项通过；随后全量重跑取得表中结果。保留了失败及通过日志，不将环境冲突隐藏为一次全量通过。

实际发布核验发现固定脚本 URL 在 300 秒缓存期内可能仍显示旧首页。已在最终前端打包后，按脚本和样式内容的 SHA-256 分别生成版本参数；只改写构建 HTML，保留源入口、路由与 CSP。正式浏览器已读回脚本版本 `718677ccea0da0aa`、样式版本 `83b5175f01602b1e` 和新“完善企业准入”任务；五项业务服务显示“开通前核对企业连接”，三项基础服务显示“支持接入”。最终发布重启后仍保持原管理员登录。验收同时核对了浏览器资源 URL、新文案与公网 readyz build ID。

## 持久化与回滚

Portal 使用三个独立 SQLite 生产存储；现有租户与 Key authority 使用 PostgreSQL，T0 密钥继续使用 OCI。`deploy/portal/backup-portal-state.py` 暂停 Portal 写入，建立三个数据库与私有配置的一致快照，在隔离数据库实际恢复并验证完整性与外键，再恢复 Portal。

真实人员登录后的快照 `portal-state-20260905T151444Z` 已完成三个数据库的隔离恢复，完整性与外键检查通过。其对应镜像为 `freightclaw-portal:c72e82f18093`；备份完成后服务恢复，原浏览器会话仍有效。

`deploy/portal/promote-portal.py` 先备份私有环境与旧镜像配置，再替换指定 Portal 镜像；只有运行检查及 build ID 匹配才报告成功。失败则恢复旧配置与旧镜像。旧镜像与生产状态保留，不执行破坏性降级迁移。

## 真实企业准入历史记录（已由最新交付更新）

用户提供的“聚仓科技”已通过正式平台管理员界面创建，并独立读回 Portal 企业为 active、Gateway 租户为 active。实际组织为 `org_bcdb6b349ca944b1c421a42a`，租户为 `tenant_d7f0f731a0a851940fdc12c2`。负责人邮箱账号已唯一存在、启用且完成邮箱验证；邀请 `inv_9d09a3a85d3cfcc15a2fb25d` 仍为 pending，有效期至 `2026-09-12T15:31:24.300Z`。本次读回时成员数和有效所有者数均为 0，不能将注册成功视为已加入企业。

Portal 业务配置、Quote 固定租户和 ClearDDP 唯一启用的 M2M 连接均已绑定实际租户。变更保留原操作范围及来源镜像；备份为 Oracle `business-rebind-20260905T153755Z` 和关务 `20260905T153807Z-enterprise-rebind`。重启后 Portal 五项运行检查全通过；真实 HTTPS 报价只读预览返回 200 success，关务查询返回 503 data_not_ready，且两次请求标识均匹配。

仍需负责人登录领取邀请，再完成应用创建、按需申请、审核开通、应用负责人保存 Key、换取短期 Token、实际调用及撤销验证。当前备份 `portal-state-20260905T151444Z` 早于企业开户，不能替代开户后的新快照。

报价服务的正式来源连接与关务候选数据各自单独验收；上游 `ready=false`、未发布数据和人工复核结果保持原业务状态。此处没有客户报价保存、业务审批、正式 PDF、客户发送、订舱或支付的完成声明。

相关资料：[身份适配](portal-identity.md)、[国内邮箱登录](portal-login-cn.md)、[生产交付台账](../product/2026-09-05-mcp-product-redesign/15-implementation-delivery.md)、[新服务接入指南](../integrations/new-service-onboarding.md)。
