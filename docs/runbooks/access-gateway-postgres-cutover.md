# Access Gateway SQLite 到 PostgreSQL 切换 Runbook

本 runbook 只覆盖 Unified Access Gateway 的 tenant/client/Key/entitlement、幂等、审计和限流
状态迁移。MCP Runtime 自身的平台 SQLite 不在本次范围内。切换成功只证明候选应用已使用
PostgreSQL；不会把自托管数据库、文件签名密钥或文件 pepper 提升为正式生产设施。

## 1. 前置门禁

- 冻结 Gateway 管理写入，确认没有并发初始化、smoke 或 load runner。
- 记录候选 Git SHA、不可变镜像引用、配置摘要和上一镜像/配置三元组。
- 对两个 SQLite 源分别执行 `PRAGMA quick_check` 与 `PRAGMA foreign_key_check`，并记录 schema、
  instance、management tenant 和全表计数；不得只看文件存在或进程健康。
- 确认 PostgreSQL 目标 schema 不存在，或迁移历史与当前源逻辑指纹完全一致。
- 确认数据库密码只来自宿主私有文件，经 Compose Secret 只读挂载；不得放入 env、URL、镜像、
  命令输出、日志或审计。
- 确认上一 Gateway 镜像仍能读取原 SQLite，且原卷、备份和上一配置在演练完成前均不删除。

任一身份、schema、完整性、计数或 Secret 检查失败都停止切换。

## 2. 冻结与备份

1. 停止 Gateway，不停止 PostgreSQL；此后不再向 SQLite 写入。
2. 对停止后的源重新执行完整性检查并记录最终计数。
3. 备份 tenant store、operations store、marker 和 pepper history；备份目录设为 root 私有并生成
   SHA-256。manifest 只记录路径引用、大小、模式、计数和 digest，不记录 Key、pepper 或数据库密码。
4. 保持 Gateway volume 原样。备份不是迁移成功的替代证据。

## 3. 单事务迁移

使用与候选镜像相同的代码和配置运行：

```bash
npm run migrate:access-gateway-postgres
```

迁移器必须返回：

- `status=migrated`，或相同源幂等重跑时 `status=already_applied`；
- 源、目标逻辑指纹完全一致；
- tenant、client、credential、access event、idempotency、gateway audit、rate window 全表计数一致。

目标 schema 已存在但没有相同迁移历史、幂等操作无法唯一绑定 event、显式 delivery acknowledgement
无法投影或任一读回不一致时，事务回滚并保持旧应用停止状态。

## 4. 应用切换与读回

1. 配置 `ACCESS_GATEWAY_STORE_BACKEND=postgresql`，不提供 SQLite fallback。
2. 启动候选镜像；数据库连接、schema version、instance 或 management tenant 不匹配必须启动失败。
3. 回读 `/access/v1/readyz`：HTTP 200、`operational_ready=true`、
   `database_backend=postgresql`、`production_eligible=false`。
4. 从管理 API 只读回读 tenant/client/credential 状态，并与停止后的 SQLite 最终计数和样本 ID 对照。
5. 验证长期 Key 兑换短 JWT、JWT 调用固定 T0 目录、审计新增和跨租户拒绝。若目标仍处候选环境，
   使用合成 tenant/Key，完成后停用并保留审计。
6. 触发 PostgreSQL 备份并验证备份非空；恢复演练使用隔离数据库，不覆盖活动库。

## 5. 写入前回滚演练

在新 Gateway 接受管理写入前：

1. 停止 PostgreSQL 版 Gateway。
2. 用上一不可变镜像、上一配置和未改动的原卷启动 SQLite 版 Gateway。
3. 回读上一版 readiness、最终 SQLite 计数和只读管理状态；失败则本次切换 NO-GO。
4. 再停止上一版，启动 PostgreSQL 候选并重复第 4 节读回。

演练通过后才解除管理写冻结。解除后 PostgreSQL 成为新权威，不能再盲目切回旧 SQLite；后续回滚
必须使用理解当前 PostgreSQL schema 的兼容镜像，或先执行经审核的前向数据同步计划。禁止手工双写、
删除迁移历史或把旧 SQLite 当作运行时 fallback。

## 6. 立即回滚条件

- readiness 非 200、backend 不是 `postgresql` 或身份/目录漂移；
- 任一全表计数、逻辑指纹、幂等 operation binding 或 delivery acknowledgement 不一致；
- Key 兑换、短 JWT、审计或租户隔离回读失败；
- 数据库连接耗尽、超时、锁冲突、备份失败或告警不可见；
- 日志、env、命令输出或审计出现凭证材料。

回滚不删除 PostgreSQL schema、迁移历史、旧卷或备份。记录失败阶段和脱敏错误引用，修复后以新候选
重新完成全部门禁。

## 7. 仍然存在的生产门禁

自托管 PostgreSQL 切换后，状态仍固定为 `production_eligible=false`，直到企业 IdP/MFA、
KMS/HSM 和 Secret Manager、数据库托管资格、集中审计/告警/吊销、Edge denylist、目标负载与故障
演练，以及三类 Agent staging 读回全部有独立证据。
