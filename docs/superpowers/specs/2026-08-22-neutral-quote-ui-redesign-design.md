# 中性内部询价页面重设计规格

## 目标

把现有 Freightcom LTL pallet 询价工作台改成基于真实询价流程的内部操作页面：保留实际页面的字段顺序、交互节奏和报价查看方式，但不在用户可见界面使用 Freightcom 名称、Logo、商标、品牌色或品牌文案。

本次是 UI/交互重设计，不改变测试适配器、请求 Schema、服务端 Token 边界、`POST /rate` → `GET /rate/{request_id}` 流程或报价状态语义。

## 选定方案

采用“结构迁移 + 中性视觉系统”：

- 迁移真实页面的顶栏导航、Shipping Details、Shipping From/To、Dimensions & Weight、Additional Services、Additional Insurance、Quote Overview 和 Shipping Rates 结构；
- 使用通用内部工具名称：`Quote Desk`、`New Quote`、`Quote History`、`Shipments`、`Tracking`、`Billing`、`Claims`；
- 不创建 Logo 或品牌图形，左上角只显示文字 `Quote Desk`；
- Provider 名称只允许出现在响应证据和测试环境说明中，不出现在主导航、页面标题或品牌区域；
- 当前只启用 Pallet / LTL，其余包装类型以 disabled 状态保留，不产生未实现请求；
- 继续显示 USD 金额标签，但不做汇率转换；原始 provider 币种只在证据详情中保留。

不采用像素级复制方案：它会把外部品牌视觉、商标语义和内部业务语义混在一起，也会增加后续维护成本。也不保留当前深色左侧控制台方案：它与用户实际操作路径不一致，首屏信息密度和表单层级不清晰。

## 页面结构

### 顶部导航

使用白色水平顶栏，左侧为纯文字 `Quote Desk`，中间为通用内部导航，当前项为 `New Quote`。右侧只保留环境状态和账户操作位置，不显示 Provider 品牌。

导航不使用装饰性图标堆叠；图标只用于明确的导航和状态含义，并保持统一的线性风格。

### 主工作区

桌面宽度采用 `minmax(0, 2fr) minmax(280px, 0.85fr)`：

- 左侧为主表单，按真实页面顺序排列；
- 右侧为 sticky `Quote Overview`，只显示当前步骤定位和状态，不重复渲染字段；
- `Shipping Rates` 在主表单提交后进入同一主工作区，保留 polling、结果表、人工复核和证据展开状态。

### 表单分区

1. `Shipping Details`：Packaging Types、预计发货日期、服务筛选。
2. `Shipping From` / `Shipping To`：Postal/ZIP、City、Province/State、Country、Location Type；API 必填的完整街道地址和联系字段放入“Address details”折叠区，不能由邮编自动猜测。
3. `Dimensions & Weight`：Quantity、Metric/Imperial、每个 Pallet 的尺寸、重量、Freight Class、Type、Units on pallet、Description、NMFC。
4. `Additional Services for Pallets`：Dangerous Goods、Stackable、Limited Access、Appointment、Threshold、In-Bond、Freeze、Amazon/FBA；未声明在当前适配器中的服务保持 disabled 并显示原因。
5. `Additional Insurance`：保险类型、金额、币种和 reference codes，默认折叠。
6. 底部操作：`Get Rates` 为唯一主按钮，`Clear` 为次按钮；提交时显示 loading，错误时回到具体字段或错误摘要。

## 视觉系统

- 页面背景：真实白色内容面，浅冷灰工作区背景，不使用当前深海军蓝大侧栏；
- 主文本：深蓝灰 `#203448`；辅助文本：`#6f8190`；边框：`#d9e2e9`；
- 操作色：使用独立的内部蓝色 `#2f78b7`，成功状态使用青绿色，警告使用琥珀色，错误使用高对比红色；
- 不使用 Freightcom 现有 Logo、品牌蓝、品牌图形或品牌文案；
- 容器只保留必要的表单分组和结果表，减少套娃卡片；
- 输入高度桌面不低于 40px，移动端不低于 44px；
- 标题、标签、输入和表格数字建立固定字号层级，金额和进度数字使用 tabular figures；
- 动画仅用于折叠、状态切换和提交反馈，时长 150–300ms，并支持 `prefers-reduced-motion`。

## 交互和数据边界

- Location Type 映射为现有 `residential` 和 `tailgate_required`，不增加新的请求字段；
- Quantity 调整只改变本地 pallet 行数量；
- Metric/Imperial 只改变输入单位，仍按现有模型生成 measurements；
- Provider 请求仍由服务端完成，浏览器不接触 Token；
- provider 认证失败、上游拒绝、响应 Schema 不匹配都保持 `unavailable` 或 `manual_review`，不得以 UI 状态伪造成功；
- 结果金额继续显示 `USD` 标签且不换算，源币种和 `conversion_applied=false` 只进入证据区域；
- API 适配器、Zod Schema 和现有测试 fixture 不因为品牌或布局变更而复制一份。

## 响应式验收

- 1440px：主表单和 Quote Overview 同屏，首屏能看到 Shipping Details、From/To 起始字段和提交入口；
- 1024px：保持双栏但压缩间距，字段不发生横向溢出；
- 760px 以下：Quote Overview 移到表单上方或表单后方，所有分区单栏；
- 375px：输入高度至少 44px，按钮可触达，表格允许横向滚动但页面不横向溢出；
- 提交、校验错误、轮询中、结果返回和 manual_review 状态均需在桌面和移动宽度可读。

## 实现范围

预计只调整：

- `apps/freightcom-quote/index.html`：中性文案、顶栏、表单容器、Quote Overview 和结果结构；
- `apps/freightcom-quote/styles.css`：新视觉 token、布局、响应式和状态样式；
- `apps/freightcom-quote/app.js`：仅调整与新 DOM 结构相关的定位和交互，不修改请求映射。

不修改：

- `src/logistics_mcp/adapters/quote/**`；
- `apps/freightcom-quote/form-model.mjs`；
- 服务端 Token、测试 endpoint、真实调用 unavailable 规则；
- 生产适配器状态。

## 验收标准

- 页面可见区域没有 Freightcom 名称、Logo、商标或品牌文案；
- 真实页面的字段顺序和核心交互可以在内部页面完成；
- API 请求 JSON 与重设计前完全一致；
- `npm run typecheck`、`npm run lint`、`npm test -- --run`、Schema/Agent 标准校验和 build 均通过；
- Edge 浏览器验证首屏、滚动、核心表单交互、提交错误状态和移动宽度；
- 真实测试环境未被 UI 重设计误触发，Token 未进入浏览器、日志或 fixture。
