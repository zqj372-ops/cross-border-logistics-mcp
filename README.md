# 跨境物流 MCP

这是公司内部共用的跨境物流能力基线：一个共享的远程 MCP 网关、现有业务系统适配器，以及新的确定性计算引擎。它供 ChatGPT、Codex、企业助手和内部工作台共同使用，目标是把已有报价、关务、记录和运营能力以稳定、结构化、可审计的工具契约暴露出来。

## 定位与边界

- AI 负责理解意图、收集缺失字段、选择工具和解释结果。
- 确定性代码负责金额、计费重、分泡、装柜容量、状态和规则命中。
- 现有系统仍是价格、Zone、规则、关税和业务记录的权威源；MCP 不复制一套权威业务数据库。
- Phase 1 只允许查询/试算、保存现有报价系统草稿、创建人工复核任务。
- Phase 1 禁止发送/发布报价、修改价格或 Zone、形成正式报关结论、订舱/SO、自动学习并上线规则，以及任何未列明的通用写操作。
- RiskCustoms 的 `ready=false` 必须原样映射为 `unavailable` 或 `manual_review`，不得由 AI 补成可用。

本仓库当前只包含共享基线文档、契约、JSON Schema 草案和后续实现计划，不包含运行时代码，也不接入生产、数据库、服务器或外部服务。

## 快速导航

- [AGENTS.md](AGENTS.md)：后续并行任务的所有权、禁止交叉修改和验证规则。
- [产品实现说明](docs/product/2026-08-11-cross-border-logistics-mcp-product-implementation.md)：目标、边界、角色、架构、流程、权限、路线图和验收标准。
- [统一响应包络](docs/contracts/envelope.md)：五种状态及审计/计算追踪要求。
- [工具目录](docs/contracts/tool-catalog.md)：Phase 1 的九个窄语义工具契约。
- [权威矩阵](docs/contracts/authority-matrix.md)：每类数据的权威源、缓存、失败策略和 MCP 禁止动作。
- [Schema 目录](docs/contracts/schemas/)：Draft 2020-12 共享模型。
- [示例目录](docs/contracts/examples/)：成功、补输入、人工复核、不可用、阻断以及关键工具的结构化示例。
- [实施计划](docs/superpowers/plans/)：货物、装柜、适配器、平台和集成安全发布的独立小步计划。

## 目录约定

```text
src/logistics_mcp/
├── platform/       # 02：租户、RBAC、envelope、审计、幂等、MCP transport
├── server/         # 02：远程 MCP 网关与工具注册
├── domains/
│   ├── cargo/      # 03：货物、CBM、体积重、分泡、计费重
│   ├── container/  # 04：理论容量与可操作容量汇总
│   ├── quote/      # 05：现有报价系统的窄适配与草稿保存
│   ├── customs/    # 05：RiskCustoms 查询/估算适配
│   ├── knowledge/  # 05：精选资料检索
│   ├── status/     # 05：数据就绪状态映射
│   └── review/     # 05：人工复核任务
└── adapters/       # 05：现有系统边界适配器

tests/
├── platform/       # 02
├── cargo/          # 03
├── container/      # 04
├── adapters/       # 05
├── domains/        # 05
└── e2e/             # 06
```

共享契约只在 `docs/contracts/**` 定义。后续任务不得在自己的 worktree 偷改共享契约；发现必须变更时，先在自己的分支写 RFC，得到基线维护者确认后再改。

## 只读核验依据

2026-08-11 已对三个现有目录做只读核验，未修改它们：

- `AI自动报价模块`：`apps/api/main.py` 注册 FastAPI 路由；`apps/api/auth.py` 有 Bearer/API-Key 和角色门禁；`packages/quote_engine/` 有确定性匹配/定价；`apps/api/db/models.py` 有 Zone、价格矩阵、报价审计和人工任务模型；`tests/quote-engine/` 覆盖精确 FSA、无价格转人工等。
- `美国、加拿大关务`：`src/worker/http/query-route.ts` 对 JSON、Schema、限流、Turnstile 和数据仓库就绪状态做门禁；`status-route.ts` 返回 `ready` 与原因；`src/shared/contracts/query.ts` 绑定来源、版本、有效期；测试覆盖就绪门禁、来源和不落原始查询审计。
- `物流LCP服务/canada-logistics-records`：`app/lib/quote-data.ts` 定义公开目录和参考费用计算；目录不可读时自动停止参考价计算；`admin-server/server.mjs` 提供单管理员草稿→发布→审计/备份流程，并将成本字段隔离在私有数据。

这些是适配器的输入证据，不代表已确认稳定的跨系统 API。跨系统调用、生产部署、租户映射和写后读端点仍标记为“待适配验证”。

## 本地验证

基线不要求安装依赖或联网。提交前至少运行：

```bash
python3 -m json.tool docs/contracts/schemas/envelope.schema.json >/dev/null
python3 -m json.tool docs/contracts/schemas/common.schema.json >/dev/null
python3 -m json.tool docs/contracts/examples/success-cargo.json >/dev/null
git diff --check
git status --short
```

后续实现按各计划中的精确命令验证；不要把 `code: 0` 当作数据读回或业务正确性的替代证据。
