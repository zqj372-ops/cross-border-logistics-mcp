# 物流邮件获客候选模块：开发与验收

## 当前交付形态

这是现有 FreightClaw 仓库中的候选业务模块，不是 Chrome 插件，也没有新建销售网站。

- `src/logistics_mcp/modules/logistics-outreach/module.ts`：16 项 MCP 工具、严格版本输入/输出、原有可信上下文与权限检查；不拥有数据库或 worker。
- `src/logistics_mcp/platform/outreach-tools.ts`：候选工具的窄权限和角色策略；没有加入 `t0-v1` 或 `business-v1` 生产 profile。
- `services/logistics-outreach/`：独立业务数据、预览/幂等/审核条件、草稿、收信和发信任务状态机。
- `services/logistics-outreach/providers/`：邮件、OpenAI-compatible 模型、浏览器/快照采集的私有 HTTP Provider 适配器。
- `services/logistics-outreach/runtime.ts`：仅在 `MCP_OUTREACH_ENABLED=true` 时组合 Provider；构造阶段只读配置和密钥文件，不发网络请求。
- `tests/outreach/`：服务状态机、HTTP Provider、运行时配置、`ModuleHost` 和 `executeRegisteredToolWithResult` Gateway 合同测试。
- [RFC](../rfcs/2026-09-11-logistics-outreach-candidate-v0.md)：Proposed；没有自行批准生产注册或修改现有 Key 权限。

**代码存在不等于已上线。** `t0-v1`、`business-v1`、现有 Key、Portal 与部署配置没有改变；正常生产 `tools/list` 不会突然出现获客工具。模块仍只在显式挂载或显式启用私有运行时时使用。正式发布仍需合同、授权、隔离 Provider、真实凭证和发布评审。

## Gateway 合同

候选工具现在同时接入现有 Gateway 的两个核心合同：

1. **RBAC**：`platform/outreach-tools.ts` 定义 16 项工具的角色和权限。精确 `tool:<name>` entitlement 使用精确工具授权；旧的权限范围身份使用 `outreach:*` 权限。`sales` 等授权角色通过 `executeRegisteredToolWithResult` 调用，未授权角色、错误工具 entitlement 和 service 身份的越界组合失败闭合。
2. **写合同**：所有写工具使用平台标准 `write_context`，包含 tenant/actor/session 绑定、`operation_mode=commit`、`preview_ref`、`idempotency_key` 和审批元数据。服务自身再次校验上下文绑定；平台幂等仓库负责重放。

`tests/outreach/gateway-contract.test.ts` 用真实 `executeRegisteredToolWithResult` 覆盖读取、写入和幂等重放。`tests/outreach/module.test.ts` 仍覆盖 ModuleHost 挂载、Schema、身份边界和任意 URL/凭证参数拒绝。

## 本地测试

在常规开发机按仓库锁文件安装依赖，然后运行：

```sh
npm ci
npm test -- tests/outreach
npm run typecheck
npm run lint
npm run validate:schemas
npm run build
```

`tests/outreach/providers.test.ts` 使用 fake `fetch` 验证 HTTP 请求、严格响应解析和失败闭合，不连接外部服务。`tests/outreach/runtime.test.ts` 使用临时目录、0600 密钥文件和 fake HTTP Provider 验证运行时组合；不会发送真实邮件或调用真实模型。

禁止把 fixture 审批函数、测试身份或测试来源当成正式授权。生产不得在 Gateway 进程中实例化 `OutreachService`；数据库、Provider 凭证和后台运行在私有业务服务中。

## 已能验证的业务流程

```text
已授权的企业页面快照引用
  -> research.preview：邮箱候选序号、来源摘要，不认定中国采购
  -> lead.import：预览绑定后导入，不允许模型猜邮箱
  -> draft.preview -> draft.prepare：调用模板或注入模型，保存待审核开发信
  -> 人员在业务侧审核确切正文及联系依据（不提供模型审批工具）
  -> message.preview -> message.queue：检查后进入私有服务队列
  -> 私有 worker dispatchOne：重新检查授权和禁发，再调用邮件 Provider
  -> 严格读回：provider_accepted / manual_review / cancelled
```

模型只收到必要的公司、来信和已批准服务说明，不能获得浏览器、发信、审批或规则修改工具。每封草稿仍待审，不能承诺价格、税费、交期、清关保证或改收款账户。

所有候选 MCP 结果包含 `candidate_only=true` 和 `production_eligible=false`，操作完成也保留 `manual_review`。草稿正文/邮箱原文保留在私有服务，MCP 返回引用和摘要。`content_ref` 是内部引用，不是现成网页链接；受保护审核页面/接口尚未实现。

