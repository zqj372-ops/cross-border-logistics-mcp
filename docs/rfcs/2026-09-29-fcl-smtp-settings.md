# FCL 发信服务设置

实施状态：按用户授权实施并进行发布验收；不改变既有 MCP 工具合同。

范围：用户要求自行更换发信服务，并提供操作界面。复用个人账号、FCL action 路由、native_configs、审计和幂等表；不新增企业授权或邮件系统。

## 接口

- `smtp-get`：读取脱敏连接与测试状态。
- `smtp-save`：以 expected_version 保存连接草稿，不影响现用服务。password 为 null 时，仅允许保留同一草稿服务器、端口、加密方式和账号的密码。
- `smtp-test`：对已保存版本发送合成测试邮件，明确收件人和 confirmed。保留幂等记录；结果不明不自动重试。
- `smtp-activate`：只启用该版本已获 SMTP 接收的草稿；提示用户确认收件。SMTP 接收不是已读证明。

旧配置继续生效，无需迁移历史记录。发件人名称使用可选 from_name，旧配置仍兼容；邮件信封仍使用原始邮箱地址。新增输入输出使用 strict Schema，生成 Draft 2020-12 和 OpenAPI；Web 与 CLI 通过同一 action 路由。

示例：旧版无设置 action；新增 `smtp-test` 输入为 `{"expected_version":1,"confirmed":true,"recipient":"operator@example.test"}`；输出只含连接元数据、版本及测试状态，不含密码。

## 权限与凭据

系统级发信通道仅由已核验的固定受理人账号修改，沿用实时身份核验。其他运营账号可维护原有节点通知，但不能读写系统 SMTP。密码以 AES-256-GCM 保存；密钥由现有独立 case credential secret 通过 HKDF 域隔离派生，AAD 绑定账号。复用 SQLite 停写备份及密钥恢复流程。禁止日志、API 回显或幂等结果保存明文凭据。

仅支持 SSL/TLS 或强制 STARTTLS，验证证书。发信前解析全部地址并拒绝非公网/组播地址，连接已核验的 IP，TLS 仍校验原主机名，避免 DNS 重绑定访问内网。

## 兼容与回滚

保存草稿不发信、不切换；启用后统一通知运输器读取新通道。既有服务器配置作为尚未启用新通道时的来源。已存在但损坏的加密记录必须失败关闭，不能悄悄切回旧账号。备份仍覆盖 native-business.sqlite，无新数据库及表迁移。回退旧程序前确认将重新使用部署文件中的原通道；不恢复业务数据库，不重复发送结果未知邮件。

## 验证

`npx vitest run tests/access-gateway/fcl-smtp-settings.test.ts tests/access-gateway/fcl-smtp-transport.test.ts tests/access-gateway/fcl-smtp-python.test.ts tests/access-gateway/portal-fcl-production-composition.test.ts tests/console/fcl-execution-ui.test.ts`

覆盖：凭据不回显和加密落盘、跨账号拒绝、保存不切换、测试幂等、未知结果不重发、版本变化需重测、启用后发送路径、TLS 与内网目标拒绝。新服务实际配置及投递由用户填写后验收。
