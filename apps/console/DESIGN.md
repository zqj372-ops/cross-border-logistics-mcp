---
name: FreightClaw Console
description: 白色留白、近黑主操作与淡蓝几何构成的物流服务入口
colors:
  ink: "#252830"
  action-hover: "#414651"
  brand: "#335cff"
  surface: "#fff"
  soft: "#f7f8fa"
  muted: "#626975"
  line: "#e8eaee"
  strong: "#cfd3db"
  selected: "#eff0f3"
  blue-soft: "#f0f3ff"
  success: "#227a50"
  success-soft: "#edf8f2"
  warning: "#88580e"
  warning-soft: "#fff7e7"
  error: "#b23a48"
  error-soft: "#fff0f2"
typography:
  display:
    fontFamily: '"Manrope", "Noto Sans SC", sans-serif'
    fontSize: "clamp(42px,5vw,72px)"
    fontWeight: 450
    lineHeight: 1.28
    letterSpacing: "-.025em"
  headline:
    fontSize: "36px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-.025em"
  title:
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.4
  panel-title:
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: '"Manrope", "Noto Sans SC", sans-serif'
    fontSize: "16px"
    lineHeight: 1.65
  label:
    fontSize: "15px"
    fontWeight: 600
  control:
    fontSize: "16px"
    fontWeight: 600
  metadata:
    fontSize: "14px"
    lineHeight: 1.7
  code:
    fontFamily: '"JetBrains Mono", "Noto Sans SC", monospace'
    fontSize: "14px"
    lineHeight: 1.85
rounded:
  field: "7px"
  control: "8px"
  icon: "14px"
  panel: "12px"
  feature: "14px"
  service: "16px"
  filter: "24px"
spacing:
  compact: "8px"
  control: "12px"
  related: "16px"
  group: "20px"
  section: "24px"
  spacious: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
    typography: "{typography.control}"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
    typography: "{typography.control}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
    typography: "{typography.control}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "10px 12px"
  navigation:
    textColor: "{colors.ink}"
  protocol-filter:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    rounded: "{rounded.filter}"
    padding: "9px 16px"
  capability-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "23px"
  case-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "24px"
  service-preview:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.service}"
    padding: "10px"
---

# Design System: FreightClaw Console

## Overview

**Creative North Star: "留白中的物流入口"**

以用户确认的 JoyAgent 参考方向为基础，FreightClaw 用白色留白、近黑文字与主操作建立安静、直接的服务入口。蓝色保留在品牌标记、链接、焦点和轻提示中；淡蓝点阵、弧线与物流图标提供轻量空间感。浅色服务预览与深色页脚构成明暗节奏，内容使用 FreightClaw 自有品牌、真实业务说明与统一的开源线性图标。

此系统覆盖 `apps/console` 的官网、服务市场、业务表单、询价协作、CLI 与操作手册。公共入口保持舒展，操作页以可扫描的信息、明确字段和真实状态为主。首页的居中双字重标题、四服务预览与弧线图标属于该页面的表达，不要求其他任务页复用整套构图。

本文按当前实现合并更新字体、阅读尺度、布局与图标规范，保留可见焦点、局部滚动、移动账号入口与状态文字。视觉依据为当前 `styles.css`、`home.js`、`icons.js`、字体清单和 `.impeccable/review/refinement` 中的本地桌面、移动端截图。询价协作补充依据 `cases.js` 与 [本地合成验收截图](../../docs/product/assets/cases-20260907/)；后台延续现有字体、图标、按钮与面板，不建立新的视觉身份。生产部署与业务就绪状态归交付记录和 [PRODUCT.md](PRODUCT.md)，不由设计文档推定。

**Key Characteristics:**

- 白色画布与近黑主操作形成稳定主次，蓝色承担链接、焦点与轻提示。
- 大标题以轻重字重建立节奏，正文、辅助文字与控件保持较大的阅读尺度。
- 中文、拉丁文字与代码使用自托管开源字体；统一线性 SVG 保持图标笔画和圆角一致。
- 柔和灰底、细边界和圆角组织内容，微弱阴影只用于浮层和预览中的小物件。
- 桌面、平板与手机保持任务顺序，服务预览随宽度从四列转为两列和横向单列。

## Colors