## Provider 接入协议

运行时只在 `MCP_OUTREACH_ENABLED=true` 且配置完整时创建。三个 Provider 都是私有 HTTP 桥，不由 MCP 客户端传入任意 URL、脚本或凭证。

| Provider | 适配器 | 固定协议 |
| --- | --- | --- |
| 邮件 | `providers/http-mail.ts` | `POST /v1/messages` 发送；`GET /v1/messages/{idempotency_key}` 读回；`GET /v1/inbox` 读取来信；请求带 `x-freightclaw-tenant` |
| 模型 | `providers/openai-model.ts` | OpenAI-compatible `POST /v1/chat/completions`；公司/来信文本作为 JSON untrusted data；只接受严格 `{subject,body}` JSON |
| 采集 | `providers/http-capture.ts` | `GET /v1/captures/{capture_ref}` 读取快照；私有 `POST /v1/captures` 只传 opaque capture ref；Chrome CDP、URL allowlist 和页面抓取属于独立 worker |

必需设置：

| 设置 | 用途 |
| --- | --- |
| `MCP_OUTREACH_STATE_DB_PATH` | 私有 SQLite 绝对路径 |
| `MCP_OUTREACH_PREVIEW_KEY_FILE` | 至少 32 字节的预览/HMAC 密钥文件 |
| `MCP_OUTREACH_CAPTURE_BASE_URL`、`MCP_OUTREACH_CAPTURE_ALLOWED_HOST`、`MCP_OUTREACH_CAPTURE_TOKEN_FILE` | 采集桥 |
| `MCP_OUTREACH_MODEL_BASE_URL`、`MCP_OUTREACH_MODEL_ALLOWED_HOST`、`MCP_OUTREACH_MODEL_API_KEY_FILE`、`MCP_OUTREACH_MODEL_NAME` | 模型桥 |
| `MCP_OUTREACH_MAIL_BASE_URL`、`MCP_OUTREACH_MAIL_ALLOWED_HOST`、`MCP_OUTREACH_MAIL_TOKEN_FILE` | 邮件桥 |
| `MCP_OUTREACH_PROVIDER_TIMEOUT_MS` | 可选；默认 15000ms |

Base URL 必须为 HTTPS，host 必须与 allowed host 精确一致；密钥文件必须是绝对路径、普通文件、非符号链接且权限不向 group/other 开放。邮件发送结果必须原样匹配收件人、幂等键和草稿 digest，否则进入 `manual_review`，绝不自动换 key 重发。

## 停止、回复与不确定发送

发送默认关闭。真实部署必须由服务器明确绑定邮箱、寄件公司及地址、密钥、联系审核和人员审批权威；缺失则不继续。

收到客户来信后暂停冷开发跟进；退订额外禁发并取消待发任务。自动回复邮件不触发销售回复生成。人工来信可 `reply.preview -> reply.prepare`，仍进入相同审核流程。`contact.suppress` 不能由另一个工具撤销。

邮件端口异常发生在可能提交之后，任务进入 `manual_review`，不以新幂等键重发。供应商返回成功但读回不匹配同样不能当成成功。`provider_accepted` 只是供应商受理，不等于送达。

排队记录可在重启后读取；进程崩溃留下的 `dispatching` 不会自动重发，目前需人员核对。不要为了恢复任务删除数据库、退订名单或幂等记录。

## 还没有接入的功能

- 真实 Chrome CDP/城市地图发现 worker：当前只有 HTTP 采集端口和 fake 测试，没有连接 Chrome、Google Maps 或公网采集源。
- 真实邮件 Provider：没有连接 SMTP、Gmail、Microsoft Graph 或真实 webhook；当前运行时只有在部署环境配置私有桥后才可能调用真实接口。
- 真实模型 Provider：没有配置真实 API Key、模型配额或供应商健康证据；当前只有 OpenAI-compatible 适配器和 fake 测试。
- MIME/退信/投诉处理、持续调度与限速 worker、崩溃发送状态自动核对、签名隔离 Provider、审核界面、正式权限与生产 profile/发布。
- RFC 仍为 Proposed；在批准前不得把候选工具加入生产目录或给现有 Key 新增 scope。

## 本次本地验证边界

本分支已运行核心 Gateway/Provider 单元测试、严格 TypeScript 编译、ESLint 和 whitespace 检查。完整仓库构建、镜像和 CI 以 PR 的实际 workflow 输出为准；这些结果验证代码候选，不代表真实邮箱、模型或 Chrome 采集已接通。
