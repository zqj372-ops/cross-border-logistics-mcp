# FCL 生产接线与切流

状态：FCL-PROD-1 候选运行手册。生产变更由 root 在 Oracle 环境执行；本页不包含真实 UUID、邮箱、token、SMTP 密码或客户数据。

## 1. 前置事实

- Portal 自身使用 SQLite；Gateway tenant authority 使用既有 PostgreSQL。
- 现有 `quote-documents.sqlite` 可能为 v2，包含企业报价和 PDF。
- Case/Native FCL DB 可能尚不存在。
- 固定 receiver 使用有效 OIDC 用户的稳定 UUID `sub`；UUID 只从私有部署配置注入。
- 生产 FCL 默认关闭。迁移完成不等同启用 FCL，也不代表 SMTP 已验收。

## 2. 私有配置

FCL 启用时至少配置：

```text
PORTAL_FCL_ENABLED=true
PORTAL_FCL_RECEIVER_SUB=<verified OIDC user UUID>
PORTAL_FCL_RECEIVER_AUTHORITY_URL=https://<OIDC-origin>/api/v3/core/users/<pk>/
PORTAL_FCL_RECEIVER_AUTHORITY_TOKEN_FILE=/run/portal-secrets/fcl-receiver-api-token
PORTAL_FCL_CASE_CREDENTIAL_SECRET_FILE=/run/portal-secrets/fcl-case-credential-secret
PORTAL_FCL_PUBLIC_SESSION_SECRET_FILE=/run/portal-secrets/fcl-public-session-secret
PORTAL_FCL_SMTP_CONFIG_FILE=/run/portal-secrets/fcl-smtp.json
PORTAL_PDF_BROWSER_EXECUTABLE=<absolute browser path>
```

authority URL 必须与 OIDC issuer 同 origin，路径精确到单用户 endpoint。API 响应只接受 `uuid`、`is_active`、`attributes.email_verified` 三个字段的投影；`uid`、`pk` 或邮箱都不能代替 UUID。

SMTP JSON 是闭合文件：

```json
{
  "host": "smtp.qq.com",
  "port": 465,
  "secure": true,
  "username": "<private>",
  "password": "<private>",
  "from": "<private sender>"
}
```

文件和宿主挂载必须由 Portal runtime UID/GID 可读。密码不进入环境变量、argv、日志或聊天。

## 3. 快照和停写

1. 使用现有 Portal backup 流程保存完整 state/secrets 快照，记录 SHA-256。
2. 停止 Portal 和所有旧 SQLite writer，确认没有旧镜像或维护脚本继续打开三库。
3. 迁移前不得让新镜像自动升级 schema；runtime 只允许 `fcl: { mode: "reopen" }`。

## 4. 离线迁移

迁移必须在能看到真实 host writer 的 PID namespace 中运行。使用 candidate 镜像并显式 `--pid=host`，不要依赖迁移容器自身 PID namespace 的空 `/proc`：

```sh
docker run --rm --network none --pid=host --cap-add=SYS_PTRACE --user 0:0 \
  -v /data/logistics-mcp/portal/state:/var/lib/freightclaw-portal \
  <candidate-image> \
  node dist/deploy/scripts/migrate-fcl-sqlite-offline.mjs \
  --state-root /var/lib/freightclaw-portal \
  --quote-documents /var/lib/freightclaw-portal/quote-documents.sqlite \
  --writers-stopped \
  --runtime-uid 10001 \
  --runtime-gid 10001
```

该命令不使用 `fresh_fixture`。空 Case/Native 使用 `exclusive_verified` 创建生产 schema；旧 Doc v2 走 v2→v3→v4→v5。脚本会在任何 open/create 前检查三库外部句柄，并在结束后把 DB/WAL/SHM 权限恢复给 runtime UID/GID。

`SYS_PTRACE` 仅供一次性离线迁移容器检查宿主机其他进程的 `/proc/<pid>/fd`。默认 Docker 权限不能完成该检查，会返回 `document_v3_upgrade_ownership_unverified`；不能跳过检查或使用容器自己的 PID namespace。保持迁移容器网络关闭，不给长期 Portal 容器增加该 capability。2026-09-26 已在 Oracle 隔离空库验证：writer 存在时拒绝迁移，停止 writer 后迁移成功。

