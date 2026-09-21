# FCL Production Wiring v1

状态：Accepted by root，2026-09-21。

本 RFC 只补齐 FCL M1 从本地验收到生产的 authority、持久化、邮件和回滚接线。它不改变
13a–13c 已接受的 FCL HTTP、Web、CLI、公开本票、Case、Rate、Quote、Document 或
Handoff 业务合同，不新增 MCP tool，也不让 API Key 获得人员操作权限。

## 1. 生产 receiver authority

生产 FCL 必须使用 OIDC 稳定 `sub`，不得使用邮箱、Portal 用户表、登录 session、
平台角色或客户端 boolean 推导 receiver。

```text
PORTAL_FCL_RECEIVER_SUB=<Authentik user UUID>
PORTAL_FCL_RECEIVER_AUTHORITY_URL=https://<OIDC-origin>/api/v3/core/users/<pk>/

authority response projection:
  uuid                 == PORTAL_FCL_RECEIVER_SUB
  is_active            == true
  attributes.email_verified == true
```

authority 只允许与 OIDC issuer 同 origin 的 exact HTTPS endpoint、只读 Bearer token 文件、
短超时、禁止 redirect、限制响应大小和 JSON content type。`uuid` 是正式字段；`uid`、`pk`
或其他响应字段都不能代替 OIDC `sub`。网络、超时、非 2xx、malformed 或 oversized 响应
均失败闭合。
账号 inactive、邮箱未验证或 UUID 不匹配属于明确拒绝；IdP 暂时不可用属于
`unavailable`，不能伪装为 active。

验证使用异步 `FclReceiverAuthority` 和请求级 `AsyncLocalStorage`：

- 启动组合只在 `authority.withVerified(...)` 中构造需要同步 startup callback 的 FCL
  services；长期 HTTP server、listeners、timers 必须在 ALS 外创建/启动，不能让启动 proof
  被长寿命 async resource 继承。
- 每个 staff/public FCL HTTP action 在进入同步 domain service 前重新验证一次。
- 同步 `receiverIsActive` 只信任当前异步上下文中的 proof；没有 request proof 时返回
  false。不得使用全局 boolean、启动时永久 true 或 Portal session 自称活跃。
- 同时覆盖 `/session` 的 `fcl_capability`、登录返回、session organization switch 和 CLI
  device flow 读取；authority 不可用时 capability 为 false，不打断无关 Portal 服务。
- staff action 还要求 `ctx.identity.userId == proof.sub`、`emailVerified=true`、
  `organizationId=null`。public 本票请求只要求 authority 证明 receiver 当前可用。

生产 authority 不可用时，FCL route 返回既有 `unavailable` 或 `blocked`，旧企业
Case/Native/Quote/Document 服务继续运行。

## 2. 生产 wiring

`PORTAL_FCL_ENABLED=true` 时，生产组合必须显式要求：

```text
PORTAL_QUOTE_DOCUMENTS_SQLITE_PATH=<absolute migrated path>
PORTAL_FCL_RECEIVER_SUB=<uuid>
PORTAL_FCL_RECEIVER_AUTHORITY_URL=<absolute https endpoint>
PORTAL_FCL_RECEIVER_AUTHORITY_TOKEN_FILE=<0600 file>
PORTAL_FCL_CASE_CREDENTIAL_SECRET_FILE=<0600 file, >=32 bytes>
PORTAL_FCL_PUBLIC_SESSION_SECRET_FILE=<0600 file, >=32 bytes>
PORTAL_FCL_SMTP_CONFIG_FILE=<0600 JSON file>
PORTAL_PDF_BROWSER_EXECUTABLE=<absolute browser path>
```

FCL=true 不要求 `PORTAL_CASES_ENABLED=true` 或 `PORTAL_NATIVE_BUSINESS_ENABLED=true`。
FCL 创建自己的 Case/Native/Document scope，只把 FCL-specific service 注入 FCL routes；
不得因 FCL 启用顺带开启 NativeFreightcom、CustomsPackages、通用 native admin 或扩大 machine
Key 权限。缺少任一 receiver/secret/authority/store/mail/renderer 配置时启动失败。不得隐式
使用 fixture receiver、默认 secret、进程内存随机 secret 或本地 fixture store。

FCL 持久化继续使用个人 scope SQLite：

```text
business-cases.sqlite      user_version=2
native-business.sqlite     user_version=3
quote-documents.sqlite     user_version=5
```

Portal、session、business-access、calls 和 public quota 的现有存储后端不变。FCL 不写入
Gateway tenant PostgreSQL schema。

