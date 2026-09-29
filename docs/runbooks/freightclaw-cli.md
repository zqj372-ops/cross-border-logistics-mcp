# CLI 构建与交付

[文档中心](../README.md) / CLI 发布

入口 `deploy/cli`，命令 `freightclaw`。CLI 调用既有接口，不新增工具合同或业务权限。当前产品版本取 `package.json` 的 `freightclawVersion`，npm 版本取 `version`。

## 构建与检查

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

发布还需全量相关测试和 CI。CLI 直接复用 `apps/console/openapi.json`，不手写第二份业务合同。测试使用合成数据、本机 HTTP 和临时安装前缀，覆盖输入、状态、大小、超时、重定向、凭证保护和独立安装。

## 交付

```sh
npm run build:cli
npm pack ./dist/cli
```

以 `npm pack` 实际输出的文件名为准，记录包哈希与版本，再通过既有发布流程提供下载。用户可安装经过核验的包：

```sh
npm install --global /absolute/path/to/verified-package.tgz
freightclaw --version
freightclaw commands --json
freightclaw schema customs query --json
freightclaw status --json
```

`status` 只检查 Portal，不读取 API Key。实际业务要用已授权身份验证；fixture 成功不证明正式来源或生产调用成功。分别记录 macOS、Linux 的验证，没有 Windows 实机记录就不宣称已验证。

CLI 包发布不需要重启 Portal 或迁移数据库；但新增命令依赖的服务端接口必须已部署。安装包不会自动升级。

## 回滚

重新安装已验证的旧包。初次安装可用 `npm uninstall --global @freightclaw/cli` 移除客户端；不会改变服务器或业务库。

[使用说明](../../deploy/cli/README.md) · [人员 CLI](../../apps/console/workspace-cli.md) · [统一 Key 合同](../rfcs/2026-09-06-unified-application-key-v1.md)
