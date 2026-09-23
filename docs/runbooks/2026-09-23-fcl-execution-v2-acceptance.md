# FCL 询报价到执行 v2：实施与本地验收

日期：2026-09-23。依据已接受的 [执行 RFC](../rfcs/2026-09-23-fcl-execution-v2.md) 完成三个小阶段的本地实施。这里的通过仅指隔离数据、合成账号和模拟 SMTP；生产迁移、真实身份目录、真实收件箱与部署没有验收。

工作区：`/private/tmp/fcl-execution-stage1-20260923`；分支：`codex/fcl-execution-stage1-20260923`；基线 HEAD：`34b90e1e93027a4fadbc8c8121ec86821a900a75`。用户在本地验收后另行授权 Git 提交，提交标识以 Git 记录为准；未推送。此前 v3 批次 1 的去重、按需读取、分页及生成物检查改动保留。

## 1. 审查与实施边界

| 原规格需要补清的地方 | 本次处理 |
| --- | --- |
| 文件批准、正式 PDF、内部 handoff 不能证明客户接受 | 单独登记“员工代录客户确认”，绑定指定报价、文件、PDF 摘要和原需求版本；不回填旧 handoff |
| handoff 的动态有效性不能决定在途业务存续 | 保存不可覆盖的成交依据；执行使用独立版本，后续运价失效不撤销执行 |
| 配邮箱不等于授予访问权 | 实际个人账号、单据和节点权限共同校验；参与人只见获授权节点，不获得报价成本、利润或运价库权限 |
| 原通知 v1 是 strict 合同，且旧后台 receiver 闭包不能支持逐单路由 | v2 固定十行，旧配置仅映射 intake；后台按原 owner 和节点快照解析配置 |
| 多数据库事务和 SMTP 不具备端到端原子性 | 沿用 Case → Rate → Document 顺序；执行、审计和 outbox 同 Case 事务，提交后发送；读回与幂等收敛，未知结果不自动重发 |
| 免费、包含和仅目的港服务容易生成错误任务 | 复用六个服务标识，以正式文件 customer_scope 的 priced/included/free 生成七类固定节点；pending 阻断 |
| 通用流程设计会扩大范围 | 仅新增同库执行记录与 outbox 两张表；节点、参与人和审计保存在执行记录内，没有通用工作流引擎、ERP 主档、企业体系或外部队列 |

询价、报价和客户确认跟进继续由原 owner 操作。前面三类提醒是内部待办；对外报价由有权人员人工发送。执行节点支持多责任人，不将这条限制扩展成全流程单人模式。美转加保税、自动船司订舱、SO 识别、库存台账、SMTP 附件仍不在本合同范围。

## 2. 三个小阶段

1. **询报价到执行**：复用 Case、Quote、Document 和 handoff，增加只读预览、客户确认、同 case 唯一且幂等的执行创建、固定服务映射、商业变更及同页展示。资料更新不改原询价或报价版本。
2. **责任人与节点通知**：节点表单、共享运输资料、真实节点权限、改派撤权、默认快照及显式应用、单票覆盖、固定字段邮件预览、合成测试邮件、持久化 outbox、发送结果核实与人工重试。普通保存不通知；完成与下一节点启动合成一个事件。
3. **回归与交付**：引用变化、重复创建、数据库连接并发、提交后丢失响应、跨账号隔离、商业变更、配置兼容、SMTP 不确定结果、迁移和回滚，以及实际浏览器、正式 PDF、CLI 与手机宽度检查。

## 3. 主要代码与合同

| 入口 | 职责 |
| --- | --- |
| `services/quote-documents/workflow.ts` | 复用正式文件门禁、执行预览/创建/商业变更、多库锁顺序 |
| `services/access-gateway/portal/fcl-execution{,-contracts,-store}.ts` | 严格结构、唯一执行、版本、权限、固定节点、审计和迁移 |
| `services/access-gateway/portal/fcl-execution-{http,http-contracts,identity}.ts` | 29 个窄动作、Web/CLI 共用合同、实际 IdP 账号校验 |
| `services/access-gateway/portal/fcl-execution-mail{,-format}.ts` | 同库队列、独立受众投影、claim/lease、未知结果和渲染 |
| `services/access-gateway/portal/native-admin.ts` | 个人通知 v2、v1 投影兼容、预览及显式测试 |
| `services/access-gateway/portal/{cases,production-fcl,production,http}.ts` | 真实事件、按单配置、worker 生命周期、显式启用和闭合路由 |
| `apps/console/{fcl,fcl-execution,fcl-node-notifications}.js` | 原工作区阶段列表、成交登记、节点表单及十行配置表 |
| `deploy/cli/fcl-workspace.ts` | 同一 person session、版本及幂等键；API Key 权限不扩大 |
| `schemas/access-gateway/fcl/`、`apps/console/openapi.json` | 生成的 Draft 2020-12 请求/响应及唯一 OpenAPI；构建只核对，不静默重写 |