实际快照、离线迁移、先 disabled v5 再启用、SMTP 验收和前向回滚步骤见
[FCL 生产接线与切流](../runbooks/2026-09-21-fcl-production-cutover.md)。

## 3. FCL=false 的 v5 兼容启动

runtime 不自动迁移。生产必须先用离线脚本升级 SQLite，之后 normal runtime 只以
`fcl: { mode: "reopen" }` 打开最终 schema。

候选制品必须支持：

- 已迁移 v5 数据库 + `PORTAL_FCL_ENABLED=false`：以 v5 reopen 打开 stores，不构造 FCL
  domain options，不挂 `/fcl` 或 `/inquiry/api/v1`，原企业文档服务继续可用。
- 已迁移 v5 数据库 + authority 缺失：启动不得失败于无关 Portal；FCL capability 为
  false，FCL route 不挂载或返回 unavailable。
- 旧 schema + FCL enabled：启动失败，提示先运行离线迁移，不允许自动升级。

## 4. 离线 SQLite 迁移

新增 `deploy/scripts/migrate-fcl-sqlite-offline.ts`：

1. 要求显式 `--writers-stopped`、绝对 state root；在任何 open/create 前校验三库路径、
   identity、symlink 和权限。quote-documents 必须位于 state root 内。
2. Linux 使用 host PID namespace 下的 `/proc` 检查 Case、Native、Document 三库是否还有当前
   进程之外的句柄；不能把迁移容器自身 PID namespace 的空 `/proc` 当成生产者已停止。
3. 空 Case/Native store 使用 `exclusive_verified` 创建，不使用 `fresh_fixture`。
4. Document v2 经 v3、v4 升级到 v5，保留 `quote_documents`、`document_pdfs`、配置、审计、
   幂等和旧 payload/bytes/hash。
5. 每个 store 在同一写事务内升级并读回最终版本；失败停止，不自动 repair。
6. 重跑安全：最终 schema 再次运行时只读校验并返回 `already_migrated`。
7. 允许已支持的旧/中间安全版本重跑升级，不能删除数据凑重跑。
8. 迁移后把 DB/WAL/SHM 所有权恢复给 runtime UID/GID，运行时不得使用
   `exclusive_verified` 或 `fresh_fixture`。

## 5. SMTP

生产邮件实现复用现有 `FclMailTransport`，通过固定 Python stdlib `smtplib` /
`EmailMessage` subprocess 和私有闭合 JSON 配置发送；不使用自写 SMTP 协议解析，也不新增
NPM 依赖。

```text
PORTAL_FCL_SMTP_CONFIG_FILE=<0600 JSON file>

JSON:
  {host, port, secure:true, username, password, from}
```

要求：

- TLS certificate verification 开启；禁止明文 fallback。
- header 值拒绝 CRLF；收件人数量、主题和正文有明确上限。
- 日志和错误不含 credential、SMTP 密码或邮件正文。
- 一次 `send()` 最多一次 SMTP attempt，不自动重发；child hard deadline 必须小于外层通知
  timeout，避免超时后继续发送。
- Python 层必须把 `send_message()` 返回的非空 refused mapping 视为失败；SMTP server 接受
  DATA 后才返回固定成功，语义为 accepted，不是 delivered/opened。
- Inquiry 先提交并读回，邮件失败不回滚 Inquiry；same-key replay 不重复发送。

邮件开关、recipient 和 CC 继续读取 Native FCL notification config。SMTP config 存在不代表
通知开启，sentinel/真实发件验收必须单独完成。

## 6. 回滚

旧生产镜像的 DocumentStore 最大版本低于 v5，不能读取迁移后的数据库。

- 迁移后、任何 v5 新写入之前：停止写入，恢复整套已验证快照，允许恢复旧镜像。
- 出现 v5 新写入之后：保留新数据库，禁止恢复旧快照。使用兼容 v5 的制品关闭 FCL
  HTTP/capability，保持原企业服务，前向修复或重新启用。
- `PORTAL_FCL_ENABLED=false` 不表示 schema 回滚，也不改变 SQLite user_version。
- 不双写，不覆盖新数据，不把 FCL 数据库复制回旧格式。

## 7. 非目标

- 不新增 Postgres FCL store。
- 不新增公共 REST/MCP 写工具。
- 不修改 FCL 定价、状态机、审核或 PDF 合同。
- 不把 SMTP accepted 写成 inbox delivered。
- 不把本地 fixture、CI、candidate build 或迁移成功写成生产业务验收。
