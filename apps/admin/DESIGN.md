---
name: FreightClaw 管理工作台
description: 浅色、紧凑、以真实状态和下一项有效操作为中心的企业物流能力工作台。
colors:
  brand: "#3659db"
  brand-dark: "#2947bd"
  brand-soft: "#eef2ff"
  ink: "#202939"
  ink-soft: "#394456"
  muted: "#637083"
  quiet: "#8490a2"
  canvas: "#f6f7fb"
  surface: "#ffffff"
  surface-soft: "#f8f9fc"
  sidebar-admin: "#f1f2f5"
  sidebar-access: "#f1f2ee"
  line: "#e1e5ec"
  line-strong: "#cbd2dc"
  line-access: "#e6e9f0"
  success: "#227a50"
  success-soft: "#edf8f2"
  warning: "#956317"
  warning-soft: "#fff7e7"
  danger: "#b23a48"
  danger-soft: "#fff0f2"
  access-success: "#16794b"
  access-warning: "#9a6700"
  access-danger: "#bd2c37"
  neutral-soft: "#f0f2f5"
typography:
  headline:
    fontFamily: "Inter, SF Pro Text, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 750
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter, SF Pro Text, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 730
    lineHeight: 1.25
  body:
    fontFamily: "Inter, SF Pro Text, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Inter, SF Pro Text, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.2
  utility:
    fontFamily: "SFMono-Regular, Consolas, PingFang SC, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  radius: "10px"
  business-radius: "12px"
  radius-small: "8px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.surface}"
    typography: "{typography.body}"
    rounded: "{rounded.radius-small}"
    padding: "8px 14px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.brand-dark}"
    textColor: "{colors.surface}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.body}"
    rounded: "{rounded.radius-small}"
    padding: "8px 14px"
    height: "40px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.radius-small}"
    padding: "8px 10px"
    height: "40px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius}"
    padding: "20px"
  business-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.business-radius}"
  business-button:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.surface}"
    typography: "{typography.body}"
    rounded: "{rounded.radius-small}"
    height: "44px"
  status-pill:
    typography: "{typography.label}"
    rounded: "999px"
    padding: "3px 8px"
---

# Design System: FreightClaw 管理工作台

> 机器扩展位于 `apps/admin/design-system/design.json`。本规范记录 `apps/admin/` 与 `apps/access-console/` 当前实现；颜色、字体、圆角和组件值以本页 frontmatter 为准。

## Overview

**Creative North Star: “受控操作台”**

FreightClaw 是浅色、紧凑、克制的企业工作台。视觉层级先回答“当前对象是什么、状态如何、下一步能做什么”，再通过折叠详情、检查器、表格和对话框展开技术证据。品牌只用一组受约束的蓝色强调操作和选中态，状态始终同时显示中文文字、形状或符号，不能只靠颜色表达。

Admin 与 Access Console 共享字体、密度、蓝色主操作、轻边框和紧凑卡片，但它们是两个独立后台。Admin 提供既有报价与关务服务的安全入口，并承载 Runtime 能力、租户权限、发布、审计、故障、客户端和 API 管理；Access Console 管理租户、调用方、API Key 与接入操作。统一的外观不表示两套后台或外部业务服务的会话、数据库、身份或权限已经合并。

**Key Characteristics:**

- 浅灰画布、白色表面、细边框和低阴影，保持信息密度而不制造装饰性层次。
- 页面按任务导航；列表先给结论和动作，版本、摘要、来源引用与读回证据按需展开。
- 蓝色只标记主操作、焦点、选中项和信息态；绿、琥珀、红只表达已核验的语义状态。
- 演示、测试、正式、未读取和读取失败明确区分；空白不等于正常，页面不生成假完成。
- 普通运行页面的目录条目与数量来自服务端返回；显式演示模式可使用本地 fixture，并清楚标明演示。读取失败时不能用示例目录补齐。
- 业务入口通过独立端点读取；入口配置状态、Runtime 快照状态、原服务登录和最终业务结果分别呈现。

## Colors

主色是受约束的企业蓝，搭配冷白表面和蓝灰文字；语义色面积小，只出现在状态标签、边框、提示底色和关键数值。

### Primary

- **受控蓝（brand）**：主按钮、品牌标记、当前导航、焦点和可操作链接。
- **深受控蓝（brand-dark）**：主按钮悬停与更强的当前态文字。
- **淡蓝底（brand-soft）**：选中导航、能力图标、信息状态和草稿差异背景。

