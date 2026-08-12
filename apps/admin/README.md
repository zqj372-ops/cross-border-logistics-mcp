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

请求失败、返回非 2xx 或缺少 `schema_version` 时显示 `unavailable`，不会回退到演示数据或默认配置。本仓库没有为该入口新增后台接口。

## 边界

- Quote Engine 继续是报价权威源；RiskCustoms 继续是关务权威源；货物、分泡和装柜仍由确定性工具计算。
- 页面只展示 `endpoint_ref`、opaque `secret_ref`、source version 和 readiness，不展示原始凭证、客户内容、报价明细或税务材料。
- 现有 7 个角色和 9 个 Phase 1 工具按平台 RBAC 展示，不能从页面新增 generic write。
- 真实写操作必须经过 `draft → validate/preview → approval → publish → readback/rollback`；本原型没有正式写 API，因此不伪造成功。

## 最小检查

不需要新增 npm 依赖。可运行：

```bash
node --check apps/admin/app.js
node --check apps/admin/fixture-data.js
node apps/admin/self-check.mjs
```

静态服务器 smoke 应使用明确的 `?fixture=1` URL；正式模式的预期结果是显示 `正式快照不可用`，而不是展示演示数据。
