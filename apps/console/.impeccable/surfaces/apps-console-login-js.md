---
version: 1
slug: "apps-console-login-js"
primary_target: "apps/console/login.js"
related_targets: ["apps/console/app.js","apps/console/styles.css","apps/console/icons.js","apps/console/fonts/fonts.css"]
---

# FreightClaw / Local account login

Scope: a narrow extension of the established white, near-black, and pale-blue Console world. Preserve `apps/console/DESIGN.md` and its sidecar; this surface does not establish a new visual identity or require a new composition workshop.

Mode: Operate. The user supplies an account, password, and image captcha to continue work. The user confirmed these three fields; login does not ask the user to select a role.

Authority: `renderLogin()` shows the inline password form only in fixtures mode. The other branch retains `/console/auth/login`; this local UI documentation does not establish a production password/captcha rollout or replace production OIDC.

Composition: desktop uses an equal two-column, full-height layout. The pale-blue story area contains FreightClaw branding, “从一票需求，到每一步进展。”, a short explanation, and three existing line-icon benefits. The white right area contains “欢迎回来”, account/password/captcha, one near-black login action, return-home link, and collapsed local-account help.

Layout: story padding is 56px 64px; the centered form panel has a 480px maximum width with 48px padding. At 1180px and below story/panel padding becomes 40px/36px. At 900px and below the sections stack, benefits disappear, and the panel maximum becomes 520px with 36px 32px padding. At 640px and below both sections use 30px 24px padding. Preserve the field order and normal document scrolling.

Typography: use the existing self-hosted `"Manrope","Noto Sans SC",sans-serif` stack. Story headline uses `clamp(28px,2.6vw,40px)` with 1.25 line height; welcome heading is 25px, reduced to 22px at 640px. Field labels and inputs are 16px; captcha status and local-account help are 14px. Do not introduce a display font for this form.

Material: near-black text/action and white controls continue the Console palette. The existing story backdrop is #eef2fb; quiet borders and the pale captcha background separate controls without a raised card or decorative illustration. The login layout does not inherit the homepage ribbon or four-service composition.

Fields: form top space is 28px and field bottom spacing is 24px. Inputs and the full-width submit button are at least 50px high. Keep visible labels, username/current-password autocomplete, masked password entry, and the numeric captcha input.

Captcha: the input shares a row with the image-refresh button. Desktop uses a flexible input plus a 164px image column and 14px gap; at 480px and below the image column is 138px with a 10px gap. The image stays 50px high with a 7px radius. A text status below the image explains loading, refresh, or retry; the button has an accessible name and the status uses `role="status"`.

Loading and refresh: disable login, clear the previous captcha identifier and input, remove the old image source, and show loading text before requesting a challenge. Images without a source are hidden. A generation check ignores superseded responses; a failed request keeps login disabled and offers retry. Do not leave a stale image visible as if it were the active challenge.

Error and success: the form contains an alert region. A rejected submission clears password and captcha, retains the account, obtains a fresh challenge, and surfaces the error. The captured rejection uses a pale-red text notice above the fields. Success resets the form and delegates to the existing authenticated-session handler; this brief does not infer a successful production session.

Focus and help: preserve visible keyboard outlines and native form validation. The login shell inherits the base 3px focus outline with 3px offset; the customer-shell-only override does not apply here. The return-home link is centered. Local-account help remains a native collapsed details/summary beneath a thin separator, with local-only wording; do not reproduce its example password in design documentation.

Related member UI: ordinary invitations offer 业务用户 (`viewer`) and 管理员 (`admin`). Existing `owner` and `developer` members retain their corresponding edit options and qualified labels; `reviewer` remains labeled 管理员（审核权限）. These labels simplify presentation while the existing role identifiers and permission checks remain authoritative.

Evidence: final source in `login.js`, `app.js`, and `styles.css`, plus existing root `.impeccable/review/login/desktop.png`, `mobile.png`, `user-1920.png`, and `error.png`. Desktop, mobile, and error captures were inspected for this brief. Captures document local rendered states, not a new runtime test or deployment.

Finish boundary: the parent review handoff reports final disposition “ship” after the sole stale-captcha-image fix. This brief records that limited outcome without expanding it to production readiness. No new world, global design rewrite, generated composition, or shipped decorative raster asset is part of this documentation change.

Not canonized: legacy small story/support copy is described only for this surface; it does not redefine the global body scale. Example credentials and rendered captcha digits are not reusable design assets.
