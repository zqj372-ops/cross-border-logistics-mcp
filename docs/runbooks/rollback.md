# Rollback runbook

回滚目标是恢复上一份已验证的应用配置和镜像，不删除数据，不重写已经应用的 migration。

1. 暂停新的发布/写操作入口，保留当前 audit 和 incident reference。
2. 从发布记录取上一镜像 digest（previous digest）、上一份配置 hash（previous config）、上一份客户端兼容矩阵和非空备份清单；
   不从聊天或记忆猜值。
3. 切换到上一镜像 digest 和上一份已审计配置；secret 仍从 secret store 注入，不复制到
   shell、日志或 runbook。
4. **保留已应用 migration（applied migration）**：只回滚应用代码/配置；任何 schema 逆迁移必须另立 RFC、备份
   和批准，不在紧急回滚中删除或重写 migration。
5. 验证 `/healthz`、`/readyz`、RiskCustoms `ready/test_data/release_ids`、审计写入和 fixture
   写后读回；失败则保持 `unavailable`/`manual_review`，不要强行恢复 success。
6. 记录切换时间、上一/当前 digest、配置 hash、数据库/适配器状态、审计 ID 和 owner；完成
   人工批准后再恢复客户端 smoke。
