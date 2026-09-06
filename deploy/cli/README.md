# FreightClaw CLI

`freightclaw` 直接调用现有 FreightClaw REST API。沿用同一个账号及统一应用 Key；企业、服务范围、人员角色和来源数据的判断由服务器负责。CLI 不计算价格或税率，也不保存业务记录。

首次使用可从 [图文使用指南（含四张实测截图）](https://github.com/zqj372-ops/cross-border-logistics-mcp/blob/main/docs/runbooks/freightclaw-cli-illustrated.md) 开始，按安装、命令选择、连接检查、输入校验和结果处理逐步操作。

## 安装与开始

需要 Node.js 22.13 或更新版本。[官网 CLI 页面](https://www.freightclaw.net/console/#cli) 提供安装包、校验文件和输入示例。当前通过官网托管的 npm 包交付，尚未发布到公共 npm registry。

```sh
npm install --global https://www.freightclaw.net/downloads/freightclaw-cli-0.1.0.tgz
freightclaw --version
freightclaw commands
freightclaw status
freightclaw schema customs query
```

也可先下载 `.tgz`，把安装命令中的网址换成本地文件的实际路径。`status` 不需要 Key，只检查 Portal 就绪状态；它不证明关税、报价来源或供应商凭证可用。`commands` 是当前 CLI 支持的命令列表，不代表你的应用已开通全部服务。

应用负责人在 [API Key 页面](https://www.freightclaw.net/console/#api-keys) 管理已有统一 Key。由本机凭证工具或 CI secret 注入 `FREIGHTCLAW_API_KEY`；也可以把既有 Key 放在本人私有文件中，通过 `--key-file` 读取。macOS/Linux 文件须归本人所有且无其他用户权限（例如600）；Windows 需自行设置仅本人可读的文件 ACL。Key 文件只放 Key 文本，可有一个末尾换行。两种来源不能同时使用。

```sh
freightclaw customs query --input ./customs-query.json --json
freightclaw customs query --input ./customs-query.json --key-file ~/.config/freightclaw/application-key --json
cat ./customs-query.json | freightclaw customs query --input - --json
```

不要把 Key 放到命令参数中；CLI 不提供明文 `--api-key` 参数，也不将 Key 写入配置。运行时只会将 Key 发送到所选服务地址，重定向会直接失败。

## 九条业务命令

| 命令 | 用途 | 输入示例 |
| --- | --- | --- |
| `cargo calculate` | 货物体积、实际重、体积重、分泡 | `examples/cargo.json` |
| `container plan` | 装柜容量和装载摘要 | `examples/container.json` |
| `agent context` | 已授权的 Agent 标准上下文 | `examples/agent.json` |
| `customs query` | 关税和归类查询 | `examples/customs-query.json` |
| `customs tax` | 单项税费估算 | `examples/customs-tax.json` |
| `customs tax-batch` | 最多20项的批量税费估算 | `examples/customs-tax-batch.json` |
| `quote zone` | 加拿大尾程报价预览 | `examples/quote-zone.json` |
| `quote extract` | 询价文字提取及预览 | `examples/quote-extract.json` |
| `quote freightcom` | Freightcom LTL 报价预览 | `examples/quote-freightcom.json` |

所有示例都是合成输入，只展示字段格式。使用前应替换日期、货物、地址、归类和来源引用；装柜参数与分泡规则也必须使用业务实际证据。示例不代表当前有效报价、税率或实际运输可行性。用 `freightclaw schema <命令>` 查看该版本完整 Draft 2020-12 输入 Schema。

输入必须为 JSON 对象。业务命令自动添加 API 的 `schema_version` 和 `input` 外层；调用方只填写示例中的领域字段。`cargo` 和 `container` 自身要求的版本字段仍须保留。金额及重量等小数使用字符串，并按 Schema 提供币种或单位。来源不足时允许服务器返回 `needs_input`、`manual_review` 或 `unavailable`。

## 输出与脚本处理

默认标准输出是缩进 JSON，`--json` 切换为单行 JSON。通过合同校验的响应完整保留服务器状态、来源版本、警告和请求引用；CLI 不因 HTTP 200 将结果改写为成功。参数、网络和协议错误只写标准错误，格式为 `{"cli_error":{"code":"…","message":"…"}}`，标准输出保持为空。

| 退出码 | 含义 |
| --- | --- |
| 0 | `success`，或本地帮助、版本、Schema、命令目录读取成功 |
| 1 | 网络/超时/重定向/响应合同错误 |
| 2 | 参数、输入、文件或凭证配置错误 |
| 3 | `needs_input`：需要补资料 |
| 4 | `manual_review`：需要人工复核 |
| 5 | `blocked`：鉴权、权限或策略阻止 |
| 6 | `unavailable`：服务或来源不可用 |

HTTP 鉴权失败若有有效 API 错误包络，会保留原响应并返回对应业务退出码；无法验证的 HTML 或异常正文不会原样输出。输出可能包含你请求的业务数据，请按已有业务权限处理重定向文件。

## 参数与边界

- `--input <文件>` / `-i <文件>`，或 `--input -` 读取标准输入。
- `--endpoint <origin>`，也可设置 `FREIGHTCLAW_ENDPOINT`；默认 `https://www.freightclaw.net`。地址只允许 HTTPS origin 或本机 HTTP，不允许路径、用户密码、查询参数或片段。只能填自己信任的服务地址。
- `--timeout <秒>`：1–60的整数，默认15；分别限制标准输入等待及整个网络请求（包括响应读取）。
- 输入与完整 API 请求均不超过32 KiB；响应最多2 MiB；Key 文件最多4 KiB。
- 不自动重试，不跟随重定向，不发送浏览器 Cookie，不提供任意 URL/工具调用或 tenant/actor 覆盖参数。
- CLI 的 Schema 随安装包冻结；服务器更新合同后，应安装对应新版本，不能通过关闭校验继续调用。
- 个人关务历史、报价保存、人工审核和 PDF 等人员操作使用网页登录。统一应用 Key 不能替代人员身份。
- RiskCustoms 的正式数据未发布时，CLI 会保留 `unavailable`。安装完成不代表来源数据、正式供应商凭证或真实客户身份验收完成。

## 从仓库构建

```sh
npm ci
npm run build:cli
npm pack ./dist/cli
```

构建将运行代码、当前 OpenAPI Schema 和所需校验库打包到 `dist/cli`，不需要运行时下载合同或访问源码目录。安装包不包含服务器、凭证和业务数据库。第三方许可列于包内 `THIRD-PARTY-NOTICES.txt`。
