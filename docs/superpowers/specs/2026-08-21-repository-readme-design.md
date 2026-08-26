# 仓库 README 图文说明设计

## 背景

当前 README 已经包含架构边界、工具契约、生产资格和运行入口，但信息密度分布不均：新成员需要先读完整段落才能理解仓库定位，Agent 客户端适配与 Module Runtime 的关系不够直观，开发入口也埋在文档后半段。

本设计只针对以 `main`（基线 `c9873b1`）为事实来源的仓库说明，不把其他分支或未合并工作写成主线能力。当前 `main` 的 RiskCustoms 状态仍是“已实现 status→query 与失败闭合，但尚未注入生产组合”，quote 仍保持生产零调用，PDF/文档能力未注册。

## 目标

1. 让新成员在首屏理解“这是一个独立运行的物流 MCP 薄控制层”，以及它与 Agent 客户端、业务模块和上游权威系统的边界。
2. 用一张主架构图表达客户端 → MCP 控制层 → Module Runtime/业务工具 → 窄适配器或本地确定性计算 → 上游权威系统的关系。
3. 用状态卡把当前能力分成可计算、待合同、不可用、需人工复核和写入需审批等可解释状态，避免“有代码”等同于“生产已上线”。
4. 把 `npm run start:fixture`、`npm run verify:runtime` 和契约/Agent 标准校验放到靠前位置，让读者可以快速跑通本地演示并知道验证边界。
5. 为 ChatGPT、Codex、企业助手、module developer、reviewer、release operator 和 runtime caller 提供统一的文档入口，事实仍由仓库标准、契约和 Standard Pack 维护。

## 非目标

- 不修改业务契约、工具注册、Schema、Agent profile 或部署配置。
- 不把 README 做成生产运维手册；生产发布、回滚、客户端接入仍链接到 `docs/runbooks/`。
- 不新增外部图片托管、截图或构建依赖；视觉表达使用 GitHub 可渲染的 Mermaid、表格、代码块和状态标识。
- 不为未获生产资格的 quote、RiskCustoms、PDF、草稿写入或人工任务能力增加“已上线”“可发送”“可生产写入”等措辞。
- 不修改与 README 无关的测试配置；验证以完整初始化 worktree 后的实际运行结果为准。

## 采用的叙事方案

采用“架构蓝图为主、状态卡与 Quick Start 为辅”的组合：

### A：架构蓝图主骨架

首屏标题下先给出定位、事实边界和一张 Mermaid 架构图。图中至少包含：

- ChatGPT、Codex、企业助手和内部工作台等 Agent 客户端。
- MCP transport、身份、tenant/RBAC、Schema、audit、idempotency、session 等平台护栏。
- Module Runtime v0、cargo、container、Agent Standard Access。
- quote/RiskCustoms 等窄适配器和 PDF/文档 pending contract。
- 现有报价、关务和文档系统作为权威来源；MCP 不复制其业务主表。

### B：状态卡

架构图后使用紧凑表格表达真实状态，字段固定为“能力 / 当前状态 / 能否调用 / 证据或下一门禁”。至少覆盖：

| 能力 | README 应表达的状态 |
| --- | --- |
| cargo / container | 本地确定性计算；返回单位、版本、假设、warnings 和 trace；container 是理论/可解释摘要，不是 3D 装柜承诺 |
| quote API | adapter 已有 fixture/fake HTTP 验证，但生产合同未通过，工具保持 `unavailable`/fail-closed |
| RiskCustoms search | 已有 status→query 和失败闭合；`main` 尚未注入生产组合，缺 M2M 合同或 ready gate 时不可用 |
| customs estimate | 尚无已核验生产 API 合同，保持 `unavailable` |
| quote.save_draft / review.create_task | 仍需 preview → approval → commit → readback，生产写源未获资格 |
| PDF / 文档 | 未注册，等待 API、认证、输入输出、副作用和写后读回合同 |
| Agent Standard Access | 通过注册表、profile、Standard Pack、固定 MCP resources 和 `system.agent_context.get` 提供 allowlisted 上下文 |

