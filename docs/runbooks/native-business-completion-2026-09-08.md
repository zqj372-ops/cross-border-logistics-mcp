# 原生业务闭环候选版部署与回滚

此文档是执行说明，不代表已上线。用户授权以运行服务为配置来源，部署仍以正式资料和业务验收为前提。

## 数据包更新

维护人员在来源数据库所在主机，以读取权限执行：

```sh
python3 deploy/scripts/export-customs-snapshot.py --source /absolute/source.sqlite --output /absolute/new-snapshot.sqlite
```

导出使用只读一致性事务，只复制法规白名单表及搜索索引；成功后才原子生成最终文件。输出文件必须不存在。保留原始来源状态和发布快照，不写原库、不复制账号/历史/凭证。将文件传输到目标原生业务目录下 `customs-inbox/`，对照输出的 SHA-256。传输完成后从网页「数据更新」或 CLI 接收，不能上传一个仍有 WAL 的活动数据库作为快照。

```sh
freightclaw workspace customs-packages import --input import.json --idempotency-key <唯一键> --session-file <人员会话>
freightclaw workspace customs-packages list --session-file <人员会话>
freightclaw workspace customs-packages browse --input browse.json --session-file <人员会话>
```

`import.json` 包含 `filename`、`sha256`、`label`；`browse.json` 如 `{"selection":"draft","collection":"tariffs","country":"CA","limit":25}`。`draft` 指最新接收候选包；`published` 指当前启用包。可选目录为 nomenclature、tariffs、measures、requirements、sources。

只有 `ready=1`、`test_data=0`、快照来源均 published、每个来源有独立审核引用、绑定哈希一致且门禁原因为空，才允许启用。发布请求为 `{id,sha256,expected_active,confirmation:"reviewed_sources_and_conditions"}`；停用为 `{expected_active}`。两者要求人员管理权限和幂等键。重复接收同一幂等请求返回原结果，原传输文件被移走也不会重复复制。选过完整数据包后，停用不会暗中回落到手动 JSON 数据。

首次打开已启用包时重新核验管理文件的 SHA-256；后续发现文件身份、大小、修改时间或 WAL 变化时停止查询。不可原地替换或修改已管理的数据包，应按新包接收、预览、发布流程操作。加拿大原始数据重新准备见 [CBSA 离线 CLI](cbsa-candidate-preparation.md)，该命令只生成待审候选，不能代替正式源发布。

每包最大 4 GiB，接收时每进程仅一项复制；校验与只读浏览需要磁盘/CPU 资源，安排维护窗口。维护人员保留 inbox、managed snapshot 和源导出三份时，应预留至少数据包大小三倍空间。目录按当前企业隔离元数据，不将法规快照放进 Git。手动 JSON 导入仍可用于小范围补录；完整包选中时手动 JSON 不改变查询来源。

## 报价与生效日期

运价发布应核对主起运地与 `extensions.origins_v1` 的每份邮编、价格及分区控制。CSV 导入/导出可通过 `origin` 指定当前起运地。空金额不是免费，缺档不插值，冲突邮编不默认挑选。源未配置的最大重量、体积和长度以 null 表达。

`extensions.quote_valid_days_v1` 控制报价单天数，报价单截止不能晚于运价截止。日期按 UTC 日历判断；发布预览与实际试算均需验证生效状态。来源试算成功后通过 `documents native-prepare` 取得签名预览，再保存，不从客户端手填费用伪造原生报价。

## 迁移和发布检查

1. 备份现有业务 SQLite、密钥文件、业务连接配置和数据包目录；保留当前镜像及配置。不得导入本地 fixture 身份或合成企业模板。
2. 新版本将 native-business 与 quote-documents 数据库格式升至 **2**，保留原记录。共享身份/调用库仍保持自身版本；新业务库不支持共享 Postgres。
3. 配置原生引擎、正式企业连接及 `PORTAL_QUOTE_DOCUMENTS_SQLITE_PATH`；`PORTAL_PDF_BROWSER_EXECUTABLE` 为绝对路径。候选 Dockerfile 加装 Chromium，已在 Oracle 候选容器验证。部署时将 `deploy/portal/chromium-seccomp.json` 与 compose.yml 放在同目录，保持 256 MiB /tmp 和 init。保持浏览器沙箱，不默认传 `--no-sandbox`。
4. 以真实企业身份核对两地运价、未知/冲突地址、混装、卸货条件、报价保存/审核/退回与 PDF；CLI 读回同一版本及文件 SHA-256。Freightcom 单独执行实际只读询价，不发邮件或订舱。
5. 关务完成真实来源发布后再启用其数据包，检查税号、适用条件、税率与来源证据；未就绪时保持不可用。
6. 代码验收通过后可合并 main；只有上述正式业务验收完成后才切换生产。分别记录 commit、镜像、迁移、数据包哈希及验收回执，不把代码合并当成业务上线。

## 回滚

停用/回退数据配置使用版本检查及人员确认，保留历史引用。程序回滚不能直接让旧二进制读取版本 2 业务库；旧版本将拒绝启动。先停止写入并备份当前库，再恢复匹配旧镜像的备份及配置；新记录另存并对账，不修改 `user_version` 强行降级。不得删除现有业务记录或密钥以“修复”启动。

## 邮编城市规则迁移

运行以下只读转换，不连接数据库或直接发布。输入目录包含 `online-quote-config-source.json`、`online-quote-effective.json`、`online-city-aliases.json`。转换会核对来源托盘算法版本，并拒绝尚未适配的邮编覆盖或城市别名。输出为待核验草稿和迁移摘要；修改正式库前仍需预览、人员确认与写后读回。

```sh
python3 deploy/scripts/prepare-residential-source.py --directory /absolute/private-source --valid-from 2026-09-07 --valid-until 2027-01-01
```

启用 `extensions.postal_city_v1` 后，CSV 按邮编、城市、省份更新，允许保留多个待复核分区；相同邮编、城市、省份、分区的完全重复行仍拒绝。主起运地和其他起运地共用此匹配模式。

## 目标容器 PDF 验证

镜像内运行 `node dist/deploy/verify-pdf-renderer.mjs /tmp/pdf-check.pdf`，输出仅含合成样张的字节数及 SHA-256，文件必须是新路径。它使用与正式导出相同的渲染器和中文字体，不访问企业资料。生产 Compose 保留 non-root、cap_drop ALL、只读根文件系统及 no-new-privileges；专用 seccomp 来源为 Playwright v1.58.2 的 `utils/docker/seccomp_profile.json`，增加 chroot 系统调用以供 Chromium 在自身用户命名空间内隔离根目录。内核仍校验能力，未授予容器主机 SYS_CHROOT 或 SYS_ADMIN。每次导出使用独立临时配置与缓存目录，结束后清理。

来源：[Playwright Docker 沙箱说明](https://playwright.dev/docs/docker)、[固定版本 seccomp](https://github.com/microsoft/playwright/blob/v1.58.2/utils/docker/seccomp_profile.json)。不得使用 --no-sandbox 或 privileged 绕过。

## 公司资料由用户自行配置

平台部署不预置公司名称、电话、邮箱或地址，也不要求所有企业先完成报价模板才能上线。各企业负责人或管理员通过服务市场 → 报价单 → 企业模板自行填写；CLI 使用 `workspace documents config` 和 `workspace documents config-save`。首次制作报价单需要公司名称和适用条款，其他业务功能不依赖此模板。此处的开放配置不改变企业数据隔离，也不将示例公司当作默认出单主体。
