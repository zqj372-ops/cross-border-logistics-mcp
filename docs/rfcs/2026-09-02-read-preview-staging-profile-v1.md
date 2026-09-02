---
standard_id: read-preview-staging-profile-v1
version: 2026-09-02.v1
priority: 94
audience: developer,reviewer,operator,caller
rule_ids: READ-PREVIEW-PROFILE-001,READ-PREVIEW-ISOLATION-001,READ-PREVIEW-AUTH-001,READ-PREVIEW-QUALIFICATION-001
---

# RFC：报价、关务与 Freightcom 受控读取预览档位 v1

- 状态：accepted for implementation；不具生产资格
- 日期：2026-09-02
- 接受依据：用户明确要求开放报价、关务和 Freightcom
- 影响范围：独立 staging profile、静态模块目录、T1 隔离 worker、短期 JWT 工具权限、Agent 标准读取和部署示例
- 不改变：`t0-v1` 的 3 tools / 5 resources、长期 Key 兑换合同、业务工具输入输出、五状态包络、业务权威归属

## 1. 错误前提与产品边界

“工具代码已经存在”不等于“可以按生产能力开放”。当前三类能力的资格不同：

- `customs.ca.search` 已有窄 M2M 合同，但真实 endpoint、tenant mapping、凭证、非测试 release 和 staging 读回仍需环境证据；
- `customs.ca.estimate` 没有已验证正式估算 API，只能可见且固定 `unavailable`；
- `quote.freightcom_ltl.preview` 只允许 Freightcom test endpoint，完成结果固定 `manual_review`、`sendable=false`、`bookable=false`、`authoritative=false`；
- `quote.canada_final_mile.calculate` 已有严格 v2 adapter，但候选 `/quotes/zone-preview` 尚未取得可比较的正式发布证据，默认必须 `unavailable`。

因此本 RFC 的“开放”是独立的受控读取预览档位，不是把这些工具加入 `t0-v1`，也不是宣称正式报价、关务估算或 Freightcom 生产费率已经上线。

## 2. Profile 与精确目录

新增唯一档位：

```text
read-preview-staging
```

精确静态模块集合：

```json
[
  "cargo",
  "container",
  "canada-final-mile-quote",
  "riskcustoms-ca",
  "freightcom-ltl",
  "agent-access"
]
```

精确工具集合：

```json
[
  "cargo.calculate",
  "container.plan_summary",
  "quote.canada_final_mile.calculate",
  "customs.ca.search",
  "customs.ca.estimate",
  "quote.freightcom_ltl.preview",
  "system.agent_context.get"
]
```

资源继续精确为现有五项 Agent resources。Knowledge、Status、Review、草稿保存、发送、订舱、关务写入和任何通用写入口都不注册。

`t0-staging` 和 `t0-v1` 的模块、工具、资源、身份判断和部署模板保持精确不变；不得把本 profile 作为 T0 的 fallback。

## 3. T1 隔离执行

三个外部能力只能通过固定协议的独立 T1 worker 执行。MCP 进程只持有 worker client，不构造业务 HTTP adapter，不读取业务 secret，也不接受客户端提交 endpoint、token、tenant 或 actor。

worker 协议只允许以下方法：

```text
quote.canada_final_mile.calculate
customs.ca.search
customs.ca.estimate
quote.freightcom_ltl.preview
system.health
```

要求：

- stdin/stdout 使用有界 NDJSON，固定协议版本、请求 ID、deadline 和闭合方法枚举；
- 只转发服务端验证后重建的最小 execution context；
- worker 退出、超时、响应过大、协议漂移或结果无效均返回 `unavailable`，不回退 fixture；
- worker health 只证明隔离进程可响应，不把单个上游 `ready=false` 扩大为整个 MCP 不存活；
- 正式部署仍需独立容器/进程资源、只读文件系统、固定 egress、secret mount、无特权用户、日志脱敏和重启策略证据。

## 4. 能力状态

### 4.1 加拿大尾程报价

