---
name: FreightClaw Console
description: 面向货主与商家的浅色物流业务入口
colors:
  primary: "#3659db"
  primary-hover: "#2947bd"
  canvas: "#f7f8fb"
  surface: "#fff"
  soft: "#f8f9fc"
  ink: "#202939"
  muted: "#637083"
  support: "#566780"
  line: "#e1e5ec"
  border-strong: "#cbd2dc"
  blue-soft: "#eef2ff"
  success: "#227a50"
  success-soft: "#edf8f2"
  warning: "#88580e"
  warning-soft: "#fff7e7"
  error: "#b23a48"
  error-soft: "#fff0f2"
typography:
  body:
    fontFamily: 'Inter, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "14px"
    lineHeight: 1.55
  headline:
    fontSize: "30px"
    fontWeight: 700
    letterSpacing: "-.025em"
  title:
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.4
  label:
    fontSize: "13px"
    fontWeight: 600
  code:
    fontFamily: '"SFMono-Regular", Consolas, monospace'
rounded:
  field: "7px"
  control: "8px"
  compact-surface: "10px"
  surface: "12px"
spacing:
  compact: "8px"
  control: "12px"
  related: "16px"
  section: "24px"
  spacious: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
    typography: "{typography.label}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "10px 12px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.surface}"
  protocol-filter:
    rounded: "{rounded.control}"
    padding: "9px 16px"
---

# Design System: FreightClaw Console

## Overview

**Creative North Star: "FreightClaw 浅色业务工作台"**

延续已确认的 FreightClaw 浅色、蓝色体系，让货主与商家能够先找到业务入口，再阅读必要的说明与结果。白色阅读区域、清晰字重和轻边界组织信息；普通页面与开发者接入页面共享导航与基础控件。

