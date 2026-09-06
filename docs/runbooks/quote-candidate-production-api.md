# Quote candidate 只读生产 API 接入与验收

更新日期：2026-09-05

## 边界

本步骤只发布候选镜像的两个只读预览接口：

- `POST https://quote.freightclaw.net/api/v1/m2m/quote/zone-preview`
- `POST https://quote.freightclaw.net/api/v1/m2m/quote/ai-extract-preview`

旧站根路径仍由 `canada-quote-web` 提供。流程不调用 record、review 或 document 路由，也不生成 PDF。一次 service actor 技术验收不代表企业组织、Portal 授权或正式报价发送闭环已完成。

## 路由发布

候选容器必须是已经审核的精确镜像，并继续绑定原报价数据库网络：

```bash
sudo python3 /tmp/start-quote-candidate.py \
  --image freightclaw-quote-api:<immutable-image-id>
```

脚本只在镜像一致时复用已有容器，并幂等连接 `freightclaw-net`。将 `deploy/portal/quote-locations.nginx` 的 location 插入 `quote.freightclaw.net` 的 HTTPS server 前，先备份：

```bash
sudo cp --preserve=mode,ownership,timestamps \
  /data/freightclaw/nginx/conf.d/quote.freightclaw.net.conf \
  /data/freightclaw/nginx/conf.d/quote.freightclaw.net.conf.bak.<UTC timestamp>
sudo docker exec freightclaw-web nginx -t
sudo docker exec freightclaw-web nginx -s reload
```

只有 `nginx -t` 成功后才能 reload。失败时恢复刚生成的备份并重新执行 `nginx -t`。不得修改 `location /`。

Cloudflare Configuration Rule 只匹配：

```text
(http.host eq "quote.freightclaw.net" and starts_with(http.request.uri.path, "/api/v1/m2m/quote/"))
```

该规则仅关闭 Browser Integrity Check；源站 mTLS、连接密钥、RS256 委托、Nginx 限流与请求体限制继续生效。

## 安全验收方法

连接密钥和委托私钥只从服务器私有文件读入验收进程。不得写入命令参数、日志、临时 JSON 或终端输出。委托 JWT 使用 service actor，寿命不超过 300 秒，并逐项绑定 issuer、audience、tenant、service caller、application、request ID 和单一 scope。

公开测试样例可使用公开机构地址，例如 Toronto City Hall；禁止客户地址、客户消息或历史报价。验收只打印以下摘要：HTTP 状态、包络状态、原因码、source version、source ref 数量及执行前后记录计数。

负向用例至少包括：

1. 无连接凭据，预期 `401 / blocked / service_connection_unauthorized`；
2. 委托 tenant 与连接配置不一致，预期 `403 / blocked / delegation_binding_mismatch`；
3. 委托 scope 与路由不一致，预期 `403 / blocked / delegation_scope_denied`。

执行前后比较 `sales_quote_records`、`manual_quote_tasks`、`m2m_quote_operations`、`m2m_quote_documents`。任一计数变化都应停止验收并调查。

## 2026-09-05 实际读回

- 候选容器：`freightclaw-quote-api:8c26d1c5f71d`，健康接口返回 `{"status":"ok"}`；容器同时连接原报价网络和 `freightclaw-net`。
- 数据库迁移：`0024_add_m2m_quote_records`；四类计数前后分别为 `1919 / 678 / 0 / 0`，调用后完全不变。
- Zone 预览：HTTP 200、`success`、schema `quote-preview@2026-09-05.v2`、1 个 source ref、source version `2026-06-03`。
- AI 提取预览首次验收为 HTTP 503、`unavailable`、`ai_extraction_unavailable`，返回模式为 `deterministic_recovery`。后续诊断确认默认配置启用、密钥可解密；默认 provider host 为 `opencode.ai`，model 为 `deepseek-v4-flash`。一次最小 provider 探针在 30 秒发生 `ReadTimeout`，紧接着同配置的完整双代理结构化提取约 23 秒成功。
- 随后再次通过公网 M2M 端点验收：HTTP 200、`success`、`extraction_mode=ai`、无缺项，并再次确认四类数据库计数不变。这证明当前生产非客户样例可调用；上游曾出现一次延迟超时，仍应通过持续运行指标观察稳定性，不能从单次成功推断 SLA。
- 三个负向用例均按预期失败闭合。Python `urllib` 在窄 Cloudflare 规则生效后能收到源服务 JSON，不再收到 1010 HTML。
- 旧站 `https://quote.freightclaw.net/` 仍返回 HTTP 200 HTML；未替换旧 Web 应用。

## 真实企业绑定读回

聚仓科技开户后，固定租户已从未开户的计划目标替换为真实 `tenant_d7f0f731a0a851940fdc12c2`。使用同一镜像 `freightclaw-quote-api:8c26d1c5f71d` 受控重建，继续连接两个既有网络。真实 HTTPS service actor 的 Zone 预览再次返回 200 success、`quote-preview@2026-09-05.v2`，请求标识匹配；未创建客户报价或执行复核/PDF。该结果证明新租户连接可用，企业人员授权和正式价格复核仍需分别验收。

此次配置回滚备份位于 `/data/logistics-mcp/portal/backups/business-rebind-20260905T153755Z`。

回滚路由时恢复上述 Nginx 备份，执行 `nginx -t`，成功后 reload；Cloudflare 中停用 `FreightClaw quote M2M API - disable BIC`。候选容器可从 `freightclaw-net` 断开，不删除原报价网络或旧 API 容器。
