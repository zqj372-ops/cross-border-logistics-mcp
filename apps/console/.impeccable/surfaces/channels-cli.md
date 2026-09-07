---
version: 1
slug: "channels-cli"
primary_target: "apps/console/channels.js"
related_targets: ["apps/console/styles.css", "apps/console/app.js", "apps/console/cli-guide.js", "apps/console/workspace-cli.md"]
---

# FreightClaw / Channels and workspace CLI

Scope: a narrow Operate-mode extension of the existing Console. Preserve `apps/console/DESIGN.md`, `.impeccable/design.json`, and `PRODUCT.md`. This brief records the built channel management and CLI connection surfaces; it introduces no new visual world or composition workshop. The dedicated documenter role was unavailable; this pass follows the Impeccable degraded documenter instructions in the assigned narrow scope.

Purpose: let authorized staff build channel metadata from an empty configuration, save drafts, inspect a publication preview, confirm publication, inspect history, preview a historical rollback, and disable a current release. The CLI connection surface lets a signed-in person authorize their own terminal session. The CLI guide distinguishes current public downloads from development-only workspace commands.

Authority: evidence is an isolated local synthetic fixture. Channel metadata remains `ready_for_quotes:false`; a published channel contains no prices, postal zones, surcharges, or rating rules. The configuration-order guide describes later work, not currently available quote capability. Personnel CLI device authorization is local-only. The public v0.1.0 download does not contain `workspace` commands. Existing member management, permissions, personal history, and other webpage functions do not yet have complete CLI coverage; the user's all-functions-through-CLI direction remains a delivery requirement, not a completed claim.

## Overview

**The Same Workbench Rule.** Channel administration extends the public Console header, account menu, organization context, tabs, typography, controls, and Lucide SVG vocabulary. The visible “业务管理” entry leads to “渠道与仓库”; it does not introduce another admin shell. Navigation visibility reflects existing role checks, while actual access remains governed by the shared API.

The first view pairs a large operational content area with a compact explanatory rail. The empty state invites creation of the first channel and explicitly says old configuration is not automatically imported. In subsequent views, the form stays primary, the confirmation follows it, and release history follows confirmation. The rail explains current publication state and entry requirements.

## Colors

Inherit the existing white surface, near-black ink and primary actions, muted gray description text, fine neutral borders, and soft gray empty-state background. Blue belongs to the existing links, selected internal navigation, focus treatment, and empty-state truck icon. The pale-blue local-environment notice distinguishes fixture output. No new palette tokens are established here.

**The Explicit State Rule.** Use words such as “草稿”, “已发布渠道信息”, “当前发布”, and “尚未发布” to convey state. Publication wording must remain specific to channel information; color and successful UI actions do not establish quote readiness.

## Typography

Inherit self-hosted Manrope / Noto Sans SC for headings, body text, labels, and controls; use JetBrains Mono for commands and the CLI confirmation code. Task titles follow the existing 36px desktop, 30px intermediate, and 28px small-screen hierarchy. Channel form, confirmation, and history headings use 22px; list titles use 21px; the guide heading uses 20px and guide subheads 17px. Body and field values stay 16px, field labels 15px, and metadata 14px.

The empty-state heading is 26px, reducing to 22px at 540px. The CLI authorization body is 17px with 1.75 line height; its eight-character code is 36px with .08em tracking. This code treatment supports human comparison and is not a general display-heading token. Do not reproduce captured confirmation codes as reusable content.

## Layout

The channel workspace uses a flexible main column and a 300px right rail with a 40px gap. The rail has a fine left divider and 28px left padding. At 900px and below, the rail moves below the main content, the gap becomes 28px, and the divider moves to its top. Its ordered guide briefly forms a horizontal row, returning to a vertical list at 540px.

The form uses a two-column field grid with 24px gaps. At 540px and below it becomes one column, preserving field order and removing the empty alignment cell. Confirmation details use two equal columns with 20px row and 24px column gaps; at 540px they become a single column with 18px gaps. Each value can wrap, including long identifiers.

Actions use a wrapping row with 12px gaps and 28px top separation; channel action buttons share available mobile width. Release rows wrap on small screens. Mobile lists hide the decorative truck container, retain channel content and state, and allow rows to wrap. Use normal vertical document scrolling; the existing context navigation and code containers retain their own local overflow behavior.

The CLI authorization panel is at most 680px wide and otherwise uses available width. Keep the code, account identity, permission explanation, 30-minute maximum session explanation, and confirm/cancel actions within the same panel on desktop and mobile.

## Elevation & Depth

Use the existing flat white panels, soft gray empty surface, and quiet borders. The channel extension adds no shadow system. Separators distinguish the guide and release history; the confirmation is an inline panel rather than an overlay.

