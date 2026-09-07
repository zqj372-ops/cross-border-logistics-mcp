# RFC：FreightClaw 自有业务引擎与空白配置后台

- Status: Draft — product direction confirmed; implementation contracts not yet frozen.
- User decision: 将业务代码迁入当前项目，新建管理后台；空白开始，旧配置仅供对照；保留现有账号与 API Key。
- Product scope: [产品与迁移设计](../product/2026-09-07-native-business-admin.md)
- This document does not claim implementation, production migration or completed testing.

## 动机与范围

2026-09-07 生产验收发现关务缺正式发布、资料提取来源不可用、Freightcom 未配置和报价证据需复核。用户选择由 FreightClaw 自主管理业务代码与配置。本方向替代“长期依赖旧业务网站作为唯一来源”的产品选择；不能把之前禁止复制业务表的约束理解为拒绝用户这次明确的重构要求。

报价、关务拥有各自的内部业务仓储和确定性引擎；MCP transport、目录与鉴权继续是薄接入层。先保留报价 Python、关务 TypeScript 核心，减少同时改语言、公式和数据模型造成的不可定位差异。业务子服务可以使用内部 API 通信，公开请求不再依赖旧站点。

## 权威变化

| 范围 | 当前 | 目标 |
|---|---|---|
| 报价计算 | 独立旧报价来源服务 | 项目内报价引擎 + 新后台发布的版本化经营配置 |
| 税则、措施与税费 | 独立旧关务来源服务 | 项目内关务引擎 + 新后台核验发布的官方数据；官方法规来源不因迁移改变 |
| 登录、组织、权限、API Key | Portal / Access Gateway | 复用现有权威 |
| Freightcom 承运商费率 | 外部 Freightcom | 继续调用企业正式账号的承运商 API |

不对旧服务双写，不把旧主库挂载为新库，不复制历史报价或旧凭证。旧配置可离线对照；正式初始化为空。配置发布前，不得从代码默认值、旧系统、fixture 或 AI 获取替代值。

## 兼容性与 JSON

既有公开 operation 名称保持：cargo.calculate、container.plan_summary、system.agent_context.get、quote.zone_preview、quote.ai_extract_preview、customs.query、customs.tax.estimate、quote.freightcom_ltl.preview。新后台不自动新增 MCP 工具，也不修改 t0-v1 目录。

既有 REST 业务请求保持，例如以下形状不因来源变更而变化：

```json
{"schema_version":"business-call@2026-09-05.v1","input":{"query":"不锈钢水杯","ruleDate":"2026-09-07","codeCountry":"CN","attributes":{"originCountry":"CN"}}}
```

新后台只允许类型明确的管理资源，不新增万能配置对象、任意 SQL、任意 URL 或脚本执行入口。Draft 2020-12 Schema 必须为每类资源独立制定、additionalProperties=false、金额 decimal string、单位显式。保存、校验、草稿试算、发布、停用和回退应分为窄操作。

新管理对象的概念形状（不是已实现 HTTP 合同）：

```json
{"schema_version":"business-admin-draft@2026-09-07.v1","resource_type":"quote_rate_set","draft_id":"draft_example","revision":1,"state":"draft","active_release_id":null}
```

状态是配置资源自身的生命周期字段，不能扩展 MCP success/needs_input/manual_review/blocked/unavailable 五种包络状态。公开结果的来源系统标识允许反映新引擎；版本、来源哈希、有效期与复核依据必须真实生成，不能沿用旧服务标识伪装相同来源。

## 权限与写入

沿用现有身份与组织权限，另行定义平台全局配置和企业配置的管理边界；不能默认所有企业管理员都有全局规则写权限。业务 Key 的查询权限不继承后台写权限。所有管理写入必须校验实时角色、服务端组织上下文、CSRF、对象版本、幂等与审计。发布需要固定草稿内容和校验结果；事务提交后读取实际生效版本再返回成功。并发编辑不能互相覆盖。

凭证只进入服务端安全存储，前端只返回是否配置和末尾脱敏标识；正式值通过明确保存的安全表单提交。普通配置导出和审计不包含密钥。连接地址限定允许的服务商，禁止任意出站请求。

## 分阶段迁移

1. 冻结源码提交与文件清单，识别本地未提交和云盘冲突副本，保留来源许可证与测试。
2. 在隔离分支建立业务引擎和空白业务存储，接入窄后台接口；新增失败优先的测试。
3. 移除默认燃油、附加费、起运仓映射、计费托阈值和测试数据回退；所有经营规则来自显式发布。
4. 完成后台导入→草稿→校验→试算→发布→回退，使用合成数据验证但不放入生产种子。
5. 完成实际业务配置后，按租户/operation 显式选择新引擎；未配置不自动回退旧服务。
6. 新旧结果对照仅在明确测试环境执行；旧响应不被当成新引擎的权威数据。
7. 生产切换前验证旧域名不可访问条件下新引擎独立工作、权限兼容和备份恢复。

## 回归测试与回退

实施阶段需要：空库不可算、显式零费用可算、缺配置不是零、无隐式仓库/邻近 FSA 推断、多币种不混算、过期/重叠版本被拒绝、草稿不影响正式查询、同输入同版本确定性、关务测试数据/缺来源拒绝、跨组织拒绝、旧查询 Key 无后台写权限、并发编辑冲突、发布幂等及读回、重启持久化、回退保持历史不变、公开入口和 CLI/MCP 兼容。

仓库已有检查命令：`npm run validate:agent-standards`、`npm run build:agent-pack`、`npm run typecheck`、`npm run validate:schemas`、`npm test`、`git diff --check`。新引擎和后台精确测试命令随各实施切片交付；本文未创建不存在的测试路径，也不把上述待运行检查写为通过。

回退通过受控路由配置切回经过验收的旧实现或停用受影响能力；不会删除新业务数据。新配置版本仅退役，不覆盖已被结果引用的历史。没有可用旧实现时保持 unavailable，不能因回退绕过正式数据条件。
