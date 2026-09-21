# FCL 高频报价工作台：阶段验收与发布

## 交付与模型

基于原有公开询价、个人受理、NativeAdmin 运价发布和 DocumentWorkflow 审核/PDF 扩展。没有新增数据库或通用写入口，没有更换前端框架。

- `apps/inquiry/fcl-fields.ts`：统一中英文字段、费用名称及运输模式字典；询价和运营表单复用。
- `apps/console/fcl-operations.js`、`fcl.css`：方案比价、费用管理、内陆运价、目的地模板、船公司/班期；中文主视觉，英文小字；明细和历史按需展开。
- `services/quote-native/fcl-operations-contracts.ts`：闭合 ChargeItem、DeliveryRate、DestinationTemplate、QuoteCalculation、EstimateSnapshot；现有 OceanRate 保留。
- `services/quote-native/fcl-operations.ts`：共享 Decimal 金额聚合，分行成本/销售、按票/按柜、明确日期、费用版本、汇率、利润和追溯。
- `services/access-gateway/portal/fcl-operations.ts`：私有受理权限、CAS、幂等、原子发布/重算、历史、复制、推荐、锁定、人工调整审计。
- 原 `fcl-contracts.ts` 兼容 v1/v2 运价数据集；原客户报价增加可选 `extensions.fcl_estimate_v1`，绑定估价版本、摘要和完整费用有效期。
- `workflow.ts` 保留审核与正式 PDF 权威；选定预估由服务器重建客户报价。来源变化后旧报价失效，幂等重放仍返回原保存结果。
- `fcl-http-contracts.ts`、`fcl-http.ts`、`deploy/cli/fcl-workspace.ts` 和生成 Schema/OpenAPI 同步。

## 数据迁移与边界

无 SQLite DDL 迁移，Case/Native/Document 版本保持 2/3/5。旧运价保持可读，显式编辑保存时才转换为 v2；不填入示例商业价格。当前估价指针和不可变历史复用 `native_configs`、`native_releases` 的窄类型命名空间。

已写入 v2 数据后，不能直接回退到只理解 v1 的镜像。优先部署兼容修复或关闭相关入口；如需恢复备份，必须停写、核对新增数据并人工决定，禁止覆盖上线后的业务记录。

## API / CLI

新增八个动作，HTTP 为 `/console/api/v1/fcl/<action>`，CLI 为 `freightclaw workspace fcl <action>`：

| 动作 | 用途 |
| --- | --- |
| estimate-run | 按明确出运日期和柜数计算多个船公司/目的地 |
| estimate-list / estimate-get | 查询当前或指定历史版本 |
| estimate-adjust | 保存人工售价、原因、推荐及锁定 |
| estimate-duplicate | 复制独立方案 |
| estimate-select | 关联 Case 并生成现有客户报价 |
| rate-bulk-preview / rate-bulk-publish | 预览和原子发布海运调价，重算相关方案 |

批量请求可携带 `estimate_request`，首次调价即可创建多个目的地方案；不带时只重算已有方案。保持 receiver/session/CSRF/幂等约束；API Key 不获得个人工作区权限。独立 CLI 包现有 120 个 workspace 命令，其中 36 个 FCL staff 动作。

## 已执行验收

隔离 loopback fixture，合成业务时钟 2026-10-08，无生产凭证或邮件：

1. 上海 → 温哥华 → Calgary / Edmonton，40HQ；COSCO、ONE、OOCL，共六个服务器持久化方案。
2. COSCO 海运费 USD 3200 → 3500，经页面预览、核对、发布，两个目的地生成新版本；其他船公司金额不变。Calgary 总成本 CNY 30800 → 32900，销售价 33880 → 36190，固定费用不必重填。
3. 历史版本仍保留 USD 3200；逐版可查看海运费、成本、销售价、来源和计算记录。人工将 COSCO 海运售价改为 USD 3900 后，销售总额 36540、毛利 3640，保存原因与审计；重算保留人工调整。
4. 关联合成询价，生成客户报价，经现有审核流程生成真实浏览器 PDF；持久化 PDF 345186 字节，SHA-256 `693ef6a9771a1b2e7690599c3a588c49f2df082d353e898e98389246f74b98a5`。
5. 费用项目编辑、草稿保存、发布、自动重算经真实页面操作。发布后旧客户报价需重新核对；不会自动审核或发送。
6. 缺汇率、缺费用、日期冲突、范围不符、锁定后来源变化、错误受理人、幂等冲突、原子回滚、重启读回、HTTP/CLI 同口径均有针对性测试。

执行结果：`npm test` 272 文件通过、2 文件跳过；2341 测试通过、11 跳过。`typecheck`、`lint`、`build` 通过。独立 CLI 安装测试 2 项通过；agent 标准、标准包、Schema 校验及 diff 检查通过。生产部署与真实商业价格有效性不能由这些 fixture 结果代替，实际发布凭证单独记录。

## 使用限制与下一步

- 班期为人工维护信息，不代表船公司已确认舱位；没有新增船期采集或订舱。
- 路线、邮编和区域明确匹配，不猜测港口、不推断汇率。重量阶梯按本次询价总重量匹配。
- 当前受理人最多 500 个估价方案、单次 100 个组合、每方案最多 1000 个版本；历史对照按当前所选版本展示最近 12 版，可继续向前翻阅。客户报价沿用最多 60 行人工费用限制，超限方案不能生成正式报价。
- 新有效期需保留独立价格行；发布历史和报价历史均保留。不得把已经失效的当前价当成出运日期对应的有效价。
- 发送状态预留 `not_sent`；自动营销、自动邮件发送、CRM、LCL 产品、订舱不在本阶段。
- 下一步应由运营录入并核对真实来源、固定费用、汇率及目的地模板，先选一条真实业务路线验收；再根据实际数量评估分页和批量导入。不要预置合成价格到生产。
- 术语校正：Limited Access 为“受限地点费”，Remote Area 为“偏远地区费”，两者独立维护。
