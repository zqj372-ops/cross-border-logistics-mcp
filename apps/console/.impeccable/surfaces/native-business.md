---
version: 1
slug: "native-business"
primary_target: "apps/console/native-admin.js"
related_targets: ["apps/console/business.js", "apps/console/styles.css", "apps/console/native-business.md"]
---

# FreightClaw / Native business administration and private quote

Scope: a narrow Operate extension of the established Console. The confirmed world and shared tokens remain in `apps/console/DESIGN.md`; this brief does not replace that document, its sidecar, or `PRODUCT.md`. The dedicated documenter role was unavailable, so this pass uses the Impeccable degraded documenter instructions within the assigned surface boundary. No global token sidecar is regenerated because the global design system is unchanged.

Evidence: current `native-admin.js`, `business.js`, and `styles.css`; the incumbent product/design documents; and existing isolated local review assets. Record the built local workflow, not official source validity, working production credentials, or production readiness. Synthetic names, prices, dates, and organizations are examples only.

## Overview

**The Same Workbench Rule.** Extend the existing header, account entry, organization context, internal navigation, open-source typography, and Lucide line icons. Business administration belongs to the user's current organization and does not introduce a separate visual identity.

The task is to make draft → source review and preview → explicit publication understandable from the existing web workbench, with the same published configuration used by the local CLI. The page identifies the organization and selected business configuration before presenting editable fields. Its three configuration tabs are “关务数据”, “私人地址运价”, and “Freightcom 连接”. A header action retains access to “渠道与仓库”.

For customs and own rates, a compact publication strip appears above the form: either the current published version and label, or “尚未发布” with an explanation that querying is unavailable. The form, inline confirmation, and release history remain in that order. Freightcom shows credential-presence wording inside the connection form; it does not present saved credentials as a verified live connection.

## Colors

Inherit white surfaces, near-black text and primary actions, muted gray supporting text, and fine neutral borders. Blue identifies the current internal tab, links, focus, and the selected quote-source boundary. The source choice's pale-blue selection belongs to this control; it is not a new global palette. Status colors always accompany status text.

**The Explicit State Rule.** “尚未发布”, “已发布”, “当前发布”, blockers, and credential-presence wording communicate different facts. A successful save, selected blue tab, or green local query status cannot establish formal data or carrier readiness.

## Typography

Inherit Manrope / Noto Sans SC for the workbench and JetBrains Mono / Noto Sans SC for full configuration details and commands. Task titles follow the incumbent desktop-to-mobile hierarchy of 36px, 30px, and 28px. Standard field values and controls remain 16px, field labels 15px, and field help 14px. Confirmation and release-history headings use the existing 22px treatment; guide headings use 20px and subheads 17px. The native full-configuration disclosure uses 14px text.

Use headings and labeled facts to separate meaning. Long source URLs, identifiers, conditions, and complete configuration values wrap inside their own containers. None of this surface establishes a new display face or decorative heading tier.

## Layout

Administration reuses the flexible main column plus a 300px companion guide, separated by a 40px gap and the guide's fine left border. At 900px and below it becomes one column, placing the guide after the main content with a top separator. The native form uses the shared two-column field grid and its existing mobile collapse; it does not acquire the separate channel form's 48px control override. Confirmation facts use two columns and become one at 540px.

The publication strip wraps its state and description, uses 16px by 20px padding, and leaves 24px before the workspace. Configuration tabs wrap instead of clipping labels. The inline preview follows the saved draft, and opening a preview scrolls the confirmation into view. History follows confirmation. Action rows wrap, and the inherited narrow-screen action treatment shares available width.

Private quote places the source selector before the inputs and results. Desktop uses the existing two-column business layout; at 900px and below, inputs and then results follow in one column. Source, publication version, and validity sit inside the own-rate amount summary, before the detailed fee breakdown. The full configuration disclosure scrolls locally at a maximum height of 420px rather than expanding into an unbounded code block.

## Elevation & Depth

The extension uses flat white panels, quiet borders, and normal document flow. The companion guide is separated by a line; confirmation is an inline panel rather than an overlay. No new shadows or animation system is introduced.

## Shapes

Inherit gently rounded fields, buttons, and panels, including the 12px publication-strip corners. Source-choice controls use their built 10px corners and full-width rectangular shape. Tabs pair a 20px line icon with a text label and a 2px current-state underline. Interactive elements keep the customer shell's visible blue focus outline with its existing width and offset.

## Components

### Empty, loading, and denied states

New configuration stays empty. Customs begins with an unpopulated data-package picker and “尚无数据批次”; own rates begin with blank business fields and no publication history. Loading uses a textual status region. Failed or denied reads show explanatory error wording with “重新加载”. These states must not be rendered as successfully loaded empty business data.

