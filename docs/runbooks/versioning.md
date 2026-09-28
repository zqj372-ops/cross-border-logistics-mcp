# 版本号规则

当前对外版本：`0.016`，对应内部 npm semver `0.0.16`。本次修复关税参考检索的零件误匹配、无效父级、双语候选名额、超长品名与关键词截断，并增加默认关闭的商品名检索词建议。关税仍为官方原文参考和待复核候选；船期开放仍受部署权限和目标环境验证限制。

## 递增规则

每次完成一次受控发布并更新 `main` 后，对外版本按 `0.001` 递增：

```text
0.002 -> 0.003 -> 0.004 -> 0.005 -> 0.006 -> 0.007 -> ...
```

不得跳号，不得把开发中的改动提前写进已发布版本。历史发布回执、截图和下载校验记录保留原版本号，不因后续编号而改写。

## 两套编号

npm 不允许 `0.002` 这种带前导零的 semver，因此版本同时保留两套标识：

| 用途 | 当前值 | 下一版 | 权威位置 |
| --- | --- | --- | --- |
| 对外产品版本 | `0.016` | `0.017` | `src/logistics_mcp/version.ts` |
| npm 包版本 | `0.0.16` | `0.0.17` | `package.json`、`deploy/cli/package.json` |

官网、CLI `--version`、MCP `serverInfo.version` 和面向用户的文档使用对外产品版本。npm tarball 的包元数据使用合法 semver；发布下载文件可以使用对外版本命名。

## 每次发布检查

1. 更新 `src/logistics_mcp/version.ts` 中的 `FREIGHTCLAW_VERSION`。
2. 将 `package.json` 和 `deploy/cli/package.json` 的 semver 同步递增。
3. 运行 `npm install --package-lock-only --ignore-scripts` 更新根锁文件版本。
4. 更新 README、CLI 文档和官网 CLI 下载页中的当前版本与下载路径。
5. 运行 `npm run build:cli`、CLI 包测试、typecheck、lint 和 `git diff --check`。
6. 记录精确代码 SHA、镜像 ID、下载包哈希和实际读回结果。
