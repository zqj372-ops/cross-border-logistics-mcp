# 关税官方资料参考查询 v1

状态：按用户 2026-09-27 明确选择实施：先可查官方税号、税率与候选结果，未核验措施明确标注待复核；随后补齐正式税费。

生产故障已核对：旧来源 15 staged、0 published、0 publication snapshot；带正确租户与既有凭据的状态请求返回 503 data_not_ready。正式查询合同不得伪造 ready=true。

## 最小兼容变更

`customs.query` 保持输入、权限、访客额度和 CLI 命令。平台为已有连接显式配置独立只读参考资料文件及 SHA-256。只有来源明确返回经过结构校验的 data_not_ready 时，才查询该文件；认证、网络、快照冲突等错误不触发替代来源。未配置时保持原不可用行为。

旧正式响应 `portal-customs@2026-09-05.v1` 完全不变。新增参考响应 `portal-customs-reference@2026-09-27.v1`，status 只能为 manual_review，data 含规则日期、资料文件哈希、候选税号、原始税率、来源版本、层级品名和未核验范围。`formal_ready=false`；不提供合计、应缴税额或正式归类结论。未匹配也保持 manual_review，不能将未找到当免税。UI 明示档案抓取日期、来源版本与待复核，CLI/API 输出同一结构。

示例形状：旧 `{"schema_version":"portal-customs@2026-09-05.v1","status":"unavailable","data":null,"reason_codes":["customs_data_not_ready"]}`；新 `{"schema_version":"portal-customs-reference@2026-09-27.v1","status":"manual_review","data":{"request_id":"req_reference_example","formal_ready":false,"rule_date":"2026-09-27","snapshot_sha256":"<实际哈希>","candidates":[],"sources":[],"warnings":["正式税费尚未完成核验"]},"reason_codes":["customs_reference_only"]}`。完整字段以配套生成 Schema 为准。

## 来源与权限

资料来自现有官方法规白名单表及新取得的官方原件，保留实际 source_release 状态、原文表达、源行定位与哈希。以版本化离线文件供既有查询入口读取，不修改来源生产库、审批、publication_snapshot 或业务历史。平台文件由部署配置绑定，用户不能指定路径/URL/SQL。只读查询在原授权检查之后调用；没有新增公开管理权限。参考查询暂不进入旧来源人员历史，调用日志仍按现有规则记录。

同一国家税率只展示明确匹配税号、显式前缀规则与来源层级的原文规则；父级规则标明所属税目，不自动得出继承适用或优惠资格。贸易救济、附加税、排除条款、许可证、汇率及总税费一律待核验。

## 验证、迁移和回滚

先验证参考文件来源和行数、负向权限/格式/文件变更、只在 data_not_ready 回退、Web/API/CLI 同一资料哈希。运行相关 customs/Portal/CLI 测试、typecheck、lint、Schema/OpenAPI/Agent 校验及构建。先独立容器验证，再保留旧镜像与配置切换；既有 FCL 数据格式不迁移。关闭 customsReference 配置即可恢复旧来源行为，保留所有法规文件与业务记录。完整正式税费另需来源更新、高风险措施/叠加矩阵审核及正式发布验收。
