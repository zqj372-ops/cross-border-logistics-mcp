# FreightClaw

**加拿大整柜到门、清提派，以及物流 API / CLI / MCP。**

客户提交需求、确认报价、查看进度；运营在同一票业务里报价、接单、处理运输节点和邮件。整柜业务按个人账号授权，不要求创建企业。

![客户与运营分开入口，共同跟进一票业务](docs/assets/business-flow.svg)

[客户中心](https://www.freightclaw.net/customer/) · [运营后台](https://www.freightclaw.net/ops/) · [能力市场](https://www.freightclaw.net/console/#market) · [CLI](https://www.freightclaw.net/console/#cli)

## 从这里开始

| 你要做什么 | 阅读 |
| --- | --- |
| 询价、确认报价、查运输进度 | [客户使用手册](docs/guides/customer.md) |
| 维护价格、报价、接单和跟进 | [运营使用手册](docs/guides/operations.md) |
| 设置发件邮箱、节点收件人和财务提醒 | [邮件设置](docs/runbooks/fcl-mail-settings.md) |
| 用命令行或 Agent 接入 | [CLI 快速开始](docs/runbooks/freightclaw-cli-illustrated.md) · [API / MCP 指南](apps/console/skill.md) |
| 本地开发、测试或部署 | [开发指南](docs/guides/development.md) · [发布与维护](docs/guides/maintenance.md) |
| 查找合同、RFC、历史验收 | [文档中心](docs/README.md) |

## 一票业务怎么走

1. **询价**：填写航线、货物、柜型、服务和联系方式；缺少资料继续补充。
2. **报价**：选择海运费、套用其他费用模板、调整本票价格，再核对并发布报价。
3. **下单**：客户确认，运营接单。已有 SO 和柜号后，以它们跟进运输。
4. **执行**：按本票服务处理订舱、报关、清关、提柜、派送等节点；客户只看公开进度。
5. **完成**：保留报价版本、文件、节点记录和邮件状态，便于追查。

**基础海运费只计一次。** 海运费表维护基础海运费，费用模板维护其他费用；二者不要求报价有效期。正式对客报价保留有效期和历史快照。没有匹配价格时补充价格，不按零元报价。

## 能力与边界

| 能力 | 入口 | 使用时注意 |
| --- | --- | --- |
| 整柜询价、报价、接单、进度和附件 | 客户端 / 运营端 / 人员 CLI | 登录身份、数据隔离和节点权限由服务端校验 |
| 货物体积、重量与装柜摘要 | 网页 / REST / CLI / MCP | 依照输入与确定性规则计算，不承诺实际装载 |
| 私人地址报价、Freightcom 试算 | 能力市场 / REST / CLI | 需要相应运价或供应商连接；试算不是订舱 |
| 关税查询、税费估算 | 能力市场 / REST / CLI | 核对来源、日期和待复核项；来源未就绪不返回成功 |
| 船期、码头资料 | 能力市场 / 人员 CLI | 来源与支持范围见[采集器说明](services/maritime/schedule-collector/README.md) |
| 机器接入与模块管理 | API Key / MCP / 管理控制面 | 机器凭证不自动获得人员审批或业务写权限 |

不同入口共用既有服务与合同。MCP 的实际工具目录取决于授权和模块发布；网页有某项功能，不代表该功能已开放为机器写工具。

## 本地运行

需要 **Node.js 22.13+**。在仓库根目录执行：

```bash
npm ci
PORTAL_FIXTURE_FCL_PERSONAL=true PORTAL_FIXTURE_FCL_EXECUTION=true \
  PORTAL_FIXTURE_DIRECTORY=.runtime/docs-fcl-fixture npm run start:console:fixture
```

打开 `http://127.0.0.1:8882/console/`。客户与运营入口分别为 `/customer/`、`/ops/`。此模式使用合成身份、本地数据和模拟邮件传输，不验证真实邮件送达。见[开发指南](docs/guides/development.md)。

## 仓库地图

| 目录 | 内容 |
| --- | --- |
| [`apps/console`](apps/console/README.md) | 官网、客户中心、运营后台、能力市场 |
| `apps/inquiry` | 公开询价页面与表单 |
| [`services/access-gateway`](services/access-gateway/README.md) | 身份、授权、Portal API 与业务编排 |
| `services/quote-native`、`services/quote-documents` | 计价、报价单与历史版本 |
| `services/customs-native`、`services/maritime` | 关务与海事数据服务 |
| `src/logistics_mcp` | MCP Runtime、标准包、确定性计算及适配器 |
| [`deploy`](deploy/README.md)、[`deploy/cli`](deploy/cli/README.md) | 部署、构建脚本和命令行客户端 |
| `tests`、[`docs`](docs/README.md) | 自动化验证、使用说明与技术参考 |

参与开发先读 [AGENTS.md](AGENTS.md)，再按 [Agent 标准入口](docs/agent/index.json) 选择任务 profile。合同、安全规则和来源权威保持有效。

> 整理日期：2026-09-29。代码实现、测试通过、部署完成、收件人确认是不同证据；本文不代替线上版本读回。CI 不自动部署生产。旧记录见[完整文档索引](docs/catalog.md)。
