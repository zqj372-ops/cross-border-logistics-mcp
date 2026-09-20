# FCL M1 本地验收 Runbook

状态：FCL.13c 的合成本地验收步骤。本文记录 K12 以外的本机 root 验收结果，并给出仓库相对的可复现路径。

这不是生产部署、真实客户验收或 `pilot_verified`。测试数据、账号、数据库、Cookie、PDF 和 credential 都是合成本地资料；不得指向生产数据库、生产服务器、真实邮件收件人或真实承运商凭据。

最终实现 SHA：

```text
47766b2874e41542d9ecb6f62c53ef8c2426ac5f
```

13c 固定后的本机验收证据目录（外部主机路径，仅作引用；不要远程复制私有数据库）：

```text
/Users/autumn/Documents/Codex/outputs/fcl-m1-20260921
```

## 1. 验收范围

只验收 FCL Inquiry → Case → Rate → Cost/Sell → Document review/approve → PDF → Handoff 的主链，以及 Web/API/CLI 读取同一记录、同一版本和同一票恢复。

不验收：

- 真实 production FCL receiver authority；
- 真实 IdP、真实邮件或真实承运商；
- Booking/SO/订单/Shipment；
- 生产部署、生产数据库迁移或公网流量；
- 把 `sent` 当作 delivered，或把 HTTP 200 当作客户已收到。

## 2. 构建顺序

`npm run build` 会清空 `dist`，所以 CLI 必须最后构建。先在仓库根目录执行：

```sh
npm ci
npm run build
npm run build:inquiry
npm run build:cli
node dist/cli/bin/freightclaw.mjs --version
```

全仓 `npm test` 中部分 build 测试会重建 `dist`。如果测试后还要运行 bundled CLI 演示，先重新执行一次 `npm run build:cli`；这是生成物生命周期，不代表 FCL 实现失败。

可选候选功能 Schema 复核：

```sh
npm run generate:native-schemas
npm run generate:portal-openapi
npm run validate:schemas
git diff --check
```

`validate:schemas` 必须包含 `schemas/access-gateway/fcl/**`，不能只用旧根目录计数代替。

## 3. 合成 FCL fixture

### 3.1 私有目录和端口

绝对私有目录是必填约束。不要使用仓库目录、共享目录或生产路径。示例：

```sh
umask 077
export FCL_ACCEPTANCE_ROOT="$HOME/.local/state/freightclaw-fcl-acceptance-20260921"
export FCL_ACCEPTANCE_PORT=8891
install -d -m 700 "$FCL_ACCEPTANCE_ROOT"
```

端口必须是本机空闲 loopback 端口；server 只监听 `127.0.0.1`，不接受远程主机。

### 3.2 Renderer 注入

正式 PDF 要求绝对路径的浏览器可执行文件和受沙箱保护的渲染器。生产或部署者可以选择以下一种方式；不要让 CLI 自动寻找浏览器，也不要传 `--no-sandbox`。

方式 A：只用浏览器可执行文件，走 JSON 渲染回退：

```sh
export PORTAL_PDF_BROWSER_EXECUTABLE="/absolute/path/to/sandbox-capable-edge-or-chromium"
```

方式 B：fixture 额外注入 Playwright 模块，渲染器会显式使用 `chromiumSandbox:true`：

```sh
export PORTAL_PDF_BROWSER_EXECUTABLE="/absolute/path/to/sandbox-capable-edge-or-chromium"
export PORTAL_FIXTURE_PDF_PLAYWRIGHT_MODULE="/absolute/path/to/playwright/module.mjs"
```

`PORTAL_FIXTURE_PDF_PLAYWRIGHT_MODULE` 只在 `--fixtures` 下读取，必须是绝对路径。两种方式都不得加入 `--no-sandbox`、`--disable-setuid-sandbox` 或同等降级参数。

### 3.3 启动零企业个人 FCL fixture

```sh
PORTAL_FIXTURE_FCL_PERSONAL=true \
PORTAL_FIXTURE_DIRECTORY="$FCL_ACCEPTANCE_ROOT" \
PORTAL_FIXTURE_PORT="$FCL_ACCEPTANCE_PORT" \
node dist/src/logistics_mcp/server/portal-fixture.mjs --fixtures
```

启动后记录实际 origin，例如：

```text
http://127.0.0.1:8891
```

在另一个终端设置：

```sh
export FCL_BASE_URL="http://127.0.0.1:$FCL_ACCEPTANCE_PORT"
```

