# 进度与报关邮件验收

本批候选版本 0.021；本节记录本地验证，生产状态以部署回执为准。未发送真实报关资料。

## 操作

- 客户中心：从首页、能力市场或 CLI 页顶部进入；列表显示 SO、柜号、航线、进度。未登记 SO 时保留询价号。
- 更新节点：选择客户可见或仅内部，确认本次话术后提交。内部更新不进入客户时间线，不发给客户或外部对接人。
- 节点联系人：在“负责人及通知设置”填写内部负责人邮箱和外部对接人邮箱。邮箱不授予系统权限。
- 报关资料：在出口报关或加拿大清关节点上传 → 预览收件人、正文与附件 → 确认发送。支持 PDF、图片、Word、Excel，最多 5 个、合计 4 MiB。发送不代表清关完成。
- 报价：审核通过后直接发布，系统生成并校验 PDF；下载 PDF 不再是发布前必须手工操作的一步。历史报价和历史 PDF 不改写。

## 已运行

- `npm run build`：通过；`npm run typecheck`、`npm run lint`、`git diff --check`：通过。
- `npm run validate:agent-standards`、`npm run build:agent-pack`：通过，14 条标准。
- `npm run validate:access-gateway-schemas`：220 个 Schema；`npm run validate:portal-openapi`：通过。
- `npx vitest run tests/access-gateway/fcl-execution*.test.ts tests/access-gateway/fcl-customer-portals.test.ts tests/access-gateway/fcl-smtp-transport.test.ts tests/console/fcl-*.test.ts tests/quote-documents/fcl*.test.ts`：174 通过、1 跳过。
- `npx vitest run tests/access-gateway/portal-fcl-cli.test.ts`：13 通过。
- CLI 对本地服务实际调用 `execution-documents-preview`：140005 字节合成 PDF，成功返回附件摘要，不返回原文。
- Python SMTP sender 使用假 SMTP 接收器：实际生成 MIME 附件，核对文件名、类型和字节内容通过。
- Edge 本地 GUI：内部节点更新成功；客户页保持公开状态且无内部内容；原生文件选择 → 邮件预览 → 确认发送 → 发信记录成功，节点保持处理中。

本地邮件传输为 fixture，不代表真实 SMTP 投递或收件成功。正式 PDF 改动经过现有测试，未在生产重新出单验收。未执行生产数据库迁移。

## 2026-09-29 界面改版

- 客户中心与整柜运营采用系统字体、浅灰底、白色分组列表、蓝色主操作与分段页签。
- 执行中的客户订单先展示运输进度，报价和历史按需展开；待确认报价仍优先展开。内部备注与凭据收起，不移除数据或权限。
- 本轮 9 个前端测试文件、68 项通过；新增进度优先和报价默认折叠测试。构建、lint、类型检查与差异检查通过。
- 浏览器实际核对客户列表/详情、展开报价、运营报价/执行页签、清关节点；1280px 桌面及 390px 手机均无整页横向溢出，手机详情入口直接可见。最终运营页控制台无错误。
- 截图位于 `.runtime/progress-qa/apple-customer.png`、`apple-operations.png`；仅本地合成数据，未上线。

## 发布前检查

- 全量测试：302 个文件通过、2 个跳过；唯一失败为 CLI 命令数量由 158 增至 160 的旧断言。更新断言及附件命令检查后，两项 CLI 包测试和两项客户界面测试复测通过。
- 类型、lint、17 个主契约及 220 个接入 Schema、OpenAPI、14 条 Agent 标准、隔离发布门禁通过。
- 客户用语统一为“确认报价并下单”“待接单”“运输处理中”；内部邮件状态保留准确的“邮件服务器已接收”，不表示收件成功。
