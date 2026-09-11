# 物流邮件获客候选模块：开发与验收

## 当前交付形态

这是现有 FreightClaw 仓库中的候选业务模块，不是 Chrome 插件，也没有新建销售网站。

- `src/logistics_mcp/modules/logistics-outreach/module.ts`：16 项 MCP 工具、严格版本输入/输出、原有可信上下文与权限检查；不拥有数据库或 worker。
- `services/logistics-outreach/`：独立业务数据、预览/幂等/审核条件、草稿、收信和发信任务状态机。
- `tests/outreach/`：共享核心测试和实际 ModuleHost 集成测试。
- [RFC](../rfcs/2026-09-11-logistics-outreach-candidate-v0.md)：Proposed；没有自行批准新合同或修改生产注册表。

**代码存在不等于已上线。** `t0-v1`、`business-v1`、现有 Key、Portal 与部署配置没有改变；正常生产 `tools/list` 不会突然出现获客工具。测试中显式挂载候选模块。正式接入需补合同、授权、隔离 Provider 和发布评审。

## 本地测试

在常规开发机按仓库锁文件安装依赖，然后运行：

```sh
npm ci
npm test -- tests/outreach
npm run typecheck
npm run lint
npm run validate:schemas
npm run build
```

`tests/outreach/module.test.ts` 展示实际接入点：先为 `CapabilityRegistry` 提供 `OUTREACH_CAPABILITY` 和精确 `OUTREACH_CAPABILITY_VERSION`，再把 `createLogisticsOutreachModule()` 传入现有 `ModuleHost`。测试使用临时目录和 `.invalid` 合成数据，不连接业务邮箱、模型服务或 Chrome。

禁止把 fixture 审批函数、测试身份或测试来源当成正式授权。生产不得在 Gateway 进程中实例化 `OutreachService`；数据库与后台运行在私有业务服务中。

## 已能验证的业务流程

```
已授权的企业页面快照引用
  -> research.preview：邮箱候选序号、来源摘要，不认定中国采购
  -> lead.import：预览绑定后导入，不允许模型猜邮箱
  -> draft.preview -> draft.prepare：生成并保存待审核开发信
  -> 人员在业务侧审核确切正文及联系依据（不提供模型审批工具）
  -> message.preview -> message.queue：检查后进入私有服务队列
  -> 私有 worker dispatchOne：重新检查授权和禁发，再调用邮件端口
  -> 严格读回：simulated / provider_accepted / manual_review
```

模型生成通过 `OutreachPorts.generate` 注入。未注入时明确返回 `generation=template`；不是假装调用了大模型。模型只收到必要的公司/来信数据和已批准服务说明，没有浏览器、发信、审批或规则修改工具。每封草稿仍待审，不能承诺价格、税费、交期、清关保证或改收款账户。

所有候选 MCP 结果包含 `candidate_only=true` 和 `production_eligible=false`，操作完成也保留 `manual_review`。草稿正文/邮箱原文保留在私有服务，MCP 返回引用和摘要。`content_ref` 是内部引用，不是现成网页链接；受保护审核页面/接口尚未实现。

## 停止、回复与不确定发送

默认 fixture 关闭发送。真实部署必须由服务器明确绑定邮箱、寄件公司及地址、密钥、联系审核和人员审批权威；缺失则不继续。

收到客户来信后暂停冷开发跟进；退订额外禁发并取消待发任务。自动回复邮件不触发销售回复生成。人工来信可 `reply.preview -> reply.prepare`，仍进入相同审核流程。`contact.suppress` 不能由另一个工具撤销。

邮件端口异常发生在可能提交之后，任务进入 `manual_review`，不以新幂等键重发。供应商返回成功但读回不匹配同样不能当成成功。`provider_accepted` 只是供应商受理，不等于送达。

排队记录可在重启后读取；进程崩溃留下的 `dispatching` 不会自动重发，目前需人员核对。不要为了恢复任务删除数据库、退订名单或幂等记录。

## 还没有接入的功能

城市地图搜索、Chrome CDP 浏览器采集、真实邮箱、真实模型 HTTP 客户端、MIME/退信/投诉处理、定时限速 worker、签名私有 Provider、审核界面、正式权限与生产发布均未完成。当前只有对应能力端口和可验证的候选流程，不能直接群发真实商家。

后续浏览器 worker 可以使用独立 Chrome 调试资料目录，将有权研究的页面转成受控快照；调试端口不得公开，不能接受模型传入任意脚本或内网 URL。浏览器发现和对外联系的依据必须分别审核。

## 本次本地验证边界

已实际执行核心严格编译、共享测试集的 Node 原生测试运行（18/18 通过）和新增 wrapper/ModuleHost 测试文件的语法转译。完整仓库依赖无法在本次本地环境安装，不能将其写成全量 Vitest、lint 或 build 已通过。完整结果以实际 PR CI/开发机输出为准。