### Neutral

- **主墨色（ink）与次墨色（ink-soft）**：标题、正文和值；长技术值允许换行，不用更亮颜色伪装层级。
- **说明灰（muted）与静默灰（quiet）**：辅助说明、时间、字段提示和导航分组。
- **画布（canvas）、白色表面（surface）与柔和表面（surface-soft）**：形成主要深度；Admin 和 Access 分别保留略有差异的侧栏色。
- **边界线（line、line-strong、line-access）**：分隔表面、字段和数据行。Access 保留其较浅的独立边框值，不强行重写为 Admin token。

### Tertiary

- **成功绿、提醒琥珀、阻断红及其柔和底色**：只承载服务端或本地流程已知状态。Access 使用自己的绿、琥珀和红值，但语义不变。

**The Evidence Before Color Rule.** 颜色只强化已显示的文字状态；`success`、`needs_input`、`manual_review`、`blocked`、`unavailable` 以及管理流程状态都必须有明确中文标签和原因。

**The Scoped Status Rule.** 成功色只说明标签所指的状态，例如“快照就绪”，不能推导为模块已生效、客户端已接通或生产已就绪。未读取和读取失败不能显示成功；演示与测试数据即使存在已完成的步骤，也必须保留环境和结果范围说明。

## Typography

**Display Font:** 无独立展示字体；页面标题沿用正文家族。

**Body Font:** Inter，依次回退到 SF Pro Text、PingFang SC、Microsoft YaHei、system-ui 和 sans-serif。
**Label/Mono Font:** 技术值使用 SFMono-Regular、Consolas、PingFang SC、monospace。

字体体系服务于快速扫描：页面标题紧凑而有重量，卡片标题只比正文高一级，标签和值靠字重区分。英文工具名、版本、摘要和一次性凭证才进入等宽字体语境；中文任务名称保持正文家族。

### Hierarchy

- **Headline**（750，28px，1.25）：管理页的默认页面标题 token；手机依当前断点缩到 25px/24px，窄屏再到 23px。业务工作台与业务页 `h1` 在桌面为 30px、`900px` 以下为 27px，工作台 `h1` 在 `640px` 以下为 25px；报价主标题 31px、关务入口 23px、税费估算入口 18px，业务详情主面板标题 25px。响应式尺寸以当前页面规则为准，不能把这些局部值覆盖为全站 28px。
- **Title**（730，18px，1.25）：主要面板标题；Access 的表面标题通常为 16px。
- **Body**（400，14px，1.55）：任务说明、表单和数据正文。
- **Label**（650，12px，1.2）：状态、指标名称、表头、上下文和元数据；不依赖全大写制造层级。
- **Utility**（400，12px，1.55）：凭证、版本、摘要和其他需要逐字符辨认的技术值。

**The Business Name First Rule.** 先显示准确的中文能力、来源和操作名称；工具名、模块 ID、风险级别、版本和摘要放在次级信息或详情中。映射只能改善显示，不能改变服务端身份或吞掉未知条目。

## Layout

桌面以 `1440px` 最大内容宽度为上限。Admin 顶栏高约 `64px`，桌面侧栏固定 `224px`，主内容内边距 `32px`；Access 使用同样的 `224px` 侧栏和 `32px` 主内容内边距，顶栏约 `76px`。常见布局间距来自当前实现的 `8px`、`10px`、`12px`、`14px`、`16px`、`18px`、`20px`、`24px` 与 `32px` 重复值，这些是观察到的节奏，不另立 CSS token。

Admin 有 11 个任务页面：工作台、询价工作台、关务查询、税费估算 4 个业务入口，以及能力与配置、Agent 接入、审批与发布、审计日志、数据连接、工具权限、系统结构 7 个管理页。桌面使用固定侧栏，移动菜单按钮隐藏；`900px` 及以下把 4 个常用业务入口常驻顶部，菜单按钮展开 7 个管理页。管理菜单使用两列布局而非横向滚动；`640px` 以下业务启动区、卡片和指标转为单列，表格仍可显式横向滚动。

Access Console 有 4 个独立视图：工作台、接入管理、操作记录、身份设置。桌面使用 `224px` 侧栏；`760px` 及以下变为横向导航和单列内容，`460px` 以下指标、对话框权限项和按钮进一步纵向排列。Access 的移动导航没有 Admin 的“10 页面”提示，不能复制该文案。

