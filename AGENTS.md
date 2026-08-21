# Agent 标准入口

本仓库的机器可读 Agent 标准入口是 `docs/agent/index.json`。开始模块开发、审查、发布
或运行时调用前，先按 profile 读取对应标准；开发/构建时使用 `npm run validate:agent-standards`
和 `npm run build:agent-pack`，运行时只使用生成的
`dist/standards/agent-standard-pack.json`，不得从当前工作目录随意读取 Markdown。
本入口与下方协作规则共同生效；在 v0 迁移完成前，以下任务所有权和安全红线仍是完整权威。

# 后续任务协作规则

本文件是共享基线的执行约束。任务 02–06 使用独立分支/worktree 时，必须先阅读本文件、产品实现说明、统一包络、工具目录和权威矩阵。

## 任务所有权

| 任务 | 可写目录 | 主要交付 |
| --- | --- | --- |
| 01 基线 | `README.md`、`AGENTS.md`、`docs/product/**`、`docs/contracts/**`、`docs/superpowers/plans/**` | 共享定位、契约、Schema、示例和实现计划 |
| 02 平台 | `src/logistics_mcp/platform/**`、`src/logistics_mcp/server/**`、`tests/platform/**` | MCP transport、租户上下文、RBAC、envelope、审计、幂等和工具注册 |
| 03 货物/分泡 | `src/logistics_mcp/domains/cargo/**`、`tests/cargo/**` | CargoLine、CBM、体积重、分泡、计费重和证据模式 |
| 04 装柜 | `src/logistics_mcp/domains/container/**`、`tests/container/**` | 理论容量/可操作容量、装载汇总、超方超重和装载顺序摘要 |
| 05 适配器 | `src/logistics_mcp/adapters/**`、`src/logistics_mcp/domains/{quote,customs,knowledge,status,review}/**`、`tests/adapters/**`、`tests/domains/**` | 现有报价、RiskCustoms、精选知识、状态和复核任务的窄适配 |
| 06 集成 | `tests/e2e/**`、`deploy/**`、`docs/runbooks/**`、客户端配置示例 | 多客户端、部署、安全发布、端到端和回滚验证 |

任务 06 原则上不重写 02–05 的领域实现，只通过小型集成修复解决问题。

## 禁止交叉修改

- 02–06 不得直接修改 `docs/contracts/**`、其他任务的源码目录或测试目录。
- 共享契约只能由 01 基线维护。发现字段、状态、权限或版本必须变化时，在自己的分支新建 `docs/rfcs/YYYY-MM-DD-<slug>.md`，写清动机、兼容性、迁移和测试，再请求基线维护者处理。
- 禁止新增 `generic commit_operation`、万能写入口、模型驱动的规则写入、隐式跨租户查询或默认配置回退。
- 不能把报价、Zone、关税、业务记录复制成 MCP 自有权威表；只能保存必要的版本引用、快照 ID、opaque handle 或适配器缓存。
- 不得修改 `/Users/autumn/Documents/AI自动报价模块`、`/Users/autumn/Documents/美国、加拿大关务`、`/Users/autumn/Documents/物流LCP服务/canada-logistics-records`，也不得连接生产数据库、服务器或外部服务。

## 契约执行规则

- 每个工具输入和输出都要使用 Draft 2020-12 Schema，`additionalProperties` 默认显式为 `false`；扩展字段必须进入新版本或明确的 `extensions` 命名空间。
- 响应包络的 `status` 只允许：`success`、`needs_input`、`manual_review`、`blocked`、`unavailable`。
- 金额只能使用 decimal string 与 ISO 4217 三位币种；重量、长度、体积、数量必须带单位。禁止用 float 表示金额、税率、重量或比例。
- `unit_weight`、`piece_weights`、`line_total_weight` 是互斥证据模式，不能在同一 CargoLine 混用；证据不足必须补输入或人工复核。
- 每个计算结果必须带规则/数据版本、source refs、assumptions、warnings、blockers 和 calculation trace。
- `ready=false` 的 RiskCustoms 结果必须原样进入 `unavailable` 或 `manual_review`，绝不由 AI 补成 `success`。
- 写工具必须有服务端注入的 tenant/actor 上下文、`idempotency_key`、预览/审批约束，并在成功前完成目标系统写后读回；只返回 `code: 0` 不算成功。
- 日志默认不得写入客户地址、报价明细、税务材料全文、原始聊天和凭证；使用 opaque handle/reference 与脱敏摘要。

## 验证与提交

每个任务都要遵循：

1. 先用 `rg --files` 和 `rg -n` 确认真实入口、契约和测试，再改自己的所有权目录。
2. 先写会失败的测试，再写最小实现；每个小步运行精确测试命令。
3. 运行全量相关测试、Schema 校验、`git diff --check`，并检查敏感字段没有进入日志/fixture。
4. 写操作适配器必须用假的仓库/HTTP fixture 测试幂等、权限、审批、失败闭合和写后读回；不对生产系统做 smoke test。
5. 小步提交，提交信息使用 `feat|fix|test|docs|chore: <scope>`；不要把不属于所有权目录的改动一并提交。
6. 最终回复只报告已运行的命令和实际输出；未核实接口写“待适配验证”，不要推断成功。

## 基线文件变更流程

本次 01 基线提交后，普通任务不得修改契约文件。RFC 至少包含：变更原因、影响工具、旧/新 JSON、版本兼容策略、状态/权限影响、迁移步骤、回归测试命令和回滚方式。只有 RFC 被接受后，01 才更新契约和示例；相关实现任务随后才能引用新版本。
