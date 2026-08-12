# Security gates

这是集成验收清单，不是生产授权。每项都要附命令输出或 staging evidence；未验证的
真实 endpoint、issuer、tenant mapping、出站 DNS 和 RiskCustoms release 继续标记为
“待适配验证”。

## 请求边界

- HTTPS、Host 和 `Content-Type: application/json` 必须通过网关校验；浏览器提供 Origin 时
  必须精确命中白名单，非浏览器 MCP 客户端可不提供 Origin。请求体默认
  上限 `32 KiB`，超限为 blocked/413。
- Bearer token 由内置 RS256/JWKS verifier 验证签名后，再由网关校验 issuer、audience、sub、tenant、
  actor role、iat 和 exp；过期或未来 token blocked。
- tenant/actor/roles/scopes/client/session 只来自认证 claims。输入中的同名字段不能覆盖
  会话；跨租户请求在 adapter 前拒绝。
- 企业身份源必须在 staging 用脱敏短时 token 验证定制 claims 映射；JWKS
  health 只证明公钥可用，不代表 claims 合同已验收。
- 未注册工具和 Phase 1 禁止动作（发送、发布、订舱、通用写入、3D 装载布局）不进入
  下游 adapter。
- 每个 session 绑定 tenant、actor、client、认证 session 和 context fingerprint；idle TTL、
  max lifetime、token expiry 上限和 max sessions 必须有界。context 不匹配不能复用或 touch，
  过期/关闭必须关闭对应 SDK server/transport。

## 出站与日志

- 只允许 HTTPS 和精确 hostname allowlist；`createFetchJsonClient` 初始化时以及每次解析
  请求 URL 后都必须复用 `assertAllowedOutboundUrl`。统一策略要正确规范化大小写、末尾点
  和 IPv6 方括号，并拒绝 redirect、URL credentials、IP literal、loopback、RFC1918、
  link-local、IPv4-mapped private address；即使这些地址被误加入 allowlist，也必须在应用层
  拒绝。测试应通过真实 HTTP client 请求路径验证，不只单测 security helper。
- 应用层这里只检查 URL/hostname，不做 DNS 解析，不能单独解决 DNS rebinding。生产网络出口
  仍必须由 egress proxy/firewall 对解析后的目的 IP 执行 allow/deny 和 rebinding 防护。
- 生产 assembly 不得把 Memory audit/idempotency 实现当作 durable；缺 audit、幂等、session
  binding、token verifier 或 adapter source 时 readiness fail-closed，`/mcp` 不调用认证器或下游。
- 审计失败 fail-closed；未完成审计的结果不能释放为 success。
- 日志/审计只保留脱敏 ID、版本、状态、原因和 opaque reference metadata；不得写入 bearer、
  API key、客户地址、报价金额、税务材料全文或原始聊天。

## Admin 控制台边界

- `/admin` 静态路由在 `start.ts` 中发生于 MCP bearer auth 之前；`MCP_ADMIN_UI_ENABLED` 默认关闭，
  未显式开启时返回 blocked/404。构建固定包含四个静态资源，不代表运行时已经开放。
- 当前控制台只有静态壳和固定 `503/unavailable` 的 snapshot 占位。只有在批准的企业身份网关/访问
  控制之后才可开启 `MCP_ADMIN_UI_ENABLED=true`，不得直接暴露公网；不新增 header bypass、共享密钥
  或万能 admin token。
- 未来 snapshot/provider 接入必须另行完成 admin RBAC、tenant binding、CSRF/Origin、版本/审批/审计，
  不能把 MCP bearer auth 或静态文件可达性当作控制台授权。

## 证据

```bash
npm test -- --run tests/e2e/security-gates.test.ts tests/platform/http-security.test.ts
npm run typecheck
npm run lint
```

RiskCustoms `ready=false` 必须保持 `unavailable`/`manual_review`；不能用 fixture、旧数据或
模型猜值提升成 success。
