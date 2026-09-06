# FreightClaw CLI 交付与验证

版本：0.1.0。入口为 `deploy/cli`，二进制命令为 `freightclaw`。这是现有固定 REST 路由的客户端，适用已接受的 [统一应用 Key 合同](../rfcs/2026-09-06-unified-application-key-v1.md)；没有新增服务端模块、工具合同、身份或业务写权限。

使用方法、命令表、输入示例、退出码和凭证方式见 [CLI 使用说明](../../deploy/cli/README.md)。当前通过 npm tarball 交付，未发布到公共 npm registry。此客户端发布无需重启 Portal、迁移数据库或改动来源服务。

## 构建与验证

```sh
npm ci
npm run validate:agent-standards
npm run build:agent-pack
npm run build:cli
npx vitest run tests/e2e/freightclaw-cli.test.ts tests/e2e/freightclaw-cli-package.test.ts
npm run typecheck
npm run lint
npm run validate:schemas
git diff --check
```

CLI 请求/响应校验直接复用 `apps/console/openapi.json` 的已发布 Schema；没有手写第二份业务合同。T0 统一包络额外限定为当前命令的货物或装柜结果类型。类型、版本或状态不一致时返回本地协议错误；不会猜测修复数据。

完整集成测试使用合成数据及本机 HTTP 服务，覆盖应用 Key 的固定路由、九条输入 Schema、业务状态、错误合同、流式响应大小、超时、重定向、凭证回显保护和安装后独立运行。安装测试在临时目录构建 tarball，再安装到独立前缀；不会写入用户全局安装。

发布前运行仓库全量测试和现有 CI。CI 继续校验服务端构建、Schema、镜像和共享数据库，不把客户端 fixture 成功当作真实客户业务验收。Mac 本机与 Linux CI 的结果分别记录；没有 Windows 实机验收时不得宣称 Windows 已验证。

## 打包与安装

```sh
npm run build:cli
npm pack ./dist/cli
npm install --global /absolute/path/freightclaw-cli-0.1.0.tgz
freightclaw --version
freightclaw commands --json
freightclaw schema customs query --json
freightclaw status --json
```

`status` 只访问 Portal 公共就绪接口且不读取 API Key；真实账号调用应由已开通服务的应用提供 Key。保持原服务授权及正式数据就绪要求。现有来源部署及数据限制见 [2026-09-07 关务历史部署记录](riskcustoms-history-deployment-2026-09-07.md)。

回滚只需重新安装已验证的旧 tarball；初次交付可用 `npm uninstall --global @freightclaw/cli` 移除客户端。不会改变服务器或业务数据库。
