# T0 Client onboarding

ChatGPT、Codex 和企业助手使用同一个受企业 Edge 保护的远程 MCP endpoint。仓库中的
`deploy/clients/*` 只是不含真实身份的配置模板；假地址、静态模板和解析测试不能证明真实客户端
已经兼容。

生产 `t0-v1` 客户端只接收 Unified Access Gateway 签发的短期 JWT。长期 API Key 仅用于
`POST /access/v1/token/exchange`，不得写入提示词、仓库、普通配置或日志，也不得直接发送给 MCP。
tenant、actor、roles、scopes、client 和 session 均由服务端校验后注入，客户端不能提交或覆盖。

## T0 精确目录

`tools/list` 必须精确等于：

```text
cargo.calculate
container.plan_summary
system.agent_context.get
```

`resources/list` 必须精确等于：

```text
logistics://agent/bootstrap
logistics://standards/index
logistics://contracts/envelope/current
logistics://modules/catalog
logistics://agent/profiles
```

生产 T0 不注册报价、RiskCustoms、Freightcom、知识/状态、复核或任何业务写工具。旧的九业务工具
只属于历史 Phase 1/fixture 验证范围；它们不是 `t0-v1` 可用能力，不能出现在 T0 客户端模板或
生产 `tools/list` 中。

## 首次连接顺序

1. 客户端从企业 secret injection 取得长期 Key，向 Gateway 兑换所需 exact T0 scopes 的短期 JWT；
2. 使用短期 JWT initialize MCP session；
3. 读取 `resources/list`，验证精确五项；
4. 读取 `logistics://agent/bootstrap`、`logistics://standards/index` 和
   `logistics://agent/profiles`；
5. 读取 `logistics://modules/catalog`，验证 `schema_version=2026-09-02.v1`、目标 profile、
   `catalog_generation`、`catalog_digest` 和精确三个模块；generation 后缀必须等于 digest hex；
6. 调用 `system.agent_context.get({"profile_id":"runtime-caller"})`；
7. 读取 `tools/list`，验证精确三项；
8. 只按返回 Schema 调用 cargo/container，并保留版本、source refs、warnings、blockers 和 trace；
9. JWT 到期后重新兑换并建立新 session，不把旧 token 当作可续期长期凭证。

Pack 缺失、hash/descriptor/profile/catalog 不一致、未知资源或逐资源 scope 不满足必须失败闭合；
客户端不能回退读取工作目录 Markdown、网络说明或模型自造规则。

## 五态处理

- `success`：展示版本、来源、trace 和 warnings；仍遵守 `sendable=false` 与
  `theoretical_only=true`。
- `needs_input`：把 blockers 转成补问；禁止猜重量、单位、规则或其他默认值。
- `manual_review`：保留原因和来源交给人工复核，不改写为确定结果。
- `unavailable`：说明权威依赖不可用，不以旧数据、fixture、搜索或模型估值替代。
- `blocked`：停止调用并展示脱敏拒绝原因，不改名重试或绕过权限、Gateway/Edge。

## Staging 验收

ChatGPT、Codex 和企业助手必须分别保存真实 staging 回执，至少覆盖：

1. Gateway 一次性 Key 交付、短 JWT exchange、TTL/续期和 JWKS；
2. `tools/list` 精确 3、`resources/list` 精确 5、Pack/profile/catalog digest 一致；
3. cargo/container 的 `success`、`needs_input`、`manual_review`，以及 container 3D 请求 `blocked`；
4. 错误 issuer/audience、过期 token、错误 tenant/client/session、非 T0 scope 全部拒绝；
5. Key/tenant/client 吊销阻断新 token，Edge denylist 和新 session 策略按 RFC 生效；
6. 每次成功/拒绝均有脱敏 request/audit ID，审计失败时不签 token且工具不返回 success。

在取得上述真实回执前，三份模板的兼容状态统一为：**待真实 staging 适配验证**。
