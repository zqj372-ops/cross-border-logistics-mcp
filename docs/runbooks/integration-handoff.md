# Integration handoff

当前 `main` 已经整合平台、货物、装柜、失败闭合适配器、编译产物运行时、
中文脱敏后台和多客户端 MCP 元数据。本地 `main` 跟踪 GitHub 私有仓库
`zqj372-ops/cross-border-logistics-mcp`。截至 2026-08-13，远程 `main` 的
[持续验证](https://github.com/zqj372-ops/cross-border-logistics-mcp/actions/runs/31662490464)
已通过编译、全量测试、类型检查、代码规范、契约校验、演示发布门禁、容器配置和
候选镜像构建。这些证据不代表业务 API 或生产部署已验收；在取得批准的 staging
证据前不连接现有生产系统。真实跨系统 endpoint、tenant mapping、认证、
RiskCustoms estimate 和写后读 API 均为“待适配验证”。
当前 `start.ts` 已接入 RS256/JWKS 签名验证和 issuer/audience/短时 token policy；
JWKS 主机必须在 HTTPS 出站白名单。生产身份源还必须经 staging 验证能提供
`tenant_id`、`actor_role`、`roles`、`scopes`、`client_id` 和 `session_id` 等合同 claims；
未验证前仍标记“待身份适配验证”。生产组合同时要求 SQLite durable
audit/idempotency/session-binding 和 production adapter source；
缺任一依赖时不创建 Memory fallback，`/readyz` 为 `503/not_ready`，`/mcp` 在认证和 adapter
之前返回 `503/unavailable`。fixture 只使用有界本地 session registry；MCP SDK runtime 对象不进入
SQLite binding store。

## 精确验证命令

```bash
npm ci
npm run build
npm test -- --run tests/platform tests/cargo tests/container tests/adapters tests/domains tests/e2e
npm test -- --run
npm run typecheck
npm run lint
npm run validate:schemas
git diff --check
git status --short
docker compose --env-file deploy/env.example -f deploy/compose.yml config
bash deploy/scripts/check-release.sh --fixture-only
```

Docker build 只允许在本地做非推送验证；不可用时记录“Docker 未验证”，不以 compose config
代替镜像构建证据。测试 fixture 不读 `.env`、系统凭证或真实 URL；每个 harness 都调用
`close()`。

## 交接边界

- 唯一注册九工具：`cargo.calculate`、`container.plan_summary`、
  `quote.canada_final_mile.calculate`、`quote.save_draft`、`customs.ca.search`、
  `customs.ca.estimate`、`knowledge.search_curated`、`system.get_data_status`、
  `review.create_task`。
- 五状态必须闭合；`unavailable`、`manual_review`、`blocked` 不能提升为 success。
- 生产组合默认禁用未核验适配器；fixture 只接受 `DATA_MODE=fixtures`/显式 fixture mode。
- 两个窄写工具只能 preview→approval policy→commit→readback；不发送/发布报价、不订舱、不
  改价格/Zone/税率、不建立第二套业务主数据。
- 报价 `sendable=false`、装柜 `theoretical_only=true` 是客户端不可越过的边界。
