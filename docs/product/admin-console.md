# 跨境物流 MCP 控制台原型说明

**范围：** 08A 单页控制面原型
**版本：** `2026-08-11.v1` 兼容展示
**状态：** 仅前端原型，未接入正式后台写 API

## 信息架构

单页左侧导航包含 6 个视图，使用 URL hash 保留当前视图，不引入多页路由框架：

1. **总览**：展示 `/healthz`、`/readyz`、来源就绪、阻断原因、待处理项和状态说明。
2. **客户端接入**：展示 ChatGPT、Codex、企业助手的 `client_id`、issuer、audience、allowed origins 和最近校验结果。
3. **工具权限**：按已校验快照返回的角色和 Phase 1 工具展示 permission、读/写 kind 和角色授权；缺失或空数组只显示暂无/不可用，不生成默认权限。
4. **数据源与适配器**：展示 Quote Engine、RiskCustoms、knowledge、status、review 的 `endpoint_ref`、`secret_ref`、source version 和 readiness。编辑动作只生成浏览器本地草稿。
5. **审批与发布**：展示草稿差异、校验结果、审批链和禁用的发布/回滚动作。
6. **审计日志**：展示脱敏 actor、tenant、action、result、reason、config version 和 trace id。

## 数据边界

控制台是现有 MCP 的控制面，不建立第二套报价、关税、Zone、航线、装柜或业务记录库。Quote Engine、RiskCustoms 和确定性货物/装柜工具的权威边界保持不变；页面只展示版本、状态、来源引用、权限和审批信息。

展示字段应遵守以下约束：

- 凭证只使用 opaque `secret_ref`，不出现原始 token、secret、环境变量或密码。
- 客户地址、原始聊天、报价明细、税务材料和附件不进入 fixture、页面或普通审计日志。
- `ready=false` 的 RiskCustoms 结果保持 `unavailable` 或 `manual_review`，不能由 AI 或前端补成成功。
- fixture 只由 URL 明确带 `?fixture=1` 启用，并持续显示“演示数据 / 未连接正式后台”。
- 正式快照请求失败必须 fail-closed；页面不使用 fixture 或默认配置作静默回退。

## 状态机

后端包络沿用 5 个接口状态：`success`、`needs_input`、`manual_review`、`blocked`、`unavailable`。前端另有展示层状态：

```text
加载中 loading
  ├─ 正式快照成功且 schema_version 有效 → 展示控制台
  ├─ 无记录 → 暂无记录 empty
  ├─ 请求/格式失败 → 加载失败 error + 不可用 unavailable
  └─ fixture=1 → 展示明确标记的演示快照

控制台内的配置草稿
  → validate/preview
  → approval
  → publish
  → readback
  → 成功才可报告 success；权限、阶段或安全禁止时 blocked，来源不可靠时 unavailable，冲突时 manual_review。
```

`ready` 是就绪检查文案，不是替代后端包络状态。颜色不是唯一依据；状态同时使用文字和图标。

## 未来最小 API 契约

本任务不实现后端接口。未来正式接入至少需要：

### 读取快照

```http
GET /admin/api/v1/snapshot
Accept: application/json
```

返回必须带 `schema_version`，并返回本页需要的 `tenant`、`environment`、`config`、`actor`、`health`、`clients`、`roles`、`tools`、`sources`、`approvals` 和 `audit`。数组为空时返回空数组，不让前端猜测或补默认业务数据。来源必须带 `endpoint_ref`、`secret_ref`、`source_version` 和 readiness/reason；审计不得带敏感原文。

### 预览差异

```http
POST /admin/api/v1/config/preview
```

请求最小包含服务端绑定的租户/actor 上下文、配置草稿版本和幂等键；响应至少包含 `status`、`preview_ref`、脱敏 `diff`、校验结果、来源版本和 `trace_id`。preview 不写外部权威系统。

### 发布与回滚

```http
POST /admin/api/v1/config/publish
POST /admin/api/v1/config/rollback
```

两者都必须引用同一 `preview_ref` 或明确目标版本，并带服务端审批 ID、幂等键和审计关联。只有目标系统写入后读回，且租户、版本和关键状态核对通过，才可返回 `success`；未知写结果转 `manual_review`，依赖不可用转 `unavailable`。fixture 模式永远不调用这些接口。

## 发布前检查

- 严格 CSP 下不允许 `style="..."` 内联属性；表格宽度使用 CSS class。
- 使用键盘可达的跳过链接、导航、按钮、对话框和局部横向表格区域。
- 发布/回滚/保存到服务器在没有正式 API、审批和读回证据时保持禁用。
- 通过静态服务器分别验证 `?fixture=1` 和不带 fixture 的 fail-closed 路径。

## 运行安全边界

运行时 `/admin` 静态路由发生在 MCP bearer auth 之前。当前只提供静态壳和固定 `503/unavailable` 的 snapshot 占位，因此 `MCP_ADMIN_UI_ENABLED` 默认关闭；只有在批准的企业身份网关/访问控制之后才允许开启，不能直接公网暴露。未来 snapshot/provider 接入仍需独立的 admin RBAC、tenant binding、CSRF/Origin、版本/审批/审计；本原型不提供 header bypass、共享密钥、万能 admin token 或真实保存/发布/回滚。
