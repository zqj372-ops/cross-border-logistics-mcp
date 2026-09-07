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
    fontSize: "clamp(40px,4.2vw,58px)"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "-.025em"
  headline:
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-.025em"
  title:
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1.4
  panel-title:
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: 'Inter, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "14px"
    lineHeight: 1.55
  label:
    fontSize: "13px"
    fontWeight: 600
  code:
    fontFamily: '"SFMono-Regular", Consolas, monospace'
rounded:
  field: "7px"
  control: "8px"
  icon: "10px"
  panel: "12px"
  feature: "14px"
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
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
    typography: "{typography.label}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
    typography: "{typography.label}"
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
  service-preview:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.feature}"
    padding: "8px"
---

# Design System: FreightClaw Console

## Overview

**Creative North Star: "留白中的物流入口"**

以用户确认的 JoyAgent 参考方向为基础，FreightClaw 用白色留白、近黑文字与主操作建立安静、直接的服务入口。蓝色保留在品牌标记、链接、焦点和轻提示中；淡蓝点阵、弧线与物流图标提供轻量空间感。浅色服务预览与深色页脚构成明暗节奏，内容仍使用 FreightClaw 自有品牌、图标与实际业务。

此系统覆盖 `apps/console` 的官网、服务市场、业务表单、CLI 与操作手册。公共入口保持舒展，操作页以可扫描的信息、明确字段和真实状态为主。首页的居中双字重标题、四服务预览与弧线图标属于该页面的表达，不要求其他任务页复用整套构图。

本文更新并合并既有规范：保留已实现的可见焦点、局部滚动、移动账号入口与状态文字；视觉依据为当前 `styles.css`、`home.js`、`app.js`、`market.js` 和本轮桌面、移动端截图。生产部署与业务就绪状态归交付记录和 [PRODUCT.md](PRODUCT.md)，不由设计文档推定。

**Key Characteristics:**

- 白色画布与近黑主操作形成稳定主次，蓝色承担链接、焦点与轻提示。
- 大标题以轻重字重建立节奏，任务页用紧凑字号和充分行距保证扫描。
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

正文与代码采用前置字体栈，不依赖外部字体服务。常规正文为 `body`，说明文字多使用（13–14 px）与（1.8）行高；表单和详情标题使用 `headline`，服务和章节标题使用 `title`。长篇手册采用更宽松的行距，数字摘要和额度使用等宽数字，代码与长标识允许换行。

首页标题使用 `display` 尺度，前半句常规字重、后半句加重（700），保持单一语句的连贯性；（760 px）、（540 px）、（360 px）及以下依次为（40、37、32 px）。该标题的系统中文字体继承是实现事实，不作为未来展示字体的选型规范。市场标题保留响应尺寸（28–44 px），任务页无需采用首页展示尺度。

**The Weight Contrast Rule.** 展示标题通过轻重字重而非多种装饰字体建立主次；表单、目录与说明继续优先保证阅读和扫描。

## Layout

公共顶栏为（80 px），主要内容与首页容器最大宽度为（1280 px）。桌面以（32 px）侧边空间开始，手机在（760 px）及以下使用（20 px），最窄首页在（360 px）及以下使用（14 px）。移动顶栏为（72 px），主导航进入抽屉，账号入口保持可见。

首页服务预览在桌面为四列，（900 px）及以下两列，（540 px）及以下为单列；手机每张服务卡将预览移到左侧、文字放右侧，保留同样的内容顺序。接入说明与终端在宽屏并列，（760 px）及以下堆叠。点阵背景和弧线在自己的装饰区域收束，不参与正文的可用宽度。

市场使用分类与能力列表两区结构，能力卡片为三列，（1120 px）及以下两列，（540 px）及以下单列；（760 px）及以下分类成为局部横向目录。详情与表单按空间从并列变为顺序堆叠。手册保留目录与正文的阅读关系，不继承首页展示区的大留白。

**The Local Overflow Rule.** 宽表格、代码和目录只在自己的容器内滚动；页面列与文字容器允许收缩，保持手机任务顺序。

## Elevation & Depth

空间感以白色、柔灰与细描边为主。点阵和低饱和光晕提供首页气氛，深色终端和页脚提供实用的明暗对照；这些都不是业务状态信号。

**The Quiet Depth Rule.** 静态内容主要依靠留白、浅底和细边界分层；小物件和覆盖层可以使用柔和阴影，不将它扩大为所有卡片的默认效果。

