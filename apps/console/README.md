# Portal 前端

[文档中心](../../docs/README.md) / Portal

同一份前端资产提供三个入口，身份与数据权限由服务端控制。

| 入口 | 使用者 | 内容 |
| --- | --- | --- |
| `/console/` | 访客、用户、接入人员 | 首页、能力市场、CLI、操作手册及账号入口 |
| `/customer/` | 客户 | 本人询价、报价确认、进度与共享文件 |
| `/ops/` | 已授权运营和节点人员 | 询价、报价、接单、执行节点、邮件与配置 |

整柜业务使用个人授权。旧平台的应用、凭证和服务授权管理仍有独立合同，不能因为简化页面而绕过后端鉴权。

## 页面与接口

`app.js` 负责导航与会话，`fcl-customer.js` 负责客户业务，`fcl.js`、`fcl-operations.js` 负责整柜操作。页面复用现有组件和样式；不在浏览器自行计算权威报价或改写服务端状态。

人员使用登录会话；程序使用应用 Key 或独立人员 CLI 会话。客户进度与内部记录分开；来源未就绪、权限不足、版本冲突按原状态显示。

## 本地运行

按[开发指南](../../docs/guides/development.md)启动隔离 fixture。普通模式使用 `npm run start:console:fixture`，个人 FCL 另显式启用对应环境开关。

```bash
npm run validate:portal-openapi
npm run build
```

`generate:portal-openapi` 更新 `apps/console/openapi.json`；`validate:portal-openapi` 只检查，过期时失败。构建检查合同、生成带内容版本的静态资产，并复制 OpenAPI 到 `dist/console/openapi.json`。CLI 复用同一份 Schema。

## 验证入口

- 页面与 API：`tests/access-gateway/console-*.test.ts`、`portal-*.test.ts`。
- 浏览器流程：`tests/e2e/portal-browser/`，独立于默认 Vitest 套件。
- 操作说明：[客户手册](../../docs/guides/customer.md)、[运营手册](../../docs/guides/operations.md)、[人员 CLI](workspace-cli.md)。

单元测试通过不等于浏览器或生产验收完成。各次结果见[历史索引](../../docs/catalog.md)。