用户此前指定 [Wind Alice Market](https://aifinmarket.wind.com.cn/#/home) 为组织方式参考。保留轻顶栏、可检索市场、详情配置区和左侧目录手册；不复制第三方品牌、文案、用户数据或未实现产品。没有外部图片或字体服务依赖。图标以当前内联 SVG 资产为准。

本次是对既有文档的合并更新，范围为 `apps/console`。首页双入口与工具行属于当前首页的编排，不能据此要求所有页面采用相同结构。官网根路径与 `/console/` 使用同一首页组件和构建资产；原海运询价服务的界面规范仍归其自身目录。

**Key Characteristics:**

- 浅色画布承托白色内容区，蓝色标识主操作与选中项。
- 业务说明短而直接，专业参数、原始结果与接入细节按任务展开。
- 页面平面为主，以边界、底色和留白分层；浮层使用柔和阴影。
- 桌面与手机保持相同任务顺序，账号入口在手机顶栏保持可见。

当前记录来自实现代码与 `.runtime/public-review/reviewed-*.jpg`、`reviewed-metrics.json`，属于隔离样例的界面证据。此前市场和手册检查记录保存在 `.runtime/market-review/`。独立完成审查已针对本轮小字对比度、标题字距和窄屏溢出修正给出限定范围的通过结论；检测器因缺少 HTML parser 降级为正则，不能替代完整的对比度、可访问性或生产验收。生产版本与来源状态仍以交付台账为准。

## Colors

颜色原语以前置 token 为准，CSS 自定义属性是实现来源。浅底与深字保持阅读层级，业务入口可以在此基础上使用有明确语义的局部配色。sidecar 的八阶色带仅供预览生成的明度展示，不是源码已有的品牌色阶，也不新增规范色值。

### Primary

- **业务蓝**：主按钮、选中导航、分类与正文链接；悬停使用更深的同色系。
- **浅蓝底**：信息提示、选中区域和账号图标背景的相关色系，不承担正文颜色。

### Secondary

- **成功绿、提示琥珀、错误红**：分别配合对应浅底和明确状态文字。颜色不能将来源未就绪的结果表现为成功。
- 首页海运区为深蓝承载白色文字，关务区为白底搭配绿色操作。它们是已有业务区的配色应用，不替换全站主色。

### Neutral

- **浅色画布与白色表面**：区分页面背景、表单、卡片和阅读区。
- **正文墨色、次要文字与辅助文字**：辅助文字在首页工具、接入和页脚区域使用 `support`；占位文字使用 `muted`。
- **分隔线与控件描边**：普通分区使用轻边界，输入与次按钮使用较明确的边界。

**The Readable Support Rule.** 辅助文字依靠层级与位置降低强调，不通过降低到难以阅读的对比度来弱化。

## Typography

正文采用前置 `body` 字体栈，中文使用设备已有字体；代码采用独立等宽栈。不下载外部字体。系统字体在现有大标题中的继承是当前实现事实，不将它确认为未来展示字体的选型。

正文基准为 `body`，一般说明使用（13–14 px），长篇手册使用更宽松的行高（1.9–2）与最大行长（76ch）。业务页面标题采用 `headline`，章节标题采用 `title`，卡片标题以中等尺寸与较重字重区分，按钮采用 `label`。数字额度与摘要使用等宽数字，代码与长标识允许换行。

当前首页标题“询运费，查关税。”采用（50 px / 650 / 1.35），字距为（-.035em）；在（720 px）及以下缩为（36 px），在（360 px）及以下缩为（32 px）。这记录首页已通过检查的标题尺度，不把单个首页的字号设为所有页面的标题规则。未把旧页面的小号大写眉题或装饰标签纳入排版规范。

## Layout

顶栏当前高度为（68 px），主要内容最大宽度为（1280 px），首页阅读区最大宽度为（1160 px）。宽屏通过居中留白控制行长；较窄屏幕依次使用（40、24、18 px）侧边空间。正文、表单与卡片采用 `minmax(0,1fr)` 或 `min-width:0` 允许内容收缩，根元素不强制最小页面宽度。

当前首页按短标题、主要服务、更多工具、CLI/API 接入与页脚排列。服务区为（1.2:1）两列、间距（24 px）；（720 px）及以下变为单列、间距（16 px）。工具区在手机上成为带分隔线的纵向行。终端简例在（1000 px）及以下隐藏，保留实际 CLI 与手册入口。

市场维持分类和内容的两区结构；能力卡片在桌面、平板、手机分别为三列、两列、一列。详情在宽屏并列说明与接入区，窄屏按阅读顺序堆叠。手册保留左侧七章目录与右侧正文，手机目录可局部横向滚动。个人中心保留当前企业与任务页签，按角色呈现可操作的工作区。

**The Local Overflow Rule.** 宽表格、代码和目录可以在自己的容器中滚动，页面本身不能横向溢出；窄屏检查比较文档 `scrollWidth` 与 `clientWidth`。

（320 px）检查中可用文档宽度为（305 px），首页内容宽度同为（305 px）；不能用含滚动条的视口宽度代替可用宽度判断。更窄市场筛选项在（360 px）及以下采用紧凑内边距（9 px 6 px）和字号（13 px）。

## Elevation & Depth

大多数页面表面不加阴影，主要依靠轻描边、浅底和留白分层。首页主服务区通过深浅底色建立主次，能力卡片悬停调整底色和边界。

账号下拉使用柔和浮层阴影（`0 12px 36px #172a4821`），通知使用（`0 8px 25px #20293925`）；移动导航保留侧向阴影。这些阴影对应覆盖层，不将其扩展到全部静态卡片。完整阴影值、焦点与动效保存在 sidecar。

交互变化保持短促：首页按钮与账号开关使用（160 ms）的背景和文字颜色过渡，能力卡片使用（180 ms）的底色和边框过渡。系统开启减少动效时关闭动画与过渡。

## Shapes

基础控件使用 `field`、`control` 圆角，面板使用 `surface` 圆角。小型图标底座和提示条使用紧凑表面尺度，账号头像保持圆形。一般边界为细实线（1 px）。

首页两块主要服务面板当前采用（18 px）圆角，在手机改为（14 px）；账号下拉同为（14 px）。这是已有组件的较大容器尺度，不将每一个模块包入相同的大卡片。

## Components

### Buttons

主按钮使用业务蓝底与白字，次按钮使用白底、正文色和明确描边；最小高度（42 px）。幽灵按钮减轻底色与边界，文本操作使用链接颜色。禁用按钮降低不透明度并显示不可操作光标；所有交互保留可见键盘焦点。

首页海运区使用反白主按钮，关务入口使用绿色按钮，两者最小高度（46 px）。这些局部配色由所属业务面板决定，不能替换全站按钮默认值。

### Inputs / Fields

输入框、选择框和文本域使用白底、明确边界、字段圆角、最小高度（42 px），内边距由 `field` 定义。占位文字使用 `muted`，字号（13 px），不替代可见标签。表单错误、加载与来源未就绪都有真实文字反馈，保留已填写内容。

### Navigation / Account

主导航保持“首页 / 市场 / CLI / 操作手册”。选中项为蓝色文字与底部短线；（760 px）及以下改为菜单按钮与抽屉，账号图标始终可见。主要内容在抽屉打开时设为 inert。

账号开关最小点击高度（44 px），下拉宽度（252 px），菜单项最小高度（44 px）。下拉包含个人中心、历史与退出等按会话和角色显示的操作；支持外部点击关闭、Escape 关闭与焦点恢复。访客菜单提供登录个人中心。个人数据不进入公共主导航。

### Chips / Filters

市场协议与分类使用轻底色的选中态，不依赖浓重描边。数量保持次级显示；窄屏允许控件紧凑排布，不能靠裁切隐藏可选项。状态标签将颜色与文字同时呈现。

### Cards / Containers

能力卡片使用白底、细边界和表面圆角，常规内边距（23 px）；标题、简要说明与页尾动作形成稳定顺序。悬停提高边界可见度，焦点轮廓独立于边界。说明和实际输入输出保持可阅读，接入细节进入详情区。

### Visitor Quota / Results

访客额度在查询页顶部以浅绿提示区展示，数字使用等宽数字；手机解释文字另起一行。显示真实剩余次数、共享范围与重置规则，额度不足时保留输入并提供明确下一步。关税与税费共用每日 20 次的业务边界、尾程及个人功能的登录要求详见 [PRODUCT.md](PRODUCT.md)，不由视觉状态替代权限检查。

API Key 明文确认保存后清空，同页显示实际只读验证结果；截图不含完整 Key。业务状态沿用来源结果，不通过视觉样例合成成功。

## Do's and Don'ts

### Do:

- **Do** 延续浅色画布、蓝色主操作与真实业务状态的颜色分工。
- **Do** 用间距、字重和清晰边界组织信息，辅助文字保持可阅读。
- **Do** 保留可见标签、键盘焦点、菜单关闭与焦点恢复行为。
- **Do** 将表格、目录和代码的横向滚动限制在局部容器。
- **Do** 在桌面与手机保留任务顺序，并让账号入口始终可达。

### Don't:

- **Don't** 将首页双入口的当前编排升级为所有页面必须遵守的布局。
- **Don't** 复制第三方品牌、未实现产品，或用样例结果代替真实来源状态。
- **Don't** 把权限实现术语变成普通用户必须完成的操作步骤。
- **Don't** 将完整凭证放入截图，或用颜色单独表达成功、警告与失败。
- **Don't** 将遗留的小号大写眉题、装饰字形图标或系统展示字体继承确认为未来界面的设计规则。
