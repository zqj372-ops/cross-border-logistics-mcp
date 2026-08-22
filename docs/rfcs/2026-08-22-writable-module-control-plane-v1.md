---
standard_id: writable-module-control-plane-v1
version: 2026-08-22.v1
priority: 85
audience: developer,reviewer,operator
rule_ids: CONTROL-WRITE-001,CONTROL-AUTH-001,CONTROL-RELEASE-001
---

# RFC: 可写模块控制面 v1

- 状态：accepted for implementation by user confirmation on 2026-08-22
- 日期：2026-08-22
- 基线：`81b5ca83aeca65e3b44ffc06c50e368d948e4f09`
- 影响范围：本机/fixture 模块控制元数据、Admin 管理 API、静态模块启停门禁、构建清单、发布与回滚 runbook
- 不改变：Phase 1 业务工具合同、统一五状态字段、报价/关务/客户/文档权威边界

## 动机

当前 Admin 页面只能展示脱敏快照，Module Runtime 只能在启动时挂载静态可信模块。用户需要
真正保存 MCP 自身模块配置，并通过预览、审批、发布、读回和回滚管理已随应用构建的模块。
继续只增加说明文档或前端假开关不能满足该需求；直接引入 FastAdmin PHP 后端、任意插件
下载器或运行时代码加载又会破坏现有平台权威和供应链边界。

## 决策

1. 新增 `src/logistics_mcp/control-plane/**`，归平台团队所有，只保存模块控制元数据，不保存
   任何业务主数据。
2. 新增 `schemas/admin-control/**`，定义 Admin 管理 API 的 Draft 2020-12 请求/响应。该目录
   不改变 `docs/contracts/**` 的 Phase 1 MCP 工具合同。
3. 构建生成只包含当前应用内静态可信模块的 module inventory 和 canonical descriptor
   digest。客户端只能按 exact ID/version/digest 登记，不能提交 URL、路径、源码或 secret。
   v1 inventory 只允许 `local_build`、`production_eligible=false`；不接受 `verified_release`。
4. 新增独立 SQLite control store，使用显式 `MCP_CONTROL_DB_PATH`。表是窄语义 release/
   preview/approval/readback/event 表，不提供通用 key-value 或 SQL 写入口。
5. 新增管理 API：读取 control state、登记部署清单模块、生成部署/回滚 preview、审批、发布，
   以及对固定 pending/manual-review release 做 exact readback reconciliation。
   所有 POST 要求 Idempotency-Key，身份由 verifier 注入。
6. 管理写入要求 active role 为 admin、roles 包含 admin、`platform:admin` scope 和服务端配置的管理 tenant。preview creator
   与 approver 必须是不同 actor。
7. 新增 `ModuleActivationRegistry`。它只切换已挂载模块的调用门禁，不加载代码、不卸载
   lease、不改变工具公共合同。禁用工具保留目录可见性，调用返回 `unavailable`。
8. publish 必须在持久化后应用不可变 activation snapshot，并对 release/revision/module refs
   做 exact readback。读回未知或不一致返回 `manual_review`。
9. rollback 通过同一 preview/approval/publish 流程创建新 revision，不删除或改写历史 release。
10. Admin UI 使用自托管 AdminLTE 4 CSS 和现有原生 ES module；FastAdmin 只作为信息架构参考，
    不引入其 PHP runtime、权限表、ORM 或插件安装器。
11. v1 只允许 loopback fixture/local 写入；`MCP_DATA_MODE=production` 的 Admin POST 固定
    `blocked`。生产认证、Deployment Evidence 和多实例发布必须另行 RFC，不能靠配置打开。

## 所有权

| 路径 | 所有者 | 内容 |
| --- | --- | --- |
| `src/logistics_mcp/control-plane/**` | 平台任务 02 | inventory、store、service、activation、errors/types |
| `schemas/admin-control/**` | 本 RFC 控制面合同维护者 | 仅 Admin API schema |
| `src/logistics_mcp/server/admin-control-api.ts` | 平台任务 02 | HTTP 管理边界 |
| `src/logistics_mcp/server/{admin-static,start,composition}.ts` | 平台任务 02 | 受控接线与 activation gate |
| `apps/admin/**` | 控制台集成 | AdminLTE 外壳、模块中心和真实 API 交互 |
| `tests/{control-plane,platform,e2e}/**` | 对应实现所有者 | 合同、安全、存储、运行时和浏览器外协议测试 |
| `deploy/scripts/build.mjs`、`docs/runbooks/**` | 集成任务 06 | inventory/admin 资产构建与运行边界 |

上述新增路径所有权已同步写入 `AGENTS.md`。`docs/contracts/**` 不在本 RFC 实施中修改。如果后续要新增公共 MCP 管理工具或改变业务工具
envelope，必须另行提交共享合同 RFC。

## API 和状态兼容

- 现有 `/mcp`、`/healthz`、`/readyz`、九个 Phase 1 工具和
  `system.agent_context.get` 名称/Schema/权限保持不变。
