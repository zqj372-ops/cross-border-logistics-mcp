---
version: 2
slug: "native-business"
primary_target: "apps/console/native-admin.js"
related_targets: ["apps/console/native-rate-editor.js", "apps/console/workspace-home.js", "apps/console/business.js", "apps/console/styles.css", "apps/console/native-business.md"]
---

# FreightClaw / Native business administration and private quote

Scope: a narrow Operate extension of the established Console. The confirmed world and shared tokens remain in `apps/console/DESIGN.md`; this brief does not replace that document, its sidecar, or `PRODUCT.md`. The dedicated documenter role was unavailable, so this pass uses the Impeccable degraded documenter instructions within the assigned surface boundary. No global token sidecar is regenerated because the global design system is unchanged.

Evidence: current `native-admin.js`, `native-rate-editor.js`, `workspace-home.js`, and the native styles at the end of `styles.css`; the incumbent product/design documents; `docs/product/2026-09-07-business-admin-pages.md`; `docs/rfcs/2026-09-07-fixed-residential-admin-migration.md`; and existing isolated local review assets. Previously documented private-result behavior remains grounded in `business.js`. Record the built local workflow, not official source validity, working production credentials, or production readiness. Synthetic names, prices, dates, and organizations are examples only.

## Overview

**The Same Workbench Rule.** Extend the existing header, account entry, organization context, internal navigation, open-source typography, and Lucide line icons. Business administration belongs to the user's current organization and does not introduce a separate visual identity.

The task is business-specific maintenance: overview → focused editor → saved draft → readable source/price review → explicit publication, with the same configuration used by the local CLI. Business management now opens a status overview with three entries: “关务管理”, “私人地址运价”, and “外部连接”. Each entry shows its actual configuration state and a direct editing action. The private-address business uses one fixed configuration per organization, without a channel selector or channel-creation step. Legacy channel deep links remain a compatibility boundary and do not participate in this rating flow.

For customs and own rates, a compact publication strip stays above the focused content: unconfigured, saved draft but unpublished, published version, future-effective rates, or expired rates. A local tab row selects the maintenance task. “核验与发布” is its own page, with preview/confirmation followed by release history. Freightcom separately reports saved-credential presence, latest configuration update, and live-query verification status.

| Surface | Built responsibility |
| --- | --- |
| Business overview | Real state and entry to customs, fixed private rates, and external connections. |
| Private rates: basic information | Fixed origin, source reference, validity, and delivery conditions. |
| Private rates: postal coverage | Postal/city/province and zone filters, labeled rows, add/delete, pagination, import/export. |
| Private rates: price and billing | Zone × pallet-count matrix, zone enablement and fuel override; expandable row and threshold maintenance. |
| Private rates: accessorials | Explicit residential, liftgate, pallet-jack, appointment, fuel, and waiting fees. |
| Private rates: review and publish | Readable prices, charges, limits, exceptions, confirmation, disable, and historical rollback. |
| Customs | Separate nomenclature, tariff, measure, requirement, and source search; separate import and publication pages. |
| External connections | Organization-scoped Freightcom credentials and a real-query entry point. |
| Workbench | Personal inquiry progress, continuation, and business shortcuts; service discovery stays in the market. |

## Colors

Inherit white surfaces, near-black text and primary actions, muted gray supporting text, and fine neutral borders. Blue identifies the current internal tab, links, focus, and the selected quote-source boundary. The source choice's pale-blue selection belongs to this control; it is not a new global palette. Status colors always accompany status text.

**The Explicit State Rule.** “尚未发布”, “已发布”, “当前发布”, blockers, and credential-presence wording communicate different facts. A successful save, selected blue tab, or green local query status cannot establish formal data or carrier readiness.

## Typography

Inherit Manrope / Noto Sans SC for the workbench and JetBrains Mono / Noto Sans SC for full configuration details and commands. Task titles follow the incumbent desktop-to-mobile hierarchy of 36px, 30px, and 28px. Standard field values and controls remain 16px, field labels 15px, and field help 14px. Confirmation and release-history headings use the existing 22px treatment; guide headings use 20px and subheads 17px. The native full-configuration disclosure uses 14px text.

Use headings and labeled facts to separate meaning. Long source URLs, identifiers, conditions, and complete configuration values wrap inside their own containers. None of this surface establishes a new display face or decorative heading tier.

## Layout

Focused rate and customs pages use the available operational content width, with task navigation and state above the editor. The external-connection page retains the flexible main column plus 300px companion guide and 40px gap; at 900px it stacks with the guide below. Shared field grids collapse with the incumbent mobile behavior; editable postal/price rows become two columns at 900px. Confirmation facts and the fee/rule list become one column at 540px. Business-overview rows align icon, explanation/state, and entry action; on mobile the action sits under the explanation.

The desktop publication strip wraps its state and description, using 16px by 20px padding with 24px below. At 540px and below it tightens to 12px padding and 12px separation. The mobile return action sits above the title, the redundant page subtitle is hidden, and local tabs stay on one horizontally scrollable row with 44px targets. These compact changes preserve the organization and actual state while bringing the matrix and its main editing controls into the first viewport. Do not restore several rows of local navigation above the work. Opening a publication preview scrolls confirmation into view; history follows it.

