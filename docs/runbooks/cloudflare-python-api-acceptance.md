# Cloudflare Python API 验收

## 已确认故障

2026-09-05 从本机、Oracle 节点和远程节点使用 Python 标准库 `urllib.request` 请求 FreightClaw 时，Cloudflare 返回 HTTP 403、`text/plain` 和 `error code: 1010`。相同地址使用 curl、Node `fetch`、Python `requests` 或给 curl 设置 `FreightClaw-Python-SDK/1.0` User-Agent 均能到达应用。无凭据访问机器接口时，应用返回 `application/json` 的结构化 403 `machine_request_denied`。

Cloudflare 官方将 1010 定义为按浏览器签名拒绝。Browser Integrity Check 会拦截无 User-Agent 或它认为不标准的 User-Agent。不要通过要求客户伪装浏览器来解决。

## 窄配置规则

2026-09-05 已在 `www.freightclaw.net` 的 Cloudflare **Rules → Configuration rules** 部署活动规则 `FreightClaw machine API - disable BIC`，匹配表达式：

```text
http.host eq "www.freightclaw.net" and (
  starts_with(http.request.uri.path, "/access/v2/") or
  starts_with(http.request.uri.path, "/api/v2/") or
  http.request.uri.path eq "/console/openapi.json" or
  http.request.uri.path eq "/console/readyz" or
  http.request.uri.path eq "/console/skill.md" or
  http.request.uri.path eq "/mcp" or
  http.request.uri.path eq "/runtime/readyz"
)
```

仅把 **Browser Integrity Check** 设置为 Off。不要跳过托管 WAF、速率限制、Bot 管理或全站安全规则。机器接口自身的 Host/代理边界、Key/JWT、当前授权和请求大小限制继续生效。

部署后的反向边界检查确认：Python `urllib` 访问 `/` 和 `/console/auth/login` 仍收到 Cloudflare 1010，证明规则没有对全站关闭 BIC。

## 验收

在本机与至少一个外部节点运行：

```bash
python3 deploy/scripts/verify-public-python-api.py
```

四行结果都必须为 `"passed": true`。其中 health/OpenAPI 应为 JSON 200；无凭据的兑换和工具请求应为应用 JSON 403。任何 Cloudflare HTML/纯文本挑战、重定向或 200 演示数据均不通过。2026-09-05 本机、Oracle 和腾讯云广州节点的四项验收均通过。

## 2026-09-06 市场与 Agent 接入更新

原规则已保存并回读上述新增的三个精确路径。普通 Python 默认客户端验证：公开 Agent Markdown 200 text/markdown、Runtime 200 JSON、无认证 MCP 401 JSON，不再出现 1010。原 `/access/v2/` 与 `/api/v2/` 前缀已覆盖统一 Key 换票和内部 authority。根路径仍返回原 Browser Integrity Check 拒绝。完整生产证据见最新市场交付记录。
