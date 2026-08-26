# Release runbook

本 runbook 是 MCP control-plane 的候选交接门禁。它描述“满足什么条件才可以进入另行授权的部署流程”，不表示本 checkout 已经生产发布。所有真实端点、企业身份、tenant mapping、上游关务/报价合同和生产 deployment 证据，在取得独立 staging 证据前都必须标为“待适配验证”。

No automatic send, publish, or booking path is included. Admin 生产 POST 在 v1 固定为 `blocked`，且必须在 authenticator、control service 和任何业务写适配器之前返回；本任务不执行生产访问、部署或发布。

## 当前证据分类（2026-08-26 文档切片）

| 分类 | 当前可确认事实 | 不得据此声称 |
| --- | --- | --- |
| 已实现的代码切片 | 当前 checkout 可见 control contract/inventory/hash、SQLite control store 与 identity marker、activation gate、register/preview/approval service、Admin UI/API 模型 | 不等于本次验收已经跑通完整 HTTP 发布链 |
| 已存在的测试切片 | 可见 control-plane、runtime activation、Admin API/UI 相关测试文件；测试文件存在不是通过证据 | 不预写通过数、覆盖率、生产 readback 或上线结论 |
| 并行未完成 / 待最终回读 | 本次读到 `publish`/`reconcile` 仍有未实现分支；`start.ts` 的 initializer/store/Admin API 接线及真实 HTTP exact readback 需要并行代理完成后重新回读 | 不把计划、接口表或静态 UI 当作已接通写链路 |
| 本地受控环境 | 只允许显式 initializer + fixture/local composition + loopback + synthetic data；fixture identity 不可用于生产 | 不等于企业身份、生产数据或生产 readiness |
| 生产固定 blocked | `POST /admin/api/v1/control/**` 在生产固定返回 `blocked/admin_control_production_disabled_v1` | 不可由 env、静态资源、fixture token 或本地测试解除 |

## 先决条件与兼容门

发布前必须把 control-plane 状态作为独立的受保护对象处理。application root 由 server assembly/受管 service unit 明确传入，并固定派生：

```text
state_dir  = <application-root>/.runtime/mcp-instance-state
control_db = <state_dir>/control.sqlite
marker     = <state_dir>/control-identity.json
```

initializer 是唯一创建者，且必须显式调用。runtime open/startup 不得隐式创建、修复、替换或删除 DB、marker、目录和 schema；缺少或损坏的 derived state 必须在监听前 fail closed。`MCP_ADMIN_CONTROL_ENABLED` 必须是字面值 `true`，不能用缺省值、truthy 变体或环境变量单独伪造 control state。

### 备份与兼容性清单

`non-empty backup` 必须在任何变更前生成并可定位。备份摘要可以记录 hash、size、时间、版本和恢复演练结果，但不得记录 token、密码、客户地址、报价明细、税务材料全文或原始凭证。

| 对象 | 备份/核对内容 | 兼容门不满足时 |
| --- | --- | --- |
| control DB | `control.sqlite` 非空备份；`control_db_id`、schema/user_version、release/revision、inventory digest set、event history 和 readback refs | `blocked`；不创建 replacement DB，不清空历史 |
| marker | `control-identity.json` 原文 hash 与唯一字段；路径为同一 state dir 下的 regular file | `blocked`；不从 DB 或 env 猜 marker |
| application root | 绝对、预期且未改变的 root；所有中间节点不得为 symlink | `blocked`；root 改变不是兼容升级 |
| identity/tenant | marker 与 DB singleton 的 `instance_id`、`management_tenant_id`、`control_db_id`、absolute path、schema tuple 完全一致 | `blocked`；不得把管理 tenant 改成请求里的任意 `tenant_id` |
| schema | 只接受已支持的 strict v1 schema；先做兼容检查，再打开写链路 | `blocked`；不得静默迁移、逆迁或降级解释 |
| permission | state dir `0700`、marker `0400`、DB `0600`，regular file、无 sidecar、无额外文件 | `blocked`；先走明确的修复/迁移流程，不由 startup 自修 |
| lock | 单进程 SQLite lock 可获得且没有第二实例持有；WAL/FULL 等持久性约束符合运行时合同 | `blocked`；不得绕过锁或强制并发写 |

