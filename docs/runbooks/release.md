# Release runbook

发布是人工批准的候选交接，不包含自动发布、发送报价、订舱或生产写入。所有真实端点、
认证、tenant mapping 和关务连接在取得 staging 证据前都标记为“待适配验证”。
No automatic send, publish, or booking path is included.

## 必须按顺序完成

1. **candidate build**：从干净的候选分支工作区生成镜像/包，记录
   commit SHA、Node 版本和依赖锁文件 hash；构建始终校验并复制 `index.html`、`styles.css`、
   `app.js`、`fixture-data.js` 四个固定 admin 资源。资源打包不等于开放控制台，
   `MCP_ADMIN_UI_ENABLED` 默认关闭。
2. **non-empty backup**：在任何 staging/生产变更前，生成非空备份清单，记录配置、审计
   依赖、现有系统回滚点和已应用 migration；不把密钥正文写入清单。
3. **Schema**：运行 Draft 2020-12 Schema 和全部示例校验，确认十工具/五状态契约未漂移。
4. **full tests**：运行 platform、cargo、container、adapters、domains、e2e 全测试以及
   typecheck/lint；安全扫描必须无 Critical/Important。
5. **image digest**：构建后记录不可变 image digest，不以 tag 作为唯一证据。
6. **staging health/readiness**：只在批准的 staging URL 验证 `/healthz` 与 `/readyz`；health
   只证明进程，readiness 反映身份/JWKS/SQLite 等全局依赖；业务 API 状态要通过
   对应工具和 `system.get_data_status` 另行验收。
7. **RiskCustoms**：核对 `ready`、`test_data`、snapshot/release hash 和 release IDs；
   `ready=false` 原样保持 `unavailable`/`manual_review`，不得伪 ready。
8. **write preview/commit**：只用隔离 fixture/sandbox 验证已登记写工具的 preview、审批、
   commit、幂等和写后 readback；报价单仍保持不可发送，HTTP 成功码不等于业务成功。
   `quote.create_pdf` 还必须验证 Quote preview → PDF POST `201/200`/同 key replay → GET
   exact readback、跨租户零请求和 `sendable=false`；未取得完整 staging 证据时保持默认关闭。
9. **audit review**：检查 audit_id、脱敏、tenant/actor、版本、状态、幂等 outcome 和
   readback status；审计失败必须 fail-closed。
10. **client smoke**：先用实际企业身份源的脱敏短时 token 验证 claims 映射，再检查
    tools/list、五状态和 `system.get_data_status`；
    确认 `sendable=false`/`theoretical_only=true` 不被客户端越界解释。
11. **explicit approval**：由发布负责人、业务 owner、安全 owner 和运维 owner 明确批准，
    保存证据路径后才可进入另行授权的部署流程。

```bash
npm run build
bash deploy/scripts/check-release.sh --fixture-only
docker compose --env-file deploy/env.example -f deploy/compose.yml config
```

`--fixture-only` 只做本地只读/隔离验证，不访问网络、不打印密钥，也不启动容器。
该门禁会先验证构建产物：默认禁用且缺配置时失败闭合。

Quote PDF 的五个运行时变量为 `MCP_QUOTE_PDF_ENABLED`、`MCP_QUOTE_PDF_BASE_URL`、
`MCP_QUOTE_PDF_ALLOWED_HOSTS`、`MCP_QUOTE_PDF_TENANT_ID` 和
`MCP_QUOTE_PDF_BEARER_TOKEN`。Compose 用空默认值透传可选配置，enabled 默认 false；
只有显式启用且 HTTPS/非 loopback/精确 allowlist/单公司 tenant/secret injection 与 staging
写后读回证据全部通过，才可由另行批准的变更启用。不要把 URL、token、tenant 或 actor 写入
客户端模板、镜像参数、label 或日志。

Admin 控制台的静态路由在 MCP bearer auth 之前。只有在批准的企业身份网关/访问控制之后才允许
开启 `MCP_ADMIN_UI_ENABLED=true`，不能直接公网暴露。当前只读 snapshot 仅允许本机回环访问且不返回
身份、租户、地址、凭证或审计明细；多人入口仍需独立 admin RBAC、tenant binding、CSRF/Origin、
版本/审批/审计。保存、发布和回滚 API 未接通，正式写配置保持不可用。
