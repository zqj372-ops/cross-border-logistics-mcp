# Freightcom 测试 LTL MCP 运行手册

本手册只启用 `quote.freightcom_ltl.preview` 测试工具，不启用生产调用，也不允许 Token 出现在
MCP 参数、聊天、源代码、fixture 或 shell history 中。

## 凭证边界

- 测试 endpoint：`https://customer-external-api.ssd-test.freightcom.com`；
- Keychain account：`JHT LOGISTICS CO., LTD.`；
- Keychain service：`freightcom-api-test-mcp-v1`。

需要更新 Token 时运行 `npm run credential:freightcom-test`，然后在浏览器打开
`http://127.0.0.1:56571/` 输入。页面只保存到本机 Keychain，不读取或显示已有 Token。

只检查是否存在，不打印值：

```text
security find-generic-password -a "JHT LOGISTICS CO., LTD." -s "freightcom-api-test-mcp-v1" >/dev/null && echo stored
```

## 启动

干净 checkout 第一次启动时，必须先显式初始化严格 control state；runtime 不会创建或修复
control DB/marker：

```text
npm ci
npm run init:control-fixture
npm run start:freightcom-test-mcp
```

`npm run init:control-fixture` 只用于尚未初始化的本地 fixture root。已有 control state 时不要删除、
覆盖或重新初始化；应先按控制面状态处理未决 release/readback。initializer 失败时停止，不得用空库
替代。`start:freightcom-test-mcp` 必须在 initializer 成功后执行，否则会在监听端口前失败闭合。

本地 MCP endpoint 为 `http://127.0.0.1:8080/mcp`。`local-fixture-token` 只是本地 MCP client
认证，不是 Freightcom Token。上游凭证只在工具调用时通过 Keychain helper 读取。

## 激活测试模块

静态 inventory 和 `tools/list` 可见不等于模块已获准执行。初始 activation 严格为空；此时调用
`quote.freightcom_ltl.preview` 必须返回 `unavailable/module_policy_not_released`，不会访问
Freightcom。只在本地隔离 fixture 中按以下顺序激活：

1. 打开 `http://127.0.0.1:8080/admin/?fixture=1`，进入“模块中心”；
2. 选择“本地演示申请人”，选中 `freightcom-ltl`，点击“登记选中模块”，等待服务端重新读回为
   “已登记”；
3. 只将 `freightcom-ltl` 的“期望启用”开关设为启用，点击“保存草稿”，再点击“生成预览”；
   预览必须显示目标模块 exact version/digest 且校验项全部通过；
4. 切换为“本地演示审批人”，点击“提交审批”。申请人与审批人必须是不同 actor；
5. 切回“本地演示申请人”，点击“发布并读回”；
6. 只有页面重新读取的服务端状态同时满足以下条件，才可继续 MCP 工具调用：
   `activation.state=active`、active modules 包含 exact `freightcom-ltl` ref、release 状态为
   `active_verified`，且 `latest_readback.status=verified` 并匹配同一 release/revision/module ref。

任一步返回 `blocked`、`manual_review`、`unavailable`，或 readback 不一致，都应停止；不得跳过审批、
直接改 SQLite，或把 inventory/tool 可见性当成激活证明。`active_verified` 仅表示本地 runtime exact
readback，不表示制品签名、生产资格或正式报价资格。

## 预期行为

1. `initialize` 创建 MCP session；
2. `tools/list` 包含 `quote.freightcom_ltl.preview`；
3. 未完成上述激活链时，`tools/call` 保持 `unavailable/module_policy_not_released`；
4. 激活 exact readback 后，`tools/call` 只接受闭合的 pallet LTL Schema；
5. adapter 执行 `POST /rate`，随后在有界窗口内轮询 `GET /rate/{request_id}`；
6. 完成结果为 `manual_review`，并包含 `sendable=false`、`bookable=false`、
   `authoritative=false`；
7. 原始币种保留在 `total`，测试显示值在 `display_total`，不执行 FX；
8. 认证、Schema、超时或网络问题失败闭合，不生成备用报价。

## 生产边界

`t0-v1` 的 production 组合始终不构造 Freightcom adapter。只有独立
`read-preview-staging` profile 同时满足测试开关、固定测试 host、精确 tenant allowlist 和
secret-file 边界时才允许构造测试 adapter；这不会赋予 Freightcom production 资格。订舱、保存
和发送报价均不在该工具范围内。
