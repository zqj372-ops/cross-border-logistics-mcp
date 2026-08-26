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

```text
npm run start:freightcom-test-mcp
```

本地 MCP endpoint 为 `http://127.0.0.1:8080/mcp`。`local-fixture-token` 只是本地 MCP client
认证，不是 Freightcom Token。上游凭证只在工具调用时通过 Keychain helper 读取。

## 预期行为

1. `initialize` 创建 MCP session；
2. `tools/list` 包含 `quote.freightcom_ltl.preview`；
3. `tools/call` 只接受闭合的 pallet LTL Schema；
4. adapter 执行 `POST /rate`，随后在有界窗口内轮询 `GET /rate/{request_id}`；
5. 完成结果为 `manual_review`，并包含 `sendable=false`、`bookable=false`、
   `authoritative=false`；
6. 原始币种保留在 `total`，测试显示值在 `display_total`，不执行 FX；
7. 认证、Schema、超时或网络问题失败闭合，不生成备用报价。

## 生产边界

`MCP_DATA_MODE=production` 始终使用 disabled Freightcom adapter。设置测试开关不会改变生产组合。
订舱、保存和发送报价均不在该工具范围内。