### Shadow Vocabulary

- **预览小物件**（`0 6px 18px #323f6310`）：白色图标底座和迷你终端的轻微悬浮感。
- **账号浮层**（`0 12px 36px #25283024`）：账号菜单覆盖页面时的层级提示。
- 通知和对话框保留各自已有的覆盖层阴影，完整值记录在 sidecar。

交互颜色与边界变化采用短促过渡（180 ms）。首页弧线一次入场使用（1.1 s）的缓出，位移与模糊都很轻；启用减少动效时关闭动画与过渡。持续装饰动画不是此系统的一部分。

## Shapes

控件使用 `field` 与 `control` 圆角；一般面板采用 `panel`，首页服务预览、接入容器和账号下拉采用 `feature`。市场筛选采用 `filter` 的胶囊轮廓；账号头像与弧线节点保持圆形。描边通常为细实线（1 px）。

图标以现有内联 SVG 为准。首页的圆形节点、细弧线和浅色预览内部的小矩形组成同一几何语言，不引入第三方图片或商标。首页预览中更小的圆角仅服务其内部图示，不另建通用容器等级。

## Components

### Buttons

近黑主按钮、白色次按钮与透明轻按钮形成明确层级，基础最小高度为（42 px）；首页双行动按钮为（48 px）。主要按钮悬停变为深灰，次按钮悬停增加浅底，轻按钮通过文字和底色变化回应。禁用按钮降低不透明度并使用不可操作光标。

所有交互保留可见焦点，基础焦点为（3 px）蓝色轮廓、偏移（3 px）。首页按钮只是同一主次体系的较大尺寸，不形成另一套主色。

### Inputs / Fields

白底、明确边界、字段圆角与（42 px）最小高度。输入框与文本域始终配合可见标签；错误用红色边界加文字说明。市场搜索使用带内联 SVG 的胶囊输入，最小高度（44 px），图标不替代输入的可访问名称。

### Navigation / Account

白色水平顶栏容纳 FreightClaw 标记、主导航与账号图标。当前主导航通过近黑文字与较重字重表示位置，悬停为蓝色；旧版底部蓝线不再用于公共主导航。客户内部页签继续用蓝色与短线表达选择。

账号按钮最小高度（44 px），圆形头像置于淡灰底。下拉为（252 px）宽，菜单行最小高度（44 px），支持外部点击关闭、Escape 关闭与焦点恢复。移动抽屉展开时主内容不可交互，账号功能不占用公共主导航。

### Chips / Filters

市场协议和分类使用浅灰选中底、深色文字与胶囊圆角；数量为次级文字。小屏允许局部滚动或紧凑布局，保留每个选项。协议标签与业务状态标签使用明确文字，视觉样式不推断服务能力。

### Cards / Containers

市场能力卡为白底、轻描边、面板圆角，标题、说明与页尾动作维持稳定顺序；悬停增加浅底和蓝灰边界，焦点轮廓独立于边界。

首页服务预览采用白色外框、柔灰图示区与下方短说明；手机改为左图右文。图示是辅助预览，真实服务说明和行动仍位于可访问正文。四个服务共享轮廓、间距与标题层级，以内部几何和少量颜色区分。

### Results / Quota / Code

额度使用浅蓝提示区，数字为等宽数字，手机说明换行。来源状态保留文字反馈，视觉颜色不替代可用性与权限判断。代码示例保留独立等宽栈、明确行距和可换行边界；API Key 明文不成为文档或组件预览的内容。

## Do's and Don'ts

### Do:

- **Do** 使用白色画布、近黑主操作与蓝色链接的角色分工。
- **Do** 用留白、字重、浅底与细边界组织内容，并保留清晰的辅助文字。
- **Do** 保留字段标签、可见键盘焦点、菜单关闭及焦点恢复行为。
- **Do** 将宽表格、代码和目录的滚动限定在局部容器。
- **Do** 让移动账号入口始终可达，并保持服务和表单的阅读顺序。

### Don't:

- **Don't** 将首页点阵、弧线和四服务编排强加给每个任务页。
- **Don't** 将淡色预览中的装饰标签代替真实字段、业务说明或结果文字。
- **Don't** 复制参考站品牌与业务承诺，或用界面样例代替真实来源状态。
- **Don't** 仅靠颜色表达成功、警告或失败。