- 新 API 位于 `/admin/api/v1/control/**`，不是 MCP 业务工具，不进入现有工具目录。
- Admin API 使用独立 `2026-08-22.v1` closed envelope，包含 request ID、trace ID、audit ID、
  五状态、discriminated data、reason codes 和 readback；不声称复用完整 MCP envelope。
- 控制面未启用，或全新 control DB 明确没有 release 时默认启用当前全部静态模块。控制面已
  启用但 DB/状态不可恢复时启动失败，不回落全启用。
- 新版本模块代码仍需应用构建和进程发布；control plane 不宣称跨代码版本 hot-plug。

## 安全

- `/admin` 首版继续仅回环访问；生产多人访问仍需批准的企业身份网关，未在本 RFC 中授权
  直接公网暴露。
- 所有写 API 检查 loopback、Host、Origin、Content-Type、body size、Bearer、tenant、active role、
  scope、schema 和幂等键，检查顺序发生在业务写入之前。
- token 只在浏览器内存和请求 Authorization header 中存在，不持久化、不回显、不审计。
- 生产不接受 fixture token；fixture 两身份只在回环 fixture assembly 显式配置。v1 production
  Admin POST 在认证/业务 service 前固定 blocked。
- 客户端不能提交 tenant/actor/role/scope、URL、Git 地址、本地路径、命令、源码、token、
  secret 或数据库连接。
- 控制事件只保留受控 actor/tenant/object refs、reason、status、revision 和时间；不保存业务正文。

## 数据与迁移

- 使用独立 control DB，schema 从 v1 开始，避免隐式改变现有 production platform store。
- 新 DB 只由显式 fixture initializer 创建；普通 runtime 不自动重建缺失的 enabled DB。
- 数据库启用 strict tables、foreign keys、WAL、FULL synchronous、quick check 和 `0600`。
- v1 使用 SQLite exclusive locking，只允许一个进程持有同一 control DB。
- v1 只支持新库创建和同版本重开；未知 user_version 或 schema drift 失败闭合。
- 已应用 schema 不在紧急回滚中逆迁；回滚应用代码时保留 control DB 和 release 历史。

## 发布语义

- 登记：exact match 当前 build inventory；只说明当前构建包含该 descriptor。
- preview：固定 base release、desired refs、diff、validation、creator 和 expiry。
- approval：另一 actor 决定并绑定 preview hash/base/inventory/expiry；append-only 终态，
  reject/expired/consumed 不可发布或覆盖。
- publish：compare-and-set base，创建 release，应用 activation，读回 exact snapshot。
- publish 幂等记录在 release 事务中进入 `domain_committed` 并固定 release ID；进程中断后的
  同键重试只能恢复该 release 的 readback，不能创建第二个 release。
- success：只说明当前环境中的控制写入和运行时读回成功；是否 production eligible 由 inventory
  evidence 单独给出。
- manual_review：数据库写入已发生但 activation/readback 未知或不一致。
- reconciliation：只重读/恢复固定 pending/manual-review release，不创建新 release。
- rollback：复制目标已验证 profile 形成新 release，保留完整历史。

## UI 与依赖

- 新增固定版本 `admin-lte` 和其 peer `bootstrap`；构建只复制所需本地 CSS/JS，CSP 保持
  `self`，不使用 CDN。
- 保留原生 HTML/CSS/ES module，不引入第二套前端框架。
- UI 中所有模块状态来自 control state API；fixture 数据不得静默回退到 live 页面。
- 写按钮在未绑定身份、无 preview、无另一 actor approval 或 readback 未就绪时保持禁用。

## 分阶段实施

1. inventory、activation 类型和合同 schema。
2. SQLite store 与 ModuleControlService 状态机。
3. 管理认证/HTTP API 与 composition 接线。
4. ModuleActivationRegistry 调用门禁、启动恢复和运行时读回。
5. AdminLTE 模块中心、两身份 fixture 流程和脱敏 UI。
6. 构建、e2e、安全、release/rollback 文档和全量验证。

## 回滚

1. 关闭新的 Admin 写入口，保留 control DB、事件和当前 release reference。
2. 应用代码回滚到上一已验证 digest；不删除 control DB、不逆迁 schema。
3. 禁止回滚到不认识 control DB/schema/activation policy 的旧代码；compatibility gate 未通过
   时停止回滚，不能忽略独立文件后默认全部启用。
4. 若需恢复某个 module profile，使用仍可运行的新版本控制面生成 rollback preview 并经另一
   actor 批准，不直接编辑 SQLite。
5. 验证 tools/list、禁用工具 unavailable、重新启用、audit 和 active release readback。

## 验证

```bash
npm test
npm run typecheck
npm run lint
npm run validate:schemas
npm run validate:agent-standards
npm run validate:agent-adapters
npm run build
npm run verify:runtime
git diff --check
```

本 RFC 不授权生产部署、外部业务系统写入、任意制品下载或公开 Admin 入口。
