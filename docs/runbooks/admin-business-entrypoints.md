# Admin 业务入口配置

Admin 可以显示现有报价与关务系统的普通导航链接。该功能只提供入口元数据，不检查外部服务，
也不表示报价、关务工具已经进入生产目录或获得生产资格。

## 部署配置

部署方只配置服务 origin，不配置各页面路径：

```text
MCP_QUOTE_UI_ORIGIN=https://quote.example.com
MCP_CUSTOMS_UI_ORIGIN=https://customs.example.com
```

本次用户明确指定的入口可在本地预览启动环境中写为：

```text
MCP_QUOTE_UI_ORIGIN=https://quote.freightclaw.net
MCP_CUSTOMS_UI_ORIGIN=https://clearddp.com
```

这两个值只记录用户指定的公开导航 origin。本次没有连接网站，也没有核验线上登录、页面路由、
业务接口、数据版本或生产就绪状态；配置成功不能替代相应的上线验收。

正式模式只接受 HTTPS 根 origin。配置不得包含用户名、密码、查询参数、片段或非根路径。
配置必须已经是 URL 解析后的规范形式；大小写、默认端口、反斜杠、另类 IPv4 数字写法等会被拒绝，
不会由运行时自动纠正。
fixture 模式额外允许 `http://localhost:<port>`、`http://127.0.0.1:<port>` 和 IPv6 loopback。
非法值不会回显，两个服务的配置结果彼此独立。

服务端固定生成以下页面：

- 报价：`/quote`、`/ai-quote`、`/ops`；
- 关务：`/`、`/calculator`。

## 读取接口

启用本地 Admin 后，可以通过 `GET` 或 `HEAD /admin/api/v1/business-entrypoints` 读取闭合元数据。
接口沿用 Admin 的 loopback、Host、Origin、安全响应头和 `no-store` 边界。Admin 未启用或请求不在
loopback 边界内时不会分发该接口。

`configured=true` 只表示部署方提供了合法 origin。它不代表外部服务 ready，不执行 HTTP 探测，
也不改变 snapshot、MCP 工具合同、生产工具集或租户授权。远程 Admin 和跨服务单点登录不在本版范围内。
