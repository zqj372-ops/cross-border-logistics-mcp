---
name: FreightClaw 询价
description: 清晰、克制的物流询价表单视觉规范
colors:
  primary: "#3659db"
  primary-hover: "#2949c3"
  primary-active: "#213da6"
  selected-text: "#2749c2"
  selected-bg: "#f4f6ff"
  canvas: "#f8f9fc"
  surface: "#fff"
  text: "#19263b"
  muted: "#626d80"
  line: "#dfe4ee"
  input-line: "#bcc6d6"
  secondary-text: "#35415a"
  secondary-line: "#cbd3e1"
  neutral-hover: "#f3f5f9"
  error: "#af2835"
  error-summary: "#a92331"
  error-line: "#ba3847"
  error-bg: "#fff3f3"
  advisory: "#86561c"
typography:
  body:
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    lineHeight: 1.6
  headline:
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-.6px"
  title:
    fontSize: "21px"
    lineHeight: 1.4
    letterSpacing: "-.2px"
  label:
    fontSize: "13px"
    fontWeight: 600
  helper:
    fontSize: "12px"
rounded:
  field: "6px"
  button: "7px"
  option: "8px"
  panel: "10px"
spacing:
  compact: "8px"
  option-gap: "10px"
  small: "12px"
  medium: "16px"
  field-gap: "18px"
  section: "20px"
  panel: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.button}"
    padding: "10px 19px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary-text}"
    rounded: "{rounded.button}"
    padding: "10px 19px"
  button-text:
    textColor: "{colors.primary}"
    padding: "7px 0"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "10px 12px"
  service-choice:
    rounded: "{rounded.option}"
    padding: "12px"
  service-choice-selected:
    backgroundColor: "{colors.selected-bg}"
  summary:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    padding: "24px"
---

# Design System: FreightClaw 询价

## Overview

**Creative North Star: "清晰的物流询价单"**

延续 FreightClaw 的蓝色、系统字体栈与白色表单，以浅灰画布、细边界和明确字级组织信息。界面保持紧凑、平实，让填写者看清当前操作、已选内容和下一步。

本规范提取当前询价页面的实际样式和已确认交互。具体服务条件与业务字段仍以页面实现和 BRIEF.md 为准；视觉文档不构成生产可用性或报价能力的证明。

**Key Characteristics:**

- 单一蓝色强调操作与选中状态；正文与辅助文字保持明确层次。
- 白色工作区承载原生表单；大屏并列摘要，小屏按任务顺序收拢。
- 反馈给出可读文字，错误、待确认与未发送状态不只依赖颜色。

## Colors

品牌蓝是唯一操作强调色；灰色承担内容层次与结构，红色和棕色仅用于已有反馈。

- **Primary：** `primary` 用于主按钮、链接、当前步骤和输入强调；按钮悬停与按下分别使用 `primary-hover`、`primary-active`。`selected-text` 与 `selected-bg` 共同标记已选服务或运输方式。
- **Neutral：** `canvas` 承载页面，`surface` 承载表单与摘要；`text` 为正文，`muted` 为说明、占位提示与次要元信息。`line` 分隔区域，`input-line` 让输入边界清楚可辨。
- **反馈：** `error` 为字段错误；`error-summary`、`error-bg` 和 `error-line` 共同构成错误汇总。`advisory` 用于邮件过长等操作提示。

辅助文字与占位文字共用已加深的 `muted`；保留源值，不降低文字透明度来营造层次。颜色值集中在 frontmatter；本次提取未重新执行对比度或浏览器测试。

**The Action Color Rule.** 蓝色用于链接、主要操作、当前步骤、选中项和键盘焦点；不增加与任务无关的装饰色。

## Typography

全页面沿用 frontmatter 的字体栈；输入与按钮继承字体。系统中有 Inter 时优先使用，后续为系统及中文无衬线字体，不依赖新增外部字体资源。

- 页面标题采用 `headline`；手机标题缩至（25px），字距（-.5px）。
- 区段标题采用 `title`；手机缩至（19px）。摘要标题为（16px、600），小屏为（14px）。
- 正文采用 `body`；字段标签为 `label`，说明文字为 `helper`。服务名称为（15px、600），手机为（14px）。
- 手机常规输入文字升至（16px）；柜型等数量选择框保留实现中的紧凑字号。邮件预览继承正文家族并换行，不用等宽字体制造技术界面。

## Layout

页面最大宽度（1120px），内容从标题、三步进度进入表单。大屏主区域采用左表单（最大 746px）、右摘要（至少 260px），间隔（28px）；右摘要距顶部（24px）粘附。表单正文与底部操作区连成一个白色工作区。

