# Access Console

[文档中心](../../docs/README.md) / 接入管理

本目录是 **Access Gateway 的窄管理界面**。客户与日常运营请使用 [Portal](../console/README.md)，不要将这里当作整柜运营后台。

| 范围 | 内容 |
| --- | --- |
| 接入配置 | 租户、客户端、长期 Key 生命周期、三个 T0 工具 entitlement |
| 操作验证 | operation readback、生产门禁、Agent 接入清单 |
| 运营概览 | 固定 24 小时五状态计数、最多 20 条脱敏异常 |

管理入口受管理员保护；Cloudflare Access JWT 须验证签名、issuer、AUD、时效及精确管理员映射，不能只检查请求头是否存在。

仓库提供前端合同、本地合成测试和受保护的只读 overview API。具体部署能力取决于装配模式，见 [Gateway](../../services/access-gateway/README.md) 与[部署说明](../../deploy/README.md)。合成演示、候选门禁和生产验收分别记录。
