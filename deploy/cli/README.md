# FreightClaw CLI

[文档中心](../../docs/README.md) / CLI

命令行复用现有 REST API 和输入 Schema，业务数据保存在服务器。价格、税率和权限由服务端决定。

## 安装

需要 Node.js 22.13+。从[官网 CLI 页面](https://www.freightclaw.net/console/#cli)取得对应版本的安装包和校验文件；当前仓库产品版本为 0.022，npm semver 为 0.0.22。官网包是否已更新须另行核对。

```sh
npm install --global https://www.freightclaw.net/downloads/freightclaw-cli-0.022.tgz
freightclaw --version
freightclaw commands
freightclaw status
freightclaw schema customs query
```

包由官网托管，未发布到公共 npm registry。`status` 不读取 Key，只检查 Portal 就绪；不证明运价、关务来源或承运商连接可用。

## 选对身份

| 任务 | 身份 | 说明 |
| --- | --- | --- |
| 应用查询、自动化试算 | 应用 Key | 仅能调用已授予的服务 |
| 本人业务、配置、审核 | workspace 人员会话 | 浏览器核对代码后确认连接 |
| 公开 FCL 询价 | 独立询价会话 | 绑定本票，不复用人员会话 |

人员登录、FCL 和附件命令见[人员 CLI](../../apps/console/workspace-cli.md)。API Key 不能替代人员身份。

应用 Key 从 `FREIGHTCLAW_API_KEY` 或 `--key-file` 读取，二者不能同时配置。文件只放 Key 文本，macOS/Linux 要求本人拥有且其他用户无权限（如 0600），Windows 需自行限制 ACL。不要把 Key 放在命令参数或提交进仓库。

```sh
freightclaw customs query --input ./customs-query.json --json
freightclaw customs query --input ./customs-query.json --key-file ~/.config/freightclaw/application-key --json
cat ./customs-query.json | freightclaw customs query --input - --json
```

## 机器业务命令

| 命令 | 用途 | 合成示例 |
| --- | --- | --- |
| `cargo calculate` | 体积、重量、分泡 | [cargo.json](examples/cargo.json) |
| `container plan` | 装柜容量与摘要 | [container.json](examples/container.json) |
| `agent context` | 已授权标准上下文 | [agent.json](examples/agent.json) |
| `customs query` | 关税与归类查询 | [customs-query.json](examples/customs-query.json) |
| `customs tax` | 单项税费估算 | [customs-tax.json](examples/customs-tax.json) |
| `customs tax-batch` | 批量估算，最多 20 项 | [customs-tax-batch.json](examples/customs-tax-batch.json) |
| `quote zone` | 加拿大尾程试算 | [quote-zone.json](examples/quote-zone.json) |
| `quote extract` | 文字资料提取 | [quote-extract.json](examples/quote-extract.json) |
| `quote freightcom` | Freightcom LTL 试算 | [quote-freightcom.json](examples/quote-freightcom.json) |

示例只说明格式，使用前替换日期、货物、地址、来源和规则。运行 `freightclaw schema <命令>` 查看安装版本的完整合同。输入是 JSON 对象；业务外层 schema_version/input 由 CLI 添加，cargo/container 自身的版本字段仍需保留。金额与物理量按 Schema 使用十进制字符串、币种和单位。

## 输出与退出码

默认输出缩进 JSON，`--json` 输出单行。业务包络保留服务端状态、来源和警告；HTTP 200 不等于业务成功。参数、网络或协议错误写入 stderr 的 `cli_error`，不输出未经验证的 HTML 或原始错误正文。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功，或帮助 / Schema / 本地目录读取成功 |
| 1 | 网络、超时、重定向、协议错误 |
| 2 | 输入、参数、文件或凭证配置错误 |
| 3 | `needs_input`，补资料 |
| 4 | `manual_review`，人工复核 |
| 5 | `blocked`，权限或策略阻止 |
| 6 | `unavailable`，服务或来源不可用 |

## 参数与限制

| 参数 / 限制 | 规则 |
| --- | --- |
| `--input` / `-i` | 文件路径；`-` 表示标准输入 |
| `--endpoint` | 默认官网；也可用 `FREIGHTCLAW_ENDPOINT`。仅可信 HTTPS origin 或本机 HTTP，不带路径、查询、片段或用户密码 |
| `--timeout` | 1–60 秒整数，默认 15 秒，限制输入等待和完整网络请求 |
| 查询输入 / 请求 | 最多 32 KiB |
| 查询响应 / Key 文件 | 最多 2 MiB / 4 KiB |

查询不自动重试、不跟随重定向、不发送浏览器 Cookie，不提供任意 URL 或 tenant/actor 覆盖。人员导入等命令有各自 Schema 限制。合同不匹配时升级到对应版本，不关闭校验。输出可能包含业务数据，妥善保存。

## 仓库构建

```sh
npm ci
npm run build:cli
npm pack ./dist/cli
```

产物包含代码、冻结的 OpenAPI 和校验库，不含服务端、凭证或业务数据库。许可见包内 `THIRD-PARTY-NOTICES.txt`。[构建与交付手册](../../docs/runbooks/freightclaw-cli.md)说明验证和回滚。
