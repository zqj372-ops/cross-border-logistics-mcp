# 报价、关务与 Freightcom 受控读取预览 Runbook

> 状态：仅用于候选 staging。本文不授予生产资格，也不允许业务写入、发送报价或订舱。

## 1. 固定目录

`MCP_RUNTIME_PROFILE=read-preview-staging` 的 `tools/list` 必须精确等于：

```text
cargo.calculate
container.plan_summary
quote.canada_final_mile.calculate
customs.ca.search
customs.ca.estimate
quote.freightcom_ltl.preview
system.agent_context.get
```

`resources/list` 仍须精确为 5 个已审核的 `logistics://` 资源。静态模块必须精确为
`cargo`、`container`、`canada-final-mile-quote`、`riskcustoms-ca`、`freightcom-ltl` 和
`agent-access`。任何保存、发送、订舱、关务写入或通用执行工具出现都立即判定 NO-GO。

## 2. 身份边界

- MCP 只接受企业 IdP/受控签发方签发的短期 JWT；JWT 必须是 `service` 身份和精确
  `tool:<name>` scope。
- Unified Access Gateway v1 仍只允许三个 T0 工具，不能给本档位兑换扩展 scope。
- 不接受客户端提交 endpoint、token、tenant、actor 或业务 permission wildcard。
- `read-preview-caller` 只读取本档位的六模块摘要；`runtime-caller` 不得被扩大。

在扩展长期 Key 合同、吊销、审计和迁移 RFC 被接受前，不得以长期 Key 直接访问本档位。

同机 OCI staging 可运行镜像内的 `dist/deploy/issue-read-preview-staging-jwt.mjs`，由 OCI
instance principal 调用现有非导出 RSA KMS key，生成最长 300 秒的验收 token。该脚本要求显式
staging 确认短语并只允许 `t0-v1` 或 `read-preview-staging` 两个精确 scope 集；它不是长期
Key 兑换接口，也不得作为客户端常驻签发服务。

## 3. 配置准备

共享进程内的配置展开可继续使用 override 示例。真实同机 staging 必须使用独立服务、容器名和
状态卷，避免覆盖正在运行的 T0：

```bash
docker compose \
  --env-file <staging-env-file> \
  -f deploy/compose.read-preview-staging.yml \
  config
```

`deploy/compose.read-preview-staging.override.yml.example` 只用于隔离环境中的配置审阅，不得在
同一 Compose project 中覆盖正式 `logistics-mcp` 服务。独立 staging 固定使用
`logistics-mcp-read-preview-staging` 和 `logistics-mcp-read-preview-staging-state`。

该命令只做配置展开，不代表服务已连接。必须提供：

- 精确的 JWKS、Quote、RiskCustoms 和 Freightcom test 出站主机白名单；
- 由 Secret Manager 挂载的三个凭证文件引用，凭证正文不得进入环境变量；
- Quote 的闭合 tenant/warehouse→`toronto|calgary` 映射文件；
- Quote 和 RiskCustoms 的 HTTPS base URL 及各自二次 host allowlist；
- RiskCustoms 与 Freightcom 的精确 tenant allowlist，不允许 `*`。

Quote origin map 的格式固定为：

```json
{
  "schema_version": "2026-09-02.v1",
  "tenants": {
    "tenant-staging": {
      "warehouse-toronto": "toronto"
    }
  }
}
```

真实值必须保存在部署系统之外，仓库示例不得包含客户标识或凭证。

真实 endpoint 不等于已取得资格。若 `/quotes/zone-preview` 或 RiskCustoms M2M route 尚未部署，
对应 adapter 必须保持 `enabled=false`；不得用占位 secret 或其他旧接口伪造一次成功出站。

## 4. 隔离进程验收

主 MCP 进程只能构造 T1 worker client；业务 HTTP adapters 和 secret readers 只能存在于
`dist/src/logistics_mcp/t1-worker/start.mjs`。保存以下证据：

- worker 使用独立 PID、非 root、只读根文件系统、无 capabilities 和有界 CPU/内存/PID；
- worker 只继承审核过的 `MCP_*` 配置键，不继承数据库 URL、管理员凭证或父进程任意环境；
- stdin/stdout 只接受固定版本 NDJSON、固定方法、请求 ID 和 deadline；
- 超时、退出、未知方法、超大消息、坏 JSON 和协议漂移均失败闭合且不泄露路径/secret；
- worker 不健康时 `/readyz` 返回非 2xx，但单一业务上游 `ready=false` 只影响对应工具结果。

当前镜像内为独立子进程边界；正式生产仍需单独容器/沙箱、独立 egress policy 和重启告警证据。

## 5. 工具资格读回

### Quote

默认关闭时必须返回 `unavailable` 且零出站。启用后保存严格 v2 响应证据：tenant、origin、
effective date、`ready=true`、`test_data=false`、release、snapshot/release hash、有效期、金额和
source refs 全部一致。结果始终 `sendable=false`。候选 `/quotes/zone-preview` 没有正式发布证据前，
即使合成测试通过也仍为 NO-GO。

### RiskCustoms

`customs.ca.search` 必须先读取 status，再在同一身份与发布快照下 query。`ready=false`、
`testData=true`、release/source/hash 或 tenant 不匹配时不得 query。`customs.ca.estimate` 必须固定
`unavailable` 且零 HTTP 请求，直到正式估算合同另行获批。

### Freightcom

只允许固定 Freightcom test host，只执行 pallet LTL `POST /rate` 与有界轮询。结果必须固定
`manual_review`、`authoritative=false`、`sendable=false`、`bookable=false`，不得做 FX、保存、发送
或订舱。生产 Freightcom endpoint 和生产凭证不在本档位范围内。

## 6. 验收与回滚

在合成测试全绿后，目标 staging 仍须完成短 JWT、跨租户拒绝、7 tools / 5 resources exact
readback、审计、限流、负载、告警、secret 吊销、备份恢复和上一 T0 镜像回滚演练。所有真实
回执须绑定同一 source SHA、image digest、Standard Pack digest、catalog generation 和去密配置
hash。

回滚时撤下本 override 和扩展 JWT scope，恢复上一已验证的 `t0-v1` 镜像与配置。不得静默把
`read-preview-staging` 改名为生产，也不得保留扩展凭证挂载。任一真实证据缺失时结论固定为
**staging-only / NO-GO**。

同机告警探针由 `deploy/systemd/freightclaw-read-preview-healthcheck.*` 提供。演练至少保存一次
readiness 失败和一次恢复后的 journal 读回；它只证明本机告警状态流转。没有配置并验证外部
通知目的地时，不得写成告警已送达值班人员。