成功输出至少验证：

```text
status
case_version=2
native_version=3
document_version=5
legacy_documents.quote_count、pdf_count 和 digest
```

对真实生产库必须额外逐字节比对迁移前后的旧企业文档/PDF/配置/幂等/审计读回。迁移失败时保留现场和快照，不自动 repair，不启动新流量。

## 5. 先启动 v5 兼容模式

先保持：

```text
PORTAL_FCL_ENABLED=false
```

使用只支持 v5 的新 candidate 启动：

- stores 以 v5 reopen 打开；
- 不构造 FCL receiver/mail domain；
- 不挂 FCL HTTP 或 public inquiry 路由；
- 原企业 Case/Native/Document 服务正常启动。

读回旧企业文档记录、PDF SHA-256、模板和 Case 列表；确认迁移没有改变旧业务数据。此时 FCL 还没有上线。

## 6. 启用 FCL

通过私有 env 文件设置 `PORTAL_FCL_ENABLED=true`，重新启动/滚动发布 candidate。启动顺序必须是：

1. authority 验证 OIDC exact sub、active、email_verified；
2. 在 authority ALS 上下文内构造同步 FCL domain services；
3. ALS 退出后在 outside context 启动长期 HTTP server/timers；
4. 每个 FCL request/session capability 再执行一次 fresh authority；
5. authority 不可用时 FCL 返回 `unavailable`/`blocked`，无关 Portal 路由不受影响。

验收要求：

- `/inquiry/` 公开提交保存成功，返回本票 recovery；
- `/console/#fcl` staff person device flow 后可读同一 Case；
- `/console/api/v1/session` 的 `fcl_capability` 只在 authority 当前有效时为 true；
- API Key、企业身份和其他个人不能获得 FCL receiver 权限；
- 无 receiver proof 或 authority 失败时不生成 FCL 成功响应。

## 7. SMTP 和真实邮件

邮件 transport 只有 SMTP accepted 语义，不是 delivered。正式邮件验收必须单独进行：

1. 先保持 Native FCL notification disabled，确认 Inquiry 保存和读回；
2. 在授权测试收件人上开启通知并发送合成 Inquiry；
3. 验证 SMTP 250、应用发生器和收件箱读回；
4. 检查同 key replay 只返回原 Inquiry，不重复发送；
5. 失败、超时或未知结果只标记 notification 状态，不回滚已保存 Inquiry，不自动重试。

`sent` 只表示 SMTP server 接受了 DATA。若没有收件箱读回，不得写 delivered。

## 8. CLI 发布

公开稳定 CLI 包不随 Portal 镜像自动更新：

```sh
npm run build:cli
npm pack ./dist/cli
sha256sum <generated-freightclaw-cli-package.tgz>
```

root 将包和校验文件发布到既有 `/downloads/freightclaw-cli-0.002.tgz` 与对应 `.sha256`，更新 no-cache 读回并做一次真实下载、安装、`--version`、`workspace commands` 和 FCL public inquiry/staff device-flow检查。CLI 版本不会自动升级。

## 9. 回滚

### 9.1 尚未产生 v5 新写入

停止候选，确认零新写入后恢复整套已验证快照（Portal state、三个 SQLite、secrets 和旧镜像/配置）。不要单独把某个文件切回旧格式。

### 9.2 已经产生新写入

禁止恢复旧 SQLite 快照覆盖新记录，也禁止直接切回不能读 v5 的旧镜像。保留新数据库，发布支持 v5 的候选制品，关闭 FCL HTTP/capability 入口，继续运行原企业服务；修复后再重新启用 FCL。

`PORTAL_FCL_ENABLED=false` 只关闭 FCL 路由，不降级 schema。

## 10. 验收记录

记录 release/build ID、candidate SHA、迁移前/后版本与哈希、旧记录读回、FCL authority 查询、session capability、公开/staff FCL 全链、PDF/handoff、SMTP accepted 与收件箱结果、CLI 下载读回、零新写入时间点和回滚决定。未完成的邮件或来源验收必须明确写成 `NOT_RUN` 或 `blocked`。