- 默认注入 disabled adapter；没有完整服务器配置时固定 `unavailable`；
- staging 显式配置必须同时满足 HTTPS、双重 host allowlist、普通 secret 文件、精确 tenant/warehouse→origin 映射；
- adapter 只调用固定 `/quotes/zone-preview`，并继续校验 tenant、origin、effective date、ready、test data、release、snapshot、hash、有效期和金额证据；
- 只有严格 v2 合同返回 `ready=true`、`test_data=false` 且证据一致时，才允许 adapter 投影 `success` 或 `manual_review`；结果始终 `sendable=false`；
- staging 可调用不等于生产资格，缺真实发布和读回证据时仍标记未合格。

### 4.2 RiskCustoms

- `customs.ca.search` 继续每次先 status、通过后再 query；
- `ready=false`、`testData=true`、release/source/hash/tenant 冲突时失败闭合；
- `customs.ca.estimate` 继续零 HTTP 请求并固定 `unavailable`，直至独立估算合同被接受。

### 4.3 Freightcom

- endpoint 固定为 Freightcom test host；
- 只允许 pallet LTL `POST /rate` 和有界 `GET /rate/{request_id}`；
- secret 仅由 worker 从有界、拒绝符号链接的服务器 secret 文件读取；
- 结果固定 `manual_review`，不做 FX，不保存、不发送、不订舱、不覆盖内部报价。

## 5. 身份与权限

- MCP 仍只接受短期 Bearer JWT；
- 本 profile 只接受 `service` 身份和精确 `tool:<name>` allowlist；目录按 token entitlement 过滤；
- 现有 Unified Access Gateway v1 继续只签发三个 T0 工具，不因本 RFC 扩权；
- 扩展工具在当前阶段只能使用企业 IdP/受控签发方直接签发的短期 JWT；长期 Key 扩展必须另行提交 Access Gateway v2 RFC、迁移、吊销和审计测试；
- `platform:admin`、业务 permission wildcard、未知 tool scope 和写工具 scope 均不得进入本 profile。

## 6. Agent 标准读取

新增 `read-preview-caller` Agent profile，只投影本档位六个静态模块及其已注册工具。`runtime-caller` 继续精确投影 T0 三模块，不被扩大。模块目录 resource 必须携带当前 immutable catalog generation，并与实际挂载模块、工具和五个资源 exact readback。

## 7. 配置与部署

基础 `deploy/compose.yml` 和 `deploy/env.example` 继续是 T0 候选。新增独立 staging override/example；它不得被叠加后仍称为 `t0-v1`。

业务 secret 值不进入仓库、环境变量、命令行、聊天、日志或 fixture。配置只保存 secret 文件引用；真实云 Secret Manager/KMS 注入和 egress enforcement 由部署环境提供。

## 8. 测试与验收

至少覆盖：

- T0 目录、身份和非 T0 零构造完全回归；
- `read-preview-staging` exact 6 modules / 7 tools / 5 resources；
- 未提供、错误 kind、退出、不健康、超时、超大和协议漂移的 worker 失败闭合；
- worker 方法 allowlist、服务端 context 重建、客户端 server-owned 字段拒绝；
- Quote disabled 与严格 fake HTTP 合同；
- RiskCustoms status→query、ready/test/release/source 门禁，estimate 零请求；
- Freightcom test-only、tenant allowlist、secret 文件边界、manual review 和无 FX；
- 精确 tool scope 的可见性/调用权限，T0 长期 Key 合同不扩权；
- Agent pack、catalog generation、module descriptor/artifact digest exact readback；
- 全量测试、Schema、Agent standards/adapters、typecheck、lint、build 和 `git diff --check`。

测试只使用 fake HTTP、合成 secret 和本地隔离进程；不得连接生产数据库、真实服务器或外部 API。

## 9. 回滚

撤下 `read-preview-staging` 实例或 override，回到上一已验证的 `t0-v1` 镜像。不得在运行中把 profile 静默改为 T0，也不得保留扩展 JWT scope。回滚不删除 T0 合同、审计或长期 Key 数据；业务 secret mount 应由部署系统撤销。

## 10. 生产资格结论

本 RFC 只授权仓库实现和合成验证。Quote 正式发布、RiskCustoms 非测试 release、Freightcom production 合同、扩展长期 Key、真实 IdP/KMS/Secret Manager、托管数据库、隔离网络、负载、告警、备份恢复和回滚演练任一缺失时，本 profile 均为 staging-only / NO-GO。
