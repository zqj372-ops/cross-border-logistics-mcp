# 四节点 MCP 拓扑、带宽与 ACL Runbook

> 状态：2026-09-03 已验证 Oracle → 广州的 `read-preview-staging` 路径；其余节点按最小职责收口。
> 本文记录的是当前部署边界和后续迁移规则，不把 staging 读回解释为生产资格。

## 1. 固定角色与当前真实状态

| 节点 | 固定角色 | 架构 | 当前 MCP 状态 | 不应承载 |
| --- | --- | --- | --- | --- |
| Oracle | 主公网网关、Cloudflare 后的 TLS origin、Access Gateway、T0 MCP、PostgreSQL、监控与受控制品中转 | ARM64 | T0 生产入口保留；公网 staging 路由已反代到广州 | OCR 原始文件堆积、通用构建 Worker、无关业务 |
| 腾讯广州 | CPU Worker、定时任务和隔离的只读预览 Runtime | AMD64 | `read-preview-staging` 已运行，仅绑定 Tailscale `18080` | 公网入口、长期 API Key 验证、数据库副本、正式业务写入 |
| 阿里深圳 | 国内静态 Web、国内 webhook/edge | 以目标服务镜像实际架构为准 | 本次只完成网络角色和 ACL 收口，没有迁入 MCP Runtime | PostgreSQL、队列权威状态、报价/关务核心 |
| Tokyo | 海外 API 出口、代理、故障备用出口和 AMD64 制品缓存 | AMD64 | 本次只完成网络角色和 ACL 收口，没有迁入 MCP Runtime | 数据库、租户/Key 权威库、正式 MCP Runtime |

这次不是把四台机器拼成一个全互信集群。唯一公开的 MCP 入口仍在 Oracle；广州只接收
Oracle 发来的 staging JSON 请求。深圳和 Tokyo 的既有非 MCP 服务不因为本 Runbook 自动获得
生产资格，也不代表已经完成服务搬迁。

```text
用户 / Agent
    │ HTTPS + Cloudflare Access/WAF
    ▼
Oracle（唯一公网 MCP 入口，ARM64）
    ├── T0 MCP + Access Gateway + PostgreSQL（同节点私有路径）
    └── Tailscale tcp/18080 ──► 广州（AMD64，只读 staging Worker）
                                      │
                                      └── 审核过的测试/只读上游

深圳（国内静态 Edge） ── HTTPS ──► Oracle
Tokyo（海外出口）     ── HTTPS ──► Oracle
广州 ── 经批准的海外出口端口 ──► Tokyo（保留路径；启用前必须重新验收）
```

## 2. 带宽基线与路由决定

以下是 2026-09-03 的一次性现场测量，只用于选择迁移方式，**不是 SLA**，也不能代替运营商
合同带宽、月流量余额、P95/P99 或跨时段监控：

| 路径 | 现场结果 | 解释与决定 |
| --- | ---: | --- |
| Tokyo → Oracle，Tailscale 临时 HTTP，约 82 MB | 约 **27.7 Mbps** | 可作为受控制品回传或海外 API 通道；不能据此承诺持续吞吐 |
| Oracle → 广州，单 SSH 流 | 约 **4.59 Mbps** | 不适合每次发布都从 Oracle 重传完整镜像 |
| Oracle → 广州，四个并行 SSH 分片 | 有效约 **6.03 Mbps** | 当前制品中转最多使用 4 路并发，必须校验总 SHA-256 |
| Oracle → 广州，Tailscale 单流 | 约 **0.3 Mbps** 后中止 | 视为异常样本；没有持续监控前不把它当稳定容量 |

广州节点还出现过 Docker Hub registry 超时，因此发布不能假设目标机能稳定在线拉取基础镜像。
Oracle 公网带宽和流量最大，适合作为入口与短时制品中转，但它首先是业务网关，不应成为长期
大文件分发盘。

固定流量规则如下：

1. MCP、JWT、健康检查和审计只传有界 JSON；Oracle → 广州链路不承载用户上传原件。
2. **不跨节点复制原始 PDF**、聊天全文、OCR 图片或客户附件。后续文件工作流应使用对象存储
   的 opaque reference、短期下载凭证和生命周期策略，不能通过 MCP 包络转发二进制正文。
3. PostgreSQL、租户、Key、吊销和审计权威状态留在 Oracle；不做跨公网的同步数据库副本，
   跨节点访问 `tcp:5432` 保持拒绝。
4. 静态前端优先由 Cloudflare/深圳缓存；Oracle 只提供源站和 API，不重复传输未变化的静态包。
5. ARM64 与 AMD64 镜像分别构建、分别标记、分别校验。已加载镜像保留为目标节点本地缓存；
   仅在 digest 变化时传输，默认放在低峰期并限制为最多 4 个并行分片。
6. 备份走对象存储或专用备份目标，使用增量、压缩、加密和限速；不在四台机器之间做全量互拷。
7. Tokyo 只作为经批准的海外出口。把广州的上游请求切到 Tokyo 前，必须有显式代理配置、
   host allowlist、超时/重试上限和新的真实读回；现有直连成功不能证明代理路径已上线。