配置版本为 `fcl-notification@2026-09-23.v2`，执行版本为 `fcl-execution@2026-09-23.v1`。RFC 附件是已接受的评审快照；运行时以生成 Schema 和对应 Zod 定义为准。

日期 API 接受带偏移的 ISO 时间；Web 按表单标明的本机时区录入并保留偏移，邮件显示登记时区及 UTC 偏移，不猜测加拿大城市时区。跨时区截止日期按实际时刻排序。

执行历史和邮件记录支持分页；owner 的详情只内嵌最近 50 条操作并显示总数。当前存储上限是每票 100 次成交依据、5,000 条审计、每条邮件 100 次核实记录；达到上限失败闭合，不静默删历史。

## 4. 验收场景对应证据

| 规格验收编号 | 实际证据 |
| --- | --- |
| 1、2 | 浏览器实际生成正式 PDF，同 case 转执行；审批、导出与旧 handoff 后执行仍为空 |
| 3、4 | `fcl-execution.test.ts`：不同 key/第二连接重复创建、提交后失去响应、指定版本与摘要失配、pending 范围阻断 |
| 5、6 | 同文件：included/free、仅海运、仅目的港映射；不要求外部服务的本公司 SO |
| 7、8 | 独立执行版本、原需求读回、来源过期重放；浏览器完成节点后原 Case 版本不变 |
| 9、10 | `fcl-notification-lifecycle.test.ts`、`fcl-notification-v2.test.ts`：个人 owner 通知、事务回滚、v1 兼容、预览后仅更新未开始节点；浏览器默认变更不覆盖本票 |
| 11、12 | `fcl-execution-mail.test.ts`、Python SMTP fixture：真实 To/Cc 形状、内外投影隔离、缺项及未配置失败闭合；预览和测试仅合成内容 |
| 13、14 | `fcl-execution-collaboration.test.ts`、identity 测试和浏览器：参与人可写自己节点、Case/Quote 拒绝、改派后即时撤权和旧通知取消 |
| 15、16 | 两个独立 SQLite 连接的 worker claim、发送 lease 过期、partial/unknown、不自动重发、核实依据落在目标邮件后明确重试 |
| 17 | 浏览器保存/刷新、独立会话重新登录和 CLI 写后读回；节点凭证与成交依据持久化 |
| 18 | 旧 Console、Access Gateway、Quote Native、Quote Documents、询价合同和资产测试回归；Schema、OpenAPI 和标准包检查 |

正式 PDF 的浏览器验收使用本机 Microsoft Edge 和 Playwright 渲染，文件不是单元测试的简化 PDF。单元测试中的 PDF fixture 仍只用于合同和事务测试，不能替代正式渲染证据。

## 5. 实际执行与复现

相关回归命令：

```sh
npm test -- tests/console tests/access-gateway tests/quote-documents tests/quote-native tests/e2e/fcl-inquiry-contracts.test.ts tests/platform/admin-assets.test.ts --maxWorkers=2
```

已运行结果：**140 个文件通过，2 个文件跳过；831 项通过，11 项跳过**。跳过项属于未启用的 PostgreSQL 集成和依赖 Linux `/proc` 的现有检查。macOS 的不支持外部句柄检查时失败闭合路径已运行；没有用 macOS 的模拟 exclusiveCheck 冒充 Linux 停 writer 实测。

随后补齐邮件核实审计、跨时区排序及单票配置保存不发信的断言。最终精确重跑 `fcl-execution-mail.test.ts`、`fcl-execution-workspace.test.ts`、`fcl-execution-collaboration.test.ts`，3 个文件、8 项全部通过。最终静态检查和构建亦通过，具体命令及输出摘要保存在下述证据目录的 `validation.json`。

验证和构建顺序：

```sh
npm run typecheck
npm run lint
npm run validate:schemas
npm run validate:agent-standards
npm run build:agent-pack
npm run build
npm run build:cli
git diff --check
```

