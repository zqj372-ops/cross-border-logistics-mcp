# 跨境物流 MCP 控制台原型

这是 08A 的单页控制面原型。它管理客户端接入、角色/工具授权、适配器引用、就绪状态、审批差异和审计摘要；它不是报价、关税、Zone 或装柜业务数据库。

## 本地运行

仓库根目录执行：

```bash
python3 -m http.server 4173
```

浏览器打开：

```text
http://127.0.0.1:4173/apps/admin/?fixture=1
```

`?fixture=1` 是唯一启用演示数据的方式。演示页面会醒目标出“演示数据 / 未连接正式后台”，发布、回滚和保存到服务器按钮保持禁用；草稿差异只在浏览器本地预览，不会持久化。

不带 `fixture=1` 时，页面只请求同源：

```text
GET /admin/api/v1/snapshot
```

请求失败、返回非 2xx 或快照缺少必需对象/数组时显示 `unavailable`，不会回退到演示数据或默认配置。本仓库没有为该入口新增后台接口。

## 边界

- Quote Engine 继续是报价权威源；RiskCustoms 继续是关务权威源；货物、分泡和装柜仍由确定性工具计算。
- 页面只展示 `endpoint_ref`、opaque `secret_ref`、source version 和 readiness，不展示原始凭证、客户内容、报价明细或税务材料。
- 角色和 Phase 1 工具只按已校验快照中的平台 RBAC 展示；快照缺失时不生成默认权限，不能从页面新增 generic write。
- 真实写操作必须经过 `draft → validate/preview → approval → publish → readback/rollback`；本原型没有正式写 API，因此不伪造成功。

## 运行安全边界

构建始终校验并复制 `index.html`、`styles.css`、`app.js`、`fixture-data.js` 四个固定资源；这不等于开启控制台。`MCP_ADMIN_UI_ENABLED` 默认关闭；未显式设置为 `true` 时不开放，默认未设置返回 blocked/404，非法值返回 unavailable/503。

运行时静态 `/admin` 路由在 `start.ts` 中位于 MCP bearer auth 之前。由于当前只有静态壳和固定 `503/unavailable` 的快照占位，只有在批准的企业身份网关/访问控制之后才能开启 `MCP_ADMIN_UI_ENABLED=true`，不得直接暴露公网。未来接入正式 snapshot/provider 仍必须独立实现 admin RBAC、tenant binding、CSRF/Origin、版本/审批/审计；本原型不新增 header bypass、共享密钥、万能 admin token 或真实保存/发布/回滚。

## 最小检查

不需要新增 npm 依赖。可运行：

```bash
node --check apps/admin/app.js
node --check apps/admin/fixture-data.js
node apps/admin/self-check.mjs
```

静态服务器 smoke 应使用明确的 `?fixture=1` URL；正式模式的预期结果是显示 `正式快照不可用`，而不是展示演示数据。