监控至少按节点采集公网/月流量、Tailscale RX/TX、接口丢包、跨节点 RTT、请求/响应字节、
上游耗时、Docker pull/build 失败和磁盘增长。告警阈值应以各云厂商的实际套餐上限为分母；在
套餐数字尚未录入前，不编造固定 Mbps 阈值。月流量建议在 70%、85%、95% 三档预警，并将
镜像发布和备份流量与业务 API 流量分开计量。

## 3. 最小 ACL

仓库基线是 [`deploy/tailscale/four-node-policy.hujson`](../../deploy/tailscale/four-node-policy.hujson)。
它采用默认拒绝，只开放以下方向：

| 来源 | 目标 | 允许端口 | 用途 |
| --- | --- | --- | --- |
| tailnet admin/owner | 四个节点 tag | `tcp:22` | 人工运维 |
| Oracle gateway | 广州 worker | `tcp:18080` | staging MCP 反代 |
| Oracle gateway | 深圳 edge | `tcp:80,443` | 国内 Edge 管理/回源 |
| Oracle gateway | Tokyo egress | `tcp:80,443,18317` | 海外出口与代理 |
| 广州 worker | Oracle gateway | `tcp:443` | 受控 API 回调/状态读取 |
| 广州 worker | Tokyo egress | `tcp:443,18317` | 预留海外出口 |
| 深圳 edge | Oracle gateway | `tcp:443` | HTTPS API 回源 |
| Tokyo egress | Oracle gateway | `tcp:443` | HTTPS API/状态回传 |

任何节点之间的 `tcp:5432`、横向 SSH、广州 `18080` 的非 Oracle 来源，以及临时制品端口
`18082` 都应被拒绝。Tailscale policy 不是云安全组或主机防火墙的替代品；OCI、腾讯、阿里、
Tokyo 提供商 ACL 与主机防火墙也必须只开放实际入口。临时测速/制品端口用完立即撤销。

变更 policy 时，必须同时保留 `tests` 中的 accept 和 deny 断言。保存失败或任一 deny 测试变成
allow 时，不得继续发布。

## 4. 跨架构制品规则

- Oracle 只运行带 `arm64` 标记并在 ARM64 构建/验证的镜像。
- 广州/Tokyo 只运行带 `amd64` 标记并在 AMD64 构建/验证的镜像。
- 广州 compose 叠加
  [`deploy/compose.read-preview-guangzhou.override.yml`](../../deploy/compose.read-preview-guangzhou.override.yml)，
  其中必须显式 `platform: linux/amd64`、Tailscale host bind 和 source SHA label。
- 发布前核对 image architecture、source SHA、image ID/digest 和归档 SHA-256；文件名或 tag 不能
  代替架构读回。
- 禁止用同一个无架构 tag 覆盖两种镜像。出现 `exec format error` 时立即恢复上一已验证镜像，
  不在运行节点上尝试修改二进制绕过。

## 5. 广州 staging 发布与读回

1. 在 AMD64 环境构建镜像，写入精确 source SHA；生成归档和 SHA-256。
2. 优先命中广州本地缓存。确需中转时，在低峰期从 Oracle 临时传输，最多 4 个并行分片；
   合并后先验 SHA-256，再加载镜像，并立即关闭临时 listener/防火墙规则。
3. 使用基础 compose 加广州 override 展开配置，确认只有 Tailscale `100.95.166.107:18080` 绑定，
   不出现 `0.0.0.0` 公网发布。
4. 先验证广州私网 `/readyz`，再由 Oracle Nginx 将三个 `/staging/` 路由切到广州；正式 T0 路由
   不参与切换。
5. 用新签发的短期 JWT 从公网走完整链路，读回精确 `7 tools / 5 resources`、stateless transport、
   source SHA、审计和限流。
6. 报价、关务和 Freightcom 的状态必须按证据返回：当前 Quote/RiskCustoms 保持 `unavailable`；
   Freightcom 仅 test，固定 `manual_review`、`authoritative=false`、`sendable=false`、
   `bookable=false`。

当前超时预算由外向内依次为：Oracle Nginx 80 秒、MCP read-preview 75 秒、T1 Worker 最长 74 秒，
单次上游 HTTP 最长 20 秒。内层必须小于外层；不得再用独立的 30 秒 Worker 截断覆盖父级 deadline。

整个扩展档位仍是 **staging-only / NO-GO**。它没有开放正式报价、关务、Freightcom 生产凭证，
也没有开放任何业务写操作。

## 6. 回滚

在 Oracle 和广州分别保留上一份已验证的本架构镜像及去密配置备份。满足任一条件立即回滚：

- 广州 `/readyz` 非 2xx、容器重启或架构不匹配；
- 公网 exact readback 不再是 7 tools / 5 resources；
- Quote/Customs 越过 `unavailable` 门禁，或 Freightcom 出现可发送/可订舱/权威标志；
- Oracle → 广州超时使公网请求超过反代上限；
- ACL deny 探针变为可达；
- 审计、限流、短期 JWT 或 source SHA 无法读回。

回滚顺序：先在 Oracle 恢复上一份 Nginx staging upstream 并验证配置，再重载；随后停止广州候选，
恢复上一 AMD64 镜像。T0、Access Gateway 和 PostgreSQL 不参与 staging 回滚。最后从公网和私网
各做一次 readiness/readback，并确认临时传输端口、服务和防火墙规则均已撤销。回滚成功只表示
恢复到上一已知状态，不自动提升生产资格。
