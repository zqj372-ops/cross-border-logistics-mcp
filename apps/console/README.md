# FreightClaw 企业门户

这是当前面向企业成员、应用负责人和 Agent 接入人员的主界面。入口为 `/console/`，包含能力市场、七章操作手册、业务工作台、统一 Key、服务申请、成员和操作记录。

## 协议与业务边界

- 市场提供 3 项 MCP/REST 基础能力和 5 项业务 REST 能力，详见 `market.js` 与生成的 `openapi.json`。
- 普通人员使用登录会话；程序使用已确认交付的应用 Key。MCP 仍需兑换短期 JWT。
- 报价保存、审核、PDF 使用独立人员业务接口，权限和读回与只读试算分开。
- `activity` 记录成员、应用与授权变更，不代表业务调用日志。
- 来源未发布、凭证缺失或响应冲突时保留真实失败状态。

## 本地运行与验证

在仓库根目录执行 `npm ci` 和 `npm run start:console:fixture`，按启动输出访问 loopback 地址。合成身份与来源仅用于隔离测试。

`npm run build` 打包主界面、为静态资产生成内容版本，并生成 OpenAPI。`npm run generate:portal-openapi` 同步界面与 `docs/integrations` 两个接口副本。

测试位于 `tests/access-gateway/console-*.test.ts`、`tests/access-gateway/portal-*.test.ts` 与 `tests/e2e/portal-browser/`；浏览器流程独立于默认 Vitest 套件，不能把单元测试通过写成浏览器验收完成。

当前发布与缺口以 [状态台账](../../docs/product/2026-09-05-mcp-product-redesign/18-current-status-and-gaps.md) 为准。[新服务接入](../../docs/integrations/new-service-onboarding.md) 说明来源权威、身份、权限、接口及回滚要求。