应用镜像只能切换到理解上述 DB/schema/activation policy 的 control-plane-aware 版本。任何 pre-control-plane image 都不是 managed rollback target，即使它能启动或曾经服务过旧版 `/mcp`；它可能忽略 active policy、marker 或 release history，必须从候选与托管回滚清单中排除。

## 必须按顺序完成

1. **candidate build**：从候选分支工作区生成编译产物，记录 commit SHA、Node 版本、依赖锁文件 hash 和待审镜像构建输入；构建校验 Admin 固定静态资源。资源打包不等于开放控制台，`MCP_ADMIN_UI_ENABLED` 默认关闭。
2. **non-empty backup**：完成上面的 control DB、marker、application root、identity/tenant、schema、permission、lock 备份与兼容门；同时记录上一 verified profile、当前 release/revision、事件历史和恢复负责人。备份清单不得包含 secret 正文。
3. **Schema**：运行 Draft 2020-12 Schema、统一包络和全部示例校验；确认九工具/五状态及 control API closed envelope 没有未批准字段漂移。
4. **full test**：运行相关 platform、cargo、container、adapters、domains、module-runtime、agent-context、Admin/control-plane、e2e 测试以及 typecheck/lint；安全扫描结果必须由实际运行记录给出，不能预写通过数。
5. **image digest**：构建后记录不可变镜像 digest、产物 hash 和与 control-plane-aware 版本的对应关系；不可用 tag 或代码存在替代。pre-control-plane image 必须明确标为不可托管回滚。
6. **staging health/readiness**：仅在获批的隔离 staging URL 验证 `/healthz` 与 `/readyz`；health 只证明进程，readiness 还要反映 application root、marker、control DB、identity/tenant、schema、lock、JWKS 和其他全局依赖。任何 Admin POST 生产请求仍固定 `blocked`。
7. **RiskCustoms**：核对 `ready`、`test_data`、snapshot/release hash 和 release IDs；`ready=false` 必须原样保持 `unavailable`/`manual_review`，不得用 AI、fixture 或旧截图伪造 ready。报价、关务、客户数据的权威继续在外部系统，适配器未获资格前不写成 online。
8. **write preview / different-actor approval / publish / exact readback**：仅在隔离 fixture/sandbox（必要时为获批 staging）验证当前 build inventory-only 登记，然后按以下不可跳过的顺序：
   - creator 以固定 base release、desired module refs、diff、validation、expiry 和 idempotency key 创建 preview；不能提交 arbitrary artifact fields、URL、路径、源码或 secret。
   - 与 creator 不同的 actor 在同一 tenant、权限和未过期 preview 上审批；self-approval、重复/冲突审批、tenant/actor 变化必须 fail closed。
   - publish 持久化不可变 release/revision，再应用已挂载模块的 activation snapshot；它不加载任意代码、不改变工具公共合同、不写外部报价/关务/客户主表。
   - publish 后必须 exact readback：逐项核对 release/revision、module id/version/digest、config/profile refs、tenant/instance、activation policy、audit/idempotency outcome 和运行时工具行为。`active_verified`/`verified` 只表示 runtime exact readback，不是 artifact signature、source attestation 或 production qualification。
   - 任一读回未知、不一致、超时或目标系统仅报告 `domain_committed`，都进入 `manual_review` 或 `unavailable`；不得包装为 success。未解决的 readback 不得允许下一次 publish。

   当前文档切片读到的 `publish`/`reconcile` 和 startup/Admin HTTP 接线仍有并行待最终回读项，因此本步骤的完整成功证据槽位不能由本文件预填。
9. **audit review**：核对 audit ID、脱敏摘要、management tenant/actor、版本、状态、幂等 outcome、readback status、失败原因和 trace。日志不得写客户地址、报价明细、税务全文、原始聊天、token、密码或 URL 中的 secret；审计失败必须 fail closed。
10. **client smoke**：只在隔离环境先用实际身份适配的短时 token 验证 claims 映射，再检查 `tools/list`、五状态、`system.get_data_status` 和 Admin UI 的错误/回读显示；确认 `sendable=false`、`theoretical_only=true`、`unavailable` 和 `manual_review` 不被客户端越界解释。fixture identity 只允许 loopback local。
11. **explicit approval**：发布负责人、业务 owner、安全 owner 和运维 owner 逐项审阅证据槽位并明确批准；未填满证据或仍有 unresolved manual review 时，不能进入另行授权的部署流程。

