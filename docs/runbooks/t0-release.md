# T0 单区域发布 Runbook

> 状态：候选发布流程，当前全部真实环境证据均为 `[待实际执行]`。本文不会授予生产资格，
> 也不会把本地测试、fixture、静态页面或 `/healthz=200` 写成上线完成。

## 1. 固定发布范围

候选 `t0-v1` 的 `tools/list` 必须精确等于：

```text
cargo.calculate
container.plan_summary
system.agent_context.get
```

`resources/list` 必须精确等于 RFC 锁定的五个 `logistics://` 资源。报价、RiskCustoms、
Freightcom、订舱、文档和任何业务写操作必须未注册、未初始化且无业务出站连接。

## 2. 发布前外部先决条件

以下项目必须由对应环境 owner 提供真实回执；仓库内的 provider port、fixture 或示例值不能替代：

- real IdP：管理员 SSO/MFA、角色映射、Gateway issuer/audience；
- KMS / Secret Manager：API Key pepper 和 JWT 签名私钥，应用不得导出私钥；
- 企业 TLS/WAF/Edge：MCP 不直接暴露公网端口，配置分层限流和 Edge denylist；
- 托管 Gateway 数据库与集中审计：状态、幂等和审计原子持久化；
- 监控、告警、备份和恢复平台；
- staging、生产、发布、安全、运维和回滚 owner。

任一 owner 或真实环境缺失时，本候选保持 **NO-GO**。

## 3. 冻结候选与不可变证据

不得只记录 tag。发布记录必须绑定同一个候选的：

| 证据 | 要求 | 当前状态 |
| --- | --- | --- |
| source SHA | 已合并且受保护的 `main` 精确 commit | `[待实际执行]` |
| lockfile hash | `package-lock.json` 的 SHA-256 | `[待实际执行]` |
| Node 版本 | 与 CI/镜像一致的 `22.13.0` | `[待实际执行]` |
| image digest | registry 返回的不可变 `sha256:...` | `[待实际执行]` |
| Standard Pack digest | 构建产物 bytes 与 reviewed descriptor 双重读回 | `[待实际执行]` |
| catalog generation | profile、3 modules、3 tool contracts、5 resources 与同一 image/Pack 的内容寻址收据 | `[待实际执行]` |
| config hash | 去除 secret 正文后的版本化配置 canonical hash | `[待实际执行]` |
| SBOM / provenance | 与同一 image digest 关联 | `[待实际执行]` |

先执行仓库与 CI 门禁，再构建、签名和推送镜像。任何测试失败、依赖/secret/SAST/镜像/许可证
扫描失败或来源证明缺失都停止流程。

## 4. Staging 启动与目录读回

1. 只使用真实 Gateway 签发的短期 JWT；长期 `lmcpk_...` Key 只能调用 token exchange。
2. 明确设置 `MCP_TRANSPORT_MODE=stateless`。该模式不返回或接受 `Mcp-Session-Id`；如为已核验
   的旧客户端使用 `stateful`，必须同时保存 durable binding、owner 和容量证据，不能混合模式。
3. 部署不可变 image digest 和固定 config hash；运行时使用只读 root、non-root、cap drop、
   no-new-privileges、CPU/内存/PID 限制和持久状态卷。
4. 确认 `/healthz=200` 后继续确认 `/readyz=200`；只有 health 不能接流量。
5. 使用官方 MCP SDK initialize，并保存脱敏响应：
   - `tools/list` exact set 为 3；
   - `resources/list` exact set 为 5；
   - `logistics://modules/catalog` 的 `schema_version`、`profile`、`catalog_generation`、
     `catalog_digest` 与候选收据逐字一致，且 generation 后缀等于 digest hex；
   - bootstrap、profile 和 Standard Pack digest 与同一候选一致；
   - 任一非 T0 工具不可见且调用返回稳定失败，不触发 adapter 或网络。
6. readiness、目录或 Agent Pack 不一致时，由 Edge 摘流并判定 NO-GO。

仓库提供的 `smoke:t0-deployment` 和 `load:t0-deployment` 会创建合成 tenant/credential，属于
明确的 staging 写操作。执行者必须额外设置对应的 `DEPLOYMENT_*_ENVIRONMENT=staging` 和既有
确认短语；脚本会先回读目标 `/access/v1/readyz`，仅在目标同时报告
`profile=single-node-candidate`、`operational_ready=true`、`production_eligible=false` 时才打开
本地 Gateway SQLite。任何 production eligibility、profile 漂移、readiness 非 200 或无法核验
都必须在写入前失败闭合。smoke 必须真实执行 `cargo.calculate` 和
`container.plan_summary` 的代表性成功向量，不能用固定状态代替调用结果。