前置 token 记录当前复用的颜色；实现中的 CSS 自定义属性仍是运行时来源。整体以中性灰白为主，蓝色占小面积。sidecar 的八阶色带是面板预览用的明度扩展，不是新增生产配色。

### Primary

- **近黑墨色**：标题、正文重点和客户界面的主要按钮共用，悬停转为稍浅的深灰。
- **连接蓝**：FreightClaw 标记、正文链接、输入光标、选中页签及相关操作提示。

### Secondary

- **状态绿、琥珀与红**：只配合明确的成功、警告与错误文字，使用各自的浅底。
- 服务预览中的青绿、蓝紫来自当前 SVG 与几何组合，用于区分服务物件，不取代业务状态色。

### Neutral

- **白色表面与柔灰底**：白色承担页面和内容，柔灰承托服务预览、接入区与辅助面板。
- **正文墨色与次要灰**：分别承担核心内容和说明；选中筛选项使用轻灰底与深字。
- **轻分隔与明确描边**：前者组织内容区，后者用于可输入控件和次按钮。

**The Action Hierarchy Rule.** 客户界面的主要按钮使用近黑色；蓝色用于链接、焦点与提示，不把每个可点击区域都填成蓝色。

## Typography

**中文字体：Noto Sans SC。拉丁字体：Manrope。代码字体：JetBrains Mono。** 正文和标题使用前置 `body` 字体栈；Manrope 处理拉丁字形，Noto Sans SC 处理中文，缺字或加载失败时由通用 sans-serif 回退。代码栈由 JetBrains Mono 与 Noto Sans SC 配合，最后回退到 monospace。可变字体保留各自字重范围：Manrope（200–800）、Noto Sans SC（100–900）、JetBrains Mono（100–800）。

首页标题使用 `display` 尺度，前半句轻字重、后半句加重（700），保持单一语句的连贯性。宽屏上限由前置 token 定义；（760 px）及以下固定为（42 px），（540 px）及以下使用（`clamp(34px,10.25vw,42px)`），在（320 px）视口保留（34 px）标题。首页副标题为（20 px），手机依次为（17 px）和（16 px）。

首页服务说明保持 `body` 字号与（1.8）行高；手机行高为（1.75）。服务标题使用 `title`，在（1180 px）及以下降为（22 px），（540 px）及以下为（21 px），（360 px）及以下为（20 px）。服务辅助信息使用 `metadata`，手机为（13 px），不随图示缩成难读的小字。

任务页主标题使用 `headline`，在（760 px）和（540 px）及以下分别为（30 px）和（28 px）；市场能力标题为（21 px）。客户页表单控件与主要说明使用 `control` / `body`，字段标签使用 `label`，辅助说明为（14 px）与（1.75）行高。手册章节保留其阅读层级；数字摘要和额度使用等宽数字，代码与长标识允许换行。

字体通过本地 `fonts/fonts.css` 导入，均为 WOFF2、`font-display: swap` 和 `unicode-range` 按字符加载。构建将字体输出到带内容哈希的 `/console/fonts/` 路径，不连接字体 CDN。当前清单包含（43）个字体资产，合计（9,605,752 bytes）；其中 Noto Sans SC 的 UI 子集与后续分片合计覆盖上游（30,890）个 Unicode 码位。常用页面字形由 UI 子集提供，其余字形按需请求，不把全部分片预加载到首页。首页使用的三个基础资产合计（324,936 bytes）；这是资产文件大小，不是所有页面或所有查询的固定传输预算。来源版本、文件摘要与 SIL OFL 1.1 许可见 [字体清单](fonts/manifest.json) 和 [字体与图标许可](asset-licenses.md)。

**The Weight Contrast Rule.** 展示标题通过轻重字重而非多种装饰字体建立主次；表单、目录与说明继续优先保证阅读和扫描。

**The Readable Metadata Rule.** 首页服务正文在手机仍保持正文尺度；辅助信息与装饰图示分别处理，隐藏装饰标签时保留完整的业务说明。

## Layout

公共顶栏高（88 px），首页容器最大宽度（1536 px），客户任务页内容最大宽度（1440 px）。首页与任务页宽屏内容均使用（`calc(100% - 96px)`），即两侧至少（48 px）；顶栏侧边空间使用（`max(40px,calc((100vw - 1536px)/2))`），（1180 px）及以下改为（32 px）。手机在（760 px）及以下内容侧边空间为（20 px），最窄首页在（360 px）及以下为（14 px）。移动顶栏高（76 px），主导航进入抽屉，账号入口保持可见。

