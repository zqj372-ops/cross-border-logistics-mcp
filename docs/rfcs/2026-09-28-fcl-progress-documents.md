# FCL 进度与报关资料邮件

用户要求：客户与内部进度分开，成交后以 SO/柜号展示，报关附件可邮件发送，保留个人隔离和历史报价。

## 实现范围

复用 Case、执行历史和 outbox，不增加订单或资料权威库。公开询价、正式报价审核、个人权限不变。

- 节点动作增加可选 `extensions.progress_v1={visibility:customer|internal,message:string}`。客户只读公开进度；内部进度不触发客户或对接人通知。旧记录沿用原公开状态文案，不公开内部 reason。
- 客户输出增加 `extensions.shipment_v1={so,containers,route}`；运营列表增加同名扩展的 label。SO 取订舱字段，柜号取共享运输资料，缺失时使用原询价号，不改主键或历史编号。
- `execution-documents-preview`：原 version/case/node 上下文，加 to/cc/subject/body/attachments。仅已有出口报关、加拿大清关节点及获授权人员可用。
- `execution-documents-send`：相同输入，加 preview_digest 和 confirmed；摘要绑定个人、版本、正文、收件人及附件。幂等提交入原 outbox 后读回，不直接修改清关状态。
- 附件最多 5 个、合计 4 MiB；PDF、PNG、JPEG、XLSX、DOCX，校验文件名、扩展名、MIME、文件头和规范 base64，不展开 Office 压缩包或执行文件内容。普通日志无正文/附件，列表不返回附件原文，获授权运营可展开正文和附件名称；正文和原文件保存于受控 outbox。
- worker 发送前重新检查个人有效性、节点归属、轮次、配置绑定；明确失败可重试，未知结果沿用原人工核实流程。收件邮箱不授予系统权限。

旧输入没有 extensions；新例：`{"extensions":{"progress_v1":{"visibility":"internal","message":""}}}`，原 reason 仍供内部审计。响应包络及 MCP 静态工具目录不变；Web/CLI 共用 FCL 动作表及生成 Schema。

## 兼容与回退

无数据库表迁移，不重写历史报价/PDF。新 PDF 隐去技术追溯标识，内部记录保留。部署前备份并停旧写入者；旧程序不认识新增扩展，产生新记录后不能直接降级到旧写程序，应修复前进或在无新写入时恢复整组备份。生产尚未执行本批发布。

## 验证

相关客户/执行/SMTP/UI测试、typecheck、lint、生成 Schema、agent standards/pack、浏览器本地合成数据检查。实际命令和结果见本批交付；不将 SMTP 接收写成收件成功。