该模式应显示或读回 zero organizations / zero memberships。不要切换到 `org_fixture`，不要把平台 operator 当成 FCL 个人 receiver，也不要用 API Key 代替 person identity。

## 4. 页面入口与合成身份

公开入口：

```text
http://127.0.0.1:<PORT>/inquiry/
```

个人 FCL 入口：

```text
http://127.0.0.1:<PORT>/console/#fcl
```

本机验收账号来自现有闭集合：

```text
fcl-receiver
```

它映射到源码中的 `fixture-fcl-receiver`。密码和 captcha 仅使用 `services/access-gateway/portal/form-login.ts` 中声明为“本地验收”的合成值；不要复制、扩展或替换为真实账号，也不要把密码写入 runbook、日志、fixture 或 shell history。等待页面图形验证码后登录。

若只做自动化验证，可使用既有 `/console/api/v1/fixture-login` 和 `FIXTURE_PORTAL_IDENTITIES`，但公开提交与个人读回仍必须走同一 loopback server。

## 5. CLI device flow

使用同一 origin 建立独立 0600 person session：

```sh
export FL="$PWD/dist/cli/bin/freightclaw.mjs"
export FCL_STAFF_SESSION="$FCL_ACCEPTANCE_ROOT/cli-session.json"

node "$FL" workspace login start \
  --endpoint "$FCL_BASE_URL" \
  --session-file "$FCL_STAFF_SESSION"
```

打开输出的 verification URL，使用合成 `fcl-receiver` 登录并确认设备码，然后执行：

```sh
node "$FL" workspace login finish --session-file "$FCL_STAFF_SESSION"
node "$FL" workspace commands --json
node "$FL" workspace schema fcl case-list
node "$FL" workspace schema fcl inquiry submit
```

预期：

- staff 命令的 `auth` 为 `person_session`，scope 为 `fcl_personal`；
- public 命令的 `auth` 为 `public_inquiry_session`，scope 为 `public_inquiry_ticket`；
- `--api-key`、企业上下文和其他个人不能替代精确 FCL receiver；
- CLI 不自动重试，不自动 `confirmed`，不选最低价，不补 FX，不填 0。

## 6. 公开 Inquiry 与 ticket 恢复

### 6.1 Web 路径

在 `/inquiry/` 依次填写线路、柜型/柜数、货物、日期、Incoterm、服务和联系人，勾选 consent 后提交。公开 `submit` 成功响应按合同含一次性 `credential`；Web 只在 URL fragment/内存中暂存，随后用 exchange 换取 `Path=/inquiry` 的 HttpOnly cookie，成功后才清除恢复信息。

不要：

- 把 credential 放进 query、localStorage、普通 `--input`、日志或截图；
- 用第二个匿名身份覆盖未知结果的 pending；
- 把 `submitted` 或邮件生成当成已报价。

### 6.2 CLI 路径与恢复

使用独立 0600 文件，不复用 staff session：

```sh
export FCL_INQUIRY_SESSION="$FCL_ACCEPTANCE_ROOT/inquiry-session.json"

node "$FL" workspace fcl inquiry session \
  --inquiry-session-file "$FCL_INQUIRY_SESSION" \
  --endpoint "$FCL_BASE_URL"

node "$FL" workspace fcl inquiry submit \
  --inquiry-session-file "$FCL_INQUIRY_SESSION" \
  --input "$FCL_ACCEPTANCE_ROOT/inquiry.json" \
  --idempotency-key inquiry-submit-0000001
```

`inquiry.json` 必须以 `workspace schema fcl inquiry submit` 的闭合 Schema 为准；至少包含 synth 线路、柜型、日期、服务、联系人和 consent。提交前 CLI 会把 origin、匿名 cookie/CSRF、pending key、canonical body digest 和 body snapshot 写入 0600 文件。网络未知结果按原 key/body 重试；不能自动换匿名身份。

提交成功后：

```sh
node "$FL" workspace fcl inquiry exchange \
  --inquiry-session-file "$FCL_INQUIRY_SESSION" \
  --idempotency-key inquiry-exchange-00001

node "$FL" workspace fcl inquiry get \
  --inquiry-session-file "$FCL_INQUIRY_SESSION"
```

CLI 的 submit stdout 不输出一次性 credential；它只输出脱敏 metadata。credential 只允许来自受限 0600 ticket 文件，或 Web/外部恢复时由受限 0600 文件或 stdin 提供 `{"inquiry_id":"...","credential":"..."}` 给 exchange。exchange 成功后 local ticket 保留 inquiry_id，清除 raw credential，并保留 cookie/CSRF。