- 宽度不超过（1180px）时，页面左右留（24px），右摘要固定为（280px），栏间距（24px）。
- 宽度不超过（959px）时，整体改为单列，页面最大宽度（720px）、左右内边距（24px）。摘要移至正文之后、操作区之前，用原生折叠摘要呈现；操作区粘附视口底部。
- 服务选项在桌面及（729px）窗口均为两列，末项跨两列。只在宽度不超过（540px）时改为单列；手机页面左右留（16px），选项最小高度由（68px）提高到（72px）。
- 常规双列字段在手机变成单列；数量相关字段仍保留两列，避免数值与单位失去对应。核对信息使用紧凑双列定义列表。
- 手机收起页头第一个次要导航与路线辅助标签；保留品牌及核心操作。长地址、备注和邮件内容允许换行，邮件预览具有内部滚动上限。

## Elevation & Depth

界面主要以白色表面、浅色画布及细边界区分区域。普通表单与摘要没有外投影；服务选中使用蓝色内描边。小屏底部操作区仅使用向上的轻阴影（`0 -8px 12px -12px #24344b55`）提示其粘附层级。

所有可交互元素的键盘焦点使用品牌蓝轮廓（3px），向外偏移（3px）。只有在用户未要求减少动态效果时，按钮、链接和选择项才对背景与边框执行（150ms）过渡，不附加位移动画。

## Shapes

主工作区及摘要使用 `panel` 圆角；服务选项用 `option`，按钮用 `button`，文本输入和运输方式选项用 `field`。结构边框为（1px）；表单正文去掉底边框，操作区去掉顶边框，使两段视觉连续。小屏嵌入的摘要不再单独带圆角。

步骤序号保留小圆形。服务图标放在方形圆角底板内，沿用页面已有内联 SVG；不引入图片、图标字体或新的视觉素材。

## Components

- **步骤导航：** 三步按钮与编号共同说明当前位置。当前步骤以蓝色编号底与加深文字区分；连接线仅表达顺序。回到先前步骤仍须维持已有表单状态。
- **服务选择：** 五项服务使用整行可点击的原生复选框标签，图标、名称、说明和复选框保持固定顺序。服务独立多选，初始无预选。悬停轻微改变背景与边框；选中同时改变复选框、外边界、内描边和图标底色。
- **输入与动态字段：** 文本、日期、选择框、单选框及复选框使用原生控件。常规输入最小高度（44px），多行输入至少（92px）并可纵向调整。整柜显示柜型与柜数，拼箱显示体积与毛重；未知数量可标记“待确认”。仅选择中国提货或订舱时要求中国起运地；仓储与派送资料按所选服务出现。
- **错误反馈：** 字段下方显示具体错误；错误汇总使用淡红背景和左侧强调线。错误字段保留 `aria-invalid` 边界状态，不能用边框颜色代替解释文字。
- **摘要：** 桌面右侧显示已选服务、路线和报价待确认信息；小屏通过原生 `details`／`summary` 折叠，使用加号与减号表明展开状态。摘要是当前草稿的回顾，不代表价格已经取得。
- **按钮：** 主操作为蓝底白字，次操作为白底灰边框，修改等轻操作使用蓝色文本按钮。常规按钮最小高度（44px），文本按钮最小高度（34px）；手机通过内边距和字号适配空间。
- **核对与邮件结果：** 三步后生成邮件预览，提供复制与可选邮件应用入口，明确“尚未发送”。复制受限时保留手动复制区域，长邮件提示使用操作提示色。草稿只在内存中；企业 `#business` 使用独立草稿。原 84 项费用目录入口保留并在新标签页打开。

**The Native Field Rule.** 保留原生复选框、单选框、选择框、日期与文本输入的行为；标签、可选提示和错误信息要与对应字段一起出现。

## Do's and Don'ts

### Do:

- Do 保持服务可独立多选且初始无预选，选中状态同时呈现原生复选框与蓝色边界。
- Do 保留桌面与 729 像素窗口的两列服务；手机改为单列。
- Do 根据所选服务和运输方式显示必要字段，对未知数量保留“待确认”。
- Do 明确区分邮件已生成和尚未发送；复制、手动复制及可选邮件应用入口均属于用户后续操作。
- Do 对键盘焦点、错误字段和长地址保持可读与可定位。

### Don't:

- Don't 把蓝色品牌表单扩展成大幅宣传区、渐变背景或装饰卡片。
- Don't 用自绘控件替换现有原生输入行为，或隐藏错误文字只留下红框。
- Don't 将侧栏摘要当作已获得价格、正式报价或已经发送的证明。
- Don't 把独立企业草稿、客户询价草稿和原费用目录混成同一个流程。