`build` 清理 `dist`，CLI 必须后构建。不要在运行 bundled CLI 之前再次清理构建目录。

本次 loopback fixture 使用 `PORTAL_FIXTURE_FCL_PERSONAL=true`、`PORTAL_FIXTURE_FCL_EXECUTION=true`、端口 `8953`，数据目录 `/private/tmp/fcl-v2-execution-fixture-20260923`，固定合成业务日期 2026-10-08。启动入口为 `node dist/src/logistics_mcp/server/portal-fixture.mjs --fixtures`。启用真实本地 PDF 渲染需要 `PORTAL_PDF_BROWSER_EXECUTABLE` 和 `PORTAL_FIXTURE_PDF_PLAYWRIGHT_MODULE` 指向本机已有依赖；未安装或不可运行时应明确失败。

浏览器命令（本机路径）：

```sh
PLAYWRIGHT_MODULE=/private/tmp/fcl-stage1-playwright.mjs \
PLAYWRIGHT_EXECUTABLE_PATH='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' \
PORTAL_BASE_URL=http://127.0.0.1:8953 \
FCL_EVIDENCE_DIRECTORY=/private/tmp/fcl-v2-execution-evidence-20260923 \
node --import tsx/esm tests/e2e/portal-browser/fcl-execution-flow.mjs
```

证据目录：`/private/tmp/fcl-v2-execution-evidence-20260923`，包含 `acceptance.json`、`validation.json`、`related-tests.log`、`formal-quote.pdf`、`owner-desktop.png`、`completed-desktop.png`、`participant-mobile.png`、`node-mail-config.png` 和 `node-mail-mobile.png`。CLI 临时 session/input 文件使用 0600 并在验收 finally 中移除，不将凭证加入交付文件。

## 6. 生产启用前的迁移与回滚

**以下是操作说明，本次没有执行生产迁移。**

1. 停止旧 Portal 和其他 SQLite writer。对 Case、Native、Document 三库及配套 WAL/SHM 做一致备份，记录路径、摘要和旧版本；脚本不会代替运营者创建备份。
2. 在已确认无外部 writer 的 Linux 环境执行既有离线脚本，增加 `--execution`。状态目录必须为私有目录，数据库文件不得是 symlink；保留运行用户 ownership。
3. 参数形状：`npm run migrate:fcl-sqlite -- --state-root <绝对私有目录> --writers-stopped --execution`。若文档库使用另一位置，使用位于同一受控状态目录的 `--quote-documents`；需要时同时提供 `--runtime-uid` / `--runtime-gid`。
4. 读回 Case v3、Native v3、Document v5，完整性检查，核对旧业务与文档摘要、旧记录数；两张执行表初始为空。脚本拒绝运行时自动升级；旧 v2 reader 拒绝 v3。
5. 配置 `PORTAL_FCL_EXECUTION_ENABLED=true` 和受保护的 `PORTAL_FCL_EXECUTION_DIRECTORY_FILE`，同时保留既有 FCL/SMTP/PDF 启用条件。目录文件的 `people` 数组只引用真实 IdP 的 `user_id` 与 `authority_url`，不创建用户、不分配 Case 权限。URL 必须是同一 OIDC issuer 的 HTTPS Authentik 用户权威接口；沿用受保护 authority token 文件。未知、停用、未验证邮箱或不可用的权威查询不得被当成活动人员。
6. 内部邮件详情链接来自已校验的 `PORTAL_PUBLIC_ORIGIN`，要求重新登录；外部作业邮件不包含内部入口。测试实际 IdP 撤权、受保护 SMTP、明确测试邮件及收件箱读回后，才能记录为生产验收通过。

跨库迁移不是一个 SQLite 事务。中途失败时保持停写，核对各库版本后重试到目标版本，或恢复整套一致备份；不能只回滚其中一库。文件批准与派生通知的多库提交同样依赖原 key 重试收敛，不能因通知结果未知重新批准并换 key。

上线前回滚可恢复三库一致备份并使用配套旧程序。产生执行新事实后，应先停写、导出并核实新事实，再决定恢复或前向修复。禁止只降低 `user_version` 或删除执行表来伪装回滚。

真实 IdP 目录、Linux 停 writer 检查、SMTP 接收和最终投递、生产迁移与部署均保留为上线前待验证项。本地合成 transport 返回成功只证明派发路径；界面“SMTP 已接收”不表示最终投递或已读。