每次 restart 后，public cookie/ticket 文件只要仍绑定同一 origin，就应继续读回同一票；staff person session 和浏览器登录状态是进程内 session，重启后需重新走 device flow 或网页登录。

## 7. Case、补料与确认验收

在 `/console/#fcl` 打开该 Case，或在 CLI 使用：

```sh
node "$FL" workspace fcl case-list --session-file "$FCL_STAFF_SESSION"
node "$FL" workspace fcl case-get --session-file "$FCL_STAFF_SESSION" \
  --input "$FCL_ACCEPTANCE_ROOT/case-get.json"
```

按顺序人工核对：

1. 原始 Inquiry 原件保持不变；当前结构化 Case 可补充，不可覆盖原件。
2. 工作人员代录完整字段，事件显示 actor 和 before/after。
3. 将 Case 置为 `needs_input`，公开页可在本票范围内提交完整补充字段；attempt 必须拒绝跨票、过期或错误 credential。
4. 工作人员确认字段后，Case 版本递增；确认是独立写动作，不等同于客户补充。
5. 重复 same key/body 不重复 Case、事件或通知。

补充响应含 notification 字段时，状态只能是 `not_attempted`、`disabled`、`sent`、`failed`。**`sent` 只表示受控 transport 接受了本次尝试，不表示客户收到、打开或已回复**；fixture 的 disabled/失败也不能阻断已保存 Inquiry。

## 8. Rate、CAS 与历史版本

用 `workspace schema fcl rate-save` 生成闭合输入。Rate 必须明确：

- POL/POD；
- container type、数量依据、币种和 decimal string；
- 供应商标签、source_ref、source_version；
- `valid_from`、`valid_until`；
- additional fees 的单位、数量和条件。

`rate-save.json` 是闭合的 `{expected_version,input}`；示例只可使用合成来源：

```json
{
  "expected_version": 0,
  "input": {
    "contract_version": "fcl-rate-dataset@2026-09-20.v1",
    "label": "Synthetic acceptance rates",
    "rates": [
      {
        "rate_id": "00000000-0000-4000-8000-000000000201",
        "supplier_label": "Synthetic carrier",
        "pol": "Yantian",
        "pod": "Vancouver",
        "valid_from": "2026-10-01",
        "valid_until": "2026-10-31",
        "source_ref": "fixture:fcl-rate-001",
        "source_version": "v1",
        "note": null,
        "items": [{"container_type": "40HQ", "ocean_freight": "3200", "currency": "USD"}],
        "additional_fees": []
      }
    ]
  }
}
```

保存、预览、发布必须按顺序执行：

```sh
node "$FL" workspace fcl rate-save --session-file "$FCL_STAFF_SESSION" \
  --input "$FCL_ACCEPTANCE_ROOT/rate-save.json" \
  --idempotency-key rate-save-0000001

node "$FL" workspace fcl rate-preview --session-file "$FCL_STAFF_SESSION"

node "$FL" workspace fcl rate-publish --session-file "$FCL_STAFF_SESSION" \
  --input "$FCL_ACCEPTANCE_ROOT/rate-publish.json" \
  --idempotency-key rate-publish-00001
```

`rate-preview` 必须返回 `preview_hash` 和 `can_publish`；`rate-publish` 必须使用当前 expected_version、刚返回的 preview hash 和精确 confirmation `reviewed_sources_and_conditions`。旧版本、篡改 hash、缺失来源或过期窗口必须 `blocked` / `manual_review`，不能伪装成功。

历史回退先预览已选 `release_id`，再用同一 `release_id`、`preview_hash` 和当前版本调用 `rate-rollback`。回退创建新的 active release，不覆盖旧发布。

## 9. Cost/Sell、混币与调查

先用 `workspace schema fcl quote-match` 明确 `case_ref`、`expected_case_version`、补充 ref 和 selected rate。Match 的 `manual_review`、`blocked`、`unavailable` 必须原样显示，不自动选最低价。

首次 Cost/Sell 必须：

1. 用 `operation=create` 保存同一 `quote_ref`；
2. 缺售价、缺 FX 或服务范围不完整时返回 `needs_input`，保留 data 和版本；
3. 不补 0；在同 quote_ref 用 `operation=update` 提交售价、人工费用、服务范围和 FX；
4. 保存后只展示服务器计算的 Cost、Sell、GP 和 Margin。

