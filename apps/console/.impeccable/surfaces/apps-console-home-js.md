---
version: 1
slug: "apps-console-home-js"
primary_target: "apps/console/home.js"
related_targets: ["apps/console/styles.css","apps/console/app.js","apps/console/index.html","apps/console/icons.js","apps/console/fonts/fonts.css","apps/console/fonts/manifest.json","apps/console/asset-licenses.md"]
---

# FreightClaw / JoyAgent reference direction

User explicitly chose https://joyagent.jd.com/pl/ on 2026-09-07 as the visual style for the existing website. This pins the direction and replaces the previous Wind/blue-card aesthetic. Code-led translation of a supplied reference; no alternative visual world or generated concept was requested.

Mode: Persuade. The visitor identifies an available service and starts the appropriate task. The latest refinement asks for a larger, more readable layout, free open-source fonts, and clearer icons within the same pinned white, near-black, and pale-blue direction.

Audience: cargo owners and merchants who need a quick ocean inquiry or customs lookup. Preserve public access and server-owned anonymous customs/tax quota of 20/day, login required for tail quoting and account records, account-icon menu, original inquiry and pricing directory. Actual source readiness must remain visible.

Composition: white spacious horizontal header; centered light + bold black headline and two clear CTAs; quiet blue dot field and a curved logistics icon ribbon; four pale service previews; secondary tail/market row; API/CLI connection section; compact charcoal footer. Pink/lilac and pale blue in the reference remain subtle atmosphere, not brand claims. FreightClaw retains its own brand and live routes with selected Lucide SVG icons. Reference UI photographs/logos/copy/prices are not copied.

Typography: self-hosted Manrope for Latin, Noto Sans SC for Chinese, and JetBrains Mono with Noto Sans SC for code. The body stack is `"Manrope","Noto Sans SC",sans-serif`; the code stack is `"JetBrains Mono","Noto Sans SC",monospace`. The headline is `450 clamp(42px,5vw,72px)/1.28`, with its second phrase at 700. At 760px and below it is 42px; at 540px and below it is `clamp(34px,10.25vw,42px)`, retaining 34px at a 320px viewport. Service body text is 16px across desktop and phone; metadata is 14px desktop and 13px phone. Four service cards and the dot surface remain earned reference choices. Near-black #252830; support #626975; interaction and customer focus blue #335cff; white #fff and pale #f7f8fa.

Layout: homepage content has a 1536px maximum and 48px minimum desktop side gutters; task pages use a 1440px maximum. The header is 88px desktop and 76px at 760px and below. The service grid uses four columns above 1180px, two columns with horizontal image/text cards at 901–1180px, two columns with vertical previews at 541–900px, and single-column icon/text rows at 540px and below. Phone icon columns are 76px, reduced to 58px at 360px and below; decorative labels and the miniature terminal are hidden while actual service text remains. Home side gutters become 20px at 760px and 14px at 360px. The two main CTAs render at about 56px height through desktop padding and retain a 52px minimum height on phone. The connection section stacks at 760px. Account dropdown width is 280px with a `calc(100vw - 68px)` maximum; menu rows are at least 48px high.

Font delivery and icon provenance: `fonts/fonts.css` imports 43 self-hosted WOFF2 assets using `font-display: swap` and `unicode-range`; esbuild emits hashed `/console/fonts/` assets. The font manifest records pinned upstream revisions, original TTF checksums, generated asset checksums and sizes. The complete font set is 9,605,752 bytes; Noto Sans SC subdivisions preserve 30,890 upstream Unicode mappings. The three basic font assets used on this home total 324,936 bytes; other character subsets are requested as needed. All three families use SIL OFL 1.1. The 25 selected Lucide inline icons retain ISC and Feather-derived MIT notices, use 24×24 coordinates, a 1.75 stroke, round caps and joins, and `aria-hidden` / `focusable="false"` for decoration. The footer links to `asset-licenses.md`. Font files do not depend on a CDN; the generic fallback remains usable when fonts fail to load.

Target viewports: 1440x1000 reference-matched, 1920x1080 comparable to user browser, 1280px and 1024px transition widths, 768x1024, 540px card transition, 390x844, and 320x740. The reference is clipped at 390; FreightClaw must adapt, with readable icon/text cards and mobile navigation. Page variants: home/account menu, market filters, customs quota/form, tax, CLI, manual, protected tail and signed-in role menu.

Motion and focus: the ribbon has one 0.8s eased entrance from 6px vertical offset and 1px blur; controls use 180ms color/border transitions. Reduced-motion disables animation and transitions. Customer controls, links, inputs, and summaries use a 3px brand-blue focus outline with 3px offset, including market cards and fields.

Finish: two batched render rounds maximum before independent reviewer, one detector, reviewer disposition followed, fresh documentation from final build. This documentation refresh reads final source plus the existing local render evidence in `.impeccable/review/refinement`; it is not a new UI test run or a deployment claim. Reference was captured from its actual public page. Runtime has no raster assets. Keep production state and verification outcomes in the runbook rather than inferring business readiness from appearance.
