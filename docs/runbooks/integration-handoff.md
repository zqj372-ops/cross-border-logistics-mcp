# Integration handoff

当前 `main` 已经整合平台、货物、装柜、失败闭合适配器、编译产物运行时、
中文脱敏后台和多客户端 MCP 元数据。本地 `main` 跟踪 GitHub 私有仓库
`zqj372-ops/cross-border-logistics-mcp`。截至 2026-08-13，远程 `main` 的
[持续验证](https://github.com/zqj372-ops/cross-border-logistics-mcp/actions/runs/31662785924)
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

## 上游合同刷新（2026-08-13）

以下结论来自本地工作树、GitHub 分支/PR/Actions 和真实调用链的重新核对。
它们是当前生产激活边界，不得用 fixture、未提交补丁或本地模块替代。

| 能力 | 当前证据 | MCP 决定 | 下一启用门槛 |
| --- | --- | --- | --- |
| AI 报价 | 远程 `main` 仍为 `8d69f9d`，只有有副作用的 `POST /quotes/zone-calculate`。本地 `/quotes/zone-preview` 候选通过 28 项定向测试，但未提交、未推送，且仍允许 `ready=true` 与 `test_data=true` 同时出现。 | `quote.canada_final_mile.calculate` 继续 `unavailable`；不调用候选端点。 | 发布纯预览 OpenAPI；版本/有效期绑定实际规则与价格快照；响应回显 tenant、origin/warehouse、billing pallets 和非测试状态；完成 PR→CI→合并→staging 读回。 |
| RiskCustoms | 当前 status/query 是匿名浏览器路径，依赖 IP、设备 Cookie 和 Turnstile；没有服务 JWT、token→tenant 映射或正式 M2M header 合同。运行路径仍是 `ready=false` / `testData=true`，也没有 estimate/OpenAPI。 | `customs.ca.search` 和 `customs.ca.estimate` 继续 `unavailable`；`start.ts` 不猜测认证 header。 | 发布服务 JWT、tenant 授权映射、M2M 限流/审计、status→query 可比 release/snapshot 证据、非测试 staging 以及独立 estimate 合同。 |
| 报价单 PDF | 远程 `main` 仍是 Electron 桌面应用；无头 bytes/hash 渲染只在本地候选提交 `b570c8c`，未进入远程分支/PR。没有 HTTP/CLI/OpenAPI、服务认证、租户存储、幂等、opaque handle 或服务端读回。 | 不注册 `pdf.*`；不暴露 PDF bytes、本地路径或明文报价 JSON。 | 上游先发布受控 `POST` 生成和同租户 `GET` 读回，返回 opaque ref/hash/version；提供 OpenAPI 3.1、大小/保留期/幂等合同及绿色 CI，再由基线 RFC 新增工具。 |

上游完成上述门槛后，MCP 只做最窄接线：报价调用无副作用 preview；
关务每次走 status→query；PDF 走 POST→GET readback 并只返回 opaque ref/hash。
详细跟踪见 [生产激活 Issue](https://github.com/zqj372-ops/cross-border-logistics-mcp/issues/2)。

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
