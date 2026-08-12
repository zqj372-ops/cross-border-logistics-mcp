# RFC：`quote.document.create` 报价 PDF 工具

- **状态：** Proposed
- **日期：** 2026-08-12
- **影响范围：** 共享工具目录、Schema、RBAC、审计、PDF adapter、管理后台
- **兼容性：** 纯新增；现有九个工具不改名、不改字段、不改状态语义

## 1. 动机

现有 Quote PDF Builder 已能用同一套模板生成桌面 PDF，但它依赖 Electron UI、保存对话框和本机路径，无法安全地供公司多人通过 ChatGPT、Codex 或企业助手调用。本 RFC 只增加一个窄工具，把“已确认的报价快照”渲染为可审计 PDF；它不重新计算价格、不接受任意 HTML、不发送文件。

## 2. 决策

新增 `quote.document.create`，权限为 `quote:document_create`，属于窄写操作，必须执行：

```text
preview → approval → commit → readback
```

PDF Builder 只负责确定性渲染。MCP 负责租户、权限、幂等、审计、快照引用、artifact 存储和读回。报价系统仍是报价内容权威源；PDF 只是指定 quote snapshot 的派生物。

## 3. 输入草案

```text
schema_version: string, required
version: string, required
quote_snapshot_ref: OpaqueReference(kind=record), required
template_version: string, required
renderer_version: string, required
locale: enum [zh-CN, en-CA], required
branding_ref: OpaqueReference(kind=document|record)|null, optional
write_context: WriteContext, required
```

约束：

- 不接受 quote 正文、客户原话、任意 HTML、模板路径、输出路径或远程资源 URL。
- `quote_snapshot_ref` 必须由服务端按 tenant 解析，并读回不可变 quote version；客户端不能指定其他租户记录。
- preview 读取并校验快照，返回 request hash、模板/renderer 版本和预计动作；不生成或存储最终 PDF。
- commit 必须携带同一 preview ref、同一 request hash、批准状态和幂等键。

## 4. 输出草案

新增 `document-result.schema.json`：

```text
version: string
operation: const quote.document.create
operation_status: previewed|committed|already_committed|rejected
document_handle: Identifier|null
media_type: const application/pdf
byte_size: integer|null
sha256: string|null
quote_snapshot_ref: Identifier
quote_version: string
template_version: string
renderer_version: string
preview_ref: Identifier
idempotency_key: string
approval: ApprovalState
readback_evidence: ReadbackEvidence|null
```

`document_handle` 是租户绑定的不透明引用，不是本机路径、对象存储 key 或公开 URL。下载/预览通过已有受控管理后台资源路由完成；本 RFC 不再增加第二个 MCP 下载工具。

## 5. 状态语义

- `success`：preview 成功，或 commit 后 artifact 读回的 sha256、byte size、tenant、quote version 全部一致。
- `needs_input`：缺 quote snapshot、版本、locale 或模板选择。
- `manual_review`：报价快照存在冲突、branding 待审核、renderer/template 版本无法重放。
- `blocked`：跨租户、任意 HTML/路径/远程资源、未批准 commit、尝试 invoice/发送/覆盖 artifact。
- `unavailable`：renderer、artifact store 或 quote snapshot readback 不可用；不得返回假 handle。

## 6. 渲染器合同

PDF 模块提供最小边界：

```ts
type RenderQuotePdfResult = {
  bytes: Uint8Array;
  sha256: string;
  rendererVersion: string;
  templateVersion: string;
};

renderQuotePdfBytes(normalizedQuoteDocument): Promise<RenderQuotePdfResult>;
```

实现复用现有 `buildQuotePdfHtml`、normalize、hidden `BrowserWindow.printToPDF` 和可编辑 JSON 附件逻辑。不得在渲染器内部打开保存对话框、写用户路径、访问网络或保存业务记录。

## 7. 金额与版本兼容

- MCP 继续使用 decimal string；进入 PDF builder 前进行一次受测转换。
- 转换必须拒绝非有限数、超过允许精度/范围的值和缺 currency；不得用二进制浮点重新计算报价。
- PDF 显示值来源于已确认 quote snapshot；renderer 不重新定价。
- artifact metadata 同时记录 quote、template 和 renderer version，保证可回放。

## 8. 安全与数据边界

- 禁止任意 HTML、JavaScript、文件路径、远程 logo/font/image URL。
- branding 只能通过服务端 allowlist 的 opaque reference 读取并做大小/MIME 校验。
- 日志只记录 tenant/actor/tool、opaque refs、版本、sha256、byte size 和状态；不记录报价正文、地址、PDF bytes、token 或对象存储路径。
- artifact store 必须 tenant scoped、私有、可撤销；返回值不包含 presigned URL。
- 最大输入、渲染时间和 PDF byte size 使用现有平台限制或显式上限，超限 fail-closed。

## 9. 迁移顺序

1. PDF 仓库先提取并测试无头渲染入口，不改 MCP。
2. MCP 增加 renderer port、artifact store port 和 fixture；生产 provider 仍缺省关闭。
3. 增加 schema、tool catalog、RBAC 和 preview/commit/readback 测试。
4. 隔离 e2e 通过后，管理后台增加状态和下载入口。
5. staging 验证后再决定是否启用；不自动进入生产。

## 10. 测试要求

- 同一快照/版本的 preview hash 稳定；preview 零写入。
- commit 缺批准或 request hash 变化时零渲染、零写入。
- 重复幂等键返回同一 handle；不同 payload 拒绝。
- 跨租户、任意 HTML、路径、远程资源和 invoice 全部在 renderer 前阻断。
- commit 后读回 sha256/byte size/version 一致；不一致为 `manual_review`/`unavailable`。
- renderer 超时、崩溃、空 bytes、超限或 artifact store 失败不返回成功。
- 现有九工具和桌面 PDF 导出全量回归通过。

## 11. 回滚

从工具注册表移除 `quote.document.create` 并关闭 provider 即可；现有九工具、报价数据和 PDF 桌面应用不迁移、不回写。已生成 artifact 依既有保留策略处理，不由回滚脚本批量删除。

## 12. 未决问题

在状态改为 Accepted 前必须确认：

1. Quote PDF Builder 以本地 package、CLI 子进程还是同进程 library 形式暴露；选择现有构建最容易支持的一种，不新增服务只为调用一次函数。
2. 公司现有私有对象存储/文档存储是否可复用；没有权威存储时，工具保持 disabled。
3. PDF 是否必须嵌入 editable JSON；若保留，必须确认不会把超出报价单显示范围的敏感字段带入附件。
