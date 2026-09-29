# 开发指南

[文档中心](../README.md) / 开发

## 先确定改哪里

| 任务 | 入口 |
| --- | --- |
| 客户与运营页面 | [apps/console](../../apps/console/README.md)、`apps/inquiry` |
| FCL 业务、权限与邮件 | `services/access-gateway/portal` |
| 报价与文档 | `services/quote-native`、`services/quote-documents` |
| 人员 CLI | `deploy/cli/workspace.ts`、`deploy/cli/fcl-workspace.ts` |
| 机器 CLI / REST 合同 | [CLI](../../deploy/cli/README.md)、`apps/console/openapi.json` |
| MCP 模块与 Agent 标准 | `src/logistics_mcp`、[Agent 标准入口](../agent/index.json) |

先读 [AGENTS.md](../../AGENTS.md)，按任务 profile 读取标准。修改模块、平台或发布前，继续阅读[模块规范](../../MODULE_DEVELOPMENT_STANDARD.md)、[包络](../contracts/envelope.md)、[工具目录](../contracts/tool-catalog.md)、[权威矩阵](../contracts/authority-matrix.md)及相关 RFC。目标架构不代表已经实现。

## 启动个人整柜演示

需要 Node.js 22.13+；原生私人地址引擎另需 Python 3。使用隔离目录，不填生产凭证。

```bash
npm ci
PORTAL_FIXTURE_FCL_PERSONAL=true PORTAL_FIXTURE_FCL_EXECUTION=true \
  PORTAL_FIXTURE_DIRECTORY=.runtime/docs-fcl-fixture npm run start:console:fixture
```

默认端口 8882，可用 `PORTAL_FIXTURE_PORT` 更换。打开 `/console/` 后使用合成身份；运营与客户分别进入 `/ops/`、`/customer/`。演示身份定义在 `services/access-gateway/portal/identity.ts`。

此模式使用固定合成业务日期和模拟邮件传输。数据保留在指定目录，再次启动会读回；不要把其他模式的库直接当作个人模式库使用。按 Ctrl+C 停止服务。

普通 Portal 演示使用 `npm run start:console:fixture`；MCP/Admin 使用独立流程：

```bash
npm run init:control-fixture
npm run start:fixture
```

后者提供 `http://127.0.0.1:8080/admin/?fixture=1` 与 `/mcp`；fixture 的 `/readyz` 保持非生产就绪，不应绕过生产门禁。

## 修改与验证

1. 用 `rg --files` 和 `rg -n` 找到入口、调用方、合同与测试。
2. 行为修改先补复现测试，再做最小实现。保留账号隔离、版本校验、幂等和写后读回。
3. 运行受影响测试；合同、构建或发布修改再运行相应门禁。

```bash
npm run validate:agent-standards
npm run build:agent-pack
npm run validate:schemas
npm run validate:portal-openapi
npm run build
npm run typecheck
npm run lint
npm test
git diff --check
```

以上是完整检查集合，不要求每次文案修改都运行全部测试。浏览器检查独立于单元测试，要记录页面、身份、数据和实际结果。

## 合同只有一个来源

OpenAPI 由 `npm run generate:portal-openapi` 生成，`validate:portal-openapi` 只检查、不修改。CLI 复用其 Schema，不手写第二套输入规则。运行时 Agent 使用生成的 `dist/standards/agent-standard-pack.json`。

金额使用 decimal string 和 ISO 4217 币种；数量带单位。业务状态固定为 `success`、`needs_input`、`manual_review`、`blocked`、`unavailable`。HTTP 200、来源缺失或未知写结果不能变成业务成功。

新增外部来源按[服务接入指南](../integrations/new-service-onboarding.md)办理。提交、生产切换与业务验收分别记录，不在本地测试中发送真实邮件或连接生产数据。