本机最终合成验收使用了：

- 海运费：40HQ × 2，成本 USD 3,200/柜，售价 USD 3,500/柜；
- 人工费用：CAD 180；
- FX 快照：USD→CNY 7.2，CAD→CNY 5.2；
- 客户金额读回：USD 7,000、CAD 180；
- 统一 CNY 利润读回：CNY 4,626。

这不是固定生产报价，只是本地合成料号/路线/速率/费用的验收断言。缺 FX 的第一版可以是 `needs_input`，但必须在同一 `quote_ref` 更新，不能伪造统一利润。

## 10. Review、退回、PDF、交接与历史

### 10.1 Document review 与退回

用 `operation=create` 保存 Document，读取当前 document version 和 content digest。先运行 `document-review`，返回的 review hash 必须绑定当前 quote/source/config 版本。

故意退回一次：

```sh
node "$FL" workspace fcl document-reject --session-file "$FCL_STAFF_SESSION" \
  --input "$FCL_ACCEPTANCE_ROOT/document-reject.json" \
  --idempotency-key document-reject-0001
```

预期 `state=rejected`，正式 PDF 和 Handoff 被阻止。修改需求或来源后，重新生成 quote/document 版本，再次 review；只有当前版本的 review hash 才能交给：

```sh
node "$FL" workspace fcl document-approve --session-file "$FCL_STAFF_SESSION" \
  --input "$FCL_ACCEPTANCE_ROOT/document-approve.json" \
  --idempotency-key document-approve-0001
```

### 10.2 正式 PDF 与历史 PDF

正式导出必须提供新的本地路径：

```sh
node "$FL" workspace fcl document-export --session-file "$FCL_STAFF_SESSION" \
  --input "$FCL_ACCEPTANCE_ROOT/document-export.json" \
  --file "$FCL_ACCEPTANCE_ROOT/formal.pdf" \
  --idempotency-key document-export-0001
```

检查：

- response Schema、文件名、`%PDF-`、byte_length 和服务端 SHA-256；
- 本地文件 0600、`wx` 创建、已存在时不覆盖；
- stdout 不含 `content_base64`；
- 成本、供应商、内部备注和内部 trace 不进入客户 PDF；
- 历史导出必须 `historical=true`、`valid_now=false`，且旧 PDF 的 SHA-256 和页内容不被新模板改写。

本机最终验收对本机生成的 6 张 PDF 逐页目检，未发现裁切或重叠；K12 不代替 root 的 Edge/PDF 验收。

### 10.3 Handoff

Handoff 只能链接当前 approved document/version 和本次实际校验过的正式 PDF：

```sh
node "$FL" workspace fcl handoff-save --session-file "$FCL_STAFF_SESSION" \
  --input "$FCL_ACCEPTANCE_ROOT/handoff-save.json" \
  --idempotency-key handoff-save-0001
```

必须核对 Case version、quote version/digest、document version、PDF SHA-256 和 `confirmed=true`。有 pending、旧 document、旧 PDF 或 case version 冲突时必须 `blocked`/`manual_review`。

模板或报价变更后：

1. 新建新 Document 并重新 review/approve；
2. 旧 Document 的历史 PDF 仍按原版本读回，不随新模板变化；
3. 第二次 Handoff 只能指向新 approved 版本，不能把旧交接当当前成功；
4. original Inquiry、Case、旧 Quote、旧 Document 和旧 Handoff 均可追溯。

## 11. Restart 与 Web/CLI 读回

保持同一个 `PORTAL_FIXTURE_FCL_PERSONAL=true`、同一个绝对 `PORTAL_FIXTURE_DIRECTORY`，停止进程后用相同命令重启。不要创建新目录，不要 reset SQLite，不要修改持久化 secret。

重启后检查：

1. staff CLI session 重新走 device flow；
2. 网页重新登录 `fcl-receiver`；
3. public `--inquiry-session-file` 继续读回同一 origin、同一 inquiry_id；
4. Case、Rate release、Quote version、Document version、PDF SHA-256 和 Handoff 状态与重启前一致；
5. 旧 Key/fixture 数据仍为合成数据；不得把重启读回写成生产持久化成功。

## 12. 本机最终验收记录

以下结果是 root 在最终实现 SHA `47766b2` 上的实际本机验收，不是本文在 K12 重跑：