**The Local Matrix Rule.** Large prices remain a table inside a focusable local scroll region, never a document-wide overflow. Render at most 20 zones × 20 pallet columns in each group, with separate previous/next controls for each axis. Table headings stay visible at the top of that region. Its maximum height is 480px, reducing to 420px on mobile. Maintain numeric alignment, intact row/column labels, and readable input widths; mobile narrows numeric fields to 100px rather than shrinking text.

Private quote places the source selector before the inputs and results. Desktop uses the existing two-column business layout; at 900px and below, inputs and then results follow in one column. Source, publication version, and validity sit inside the own-rate amount summary, before the detailed fee breakdown. The full configuration disclosure scrolls locally at a maximum height of 420px rather than expanding into an unbounded code block.

## Elevation & Depth

The extension uses flat white panels, quiet borders, and normal document flow. The companion guide is separated by a line; confirmation is an inline panel rather than an overlay. No new shadows or animation system is introduced.

## Shapes

Inherit gently rounded fields, buttons, and panels, including the 12px publication-strip corners. Source-choice controls keep their built 10px corners and full-width shape. Local maintenance tabs use text and a 2px current-state underline; overview entries use the incumbent line icons. Matrix containers and numeric fields use 8px corners. Numeric inputs, zone-enable labels, and disclosure summaries have a 44px minimum target height. Interactive elements keep the customer shell's visible blue focus outline with its existing width and offset. Native details/summary disclosure markers remain visible; do not suppress the marker or replace it with a decorative text glyph.

## Components

### Empty, loading, and denied states

New configuration stays empty. Customs distinguishes no published data, no saved draft, and no matching search results. Its separate import page starts with an unpopulated data-package picker. Own rates begin with blank business fields, empty coverage/prices, and no publication history. An empty matrix opens the row editor to make the first price actionable. Loading uses text; failed or denied reads show explanatory wording with a retry action. These states must not be rendered as successfully loaded business data.

### Draft and source review

Customs accepts a labeled normalized JSON upload, limited to 16 MiB, with a guide link. Validation errors identify the collection, row, and field. Separate search pages offer published/saved-draft selection, country, keyword, and pagination; the result context names the selected version and matching count. A result presents its code/name, rule description, dates, and source authority before an expandable full record. Search is read-only and cannot promote a draft to a current release.

Own rates separate basic information, postal coverage, price/billing, accessorials, and publication into pages for the same complete configuration. Tab switching retains unsaved edits in the current browser session. “保存全部草稿” states the real save scope, shows dirty/clean status, and explains that the first save requires all pages to be complete. Refreshing or leaving the browser is not a persistence mechanism. Field labels retain quantities and units; blank fees and matrix cells do not imply zero.

### Matrix and spreadsheet maintenance

Daily price edits occur directly in a zone × pallet matrix. An accessible name identifies each numeric field's zone and pallet count. Clearing a cell removes that price; an explicit zero is a configured free price. The zone checkbox means “允许自动报价”: disabling preserves prices but makes published queries require manual review. Blank zone fuel override explicitly inherits the same publication's global fuel percentage; a numeric override belongs to that same configuration. Low-frequency row creation/deletion and billing thresholds stay in native disclosure sections with visible markers.

Postal rows retain individual labels and add/delete/pagination actions, filtered by zone and postal/city/province text. The matrix supports zone filtering. Empty templates and current-editor draft exports remain available beside these controls; exported draft wording must not imply a published rate.

**The Preview Before Merge Rule.** CSV/XLSX/XLS import is an explicit preview before any merge. Show the file/workbook-sheet identity, recognized rows, validation errors, and added/replaced counts. A readable table previews up to 100 records and states the limit when exceeded. Errors prevent confirmation. “确认合并到草稿” changes only the editor; later save, review, and publication stay separate. Matching zone/pallet or postal keys overwrite only those entries and retain unrelated ones. Preserve the documented 5 MiB, 5000-row, and 100-column bounds, formula rejection, and fixed-origin check; do not guess aliases or merge another origin.

The migration source is the frozen original quote-admin commit documented in the delivery note/RFC. The matrix, table recognition, and maintenance tasks are adapted to this Console and shared web/CLI conversion logic; original React styling, channel management, old rates/accounts/credentials, and AI/mail/WeChat configuration are not copied. The current source documents 43 workspace commands, including browse, import-preview, and export; that is a local build inventory, not proof that every legacy or production function has CLI parity. CLI import preview returns reviewable save input for the existing save/preview/publish flow, and export identifies the selected draft or publication.

**The Review Before Publication Rule.** Saving a draft is distinct from previewing and explicitly confirming publication. Show returned summary facts, blockers, readable actual price rows, every fee/billing value with its label/unit, and zone exceptions before confirmation. Postal rows and full JSON are secondary disclosures; JSON must not be the only usable price review. The readable table shows up to 100 records with an explicit truncation notice and retains the full configuration disclosure. Keep the reminder that format checks cannot replace business source review. Confirmation is present only when the returned preview permits publication, or when confirming disable. Unsaved own-rate edits block preview and state-changing actions until saved.

