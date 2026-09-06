# 本轮代码证据与范围

[返回产品方案](README.md) · [实现与验证](07-implementation.md)

## 代码基线

- 工作区：`/Users/autumn/Documents/ChatGPT/物流产品MCP`
- 分支：`codex/tenant-api-key-control`
- HEAD：`34e1e9567440e768eb9e7a1b6cfe8c2ded70baed`
- 读取与实现日期：2026-09-05。
- 本轮以当前工作区为依据，没有将远端或旧版 main 的状态代替当前实现，也没有核实远端是否还有新提交。
- 已有未跟踪文件，包括 `apps/admin/* 2.*`、`deploy/self-hosted-authentik/`、插件能力中心 PRD 和 `skills/`，未被修改或认定为已发布能力。

## GPT-5.6 子代理分工

| 子代理 | 模型 | 实际职责 |
| --- | --- | --- |
| runtime_review | GPT-5.6-sol | 读取 Runtime、工具发现、activation、配置与读回边界；独立执行实际页面脚本的凭证更换行为测试 |
| business_review | GPT-5.6-sol | 读取业务能力、权威边界与用户操作；重做 Admin 样式 |
| access_ops_review | GPT-5.6-sol | 读取企业接入与部署路由；重做 Access Console，修正凭证更换上下文与重试逻辑 |
| finish_review | GPT-5.6-sol | 新上下文独立检查代码和桌面、手机截图 |

最初三项为只读审查；用户明确要求 UI 重做后，进一步分配前端实现和测试。主代理负责 Admin 结构与操作衔接、集成、浏览器验证及最终文档。

## 当前实现证据

下列链接定位本轮完成的代码。静态实现证据与运行验证分别记录；完整验证结果见[实现记录](07-implementation.md)。

| 事实 | 证据 |
| --- | --- |
| Admin 以工作台、能力与配置、Agent 接入、审批与发布、审计日志为主导航 | [导航](/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/admin/index.html:61) |
| 首页待处理项取现有快照 blockers，连接与客户端登记分别展示 | [renderOverview](/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/admin/app.js:619) |
| 客户端登记不代表真实连通；当前接入页说明现有身份条件 | [renderClients](/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/admin/app.js:674) |
| 模块必须精确读回才显示运行时已确认，否则显示“尚未确认生效” | [发布门槛](/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/admin/app.js:1052) |
| 能力目录显示“快照就绪”，查看授权带入目标工具筛选 | [能力目录](/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/admin/app.js:1143) |
| 当前新增工具和测试来源使用准确中文映射，不因旧英文过滤而隐藏名称 | [文案映射](/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/admin/app.js:395)、[回归自检](/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/admin/self-check.mjs:114) |
| Access Console 不假定部署环境有可用的同源 Admin 路由 | [独立入口说明](/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/access-console/index.html:15) |
| 读取失败会结束加载态，各区域显示不可用 | [renderUnavailableState](/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/access-console/app.js:170) |
| 凭证更换从目标对象带出权限，提交期间冻结操作上下文 | [openRotationDialog](/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/access-console/app.js:576) |
| 未知网络结果复用同一请求；成功写入后禁止再次更换并等待读回 | [更换提交](/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/access-console/app.js:619) |
| 行为测试运行真实页面脚本，覆盖权限差异、双击、写后读回失败与未知结果重试 | [console-rotation.test.ts](/Users/autumn/Documents/ChatGPT/物流产品MCP/tests/access-gateway/console-rotation.test.ts:123) |

## 保持的运行边界

| 已核实的边界 | 证据 |
| --- | --- |
| 生产 T0 组合严格限定三模块、三工具，不构造非 T0 adapter | [composition.ts](/Users/autumn/Documents/ChatGPT/物流产品MCP/src/logistics_mcp/server/composition.ts:475) |
| activation 是调用门禁，不能当成动态安装或目录热更新 | [tool-registry.ts](/Users/autumn/Documents/ChatGPT/物流产品MCP/src/logistics_mcp/server/tool-registry.ts:298) |
| 货物计算依赖确定性领域服务及统一包络 | [cargo/service.ts](/Users/autumn/Documents/ChatGPT/物流产品MCP/src/logistics_mcp/domains/cargo/service.ts:496) |
| 装柜输出包含 theoretical_only 限制 | [container/service.ts](/Users/autumn/Documents/ChatGPT/物流产品MCP/src/logistics_mcp/domains/container/service.ts:107) |
| Freightcom 测试结果仍需人工复核，不能直接发送或订舱 | [freightcom-ltl-tool.ts](/Users/autumn/Documents/ChatGPT/物流产品MCP/src/logistics_mcp/domains/quote/freightcom-ltl-tool.ts:144) |
| 统一产品外壳属于目标；当前两个服务的路由和权限边界仍独立 | [既有产品 PRD](/Users/autumn/Documents/ChatGPT/物流产品MCP/docs/product/2026-08-31-plugin-capability-center-prd.md:19) |

## 事实与待验证事项

**已确认：** 本轮界面和操作改动、上述代码边界、相关测试、构建与本地浏览器验证。当前截图来自本地演示或隔离 fixture 后端，凭证更换测试使用合成数据。

**合理推测：** 按用户任务组织导航、减少首屏技术信息、明确目标对象和下一步有助于降低理解成本。没有真实用户测试，不能报告效率提升比例。

**产品目标：** 企业登录、统一接入向导、跨服务待办与变更聚合、目标客户端连接验证仍需后续接口和部署工作，不能由前端文案宣布完成。

**暂未验证：** 当前线上状态、真实客户端接通、外部上游 readiness、真实凭证轮换和生产发布。未连接生产数据库、服务器或业务 API。
