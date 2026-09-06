# 官网、询价与 CLI 统一入口

本次入口调整复用同一份 `apps/console` 前端。官网根路径和 `/console/` 使用同一构建的 HTML、带内容版本的 JS/CSS 和既有人员 API；业务请求继续由 Portal 检查身份、企业、权限和来源。入口变更没有新增关税或运价权威，也没有新增机器写权限。

## 页面与路径

| 路径 | 作用 |
| --- | --- |
| `/` | 公共服务首页，直接进入海运询价、关税查询、税费估算、尾程询价或系统接入 |
| `/inquiry/` | 原海运费用选择与询价表单，保留原脚本、样式、费用目录和邮件生成逻辑 |
| `/#customs`、`/console/#customs` | 同一关税工作台，继续使用人员登录与企业权限 |
| `/console/#home` | 同一服务首页；平台审核/运维账号保留原工作概览 |
| `/console/#cli` | 公开 CLI 安装页、九条命令、可下载的 JSON 示例和业务退出码说明 |
| `/downloads/freightclaw-cli-0.1.0.tgz` | 已验证的独立 CLI 安装包；不是公共 npm registry 发布 |

用户从首页进入关税查询时仍需有效人员身份和企业授权。来源未就绪时继续显示真实 `unavailable`，不能把首页入口或 CLI 安装成功写成正式关税数据已可用。

## 构建和验证

```sh
npm run build
npx vitest run tests/access-gateway tests/e2e/freightclaw-cli.test.ts tests/e2e/freightclaw-cli-package.test.ts
npm run typecheck
npm run lint
npm run validate:schemas
npm run validate:agent-standards
npm run build:agent-pack
git diff --check
```

浏览器验证包括公共首页、原询价服务、登录前后的关税入口、CLI 复制/命令选择/下载、控制台市场与移动导航。生产业务提交不用于 UI smoke test；原询价仅测试本页选项、分币种汇总和复制，不发送邮件。

## 发布顺序与回滚

1. 核对当前根页面、其引用的海运应用资源和费用目录并保存校验值。备份放在 Web 根目录之外。
2. 将旧根页面保留到 `/inquiry/index.html`，只更新 canonical/分享地址并增加返回首页导航；原 `/assets/`、`/pricing/` 和其他业务文件保持原路径。`inquiry-navigation.css` 仅作用于新增导航。
3. 发布并读回 CLI 安装包、SHA-256 文件和包内九份合成 JSON 示例。安装包使用已验证制品，已存在的同版本文件不得静默覆盖成不同内容。
4. 按既有 Portal 发布流程切换候选镜像，核对 build ID、就绪状态及权限边界。读取候选 `dist/console/index.html`，确认带版本的静态资源可访问。
5. 原子替换根 `index.html` 为同一构建的 `dist/console/index.html`。根站继续通过已有 Nginx 静态路由服务；不增加新的 API 代理或改变鉴权配置。
6. 从公网浏览器读回 `/`、`/inquiry/` 和 `/console/#cli`，验证入口、旧询价选项、资源与安装包校验值。数据库不需要迁移。

回滚时先恢复备份的旧根 `index.html`，再按 Portal 既有流程恢复上一镜像及配置并核对就绪状态。原海运脚本和费用目录保持原样，新增下载文件与 `/inquiry/` 可保留；不得用旧备份覆盖运行数据库。
