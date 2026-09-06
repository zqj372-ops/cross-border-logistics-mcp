# Wind 风格市场、手册与统一 Key 生产交付

交付日期：2026-09-06（北京时间）。本记录替代前期台账中“邀请仍待领取”“需要两类 Key”“UI 仍为侧栏工作台”的状态。

## 已上线的产品

- [首页](https://www.freightclaw.net/console/#home)：轻顶栏、业务标题、可复制给 Agent 的接入指令。
- [市场](https://www.freightclaw.net/console/#market)：8 项已实现的能力目录，按业务分类搜索，准确区分 3 项 MCP/REST 与 5 项业务 REST；详情提供用途、输入输出、实际接口及在线使用入口。
- [操作手册](https://www.freightclaw.net/console/#guide)：快速上手、账号与开通、Key、REST、MCP、结果与常见问题、新服务接入，共七章。公开 [Agent 指南](https://www.freightclaw.net/console/skill.md) 与实际 [OpenAPI](https://www.freightclaw.net/console/openapi.json) 已上线。
- 个人中心：普通业务成员进入工作台；开发与管理成员管理统一 Key、服务、成员和操作记录。viewer 深链和伪造表单不会发出申请或发钥匙请求。
- 申请只需一张表单，复用原应用；内部按当前合同分别审核。创建一把 Key 后，用户确认保存即自动验证有权限的只读样例。旧高级入口保持兼容，确认保存不会新增额外源查询。
- 后续新增服务复用原账号和应用；明确“更新服务”会轮换为当前有效业务范围并撤销旧 Key，用户更新调用程序即可。普通轮换不隐式增加权限。

视觉与信息结构参考用户提供的 [Wind Alice Market](https://aifinmarket.wind.com.cn/#/home)，内容与协议按 FreightClaw 最新代码编写。没有虚构计费、余额、Skill 商品或未注册的 MCP 工具。

## 真实账号与原 Key

真实企业“聚仓科技”为 active，应用 `app_01f176a5e63be336c89faa62` 为 active，有效所有者 1 名。企业所有者的既有邮箱登录会话已通过原身份服务恢复，正式页面能读取企业和 Key。

原 Key 尾号 `NY6A`、凭证 ID `bkey_cf7b0bb04a92eadcfcc766cc` 保留。负责人界面完成“启用基础工具”，实际持久化 `t0_mode=current_grant`、版本 3、状态 active、交付 acknowledged；该应用仍只有 1 枚有效 Key。与发布前备份对比，密钥材料、末四位、pepper 版本及有效期均未改变，凭证数量没有增加。

该 Key 的业务范围仍为 `customs.query`、`customs.tax.estimate`、`quote.zone_preview`、`quote.ai_extract_preview`；基础范围由当前有效 T0 grant 提供货物计算、装柜摘要和 Agent 上下文。

本轮没有读取或重新生成用户保存的完整 Key，没有使用该真实 Key 发起客户机器调用；`lastUsedAt` 仍为 null。统一 Key 两类调用、短 JWT 撤销即时生效等由隔离测试证明，不能把它们写成用户的真实业务调用成功。

## 发布身份与连接

Portal 与 MCP Runtime 当前镜像均为 `freightclaw-portal:a42849576004`。

- 完整 build ID：`a428495760049453f5256e6b704dbbc14d0a0a8b29661d2426f6af8b1e7d31fd`
- 镜像 ID：`sha256:bdf831cc67cfcc316d626cc546ebdfebd8d1e286b084cd520f2939b32d720ab8`
- 源清单：工作区 362 个文件逐项 SHA-256；基线 HEAD `34e1e9567440e768eb9e7a1b6cfe8c2ded70baed`，没有把工作区发布说成已合并提交。
- 压缩包 SHA-256：`b47014f7ae3ee84e354fecee53108e83766a45055f219ad5ad631aeb299792e0`
- 页面脚本版本：`97cde3bbacced52b`；样式版本：`6f12b719b40f8e91`。公网文件与最终本地构建字节一致。

Runtime 已设置 `MCP_APPLICATION_AUTHORITY_URL=https://www.freightclaw.net/access/v2/application/token/authority` 及精确允许主机。长期 Key 校验留在 Portal，Runtime 每次认证请求使用短 JWT 在线核对当前 authority。nginx 为该内部读回路由使用调用限流，不套用低频换票限流。原 Access Gateway 仍为 `cross-border-logistics-mcp:bba4ea6ccc39-arm64`，运行健康。

Cloudflare 原机器规则新增精确路径 `/console/skill.md`、`/mcp`、`/runtime/readyz`，只关闭这些机器路径的 Browser Integrity Check；其余规则与身份/授权检查不变。普通 Python 客户端现在可读取指南与运行状态，未认证 MCP/REST 仍返回结构化拒绝，根路径的旧浏览器检查仍有效。

## 实际验证

| 验证 | 结果 |
| --- | --- |
| `npm test` | 165 文件通过、1 文件跳过；1655 项通过、1 项跳过，235.28 秒 |
| 最终四个前端模块定向测试 | 29/29 通过，覆盖统一 Key、更新服务、viewer 门禁与安全验证 |
| 六组原业务浏览器流程 | T0 接入 13 项、Business 12 项、企业 7 项、复核/PDF 13 项，以及登录恢复与业务结果全部通过，0 page error |
| 新市场与手册浏览器流程 | 公共浏览、搜索/分类、3 MCP/5 API、七章、同 Key 两类只读调用、明文清空、viewer 五个深链通过 |
| 响应式 | 1440、768、390、320 px，无页面横向溢出；菜单和键盘路径通过 |
| `npm run build` / `lint` / `typecheck` / `git diff --check` | 最终版本通过；远端 Node 22.13 镜像构建与类型检查通过 |
| Schema 与 Agent 标准 | 17 通用 Schema、11 示例、18 接入 Schema；13 标准、5 profiles、4 模块、5 资源通过，标准包生成成功 |
| 正式公网检查 | 12 项通过：Portal 5 依赖、Runtime、Markdown、OpenAPI、2 静态文件、未认证机器调用及边界 |
| 独立 GPT-5.6-sol UI 复核 | 最终 SHIP；本地验收证明界面与隔离合同，不代表正式价格或税则已就绪 |

最初公网验收脚本错误地将内部 authority 路由列入公开 OpenAPI，并把 Business 无凭据应返回的 401 写成 403；按实际合同修正两项检查并重新读取，保留原失败记录。没有为此修改产品的认证边界。

## 备份与回滚

Portal 发布前备份 `market-unified-4aec11c79ae9`、发布并升级 Key 后备份 `market-delivered-a42849576004`，三个 SQLite 和私有配置均在暂停 Portal 写入的边界内保存，完成隔离恢复、完整性与外键检查。

Runtime 备份 `runtime-unified-20260905T173112Z` 完成恢复验证。主机 Python SQLite 不支持现有 STRICT 表，第一种备份校验失败；随后只读源上的 VACUUM 也未成功。两次失败均自动恢复原 Runtime，没有执行替换。最终在服务停止期间复制数据库及 WAL 到受保护备份，在无网络临时容器中使用 Runtime 自带 SQLite 实际恢复、检查并 checkpoint，验证后才切换镜像。

Portal 上一镜像 `31235bfaba58` 与 Runtime 上一镜像 `bba4ea6ccc39-arm64` 均保留。配置备份分别为 `portal-promotion-20260905T172515Z`、`nginx-unified-20260905T172553Z`，Runtime 的原 compose 参数和私有配置保存在上述 Runtime 备份中。回滚恢复对应镜像和代理配置，保留数据与审计，不能删除业务记录。

脱敏证据保存在 `.runtime/production-evidence/portal-a42849576004-*` 及 `runtime-a42849576004-promotion.json`。私有数据库与凭据仅保存在服务器受保护目录。

## 仍未完成的业务验收

关务正式发布、复合快照及动态措施依赖仍未闭合；Freightcom 尚缺真实企业供应商凭证；正式报价来源、业务复核与发送/订舱条件仍需要实际业务证据。原报价与关务来源服务的只读连接结果详见各自 runbook，不能用页面、权限已开通或 HTTP 200 替代正式业务完成。
