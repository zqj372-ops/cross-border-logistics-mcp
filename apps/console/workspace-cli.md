# 后台管理 CLI（本地开发版）

本页对应开发分支 `codex/native-business-admin-20260907`。官网 v0.1.0 下载包尚未包含 `workspace` 命令；当前人员登录只在本地隔离验收环境启用。已有查询 Key 与权限继续保留。

## 构建与登录

在该分支仓库根目录执行：

```sh
npm ci
npm run build:cli
node dist/cli/bin/freightclaw.mjs workspace login start --endpoint http://127.0.0.1:8907 --session-file ~/.config/freightclaw/local-session.json
```

首次发起返回退出码 3 和确认链接；打开链接，以账号、密码、图形验证码登录，核对代码并点击“确认连接”。随后执行：

```sh
node dist/cli/bin/freightclaw.mjs workspace login finish --session-file ~/.config/freightclaw/local-session.json
```

后续命令均追加同一个 `--session-file`；也可设置 `FREIGHTCLAW_SESSION_FILE` 指向该文件。会话绑定服务地址，不能换地址复用。文件包含凭证，只能本人读取，不要上传；默认会话最多 30 分钟。再次登录使用新文件路径，或先正常退出。应用 Key 不会自动获得后台管理权限。

## 已实现命令

下列示例省略共同前缀 `node dist/cli/bin/freightclaw.mjs`。`--json` 输出紧凑 JSON；`--input -` 可读取标准输入。

| 命令 | 用途 |
| --- | --- |
| `workspace commands` | 查询管理命令目录 |
| `workspace whoami` | 当前人员身份 |
| `workspace organizations` | 可进入的企业 |
| `workspace state` | 当前企业、成员与应用状态 |
| `workspace use --input organization.json --idempotency-key <本次唯一值>` | 切换企业；输入 `{"organization_id":"实际企业ID"}`，平台工作区使用 null |
| `workspace channels list` | 渠道列表 |
| `workspace channels get --id <渠道ID>` | 草稿和当前发布版本 |
| `workspace channels create --input channel.json --idempotency-key <本次唯一值>` | 新增草稿 |
| `workspace channels save --id <渠道ID> --input save.json --idempotency-key <本次唯一值>` | 保存草稿 |
| `workspace channels preview --id <渠道ID>` | 预览当前草稿，取得版本及确认摘要 |
| `workspace channels publish --id <渠道ID> --input publish.json --idempotency-key <本次唯一值>` | 确认发布 |
| `workspace channels history --id <渠道ID>` | 发布版本和脱敏操作记录 |
| `workspace channels disable --id <渠道ID> --input version.json --idempotency-key <本次唯一值>` | 停用当前发布版本 |
| `workspace channels rollback --id <渠道ID> --input rollback.json --idempotency-key <本次唯一值>` | 回退指定历史发布版本 |
| `workspace cases list` | 自己的询价；管理查询输入 `{"management":true}` |
| `workspace cases get --id <询价ID>` | 详情和进度；内部备注按权限过滤 |
| `workspace cases create --input inquiry.json --idempotency-key <本次唯一值>` | 提交询价 |
| `workspace cases update --id <询价ID> --input update.json --idempotency-key <本次唯一值>` | 管理员更新状态与备注 |
| `workspace cases reply --id <询价ID> --input reply.json --idempotency-key <本次唯一值>` | 客户补充资料 |
| `workspace logout` | 撤销独立 CLI 会话并删除对应文件，网页继续登录 |

## 渠道输入与发布

用 `workspace schema channels create` 查看字段；`save`、`publish`、`disable`、`rollback` 同样提供输入 Schema。以下为合成格式，名称和日期请替换为实际资料：

```json
{"code":"CA-SEA","name":"示例海运渠道","warehouse":"示例始发仓","origin_country":"CN","destination_country":"CA","service":"ocean_fcl","currency":"CAD","valid_from":"2026-09-01","valid_until":"2027-12-31"}
```

- 保存：`{"expected_version":1,"input":{完整渠道字段}}`。编号创建后固定。
- 发布：先 preview，再传 `{"expected_version":返回版本,"preview_hash":"返回摘要"}`。
- 停用：`{"expected_version":当前版本}`。
- 回退：先 history 选定 `release_id`，执行 `channels preview --id <渠道ID> --input target.json`，其中 target.json 为 `{"release_id":"选定发布ID"}`；确认后传 `{"expected_version":预览版本,"preview_hash":"预览摘要","release_id":"选定发布ID"}` 给 rollback。
- 每次写入显式提供 16–128 位 `--idempotency-key`；同一次操作重试复用原值，内容变化必须换值。CLI 不自动重试。
- 草稿保存不会覆盖当前发布版本；版本变化会拒绝旧请求。渠道信息尚不含运价、分区与计费规则，始终返回 `ready_for_quotes:false`。

询价输入合同位于仓库 `schemas/access-gateway/portal-cases-{input,update,reply,list}.schema.json`。也可使用 `workspace schema cases create`（以及 list、update、reply）查看安装包内的合同；CLI 会校验输入与成功响应。

## 交付范围

目前完成渠道配置和询价处理的网页、API、CLI 共用流程。运价、邮编分区、附加费、原生关务发布、OCR、报价导出、邮件订舱和 SO 识别仍按路线图推进；既有成员、授权、个人历史等页面的 CLI 覆盖也待补齐。后续功能以三端一起验收为完成条件，不能把页面存在或命令存在视为业务已经可用。邮件及订舱等外发操作仍需明确确认。

关务、私人地址运价、Freightcom 配置与人员身份查询：参见 [业务操作说明](native-business.md)。新增操作与网站共用当前企业配置和权限。

## 报价单制作

报价单通过人员会话管理，入口是服务市场 → 报价单制作。查询 API Key 不具备文档保存或确认权限。

- `workspace documents config`：读取当前企业模板；空白返回 `input: null`。
- `workspace documents config-save --input template-save.json --idempotency-key <唯一键>`：负责人/管理员保存公司信息、客户条款和常用费用；需要 `expected_version` 与 `confirmed: true`。
- `workspace documents preview --input preview.json`：核对 `{ "input": <报价单> }`，返回费用合计、模板版本和十分钟预览。
- `workspace documents save --input save.json --idempotency-key <唯一键>`：将预览返回的 `input`、`template_version`、`preview_hash`、`preview_expires_at` 与 `confirmed: true` 提交；不要将 `totals` 作为保存输入。
- `workspace documents list --input list.json`：可选 `limit`（1—100）和 `before`（上一页的 `next_cursor`）。
- `workspace documents get --input record.json`：输入 `{ "id": "记录 UUID" }`，读回保存时的模板和报价快照。修改时以其 `input` 重新预览和保存新单据。
- `workspace documents approve --input approval.json --idempotency-key <唯一键>`：负责人/管理员人工核对。必须填写 `id`、`expected_version`、`evidence_ref`、`evidence_version`、`review_notes`、`confirmation: "human_verified_price_and_source"`。
- `workspace documents export --input record.json --file ./quotation.pdf`：导出并校验 PDF；不会覆盖已有文件。未确认记录带草稿标识；已确认但过期的报价禁止导出正式版。

上述命令均带 `--session-file <私有会话文件>`。完整字段使用 `workspace schema documents preview` 等命令查看。金额、数量、汇率均为十进制字符串；USD/CAD 到 CNY 的汇率允许 `null`，此时不虚构折算总额。PDF 不嵌入可编辑输入或隐藏费用原文。程序不会发送邮件、下单或订舱。