以上实际响应、时间戳、request/audit ID 和证据链接：`[待实际执行]`。

## 5. 身份、租户、Key 和短 JWT 验收

在 real IdP 管理员会话中创建合成 staging tenant/client，完成一次性 Key 签发、交付确认、
精确 entitlement、token exchange 和 JWKS 校验。逐项验证：

- 三个 exact `tool:` scope，不含 `platform:admin`、旧 broad scope 或非 T0 scope；
- JWT 目标 5 分钟且不超过 15 分钟，claims/算法/`kid` 符合 Credential Exchange RFC；
- tenant/client/key 暂停、轮换和吊销阻断新 token；
- 已签短 JWT 的收敛边界由 TTL 与 Edge denylist 明确验证；
- 跨 tenant/client/session、错误 issuer/audience、过期/未来 token 全部拒绝；
- Gateway 审计落盘失败时不签 token，MCP 审计失败时工具不返回 success；
- MCP 入口拒绝长期 API Key。

credential 必须持久化签发时的 pepper version。候选环境轮换前先备份并确认本地受保护 pepper
history 已建立，再以全新 bytes 和全新 version 启动；旧、新 Key 都要完成 exchange 回读。禁止
用新版本重新标记旧 hash、复用版本名或在仍有 credential 引用时删除验证材料。该候选 keyring
不等同于生产 KMS，正式生产仍以 Secret Manager/KMS 和集中吊销回执为准。
旧 v1/v2 SQLite 首次迁移到 v3 时还必须显式设置旧 credential 实际使用的
`ACCESS_GATEWAY_LEGACY_PEPPER_VERSION`，并先证明 keyring 中存在该版本；禁止把 current version
当作迁移默认值。迁移、备份和旧 Key exchange 回读完成后才可移除该临时参数。

证据：`[待实际执行]`。

## 6. 三客户端和确定性调用验收

ChatGPT、Codex、企业 Agent 分别执行 bootstrap、token 续期和重连，且每类客户端保存真实
staging 回执。至少覆盖：

- cargo：`success`、`needs_input`、`manual_review`；
- container：`success`、`needs_input`、`manual_review`、3D/现场承诺 `blocked`；
- Agent context：只允许 `runtime-caller`，未知 profile 和资源 scope 被拒绝；
- 五态不被客户端改写为成功，也不使用模型或默认值 fallback。

三类客户端证据：`[待实际执行]`。

## 7. 负载、可观测和告警演练

初始验收目标为 **50 concurrency**、持续 10 分钟。记录请求量、p50/p95/p99、五态分布、
认证拒绝、审计失败、readiness、重启次数、CPU/内存/PID、SQLite 或托管库健康。证明无跨租户、
无 golden vector 漂移、无未受控内存增长；目标阈值由 owner 批准后固定。

必须真实触发并确认 alert 送达：readiness 失败、认证拒绝异常增长、audit failure、磁盘空间、
重启循环。负载与告警回执：`[待实际执行]`。

## 8. Backup / restore 演练

在非空 staging 数据上执行 backup，再恢复到隔离目标，记录 RPO、RTO、备份 digest、加密引用、
执行人和时间。恢复后读回 tenant/client/key 元数据、entitlement、operation/audit、MCP session
metadata、audit 和 idempotency，并重新执行 3 工具 / 5 资源 exact smoke。

backup、restore、RPO、RTO 证据：`[待实际执行]`。

## 9. Rollback 演练与发布决定

按 [T0 回滚 Runbook](t0-rollback.md) 回滚到上一份已验证的 previous image digest、previous
config hash、previous Standard Pack digest 和 previous catalog generation，完成 `/readyz`、目录、
身份、计算和审计读回。

rollback 证据：`[待实际执行]`。

只有上述证据全部绑定同一候选，且安全、平台、运维和业务 owner 明确批准，才可进入受控 canary。
任一证据缺失、目录漂移、长期 Key 直达 MCP、非 T0 adapter 构造、审计失败仍成功、真实恢复或
回滚未演练，结论固定为 **NO-GO**。
