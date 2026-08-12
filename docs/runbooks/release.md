# Release runbook

发布是人工批准的候选交接，不包含自动发布、发送报价、订舱或生产写入。所有真实端点、
认证、tenant mapping 和关务连接在取得 staging 证据前都标记为“待适配验证”。
No automatic send, publish, or booking path is included.

## 必须按顺序完成

1. **candidate build**：从干净的 `codex/task-06-integration` 工作区生成候选镜像/包，记录
   commit SHA、Node 版本和依赖锁文件 hash；构建始终校验并复制 `index.html`、`styles.css`、
   `app.js`、`fixture-data.js` 四个固定 admin 资源。资源打包不等于开放控制台，
   `MCP_ADMIN_UI_ENABLED` 默认关闭。
2. **non-empty backup**：在任何 staging/生产变更前，生成非空备份清单，记录配置、审计
   依赖、现有系统回滚点和已应用 migration；不把密钥正文写入清单。
3. **Schema**：运行 Draft 2020-12 Schema 和全部示例校验，确认九工具/五状态契约未漂移。
4. **full tests**：运行 platform、cargo、container、adapters、domains、e2e 全测试以及
   typecheck/lint；安全扫描必须无 Critical/Important。
5. **image digest**：构建后记录不可变 image digest，不以 tag 作为唯一证据。
6. **staging health/readiness**：只在批准的 staging URL 验证 `/healthz` 与 `/readyz`；health
   只证明进程，readiness 必须反映 adapter/data status。
7. **RiskCustoms**：核对 `ready`、`test_data`、snapshot/release hash 和 release IDs；
   `ready=false` 原样保持 `unavailable`/`manual_review`，不得伪 ready。
8. **write preview/commit**：只用隔离 fixture/sandbox 验证两个窄写工具的 preview、审批、
   commit、幂等和写后 readback；HTTP 成功码不等于业务成功。
9. **audit review**：检查 audit_id、脱敏、tenant/actor、版本、状态、幂等 outcome 和
   readback status；审计失败必须 fail-closed。
10. **client smoke**：使用假客户端身份检查 tools/list、五状态和 `system.get_data_status`；
    确认 `sendable=false`/`theoretical_only=true` 不被客户端越界解释。
11. **explicit approval**：由发布负责人、业务 owner、安全 owner 和运维 owner 明确批准，
    保存证据路径后才可进入另行授权的部署流程。

```bash
npm run build
bash deploy/scripts/check-release.sh --fixture-only
docker compose --env-file deploy/env.example -f deploy/compose.yml config
```

`--fixture-only` 只做本地只读/隔离验证，不访问网络、不打印密钥，也不启动容器。

Admin 控制台的静态路由在 MCP bearer auth 之前。只有在批准的企业身份网关/访问控制之后才允许
开启 `MCP_ADMIN_UI_ENABLED=true`，不能直接公网暴露；未来正式 provider 仍需独立 admin RBAC、
tenant binding、CSRF/Origin、版本/审批/审计。当前 snapshot/provider、保存/发布/回滚 API 仍未接通，
正式配置保持不可用。