### Draft and source review

Customs accepts a labeled JSON upload with its size limit and a link to the import guide. Saved customs facts show batch, review date, counts, and each returned source's authority, dataset, edition, revision, effective dates, and official URL.

Own rates group name/origin/validity/source/terms, postal coverage and rate rows, billing and cargo limits, and accessorial charges. Field labels retain quantities and units. The visible guidance distinguishes explicit zero fees from missing fees and says that unconfigured price tiers are not extrapolated.

**The Review Before Publication Rule.** Saving a draft is distinct from previewing and explicitly confirming publication. Show returned summary facts, blockers, and the expandable complete configuration before confirmation; retain the reminder that format checks do not replace business source review. The confirmation action is present only when the returned preview permits publication, or when confirming a disable action. Unsaved own-rate edits block preview and state-changing actions until saved.

### Published versions and rollback

History lists the label, publication time, and version; identifies the active entry as “当前发布”; and offers “预览回退” for other entries. Rollback presents the selected returned configuration under “确认回退”, with explicit confirm and cancel controls. Disable confirmation explains that new queries become unavailable while history remains. The current-publication strip remains separate from the draft and preview so editing alone does not imply that the active release changed.

The frontend includes current version information in mutations and uses preview evidence for publication/rollback. After a successful mutation it clears local state and reloads configuration. Identity/organization context keys and superseded-read guards prevent an earlier configuration read from replacing the current organization's view. Visual completion alone is not server or business readiness evidence.

### Freightcom connection

Show a connection name, a password input, and explicit confirmation that it is for the current organization. Saved credential presence uses wording that a real query has not yet verified the connection. The credential is never returned as a populated input; successful save clears the form. The guide links to private-address quote and explains its organization scope and carrier-returned rates.

### Private quote and provenance

Two full-width buttons select own-rate calculation or Freightcom quotation, using actual button semantics and `aria-pressed`. Each selection has a visible label and short explanation. They remain independent sources, without a blended total or automatic repricing.

Private-address input requires deliberate unload and appointment choices; own rates also require a deliberate pallet-jack choice. Freightcom's residential destination is visibly selected and fixed for this entry. Labels retain units and the result retains the returned currency. Missing publication, expired rates, uncovered postcodes, or unavailable tiers produce explanatory text rather than invented prices.

**The Source Beside Amount Rule.** An own-rate result keeps the source reference, published version, and validity next to the amount, visible without opening the calculation disclosure. Missing evidence is labeled for review. Fee details and business conditions remain below the summary. The result explicitly says it is a rule calculation that has not been saved or sent as a formal quotation. Native results do not expose the older source-system save workflow.

## Do's and Don'ts

- **Do** preserve current-organization context, the three configuration tabs, and compact publication state before editable customs/rate fields.
- **Do** keep draft, complete preview, explicit confirmation, release history, and rollback distinguishable.
- **Do** retain visible labels, units, explicit residential-service choices, text status, mobile field order, and keyboard focus.
- **Do** keep source, version, and validity adjacent to the own-rate amount.
- **Don't** turn synthetic amounts, source references, package contents, or credentials into defaults or design assets.
- **Don't** turn saved credentials or local publish/query success into an official-source or production-readiness claim.
- **Don't** promote this form composition, inherited craft-floor defects, or one-off selection values into global system requirements.

QA evidence: root `.impeccable/review/native-business/` contains nine existing captures: `rates-empty-desktop.png`, `rates-preview-desktop.png`, `rates-preview-mobile.png`, `customs-preview-desktop.png`, `customs-preview-mobile.png`, `freightcom-empty-desktop.png`, `freightcom-empty-mobile.png`, `private-result-desktop.png`, and `private-result-mobile.png`. This pass sampled rates-empty desktop, rates-preview mobile, and private-result desktop against current source. The existing `qa.json` records eight checks with `errors: []`, scoped to isolated synthetic local acceptance without official rates or credentials. Its checks cover web/CLI rate use, retained private delivery conditions, draft isolation and publication/disable/rollback, blocked test-marked customs publication, customs contract and personal history, carrier empty state and guide, explicit private Freightcom request conditions without external calls, and unauthorized-user isolation. This pass did not rerun acceptance, capture screenshots, or run a detector.

Finish boundary: the parent review handoff reports all four reviewer fixes resolved with disposition “ship” for those fixes. This is the scoped local visual-review disposition, not certification of the platform, official datasets, live carrier connection, or production deployment.

Not canonized: synthetic business values, source/credential readiness claims inferred from local success, and any inherited craft-floor defects are not reusable design rules; the existing visual world remains authoritative.