首页服务预览按可用宽度采用以下排列，服务顺序始终保持一致：

| 视口宽度 | 服务排列与图文关系 |
| --- | --- |
| 大于（1180 px） | 四列；图示在上、文字在下，列间距（24 px）。 |
| （901–1180 px） | 两列；每卡左侧图示、右侧文字，图示最小高度（220 px）。 |
| （541–900 px） | 两列；每卡恢复上下图文，图示高（150 px），列间距（18 px）。 |
| （540 px）及以下 | 单列横向卡；左侧（76 px）图标区、右侧文字，卡间距（16 px）。装饰标签与迷你终端隐藏，CLI 使用同系列终端图标。 |
| （360 px）及以下 | 左侧图标列为（58 px），图文间距（12 px），保持正文可读宽度。 |

接入说明与终端在宽屏并列，（760 px）及以下堆叠。点阵背景和弧线在自己的装饰区域收束，不参与正文的可用宽度。

市场使用分类与能力列表两区结构，能力卡片为三列，（1120 px）及以下两列，（540 px）及以下单列；（760 px）及以下分类成为局部横向目录。详情与表单按空间从并列变为顺序堆叠。手册保留目录与正文的阅读关系，不继承首页展示区的大留白。

询价详情在桌面采用两列等宽网格，左侧需求资料，右侧处理或回复表单及进展，列间距（24 px）。在（800 px）及以下改为单列，将操作与进展放在资料之前；资料字段在（480 px）及以下进一步改为单列。列表卡片在（800 px）及以下隐藏辅助图标和箭头，保留状态、服务、更新时间与完整需求编号，编号及长文本可换行。

**The Local Overflow Rule.** 宽表格、代码和目录只在自己的容器内滚动；页面列与文字容器允许收缩，保持手机任务顺序。

## Elevation & Depth

空间感以白色、柔灰与细描边为主。点阵和低饱和光晕提供首页气氛，深色终端和页脚提供实用的明暗对照；这些都不是业务状态信号。

**The Quiet Depth Rule.** 静态内容主要依靠留白、浅底和细边界分层；小物件和覆盖层可以使用柔和阴影，不将它扩大为所有卡片的默认效果。

### Shadow Vocabulary

- **预览小物件**（`0 6px 18px #323f6310`）：白色图标底座和迷你终端的轻微悬浮感。
- **账号浮层**（`0 12px 36px #25283024`）：账号菜单覆盖页面时的层级提示。
- 通知和对话框保留各自已有的覆盖层阴影，完整值记录在 sidecar。

交互颜色与边界变化采用短促过渡（180 ms）。首页弧线一次入场使用（0.8 s）的缓出，从（6 px）位移与（1 px）模糊回到静止；启用减少动效时关闭动画与过渡。持续装饰动画不是此系统的一部分。

## Shapes

控件使用 `field` 与 `control` 圆角；一般面板采用 `panel`，首页服务卡采用 `service`，接入容器和账号下拉采用 `feature`。市场筛选采用 `filter` 的胶囊轮廓；账号头像与弧线节点保持圆形。描边通常为细实线（1 px）。

图标使用 `icons.js` 中精选的（25）个 Lucide 内联 SVG，保留 Lucide 的 ISC 与 Feather 衍生部分的 MIT 许可。统一（24 × 24）坐标、（1.75）描边、圆形线帽和圆形连接点，继承文字色；装饰图标均设置 `aria-hidden` 与 `focusable="false"`。图标不使用字体文件或远程图片，来源固定版本和完整许可见 [字体与图标许可](asset-licenses.md)。

首页弧线节点中的图标在桌面为（30 px）、手机为（23 px）；服务预览主图标为（36 px），手机简化图标为（38 px）。圆形节点、细弧线与浅色预览内部的小矩形组成同一几何语言。品牌内容保持 FreightClaw，图标来源的许可与品牌身份分别记录。

## Components

### Buttons

近黑主按钮、白色次按钮与透明轻按钮形成明确层级，客户页基础最小高度为（46 px）；首页双行动按钮桌面最小宽度（210 px），由较大内边距形成约（56 px）高度，手机最小高度（52 px）。主要按钮悬停变为深灰，次按钮悬停增加浅底，轻按钮通过文字和底色变化回应。禁用按钮降低不透明度并使用不可操作光标。

