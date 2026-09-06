# FreightClaw 国内用户登录

生产主方案是 Authentik 托管的中文邮箱与密码登录。Portal 仍只接收 OIDC，不保存、代理或校验密码。脚本只修改 `freightclaw-portal` provider，创建 `freightclaw-cn-authentication`，不会覆盖 `default-authentication-flow` 或其他应用。

```bash
docker exec -i logistics-authentik-server ak shell < deploy/portal/configure-authentik-cn.py
```

首次运行保持 `FREIGHTCLAW_SMTP_READY=false`。此时已有账号的密码登录可用，但页面不开放自助注册和忘记密码，避免在邮件未发送时显示成功。先在 Authentik 配置国内可达 SMTP：host、port、username、password secret、TLS/SSL（二选一）、from address、timeout。专用注册 flow 的固定顺序是注册资料、User Write、Email verification、验证标记、登录；必须先保存未验证用户，EmailStage 才能为该用户生成可恢复 FlowToken。找回 flow 使用 Identification、Email、密码 prompt、User Write、验证标记、登录。EmailStage 必须设置尝试次数、缓存窗口和 token 有效期，并保持 `activate_user_on_success=false`。

本地安全设置页会先从 Authentik 容器对 SMTP 执行一次 `AUTH LOGIN`，不发送邮件。只有认证成功后才将 `SMTP_READY` 设为真并更新 flow；认证失败会在读写管理员账号之前终止。SMTP 已配置时，管理员邮箱和新密码可留空，保留现有值。设置成功后进入 `/console/auth/login`；未验证用户在正常密码校验后收到验证邮件，找回 flow 只用于真正的忘记密码。

邮箱注册只创建无组织、无 API 权限的人员账号；企业资格只能由 Portal 按已验证邮箱领取的企业邀请授予，不需要企业管理员再去 Authentik 创建另一张邀请。OIDC `email_verified` 继续来自目录属性且必须严格为布尔 `true`。验证策略自身必须同时检查 SMTP 已启用、`is_restored` 是 FlowToken、token 用户等于 pending user、token flow 等于当前绑定 flow，以及用户仍为 active；不能依赖另一个 policy 阻止其副作用。所有相关 FlowStageBinding 使用 `policy_engine_mode=all` 和 `evaluate_on_plan=false`。找回流程使用防枚举识别、限制尝试、一次性短期 token，且不修改用户的启用状态；已停用用户不会因注册或找回而恢复。不要使用 ROPC，也不要把 SMTP 密码写进脚本、日志或 compose environment。

QQ SMTP 验收应区分 TLS、EHLO 和 AUTH 三层。TLS 成功只证明网络和证书正常；必须显式执行 AUTH 并取得 235 才能设为 ready。2026-09-05 的一次生产检查中，Oracle 与广州均通过 `smtp.qq.com:465` TLS 1.3，EHLO 返回 250 并宣告 LOGIN、PLAIN、XOAUTH、XOAUTH2，但 VIP 别名和数值 QQ 地址使用同一已保存值显式 LOGIN 均在一秒内返回 535。不记录被拒绝授权值的内容。此时保持验证流程失败闭合，重新核对 QQ 页面生成的原始授权码并原样粘贴；不要改管理员密码或把普通 QQ 登录密码当 SMTP 授权码。

设置页从本机启动，新的会话可让程序生成 CSRF；只有确实需要保留已打开页面时才传入原来的 43 字符 nonce：

```bash
PORTAL_SETUP_PORT=8883 node deploy/portal/setup-server.mjs
# 保留现有页面时：PORTAL_SETUP_CSRF='<existing-nonce>' PORTAL_SETUP_PORT=8883 node deploy/portal/setup-server.mjs
```

设置程序优先使用显式 SMTP LOGIN 且禁止初始响应，超时为 30 秒。535 返回中文凭据拒绝；连接、TLS 或超时返回连接失败；服务端未宣告 LOGIN 时单独返回不支持。认证成功之前不读取或保存管理员变更，也不更新 EmailStage。

部署后可在 Authentik 容器内运行回滚语义验证。脚本会临时创建测试用户和 FlowToken，但外层事务强制回滚，不发送邮件：

```bash
docker cp deploy/portal/verify-authentik-cn.py logistics-authentik-server:/tmp/verify-authentik-cn.py
docker exec -e AUTHENTIK_LOG_LEVEL=error logistics-authentik-server \
  ak shell -c 'exec(open("/tmp/verify-authentik-cn.py").read())'
docker exec logistics-authentik-server rm -f /tmp/verify-authentik-cn.py
```

只有输出 `"all_pass": true` 才表示当前 binding 顺序、ALL 模式以及无令牌、错用户、错 flow、停用用户的失败闭合语义均通过。

企业微信扫码是后续可选适配。当前生产只有机器人 webhook，不能用于登录；完整扫码需要独立 Corp App 的 Corp ID、Agent ID、App Secret、可信回调域名，并由服务端以一次性 state 处理 code，再绑定到已邀请的 Authentik 用户。机器人 secret 不能复用。

2026-09-05 后续验收：用户在修复后的本地设置页重新填写 QQ 授权码，以数字 QQ 邮箱认证通过；程序在 SMTP LOGIN 成功后保存配置并以 exit 0 关闭。实际找回邮件任务于 14:43:45 UTC 完成、重试为 0；真实账号随后完成找回及邮箱验证，身份服务读回 `email_verified=true`、有效密码及 14:45:18 UTC 成功登录记录。设置页新增实时进度、重复点击保护、失败保留输入和明确中文错误。

这次身份服务成功后，工作台曾未能建立会话。代码定位为 issuer 尾斜杠被错误删除，已改为配置、discovery 和 ID Token 精确匹配，并补充真实签名回归。浏览器登录失败现在通过固定中文提示返回登录页；JSON API 保持原有错误状态，Host、传输、state、PKCE 和 nonce 校验不放松。发布后于 2026-09-05 15:03 UTC 后从工作台新发起登录，真实浏览器已进入平台管理员后台；刷新后仍保持身份，企业准入页正常显示。未重放已经消费或过期的授权码。

专用身份品牌已实际应用并在匿名登录页查看：FreightClaw 标识、简体中文、邮箱与密码表单及找回入口正常；语言选择使用深灰底白字。Authentik 2026.8 的当前简体中文目录缺少 `Log in` 和 `Show password`，安装版本的 Flow/IdentificationStage/PasswordStage 没有对应文案设置，因此这两项仍是英文；未用 CSS 伪造按钮文字或修改供应商打包文件。