主页面只保留当前任务和主要动作。Admin 的技术证据、模块状态汇总和数据说明使用原生 `details/summary` 折叠；模块检查器只在宽屏吸附，移动端回到普通文档流。列表和表格必须使用 `minmax(0, 1fr)`、可换行值或显式横向滚动，不能让工具名、摘要或中文长句撑破视口。

首页业务启动区在桌面使用 `1.28fr 1fr` 的不对称布局：正式询价占主列，关税查询与淡蓝色税费估算入口在次列上下排列。业务面板使用 12px 圆角，业务主动作最小高度 44px；这些值属于业务工作区，不改变普通管理面板的 10px 圆角和普通按钮的 40px 高度。

**The Separate Backends Rule.** 相同壳层只表达一致的操作语言；Admin 与 Access 的请求、身份、状态和允许动作分别读取，跨后台跳转不能暗示共享会话或合并权限。

## Elevation & Depth

系统以色块和细边框建立深度，常驻表面基本保持平坦。Admin 的普通面板无阴影；Access 普通表面只使用极轻的 `0 1px 2px rgb(16 24 40 / .025)`。强阴影只用于模态对话框，Access 对话框使用 `0 24px 70px rgb(19 31 55 / .2)`，背景遮罩同时轻微模糊。聚焦态使用 3px 半透明蓝色外轮廓或等价的蓝色字段环，不用阴影冒充状态。

**The Flat Until Modal Rule.** 静态卡片靠边框和背景分层；只有对话框、聚焦控件或短暂交互状态获得明显抬升。

## Shapes

基础表面为轻微圆角：普通大面板使用 `10px`，业务启动与业务详情面板使用 `12px`，按钮、字段、导航项、行项目和折叠摘要主要使用 `8px`，Access 的局部按钮和记录卡可使用当前实现的 `9px`。状态胶囊使用完全圆角，圆点只用于状态指示和步骤编号。边框通常为 1px；虚线只用于空态。品牌和功能图标使用内联 SVG 线性图形，不以文本字形代替功能图标。

## Components

组件应像操作工具：紧凑、可预测、状态明确，所有写动作均等待服务端返回或读回后再更新完成文案。

### Buttons

- **Shape:** 40px 最小高度、8px 圆角；Access 现有按钮为 9px 圆角，保持其局部差异。
- **Primary:** 蓝底白字，用于每个区域最主要且当前允许的下一步。
- **Secondary / Ghost:** 白底细边框或透明背景，用于刷新、查看、返回和低风险辅助动作。
- **Hover / Focus:** 约 140–150ms 的颜色和边框过渡；键盘焦点为 3px 半透明蓝色轮廓并有 2px 偏移。
- **Disabled / Pending:** 禁用态降为中性灰；提交期间锁定同一操作，未知写结果保持“待核验”并复用同一幂等上下文。
- **Business launch:** 业务启动区的主动作最小高度为 44px；这是局部可触达尺寸，不替换管理页的 40px 按钮规则。

### Chips

- **Status:** 12px 半粗文字、胶囊形状、淡色背景和同色系边框；文字必须说明状态。
- **Role / Filter:** 小圆角矩形，未选为中性表面，选中为淡蓝底和深蓝文字；角色显示不替代服务端权限检查。

### Cards / Containers

- **Corner Style:** 主面板 10px，内部卡片与数据区域 8–9px。
- **Background:** 默认白色；柔和灰用于次级行、草稿列和只读摘要。
- **Shadow Strategy:** 参考 Elevation；Admin 常驻面板无阴影，Access 仅有极低环境阴影。
- **Border:** 1px 中性线；成功、提醒或阻断边框只在该状态已确认时出现。
- **Internal Padding:** 主面板通常 20px，紧凑行和内部卡片通常 11–16px。

### Inputs / Fields

- **Style:** 40px 高、8px 圆角、白底和较强中性边框；标签位于字段上方。
- **Focus:** 蓝色边框配 3px 半透明蓝色焦点环。
- **Error / Disabled:** 错误文字紧邻字段；禁用态使用灰底灰字。凭证、JWT 和密码不得进入 URL、storage、cookie 或日志；身份输入提交后清空，一次性 Key 只在本次交付界面短暂显示，交付确认后隐藏。