所有客户页交互保留可见焦点：使用 `brand` 蓝色的（3 px）轮廓与（3 px）偏移。首页按钮只是同一主次体系的较大尺寸，不形成另一套主色。

### Inputs / Fields

白底、明确边界、字段圆角与客户页（46 px）最小高度。输入框与文本域始终配合可见标签；错误用红色边界加文字说明。市场搜索使用带内联 SVG 的胶囊输入，图标不替代输入的可访问名称。

### Navigation / Account

白色水平顶栏容纳 FreightClaw 标记、主导航与账号图标。当前主导航通过近黑文字与较重字重表示位置，悬停为蓝色；旧版底部蓝线不再用于公共主导航。客户内部页签继续用蓝色与短线表达选择。

账号按钮最小高度（44 px），圆形头像为（40 px）并置于淡灰底。下拉为（280 px）宽，受视口最大宽度限制，菜单行最小高度（48 px），文字为（14 px）。支持外部点击关闭、Escape 关闭与焦点恢复。移动抽屉展开时主内容不可交互，账号功能不占用公共主导航。

### Chips / Filters

市场协议和分类使用浅灰选中底、深色文字与胶囊圆角；数量为次级文字。小屏允许局部滚动或紧凑布局，保留每个选项。协议标签与业务状态标签使用明确文字，视觉样式不推断服务能力。

### Cards / Containers

市场能力卡为白底、轻描边、面板圆角，标题、说明与页尾动作维持稳定顺序；悬停增加浅底和蓝灰边界，焦点轮廓独立于边界。

首页服务预览采用白色外框、柔灰图示区与短说明，按 Layout 的断点改变图文位置。手机用清晰的单个图标释放正文宽度，额度、服务范围和来源说明仍位于可访问正文。四个服务共享轮廓、间距与标题层级，以内部几何和少量颜色区分。

### Inquiry Collaboration

“我的询价”与“询价管理”复用同一白色列表卡、状态文字和筛选按钮。卡片标题使用 `panel-title` 层级，辅助信息使用 `metadata`；整卡可进入详情，悬停边界转蓝，键盘保留统一焦点。状态筛选的当前项使用近黑主按钮，并以 `aria-pressed` 表达选择。未有需求、筛选无结果、读取中和未启用分别使用明确文字反馈。

处理区将“告知客户的进展”与“内部备注（选填）”分为独立字段；时间线中的内部记录标明“仅后台可见”。客户可补充时，最近的补充请求放在回复框上方的柔灰提示区，使用控制圆角与（20 px）内边距。列表与返回操作继续使用现有内联 SVG。账号菜单按权限提供“我的询价”或“询价管理”，不增加一套后台导航外壳。

`/inquiry/` 的提交成功区域沿用 Console 的 Manrope / Noto Sans SC、近黑正文和主次操作层级，并提供查看进度入口；原询价表单外壳仍保留，此处不宣称全页已完成视觉统一。

### Results / Quota / Code

额度使用浅蓝提示区，数字为等宽数字，手机说明换行。来源状态保留文字反馈，视觉颜色不替代可用性与权限判断。代码示例保留独立等宽栈、明确行距和可换行边界；API Key 明文不成为文档或组件预览的内容。

## Do's and Don'ts

### Do:

- **Do** 使用白色画布、近黑主操作与蓝色链接的角色分工。
- **Do** 用留白、字重、浅底与细边界组织内容，并保留清晰的辅助文字。
- **Do** 使用自托管开源字体和统一 Lucide SVG，保留来源版本、Unicode 分片与许可文件。
- **Do** 在手机服务卡保留（16 px）正文与（13 px）辅助文字，先简化装饰再安排内容。
- **Do** 保留字段标签、可见键盘焦点、菜单关闭及焦点恢复行为。
- **Do** 将宽表格、代码和目录的滚动限定在局部容器。
- **Do** 让移动账号入口始终可达，并保持服务和表单的阅读顺序。

### Don't:

- **Don't** 将首页点阵、弧线和四服务编排强加给每个任务页。
- **Don't** 将淡色预览中的装饰标签代替真实字段、业务说明或结果文字。
- **Don't** 复制参考站品牌与业务承诺，或用界面样例代替真实来源状态。
- **Don't** 仅靠颜色表达成功、警告或失败。