## Shapes

Retain the incumbent gently rounded fields, buttons, and panels. The empty surface and decorative list icon container use 12px corners. Channel inputs and selects have a minimum height of 48px. All new controls inherit the customer shell's visible blue focus outline, 3px wide with 3px offset. Lucide icons inherit their surrounding text color and remain decorative where adjacent text names the action.

## Components

### Empty, loading, and failure states

An empty API list remains empty; the soft gray block contains a truck icon, “从第一个运输渠道开始”, a concrete short explanation, and a near-black creation action. A second creation action remains available in the page header. Reading uses a textual status region. A denied or unavailable read produces a textual error with a retry action, not an empty list that suggests permission or data availability.

### Draft form

Require channel name, immutable-after-create channel code, warehouse name, service, origin country, destination country, currency, start date, and end date. New fields are blank and selects initially say “请选择”; fixture screenshot values are entered examples, not defaults. Preserve visible labels and native date/select behavior. Saved data is the source for previews; unsaved form changes are rejected before a state-changing action and remain available for correction.

### Confirmation and historical release

**The Complete Preview Rule.** Before publication or rollback, show the complete returned snapshot as eight labeled groups: channel name, channel code, warehouse, service, origin country, destination country, settlement currency, and validity period containing both dates. These are eight display groups for nine stored input fields. Render the preview response, not a summary reconstructed from the currently edited form.

Publication confirmation identifies the current saved draft version. Rollback confirmation additionally identifies the selected historical publication version and its publication time, then shows that historical snapshot. The current form and published-state rail may describe newer data; the confirmation must make the intended rollback target unambiguous. Both confirmation types retain “本次只变更渠道信息，运价与计费规则尚未接入。” and explicit confirm/cancel actions.

History identifies each release by name, publication time, and version, marks the active release as “当前发布”, and offers “预览回退” for another release. Saving a draft does not replace active published content. Disable confirmation explains that the current release will be removed while history remains. Mutations use current version checks, preview hashes where required, the existing shared mutation helper, and subsequent API reloading; frontend appearance is not evidence of server success.

### CLI authorization

Validate the eight-character uppercase hexadecimal request code before showing approval. Ask the user to compare it with their terminal, show the signed-in account identity, and explain that the CLI only receives that person's existing workspace permissions for at most 30 minutes. Approval is a deliberate button action. Cancellation returns home. After approval, tell the user to finish login in the terminal using the original session file; do not render the resulting session credential.

Web and CLI use the same resource API and records. The session file is private, bound to its service address, and CLI logout revokes its independent session without logging out the browser. An application API Key does not confer personnel administration permissions. Keep the local-only and download-version boundary visible in the CLI guide addon.

## Do's and Don'ts

- **Do** keep empty configuration empty and separate draft save, preview, explicit confirmation, and readback.
- **Do** retain the full eight-group publication/rollback summary and identify the historical version before rollback confirmation.
- **Do** clear channel UI state when identity or organization context changes and ignore superseded reads, as the current module does.
- **Do** preserve desktop-to-mobile order, readable field values, explicit state text, and visible keyboard focus.
- **Don't** turn fixture names, dates, channel IDs, or device codes into production defaults or design assets.
- **Don't** equate channel publication with operational prices, quote availability, or complete CLI parity.
- **Don't** promote the existing CLI page eyebrow, surface-specific spacing, or code-display treatment into new global design requirements.

QA contract and evidence: inspect root `.impeccable/review/channels/empty-desktop.png`, `empty-mobile.png`, `form-desktop.png`, `form-mobile.png`, `preview-desktop.png`, `preview-mobile.png`, `rollback-desktop.png`, `rollback-mobile.png`, `cli-authorization.png`, and `cli-authorization-mobile.png`. These ten captures were inspected for this documentation pass against `channels.js`, the tail of `styles.css`, `app.js` navigation, `cli-guide.js`, and `workspace-cli.md`. The existing `qa.json` records empty-state coverage, unsaved-edit protection, web publish/readback, CLI edit/publish followed by web readback, web rollback followed by CLI readback, unauthorized-user isolation, inquiry note isolation, and independent CLI logout, with `errors: []`. This pass did not rerun those checks or detectors; the file and screenshots are recorded local evidence, not new test execution.

Finish boundary: the parent review handoff reports final disposition “ship” for the scored fix restoring the complete eight-group confirmation and explicit historical release identity. That limited review disposition does not certify the entire platform, every interaction, production deployment, live source data, or full CLI coverage. The design extension is documentation only.

Not canonized: the pre-existing CLI eyebrow and any inherited craft-floor defects are not reusable design rules; synthetic business values and authorization codes are evidence only; neither local success nor metadata publication is a readiness token.