### Published versions and rollback

History lists the label, publication time, and version; identifies the active entry as “当前发布”; and offers “预览回退” for other entries. Rollback presents the selected returned configuration under “确认回退”, with explicit confirm and cancel controls. Disable confirmation explains that new queries become unavailable while history remains. The current-publication strip remains separate from the draft and preview so editing alone does not imply that the active release changed.

The frontend includes current version information in mutations and uses preview evidence for publication/rollback. After a successful mutation it clears local state and reloads configuration. Identity/organization context keys and superseded-read guards prevent an earlier configuration read from replacing the current organization's view. Visual completion alone is not server or business readiness evidence.

### Freightcom connection

Show a connection name, a password input, and explicit confirmation that it is for the current organization. Saved credential presence uses wording that a real query has not yet verified the connection. The credential is never returned as a populated input; successful save clears the form. The guide links to private-address quote and explains its organization scope and carrier-returned rates.

Disabling a connection now presents inline confirmation and cancellation. Keep credential state, configuration update time, and real-quote verification separate. The action to fill an actual inquiry does not itself verify the carrier account.

### Personal workbench

The workbench uses fetched personal case records, not market introduction cards. Show recent inquiry product, route, updated time, and actual status with links to the same case; provide refresh and all-personal-inquiries actions. Loading, read failure, no organization, and no submitted inquiries have distinct text. Common business shortcuts remain visible, while owner/admin users receive business-management and organization-inquiry handling entries. Context-generation guards prevent a prior user's response replacing the current view.

### Private quote and provenance

Two full-width buttons select own-rate calculation or Freightcom quotation, using actual button semantics and `aria-pressed`. Each selection has a visible label and short explanation. They remain independent sources, without a blended total or automatic repricing.

Private-address input requires deliberate unload and appointment choices; own rates also require a deliberate pallet-jack choice. Freightcom's residential destination is visibly selected and fixed for this entry. Labels retain units and the result retains the returned currency. Missing publication, expired rates, uncovered postcodes, or unavailable tiers produce explanatory text rather than invented prices.

**The Source Beside Amount Rule.** An own-rate result keeps the source reference, published version, and validity next to the amount, visible without opening the calculation disclosure. Missing evidence is labeled for review. Fee details and business conditions remain below the summary. The result explicitly says it is a rule calculation that has not been saved or sent as a formal quotation. Native results do not expose the older source-system save workflow.

## Do's and Don'ts

- **Do** preserve current-organization context, the three business-overview entries, task-specific local tabs, and compact actual publication state before editing.
- **Do** keep fixed private-address maintenance independent of the legacy channel compatibility path.
- **Do** keep matrix overflow local, disclosure markers visible, import merges explicit, and prices readable before confirmation.
- **Do** keep draft, complete preview, explicit confirmation, release history, and rollback distinguishable.
- **Do** retain visible labels, units, explicit residential-service choices, text status, mobile field order, and keyboard focus.
- **Do** keep source, version, and validity adjacent to the own-rate amount.
- **Don't** turn synthetic amounts, source references, package contents, or credentials into defaults or design assets.
- **Don't** turn saved credentials or local publish/query success into an official-source or production-readiness claim.
- **Don't** promote this form composition, inherited craft-floor defects, or one-off selection values into global system requirements.

QA evidence: the current root `.impeccable/review/native-business-pages/` contains 20 existing screenshots of the overview, rates basic/coverage/matrix/import/publication, customs catalog/publication, carrier connection, private result, and workbench. This update sampled `rates-matrix-desktop.png`, `rates-matrix-mobile.png`, and `rates-preview-desktop.png` against source. The existing `qa.json` records 11 checks with `errors: []`, scoped to isolated synthetic local acceptance without official rates or credentials. Coverage includes spreadsheet preview and explicit merge, matrix edits and preserved fee fields, web/CLI calculation, retained delivery conditions, draft isolation and publish/disable/rollback, selected-publication CLI export, blocked test-marked customs publication, full customs contract/history, shared draft/published catalog filters, carrier empty state, private Freightcom request conditions without external calls, and user isolation. Screenshot viewports are documented as 1440 × 1000 and 390 × 844; full-page heights vary. Earlier `.impeccable/review/native-business/` assets remain historical evidence. This pass did not rerun acceptance, capture screenshots, or run a detector.

Finish boundary: the parent handoff reports an independent full review and scoring with final disposition “ship”, after fixes to mobile first-viewport height, readable price review, and disclosure markers. The same handoff reports one detector run with 354 advisory findings and zero hard findings; this documenter did not repeat it. This is a scoped local visual-review disposition, not certification of the entire platform, official datasets, live carrier connection, original-admin production parity, or production deployment. The delivery note records no production rollout or formal rate/customs/credential import; normalized customs JSON does not imply arbitrary official PDF/HTML ingestion, and quotation PDF, mail booking, and OCR/SO workflows remain outside this surface delivery.

Not canonized: synthetic business values, source/credential readiness claims inferred from local success, and any inherited craft-floor defects are not reusable design rules; the existing visual world remains authoritative.
