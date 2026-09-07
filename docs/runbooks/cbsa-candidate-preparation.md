# 加拿大关税候选数据准备与复核

该命令是维护人员的离线 CLI，只支持 **2026 / T2026-2**。它从固定哈希的官方 CADEx ZIP 重新导出、规范化并核对来源，生成 `candidate`，不会批准、发布或修改数据库。业务人员的网页与 `freightclaw workspace customs-packages` 仍共用既有受控快照接收、浏览、发布和停用接口。

## 准备候选

维护机需要 Python 3.10+ 和提供 `mdb-tables`、`mdb-export` 的 mdbtools。门户运行时不需要执行这些来源导出工具。源码入口和构建产物均包含此 CLI；构建产物路径为 `dist/deploy/scripts/prepare-cbsa-release.py`。

先从 [CBSA 2026 年官方目录](https://www.cbsa-asfc.gc.ca/trade-commerce/tariff-tarif/2026/menu-eng.html) 获取文件，记录实际下载完成时间、URL 和 SHA-256。`--retrieved-at` 不是规范化时间，不能填写未来时间或以本次处理时间代替旧文件的抓取时间。

```sh
python3 deploy/scripts/prepare-cbsa-release.py \
  --archive /absolute/private-source/ca-en.zip \
  --sha256 9fc0ecf239374ee57577c06cef6f94a12e5be544239a60a463a1a2ac6a20cf81 \
  --language en \
  --retrieved-at ACTUAL_ISO_8601_RETRIEVAL_TIME \
  --output /absolute/private-source/new-ca-en-candidate
```

法文改用 `--language fr`，该固定版本 ZIP 的哈希为 `6d4b5a84460e857418547eb3429075dac55e2c6fd1f78bf3fc1f0abe11e91b22`。法文包提供法律品名，税率以经过复核的英文包为准；法文税率行数为零不是导入失败。新版本文件必须先更新解析配置、验证来源和回归，不能仅把命令行哈希改成新值绕过版本绑定。

输出目录必须不存在。命令保留原 ZIP、ACCDB、导出的 CSV、来源哈希、规范化 JSONL、来源清单与质量报告。已识别的 PowerBuilder 格式元数据和完全重复业务行保留逐条证据；未知表、变更的列、冲突税号和空白法律品名仍要求复核。空白品名不能仅凭数字代码被标为可申报。八位加拿大税目明确标记为前缀规则，适用于其两位统计后缀；不会把其他 `exact` 规则擅自扩展为前缀。

来源依据：[CBSA 税号结构说明](https://www.cbsa-asfc.gc.ca/trade-commerce/tariff-tarif/guide/read-lire-eng.html)、[D10-13-1 税则归类](https://www.cbsa-asfc.gc.ca/publications/dm-md/d10/d10-13-1-eng.html)、[PowerBuilder 系统元数据表](https://docs.appeon.com/pb2022/connecting_to_your_database/XREF_96173_About_the.html)。

## 与官方章节交叉核对

可增加 `--chapters-directory /absolute/private-source/chapters`。目录内放置已取得的 `ch01-eng.html`、`ch01-fra.html` 等文件，并提供 `chapter-fetch-report.json`：

```json
[
  {
    "url": "https://www.cbsa-asfc.gc.ca/trade-commerce/tariff-tarif/2026/html/02/ch01-eng.html",
    "status": 0,
    "sha256": "ACTUAL_FILE_SHA256",
    "retrieved_at": "ACTUAL_ISO_8601_RETRIEVAL_TIME"
  }
]
```

示例中的时间和哈希是占位符，必须替换成真实回执。`status: 0` 表示下载工具成功，不是发布批准。程序核对 URL 范围、文件哈希、语言、T2026-2 标记、生效日期及表头，拒绝不符的文件。`source-audit.json` 按税号保留原数据位置、官方页面、页面哈希和差异；不会依据法文或 HTML 的不同值自动覆盖 CADEx。

章节审核范围明确为 `provided_chapters_only`。它比较已提供章节中的税号、简单 MFN 税率和缺失品名，记录重复行、单位或复杂表达差异；不等于已核对全部章节、优惠原产地待遇、SIMA、法条注释或归类条件。文件结构校验通过也不等于法律发布审核通过。

退出码：`0` 表示本次解析及所选检查通过；`2` 表示需要复核或准备失败。可用候选仍标记 `candidate`、`approvalGranted: false`。来源存在差异时，保留候选与报告供核对；解析或哈希失败不生成完整候选目录。不要将返回 2 的复核报告当作执行成功回执。

## 正式发布

候选需经过原发布流程的来源核验、质量报告、版本差异、逐来源审批、覆盖范围和当前来源检查。此 CLI 不生成审批，也不制造 `publication_snapshot.ready=1`。完成正式源发布后，才按 [完整快照运行手册](native-business-completion-2026-09-08.md) 导出并启用。未通过时继续保留原快照状态和查询限制。

来源规范与解析器的文件哈希记录在 `services/customs-native/data_pipeline/provenance.json`；四份来源 Schema 原样移植，没有改动 MCP 工具合同或静态注册表。