## pending 与 reconcile 门

- 新发布后的 `published_pending_readback` 只允许固定的一次启动/运行时 exact readback 尝试。
- 未认领的 `domain_committed` pending 可以开始规定的 pending readback；已经 abandoned 的 durable claim 必须视为 interrupted unknown，不能进行第二次 adapter call。
- `manual_review` 启动时不自动重试；只有 operator-only `reconcile` 能针对固定 release 发起新的核对。manual-review replay 不得再次 activation 或 readback 目标业务系统。
- reconcile 不能编辑历史 release；它只能记录新的 reconciliation attempt/结果。结果未闭合时，新 publish 固定 blocked。
- 外部业务 adapter 的目标写入若发生 domain commit 但无法 exact readback，保持人工复核；不能由 MCP 自己建立报价、Zone、关税或客户记录作为替代权威。

## 本地受控环境与 secret 边界

本地演示必须先显式执行 initializer，再启动 fixture；startup 不负责“顺手创建”状态。Admin UI 的 token/password 只可在浏览器 password/token 输入框的内存中短暂存在，不写 URL、query、localStorage、sessionStorage、cookie、持久化 DOM、fixture data、服务日志或审计事件。服务端只记录 opaque reference 和脱敏摘要。

Admin 页面用于本地受控环境的回滚文案固定为：**“回滚到上一已读回版本（本地受控环境）”**。它不能暗示生产回滚资格；回滚必须创建新 revision、经过 preview→不同 actor approval→publish→exact readback，保留 target release、revision、event 和 DB history，不直接编辑或删除历史。

## 最终验收命令与证据槽位

以下是交接前必须实际执行的清单。本文件只定义命令和证据位置，**不填假结果**；每个槽位在执行前均为 `[待实际执行]`。

| 命令 | 目的 | 证据槽位 |
| --- | --- | --- |
| `npm run build` | 构建候选与 Admin 静态资源 | `[待实际执行：build log / artifact hash]` |
| `npx vitest run tests/e2e/module-control-plane.test.ts tests/e2e/security-gates.test.ts tests/e2e/release-gates.test.ts --pool=forks --no-file-parallelism --maxWorkers=1` | control-plane HTTP、四眼审批、exact readback、生产 POST blocked 与文档门禁 | `[待实际执行：test output / failing or passing cases]` |
| `npm test` | 全量回归 | `[待实际执行：test output / counts]` |
| `npm run typecheck && npm run lint` | 类型与规范 | `[待实际执行：command output]` |
| `npm run validate:schemas && npm run validate:agent-standards` | 契约与 Agent 标准 | `[待实际执行：validator output]` |
| `npm run build:agent-pack && npm run validate:agent-adapters` | 生成并校验标准包/适配器 | `[待实际执行：pack hash / validator output]` |
| `npm run verify:runtime` | fixture runtime/readiness boundary | `[待实际执行：runtime output]` |
| `bash deploy/scripts/check-release.sh --fixture-only` | 本地隔离 release checks；不得联网 | `[待实际执行：fixture-only output]` |
| `docker compose --env-file deploy/env.example -f deploy/compose.yml config` | 只验证本地 compose 配置，不部署 | `[待实际执行：config output]` |
| `git diff --check` | 空白/补丁完整性 | `[待实际执行：command output]` |
| changed docs/config 的 targeted `rg` secret/PII review | 检查 token、URL secret、客户/业务明文并逐项人工审阅 | `[待实际执行：match review record]` |
| `git status --short && git diff --stat` | 确认未碰非独占写集、未提交/推送 | `[待实际执行：status/diff record]` |

除非上述证据槽位由授权验收人实际填入，否则状态只能是 pending/manual_review/blocked，不得改写为 production ready 或 online。