### Navigation

- **Admin:** 桌面侧栏分为 4 个业务入口与 7 个管理页，共 11 项；当前项使用淡蓝底、深蓝文字和边框。手机常驻 4 个业务入口，菜单展开 7 个管理页；选择页面后关闭菜单，按 `Escape` 关闭并把焦点还给菜单按钮。
- **Access:** 4 项接入视图使用同一选中语言，但在 `760px` 以下独立转为横向导航。
- **Behavior:** 切换页面更新 `aria-current`，主内容获得程序化焦点；任务名称优先，技术别名只做辅助。

### Status and evidence

统一包络的五状态只能是 `success`、`needs_input`、`manual_review`、`blocked`、`unavailable`。管理流程可以显示“待审批”“正在应用”“等待读回”等独立流程用语，但不能把它们写回业务包络。目录可见、模块运行、租户授权、凭证交付、服务端目录检查和目标客户端验证分别呈现，任何一项都不能替代另一项。

### Details and dialogs

`details/summary` 承载不影响当前决策的技术证据，展开后仍保持 8–20px 的紧凑间距。模态对话框用于身份输入、凭证轮换和不可逆影响确认；标题先说明对象和动作，正文展示权限差异、有效期和结果边界，关闭后焦点回到触发控件。

## Do's and Don'ts

### Do:

- **Do** 让每页首屏明确显示当前对象、真实状态、最近读回依据和一个主要下一步。
- **Do** 普通运行页面从服务端目录渲染实际条目并保留未知项；显式演示模式单独标明。显示名称映射只处理已知文案，不固定目录数量。
- **Do** 分别呈现 Admin 与 Access 的身份、允许动作和故障；某一区域失败时保留其他已核验区域及其时间。
- **Do** 在桌面保留 224px 侧栏；手机常驻 4 个业务入口，通过可关闭的菜单访问 7 个管理页，并在关闭后恢复焦点。
- **Do** 同时使用状态文字、图形和原因，并把演示、测试、本地读回与生产资格分开说明。

### Don't:

- **Don't** 因目录存在、HTTP 成功、本地 fixture 通过或运行时精确读回就显示“生产已就绪”。
- **Don't** 把报价、Zone、税率、客户数据或业务记录做成可自由编辑的本地权威表。
- **Don't** 用前端隐藏、角色标签或共享外观代替服务端权限检查，也不要暗示两个后台共享身份。
- **Don't** 在状态读取失败或空数据时回退到演示快照、默认目录或假成功指标。
- **Don't** 把技术眉题、版本、摘要和证据铺满首屏；它们应位于次级文本、检查器、表格或折叠详情中。

## Existing-service launch workspaces · 2026-09-05

首页、正式询价、关税查询和税费估算构成 4 个业务入口。它们复用已有报价与关务 Web 服务，取代旧版 Admin 内资料准备表单；Admin 不复制税率、措施、报价或历史记录的业务权威。

- 首页使用不对称启动构图：报价主面板更宽，关税入口和淡蓝计算器面板组成右列。业务面板圆角 12px，业务按钮最小高度 44px。
- 正式询价页突出加拿大尾程主入口，并展示原服务的辅助入口；关税与税费估算分别进入原关务服务的查询页和计算器。
- 入口由 `GET /admin/api/v1/business-entrypoints` 独立读取，不依赖 Runtime snapshot 就绪。已配置只表示启动配置存在，访问状态仍未验证。
- 报价与关务 origin 由服务器启动配置提供，前端没有硬编码默认地址。未配置时展示配置说明和重试，不展示可点击的假入口。
- 外部链接以新标签页打开并使用 `noopener noreferrer`；页面不通过 URL 或表单传资料，原服务登录、租户和权限保持独立。
- 当前没有 MCP 自动业务调用、统一登录、跨服务 handoff、资料自动带入或历史恢复，也没有扩大 T0 权限。打开服务入口不能显示为询价、查询或估算成功。

早期“10 页、手机横向滚动导航、Admin 内资料准备表单、正式调用按钮禁用”的描述仅代表已替换版本，不作为当前设计依据。产品边界见 [Admin 产品说明](PRODUCT.md)，正式业务合同与验收见 [业务服务方案](../../docs/product/2026-09-05-mcp-product-redesign/09-business-services.md)。