状态文字必须与统一包络的五种状态一致：`success`、`needs_input`、`manual_review`、`blocked`、`unavailable`。

### C：Quick Start

靠前提供最短本地路径：

```bash
npm ci
npm run start:fixture
# 另一个终端
npm run verify:runtime
```

同时明确：fixture 只用于隔离演示和测试；`/readyz` 的 fixture 响应不代表生产就绪；本地假 token、监听地址和 Admin UI 都只适用于本机演示。

## README 信息架构

1. **Hero / 定位**：中文标题、英文副标题、简短能力范围和“事实边界”提示。
2. **一眼看懂**：架构 Mermaid 图 + 三条不可越过的边界：上游拥有业务权威、AI 不设价格/税率/状态、缺证据保持失败闭合。
3. **当前状态卡**：cargo/container、quote、RiskCustoms、customs、write、PDF、Agent Access。
4. **一次请求如何走**：第二张 Mermaid sequence/flow 图，展示 schema/tenant/RBAC → 工具 → 本地计算或上游窄适配 → envelope；缺配置、ready=false、上游错误和写后读回失败分别落入结构化非 success 状态。
5. **Agent 调用适配**：列出 `deploy/clients/` 的 ChatGPT、Codex、企业助手模板，说明 Streamable HTTP、服务端 Bearer/JWKS、固定工具 allowlist、固定资源和写工具审批要求；模板为管理员接入清单，不声称可直接导入。
6. **契约与标准地图**：链接 `docs/contracts/`、`docs/standards/`、`docs/agent/index.json`、Module Development Standard、RFC 和计划。
7. **Quick Start / 验证**：本地 fixture、runtime smoke、typecheck、lint、schema、Agent standards、Agent adapters、build 命令。
8. **目录地图**：按 platform/server、module-runtime/modules、agent-context、domains、adapters、apps/admin、deploy、tests 分类。
9. **安全和生产边界**：服务端注入 tenant/actor，客户端不提交 token/base URL/跨租户上下文；日志脱敏；不连接生产系统；组合测试不等于生产资格。
10. **深入阅读**：链接产品说明、后台控制台、客户端接入、发布、回滚、安全门禁和集成交接文档。

## 视觉与可读性约束

- 使用少量 Mermaid 图，图下必须有一句纯文本解释，避免只靠图形传达状态。
- 状态表同时使用文字状态和代码标识，不只依赖颜色；`unavailable`、`manual_review`、`blocked` 不用模糊的“暂不可用”替代。
- 代码块中的命令必须来自 `package.json` 或已核验文档；不展示真实 endpoint、secret、客户地址或生产 token。
- 章节保持短段落与可扫描列表，深层细节通过链接下沉到规范、契约和 runbook。
- 不引入 GitHub Actions 绿灯徽章作为生产 readiness 证明；如果展示验证信息，明确是本地/fixture 证据和当前限制。

## 验收标准

- README 从 `main` 读取的能力、状态、工具数、Agent profile、资源 URI、脚本名和链接路径均可在仓库中核对。
- Mermaid 图能在 GitHub Markdown 中渲染，且图中文字与旁边的状态说明不冲突。
- 新读者可从 README 找到：仓库定位、不能做什么、如何启动 fixture、如何验证、哪里查看契约、如何理解 Agent 适配。
- README 不包含当前 RiskCustoms/Freightcom 分支未合并内容，不把 fixture、fake HTTP、本地测试或计划写成生产连接/生产就绪。
- 修改仅限 `README.md` 和本设计文档；`git diff --check` 通过。
- 验证报告区分完整 worktree 初始化后的测试结果与环境尚未准备完成时的临时失败，不将环境误判归因于 README。