| 项目 | 结果 |
| --- | --- |
| 最终实现 | `47766b2874e41542d9ecb6f62c53ef8c2426ac5f`；clean |
| 构建/检查 | `build`、`build:inquiry`、`build:cli`、`typecheck`、`lint`、7 files/56 tests、Schema 124/17/11、diff clean 全部 PASS |
| 全仓测试 | 261 file pass / 2 skip；2,288 test pass / 10 skip；102 秒 |
| 真实 Edge Web | 21 项 PASS；zero org/memberships；无 pageerror |
| PDF | 6 张最终 PDF 逐页目检，无裁切重叠 |
| Web/CLI | 公开提交（commit 后丢响应同 key 恢复）→ 个人 device flow → Case 补料/确认 → Rate 发布 → 缺 FX 保存并同一 Quote 更新 → USD 7,000/CAD 180、CNY 4,626 利润读回 → review/approve → Edge PDF → Handoff → 模板更新新 Doc/历史 PDF 不变/第二交接 → 进程重启同一 DB 同票 Web/CLI 读回 |
| 外部证据 | `/Users/autumn/Documents/Codex/outputs/fcl-m1-20260921`（只作外部主机证据引用，不复制私有 DB） |

仓库相对可复现脚本：

```sh
PLAYWRIGHT_MODULE="/absolute/path/to/playwright/module.mjs" \
PLAYWRIGHT_EXECUTABLE_PATH="/absolute/path/to/sandbox-capable-edge-or-chromium" \
PORTAL_BASE_URL="$FCL_BASE_URL" \
node tests/e2e/portal-browser/fcl-personal-flow.mjs
```

该脚本输出 JSON checks 和 `status=pass/partial`。若 sandbox/renderer 不可用，只能记录 `partial` 和明确 reason，不能声明 PDF/Handoff 已通过。

精确 FCL 测试使用 shell 展开的仓库内文件集合：

```sh
npm test -- \
  tests/access-gateway/portal-fcl-*.test.ts \
  tests/e2e/fcl-inquiry-contracts.test.ts \
  tests/console/fcl-workspace.test.ts \
  tests/quote-documents/fcl-*.test.ts \
  tests/quote-native/fcl-*.test.ts
```

root 的独立 demo helper 不属于仓库自带能力，也不作为复现依赖；可检查仓库相对脚本、精确测试和上述外部证据目录。

### 12.1 补充本机证据

除完整 21 项 Edge 流外，root 还完成了以下独立本地检查：

- bundled CLI 公开提交了字段不完整的合成询价；`pol`、`cargo_ready_date` 和 `40HQ.quantity` 的 `null` 原样保留，`get.complete=false`，没有被 CLI 或服务端补 0、猜港口或自动填数量。
- exchange 后使用同一 key/body 再次提交，真实 server replay 返回同一 `inquiry_id`；演示库总票数为 2（既有验收票和新 demo 票），没有为同一 key 再建一票。
- 进程重启前旧 person session 继续调用返回 CLI exit 5（blocked）；重启后必须重新走 device flow，不能把旧 session 当当前授权。
- 演示读回仍为 0 organizations、0 memberships。
- root 还从 6 个关闭后的 DB/secret 私有副本启动 built portal fixture，`/inquiry/` 与 `/console/` 均返回 HTTP 200；该独立演示写入不影响原验收数据。
- root 的最终独立演示使用本机 loopback `http://127.0.0.1:60553`。该端口只记录 root 本机证据，不是远程可执行命令，也不写入最终复现步骤。

这些证据补充了“不完整输入保持不完整”和“重启/恢复不能改写原验收数据”的边界；它们仍属于合成本地验收，不代表生产或真实客户链。

## 13. 生产边界与退出条件

本 runbook 的完成条件只说明 local acceptance：代码、合成 fixture、真实本地 HTTP、真实 Edge 或部署者注入的受沙箱 renderer，以及可读回的合成记录。

仍待外部环境验证：

- 可信 production FCL receiver authority adapter；
- 真实 IdP authority；
- 真实邮件 transport 和 delivery 语义；
- 生产数据库、密钥、部署、回滚和运营人员验收。

因此 13c 是 `implemented + focused_verified + local_acceptance`；不是 `pilot_verified`，不是 `deployed`，也不代表生产已启用。任何一层未完成都必须保留 `manual_review`、`unavailable` 或 `blocked`，不能用 fixture success、HTTP 200、邮件 `sent` 或 PDF 生成替代真实业务证据。
