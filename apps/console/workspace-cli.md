# 人员 CLI

[CLI 参考](https://github.com/zqj372-ops/cross-border-logistics-mcp/blob/main/deploy/cli/README.md) / 人员操作

`workspace` 与网页使用同一业务接口和权限。人员会话、应用 Key、公开询价会话各自独立。实际命令和输入以安装包的 `workspace commands`、`workspace schema` 为准。

## 登录一次，再操作

```sh
freightclaw workspace login start --endpoint https://www.freightclaw.net --session-file ~/.config/freightclaw/session.json
```

首次返回退出码 3 与确认链接。打开链接，正常登录，核对代码并确认连接，再执行：

```sh
freightclaw workspace login finish --session-file ~/.config/freightclaw/session.json
freightclaw workspace whoami --session-file ~/.config/freightclaw/session.json
freightclaw workspace commands
```

后续命令携带同一 `--session-file`，或设置 `FREIGHTCLAW_SESSION_FILE`。会话绑定服务地址，默认最多 30 分钟，文件只允许本人读取。再次登录用新文件或先退出。`workspace logout` 撤销 CLI 会话并删除对应文件，不退出网页。

本地演示使用 `http://127.0.0.1:8882`，必须先启动对应 fixture；本地会话不能用于官网。

## 整柜业务

FCL 按个人账号隔离，无需先执行 organizations/use 或创建企业。

```sh
freightclaw workspace fcl case-list --session-file session.json
freightclaw workspace schema fcl quote-match
freightclaw workspace fcl rate-save --session-file session.json --input rates.json --idempotency-key rate-save-0000001
freightclaw workspace fcl document-export --session-file session.json --input export.json --file ./quote.pdf --idempotency-key document-export-01
```

| 任务 | 命令范围 |
| --- | --- |
| 本人受理询价 | `fcl case-create`、`case-list` 及案件 action |
| 维护价格、制作报价 | rate / template / quote / document 对应 action，先查 Schema |
| 待办与执行 | `workspace-list`、`execution-preview/start/get` |
| 节点协作 | `execution-node-*`、`execution-shared-save` |
| 历史与邮件 | `execution-history`、`execution-mail-list`、`notification-v2-*` |

海运费与模板可省略 valid_from/valid_until；正式报价保留有效期。基础海运费只从所选运价读取，旧模板重复费用先核对。执行引用来自已批准的正式文件，不能自动挑最新报价。

人员动作使用固定 `/console/api/v1/fcl/<action>`。执行参与权不自动赋予原询价、报价和运价库读取权限。PDF 导出不覆盖已有文件，stdout 不输出 content_base64。

## FCL 人员与公开询价

公开询价使用独立 `--inquiry-session-file`：

```sh
freightclaw workspace fcl inquiry session --inquiry-session-file inquiry.json
freightclaw workspace fcl inquiry submit --inquiry-session-file inquiry.json --input request.json --idempotency-key inquiry-submit-0001
freightclaw workspace fcl inquiry exchange --inquiry-session-file inquiry.json --idempotency-key inquiry-exchange-01
freightclaw workspace fcl inquiry get --inquiry-session-file inquiry.json
freightclaw workspace fcl inquiry supplement --inquiry-session-file inquiry.json --input supplement.json --idempotency-key inquiry-supplement-01
freightclaw workspace fcl inquiry logout --inquiry-session-file inquiry.json --idempotency-key inquiry-logout-0001
```

文件绑定单一 origin 和本票，拒绝 symlink，仅本人可读。提交前保存 pending key/body；结果未知时不换身份、不自动重试。exchange 可读 Web 的受限恢复文件 `{inquiry_id,credential}`，凭据不放进命令参数、URL、环境变量或输出。

## 写操作的共同规则

1. 先读当前记录和 expected_version，再按 `workspace schema <命令>` 准备输入。
2. 每次写入提供 16–128 位 `--idempotency-key`；同一次重试复用原值，内容改变使用新值。
3. 要求预览的操作先取得当前 preview_hash，再提交确认。保存草稿不等于发布。
4. 写后读回。版本冲突刷新核对；邮件 unknown 先经 `execution-mail-resolve` 核实，确认未发后才重试。smtp_accepted 不等于送达。

## 其他人员功能

| 组 | 用途与边界 |
| --- | --- |
| `channels` | 渠道草稿、预览、发布、历史、停用和回退；不含运价规则，ready_for_quotes 保持 false |
| `cases` | 普通询价列表、详情、创建、更新和客户补充 |
| `documents` | 模板、preview/save/list/get/approve/reject/export；native-prepare 由服务端重算并绑定来源 |
| `customs-data` / `customs-packages` | 关务草稿和完整快照的导入、浏览及发布控制 |
| `residential-rates` | 私人地址价格配置、表格预览导入和导出 |
| `quote self` / `quote freightcom` | 两条独立询价路径，不自动共享或覆盖资料 |
| `schedules` / `terminals` | 发布快照 query/get/save/preview/publish/disable/rollback |
| `organizations` / `state` / `use` | 旧组织配置管理；不是个人 FCL 的前置步骤 |

报价单保存使用预览返回的输入、模板版本、哈希和截止时间，不将 totals 当作保存输入。审批需真实人工证据；退回或过期记录不能导出正式版。独立文档制作不自动发送邮件或订舱。

船期/码头快照每批最多 500 条、512 KiB；来源带版本、观察和失效时间，事件时间带时区。无匹配不等于没有航次。快照维护与受控船期采集是不同路径，不能将录入来源 URL 理解成自动抓取。

[原生业务配置](native-business.md)说明关务、私人地址和 Freightcom 的具体输入；[船期采集器](https://github.com/zqj372-ops/cross-border-logistics-mcp/blob/main/services/maritime/schedule-collector/README.md)说明获准来源。API Key 不会因网页管理权限变化而自动增权。
