# T0 单区域回滚 Runbook

> 状态：演练步骤。所有目标环境字段均为 `[待实际执行]`，不得把文档存在当成回滚成功。

## 1. 回滚候选冻结

回滚只允许选择上一次完成 exact readback 的完整三元组：

```text
previous image digest
previous config hash
previous Standard Pack digest
```

同时记录 source SHA、数据库/schema 兼容性、备份引用、Gateway/JWKS 版本和 Edge 策略。
禁止回滚到不能理解当前状态的旧镜像、可变 tag、未知配置或未审核 Pack。

候选证据：`[待实际执行]`。

## 2. 触发与冻结

触发条件包括目录/Pack 漂移、持续 readiness 失败、认证或审计异常、确定性结果漂移、跨租户风险
以及 canary 错误预算超限。incident commander 先让 Edge 摘流，冻结 Gateway 管理写和新 token
签发，保留数据库、审计、日志和当前失败镜像，不删除历史或强制清锁。

触发、审批人、时间和 incident reference：`[待实际执行]`。

## 3. 回滚步骤

1. 获取回滚前的非空 backup，记录 digest、WAL/事务状态和恢复 owner；不得在活跃写入中复制
   不一致快照。
2. 验证 previous image digest、previous config hash、previous Standard Pack digest 与历史发布
   回执逐字一致。
3. 验证 Gateway 数据库 migration 向后兼容；不做临时逆迁移、不清空 tenant/key/audit 历史。
4. 部署上一不可变镜像和配置，由 `/readyz` 决定是否接流量；`/healthz` 不能单独放量。
5. 使用官方 MCP SDK 完成 exact **3 tools / 5 resources** 读回，并核对 Pack/profile/catalog digest。
6. 使用真实短 JWT 验证 cargo、container、Agent context、tenant 隔离、session 重连和审计。
7. 验证长期 API Key 仍只能兑换、Key/tenant/client 吊销继续阻断新 token、Edge denylist 生效。
8. 在批准的最小 canary 中逐步恢复流量并观察 readiness、认证、五态、审计、资源和重启指标。

每一步命令、输出、request/audit ID、时间和执行人：`[待实际执行]`。

## 4. 失败闭合

若上一镜像无法读取当前 schema、`/readyz` 不通过、3 tools / 5 resources 不一致、Pack digest
不符、审计不可写或身份策略漂移，保持摘流和 `blocked`，启动灾难恢复流程。不得继续切换更旧镜像、
禁用验证、使用 fixture token 或把未知状态写成已恢复。

失败/灾备证据：`[待实际执行]`。

## 5. 回滚完成条件

只有目标三元组、readiness、目录、Pack、真实短 JWT、确定性向量、审计、告警和恢复后数据读回
全部一致，且 incident commander、平台、安全、运维 owner 签字，才能写“回滚完成”。

最终判定：`[待实际执行：PASS / NO-GO]`。
