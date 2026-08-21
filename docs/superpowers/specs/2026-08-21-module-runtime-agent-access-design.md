# Module Runtime + Agent Standard Access v0 设计

## 目标

让独立 MCP 服务同时拥有稳定的模块运行时、机器可读的标准注册表，以及面向不同
Agent 角色的最小安全上下文投影。目标是可验证的 v0，不把 DeepSeek Harness、某个
IDE 或某个 Agent 当作宿主依赖。

## 采用的方案

### 1. Module Runtime

`ModuleHost` 在启动阶段接收一组静态可信 `ModuleDefinition`。host 创建
`CapabilityRegistry`、`ModuleCatalog` 和 `RegistrationLease`，按 manifest 校验依赖，
执行 `mount`，完成后才把工具目录暴露给 server。每个工具包含 canonical name、输入/输出
契约、权限、风险级别、handler 和标准引用。重复工具名、缺少能力、版本不匹配、mount
异常都会阻止 host 成功；关闭时按反序释放注册资源。

v0 不做运行时远程下载、模型决定的模块写入和 hot-plug。cargo/container 通过适配层把
现有领域 handler/contract 映射为 module contribution，业务计算仍由原领域代码负责。

### 2. Standard Registry

权威源是 `docs/agent/index.json`、profile JSON 和列出的标准文档。每个标准有稳定 `id`、
`version`、`priority`、`audience`、`rule_ids` 和相对 `path`。规则 ID 由正则约束且在注册表
中全局唯一。resolver 只接受 profile ID 和 allowlisted module ID；它先选 profile 的
standard set，再按 priority 降序合并，规则 ID 重复且内容 hash 不一致时返回冲突。

构建器把已解析内容、source ref、sha256、规则元数据写入
`dist/standards/agent-standard-pack.json`，通过临时文件 + rename 生成，避免半包被读取。
运行时只加载 pack，开发 CLI 才读取受注册表约束的源文件。

### 3. Agent Access Layer

profile 分为 `module-developer`、`platform-developer`、`module-reviewer`、
`release-operator`、`runtime-caller`。它们只表达 audience、标准集和上下文范围，
不表达凭据或任意路径。resolver 返回同一结构的 JSON/Markdown 投影，脱敏字段不包含
绝对路径、租户记录、网络地址和秘密。

MCP 资源固定为：

- `logistics://agent/bootstrap`
- `logistics://standards/index`
- `logistics://contracts/envelope/current`
- `logistics://modules/catalog`
- `logistics://agent/profiles`

`system.agent_context.get` 只读，输入为 profile ID 与可选模块 ID；它在服务端通过
`ExecutionContext` 做权限检查，返回既有响应包络，并把未就绪/冲突状态原样保留。

## 关键不变量

- 既有业务工具的名称、契约、五种状态和权限不改变。
- 新增 Agent 能力默认 fail-closed；没有 pack 就是 `unavailable`。
- 任意 module/standard/profile 输入都不能跳出注册表的 allowlist。
- 只保留必要的版本引用、hash 和 opaque ref，不复制报价、关税或客户数据。
- 任何写操作仍然服从 tenant/actor 注入、幂等、预览/审批、写后读回约束。

## 暂不做

- 运行中远程模块安装、模块代码签名和任意第三方 registry。
- 将所有旧领域一次性重写成模块；先以窄适配验证目录与生命周期。
- 为每个客户端维护不同事实版本；客户端适配只声明 transport、auth、资源和工具发现
  规则，事实仍以标准 pack 与 MCP server 为准。
