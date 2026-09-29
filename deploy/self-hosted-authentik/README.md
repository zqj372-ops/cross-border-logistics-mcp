# Authentik 身份服务候选

[文档中心](../../docs/README.md) / 身份部署

本目录保留在既有 Oracle 主机运行专用 Authentik 管理登录的候选配置。不替换 Cloudflare DNS/代理，也不使 Access Gateway 自动获得生产资格。

## 运行边界

| 项目 | 要求 |
| --- | --- |
| 镜像 | 候选固定 Authentik 2026.8.0、PostgreSQL 16-alpine，并绑定当时核验的不可变 digest |
| 数据库 | 仅 Authentik 私有网络可见 |
| HTTP | 只发布 127.0.0.1:19000，用于 SSH 隧道与诊断 |
| Worker | 不挂 Docker socket；embedded outpost 由已审查 blueprint 声明 |
| secrets | 在目标机生成；1000:1000，0400 |
| blueprints 目录 / 文件 | root:1000，目录 0750，文件 0640 |
| 管理员 | 绑定 authentik Admins，签发短期管理 claims；Gateway 仍验证 RS256、issuer、audience、时间和精确 management tenant |

T0 中不包含报价、关务、Freightcom 或业务写操作。

## 目录与首次配置

```text
/data/logistics-mcp/infra/authentik/
  compose.yml
  blueprints/freightclaw-admin.yaml
  secrets/postgres-password
  secrets/authentik-secret-key
  state/postgresql/
  state/data/
  state/certs/
  state/templates/
```

在有权限的本机建立隧道：

```bash
ssh -N -L 19000:127.0.0.1:19000 oracle-new
```

打开 `http://127.0.0.1:19000/if/flow/initial-setup/` 设置 akadmin 密码。密码只在页面输入，不进入聊天、仓库、shell 历史或 Gateway 环境。

对外开放前检查 blueprint、discovery/JWKS、签名、精确 claims、管理员组和 outpost。对应代理只保护 /admin、/access-console、/admin/api/v1/access/；MCP、换票、JWKS 和公开首页保持各自边界。

## 备份与回滚

变更前用 pg_dump 备份 PostgreSQL，并保存 blueprint/config 引用。同机备份只是单节点恢复副本，不是异地灾备。

回滚恢复旧 Nginx；只有 Gateway IdP 配置变更才重启 Gateway。保留 Authentik 数据库和文件，便于恢复与排障。
