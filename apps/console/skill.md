---
name: freightclaw-logistics
description: 使用 FreightClaw 的已授权物流能力，查询询价、关务与税费，执行货物计算和装柜规划。
version: 2026-09-06.v1
---

# FreightClaw 接入指南

你正在帮助用户接入 FreightClaw。先确认用户需要的业务，复用已有的 Key 和客户端配置。普通业务人员可以直接使用 [业务工作台](https://www.freightclaw.net/console/#workbench)，不需要创建 API Key。

## 接入准备

1. 在 [能力市场](https://www.freightclaw.net/console/#market) 查看能力；在 [服务申请](https://www.freightclaw.net/console/#apply) 一次选择所需服务并填写用途。
2. 服务开通后，在 [API Key](https://www.freightclaw.net/console/#api-keys) 创建一枚 Key，保存并确认。已创建的 Key 优先复用，不要为每种服务再创建一枚。
3. 将 Key 保存到用户选择的凭证管理工具，或者当前进程环境变量 `FREIGHTCLAW_API_KEY`。不要要求用户把 Key 发送到聊天，不要打印它、写入代码仓库、截图或调用报告。
4. 读取 [OpenAPI 文档](https://www.freightclaw.net/console/openapi.json)。按用户已开通的操作，使用该文档的输入 Schema。不要猜测字段或填入虚构的业务资料。

API 根地址为 `https://www.freightclaw.net`，业务调用无需浏览器登录状态。

## 一枚 Key 直接调用 REST

所有下列固定路由支持请求头：

```http
Authorization: ApiKey <FREIGHTCLAW_API_KEY>
Content-Type: application/json
```

| 能力 | 操作 | POST 路径 |
| --- | --- | --- |
| 货物计算 | `cargo.calculate` | `/api/v2/tools/cargo.calculate` |
| 装柜规划 | `container.plan_summary` | `/api/v2/tools/container.plan_summary` |
| Agent 上下文 | `system.agent_context.get` | `/api/v2/tools/system.agent_context.get` |
| 加拿大尾程试算 | `quote.zone_preview` | `/api/v2/business/quote/zone-preview` |
| 询价资料提取 | `quote.ai_extract_preview` | `/api/v2/business/quote/ai-extract-preview` |
| 关税与商品归类 | `customs.query` | `/api/v2/business/customs/query` |
| 进口税费估算 | `customs.tax.estimate` | `/api/v2/business/customs/tax-estimate` |
| 承运商 LTL 询价 | `quote.freightcom_ltl.preview` | `/api/v2/business/quote/freightcom-ltl-preview` |

基础工具路由的请求体直接使用该工具 Schema。`/api/v2/business/` 的请求体是：

```json
{
  "schema_version": "business-call@2026-09-05.v1",
  "input": {}
}
```

把 `input` 替换为文档规定的实际业务输入；空对象不代表有效查询。授权精确到操作，不能通过 Key 越过应用、成员、企业、来源服务或审核限制。企业、操作者、上游地址由服务端确定，不要添加到业务输入中。

以下是读取 Agent 规范的最小只读调用，要求 Key 已启用 `system.agent_context.get`：

```python
import json
import os
from urllib.request import Request, HTTPRedirectHandler, build_opener
from urllib.error import HTTPError

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HTTPError(req.full_url, code, "Redirect refused", headers, fp)

request = Request(
    "https://www.freightclaw.net/api/v2/tools/system.agent_context.get",
    data=json.dumps({"profile_id": "runtime-caller"}).encode(),
    headers={
        "Authorization": "ApiKey " + os.environ["FREIGHTCLAW_API_KEY"],
        "Content-Type": "application/json",
    },
    method="POST",
)
try:
    response = build_opener(NoRedirect()).open(request, timeout=45)
except HTTPError as response_error:
    response = response_error
with response:
    result = json.load(response)
print(json.dumps({
    "status": result.get("status"),
    "request_id": result.get("request_id"),
    "reason_codes": result.get("reason_codes", []),
}, ensure_ascii=False))
```

`runtime-caller` 是调用方 profile。若当前部署未提供该 profile，保留接口返回的错误并核对部署标准包，不能将失败解释为调用成功。

## MCP 客户端

MCP 入口：`https://www.freightclaw.net/mcp`，使用 Streamable HTTP。

当前 MCP 工具是 `cargo.calculate`、`container.plan_summary`、`system.agent_context.get`。报价与关务通过上表 REST API 提供，不应将其写成已经注册的 MCP 工具。

使用同一 API Key 兑换短期令牌：

```http
POST /access/v2/application/token/exchange
Authorization: ApiKey <FREIGHTCLAW_API_KEY>
Content-Type: application/json
```

```json
{
  "schema_version": "application-exchange@2026-09-06.v1",
  "requested_tool_names": ["cargo.calculate"]
}
```

只有声明过 `current_grant` 模式且具备当前有效 T0 授权的 Key 能兑换该令牌。旧业务 Key 需要负责人在个人中心点击“启用基础工具”，可保留原 Key。

新增业务服务开通后，旧 Key 的业务操作范围不会自动扩大。在个人中心选择“更新服务”，明确确认后生成包含当前服务的新 Key 并撤销旧 Key，更新调用程序中的保存值。普通轮换保留原范围。

按响应中的 `token_type`、`access_token` 与 `expires_in` 配置客户端认证。MCP 端使用 `Authorization: Bearer <access_token>`，不能把长期 API Key 直接放进 MCP 的 Bearer 配置。短期令牌到期后重新兑换；客户端配置与刷新方式应按该客户端当前文档执行，不能声称静态令牌可永久使用。

使用 MCP 客户端正常完成初始化、列出当前允许的工具，再做只读调用。只报告实际返回的工具与结果。

## 结果处理

- `success`：本次操作已完成，仍要保留来源、规则版本和业务条件。
- `needs_input`：补充接口列出的资料。未知金额、重量、尺寸与日期不要猜测。
- `manual_review`：保留结果并说明具体待核对事项，不能擅自批准。
- `blocked`：检查 Key、确认保存状态、有效期与当前服务授权。
- `unavailable`：核对连接、正式数据发布和依赖状态；不要用示例结果填充。

记录请求编号、操作名与脱敏状态，避免记录客户地址、税务材料、报价全文和凭证。HTTP 200、本次鉴权成功与业务正式可用是不同的结论。

报价保存、审核、文档生成属于有副作用的后续业务。按对应接口与用户授权执行，遵循预览、幂等和写后读回要求；接入验证只做只读操作，不创建客户报价、提交订舱或替用户审批。

## 后续服务接入

接入新服务时复用当前账户、应用、Key 和授权边界。能力目录只登记已实现的协议、操作与 Schema，不能先将未知接口写成可用能力。源系统仍负责其价格、税则和业务记录，平台保存必要引用与脱敏审计，不复制一份业务权威数据。
