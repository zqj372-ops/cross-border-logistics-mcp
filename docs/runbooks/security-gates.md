# Security gates

这是集成验收清单，不是生产授权。每项都要附命令输出或 staging evidence；未验证的
真实 endpoint、issuer、tenant mapping、出站 DNS 和 RiskCustoms release 继续标记为
“待适配验证”。

## 请求边界

- HTTPS、Origin、Host 和 `Content-Type: application/json` 必须通过网关校验；请求体默认
  上限 `32 KiB`，超限为 blocked/413。
- Bearer token 由外部 verifier 验证签名后，再由网关校验 issuer、audience、sub、tenant、
  actor role、iat 和 exp；过期或未来 token blocked。
- tenant/actor/roles/scopes/client/session 只来自认证 claims。输入中的同名字段不能覆盖
  会话；跨租户请求在 adapter 前拒绝。
- 未注册工具和 Phase 1 禁止动作（发送、发布、订舱、通用写入、3D 装载布局）不进入
  下游 adapter。

## 出站与日志

- 只允许 HTTPS 和精确 hostname allowlist；拒绝 redirect、URL credentials、IP literal、
  loopback、RFC1918、link-local、IPv4-mapped private address。网络出口还必须在网关/代理
  层做 DNS rebinding 防护。
- 审计失败 fail-closed；未完成审计的结果不能释放为 success。
- 日志/审计只保留脱敏 ID、版本、状态、原因和 opaque reference metadata；不得写入 bearer、
  API key、客户地址、报价金额、税务材料全文或原始聊天。

## 证据

```bash
npm test -- --run tests/e2e/security-gates.test.ts tests/platform/http-security.test.ts
npm run typecheck
npm run lint
```

RiskCustoms `ready=false` 必须保持 `unavailable`/`manual_review`；不能用 fixture、旧数据或
模型猜值提升成 success。
