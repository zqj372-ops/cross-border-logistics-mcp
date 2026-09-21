# FCL 前端改版验收

日期：2026-09-21。范围：M1 客户询价和个人受理工作区。用户要求统一设计风格，并让普通操作人员按业务顺序使用。

## 交付

- 公开询价、受理列表、需求核对、报价、审核、运价及通知设置共用品牌色、字号、表单、按钮和间距规则。
- 工作区按“确认需求 → 填写报价 → 审核与导出”组织；需求摘要只显示一份，首次提交和处理记录按需展开。
- 售价与利润分别显示；服务器保存的毛利率显示为百分比。报价单金额与正式下载、审核、交接集中显示。
- 已知系统状态、字段和操作提示使用中文；用户填写的备注、业务值和错误诊断原样保留。
- 只修改呈现和交互；HTTP/CLI 合同、固定受理人权限、服务端计算、审核版本绑定及 PDF 校验不变。

## 自动检查

实际运行通过：

```sh
npm run typecheck
npm run lint
npm run build
npm run build:inquiry
npm run validate:agent-standards
npm run build:agent-pack
npm test -- tests/console/fcl-workspace.test.ts tests/console/fcl-presentation.test.ts tests/e2e/fcl-inquiry-contracts.test.ts tests/access-gateway/portal-fcl-http.test.ts
node --check tests/e2e/portal-browser/fcl-personal-flow.mjs
git diff --check
```

针对性测试为 4 个文件、37 项通过。既有浏览器回归脚本已同步步骤导航和文案，本轮未执行该整套 Playwright 脚本；下面的浏览器结果来自实际逐步操作。

## 实际浏览器验收

环境：Codex 内置 Chromium 调试会话，独立 loopback fixture，Node 24.14.0，桌面 1440/1280 px 和手机 390 px。测试身份使用 fixture 登录入口；未使用生产身份或客户数据。客户端调试日志未见 warning/error。

- 公开三步提交：必填联系人、邮箱及确认项错误提示正确；柜数 0 被拒绝，数量待确认仍保留未知值。
- 客户进度及补资料：工作人员要求补充，客户修改目的地，差异显示中文字段与前后值；保存后受理端读回最新资料并重新确认。
- 报价：编辑售价，切换步骤保留草稿；未保存时正式下载不可用。保存后费用和利润更新，历史版本保留。
- 报价单：修改备注后立即锁定旧审核/下载；重新生成、独立核对、审核、下载并校验 PDF、交接均完成，刷新后交接记录仍存在。
- 样例：USD 销售额由 7000 升至 7200，毛利为 800、毛利率 11.11%；与 CAD 毛利 60、fixture 汇率共同形成 6066 CNY。显示取自保存的服务器计算结果。
- 手机询价、受理、报价、审核、运价和设置页没有整页横向溢出。

本轮未发送真实邮件。生产发布状态应以 PR/部署记录为准，以上本地验收不能替代生产验收。
