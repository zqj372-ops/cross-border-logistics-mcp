# T0 单区域候选证据模板

> 复制本模板到受控证据系统后填写。仓库版本故意保持 `[待实际执行]`，不得提交 secret、长期
> API Key、Bearer token、私钥、连接串、客户数据、完整请求体或敏感日志。

## A. 候选身份

| 字段 | 回执 |
| --- | --- |
| 环境 / 区域 | `[待实际执行]` |
| source SHA | `[待实际执行]` |
| image digest | `[待实际执行]` |
| lockfile hash | `[待实际执行]` |
| Standard Pack digest | `[待实际执行]` |
| config hash | `[待实际执行]` |
| SBOM / provenance reference | `[待实际执行]` |
| 执行人 / 时间窗口 | `[待实际执行]` |

## B. 企业依赖回执

| 依赖 | Owner / 版本 / 脱敏证据链接 | 结果 |
| --- | --- | --- |
| real IdP + SSO/MFA/角色映射 | `[待实际执行]` | `[待实际执行]` |
| KMS / Secret Manager + key rotation | `[待实际执行]` | `[待实际执行]` |
| TLS/WAF/限流 | `[待实际执行]` | `[待实际执行]` |
| Edge denylist（tenant/client/jti） | `[待实际执行]` | `[待实际执行]` |
| 托管 Gateway DB / 集中审计 | `[待实际执行]` | `[待实际执行]` |
| JWKS 发布、缓存和轮换 | `[待实际执行]` | `[待实际执行]` |

## C. Exact runtime readback

| 检查 | 脱敏 evidence reference | 结果 |
| --- | --- | --- |
| `/healthz` | `[待实际执行]` | `[待实际执行]` |
| `/readyz` | `[待实际执行]` | `[待实际执行]` |
| `tools/list` exact 3 | `[待实际执行]` | `[待实际执行]` |
| `resources/list` exact 5 | `[待实际执行]` | `[待实际执行]` |
| catalog schema/profile/generation/digest exact readback | `[待实际执行]` | `[待实际执行]` |
| bootstrap/profile/Pack digest | `[待实际执行]` | `[待实际执行]` |
| 非 T0 工具不可见、不可调用、零 adapter/network | `[待实际执行]` | `[待实际执行]` |
| MCP 拒绝长期 API Key | `[待实际执行]` | `[待实际执行]` |

## D. Gateway、租户和客户端

记录 tenant/client/Key 的 opaque ID 与末尾提示，不记录明文凭证。

| 场景 | request/operation/audit reference | 结果 |
| --- | --- | --- |
| 创建、暂停、恢复 tenant/client | `[待实际执行]` | `[待实际执行]` |
| 一次性 Key 签发与交付确认 | `[待实际执行]` | `[待实际执行]` |
| exact entitlement / token exchange | `[待实际执行]` | `[待实际执行]` |
| 轮换、吊销、短 JWT 过期 | `[待实际执行]` | `[待实际执行]` |
| tenant/client/session 隔离 | `[待实际执行]` | `[待实际执行]` |
| 审计失败闭合 / 分层限流 | `[待实际执行]` | `[待实际执行]` |

## E. Agent 和确定性向量

| 客户端/向量 | 证据 | 结果 |
| --- | --- | --- |
| ChatGPT bootstrap / renew / reconnect | `[待实际执行]` | `[待实际执行]` |
| Codex bootstrap / renew / reconnect | `[待实际执行]` | `[待实际执行]` |
| 企业 Agent bootstrap / renew / reconnect | `[待实际执行]` | `[待实际执行]` |
| cargo success / needs_input / manual_review | `[待实际执行]` | `[待实际执行]` |
| container success / needs_input / manual_review / blocked | `[待实际执行]` | `[待实际执行]` |

## F. 运维演练

| 演练 | 目标 | 实际回执 |
| --- | --- | --- |
| load | 50 concurrency × 10 分钟；记录 p50/p95/p99 和资源 | `[待实际执行]` |
| backup | 非空、加密、digest 可核验 | `[待实际执行]` |
| restore | 隔离恢复并重复 exact smoke | `[待实际执行]` |
| RPO | 目标不高于 15 分钟，最终由 owner 批准 | `[待实际执行]` |
| RTO | 目标不高于 60 分钟，最终由 owner 批准 | `[待实际执行]` |
| alert | readiness/auth/audit/disk/restart 真实触发与送达 | `[待实际执行]` |
| rollback | previous image/config/Pack 三元组并重复 exact smoke | `[待实际执行]` |

## G. 审批与结论

| 角色 | 审批人/时间/证据 | 决定 |
| --- | --- | --- |
| 平台 | `[待实际执行]` | `[待实际执行]` |
| 安全 | `[待实际执行]` | `[待实际执行]` |
| 运维/值班 | `[待实际执行]` | `[待实际执行]` |
| 业务 owner | `[待实际执行]` | `[待实际执行]` |

最终结论：`[待实际执行：GO / NO-GO]`。
