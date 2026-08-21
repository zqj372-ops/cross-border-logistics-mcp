# Neutral Quote Desk UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current dark workbench skin with a neutral, unbranded Quote Desk UI that follows the observed Freightcom quote workflow while preserving the existing LTL pallet request and response behavior.

**Architecture:** Keep the current static HTML/CSS/ES-module application and its existing DOM-to-request mapping. Replace only the visible shell, layout, copy, and styling; preserve every `name`, `id`, `data-name`, result-state hook, and API fetch path used by `app.js`. Add a small markup contract test so visible branding cannot regress while provider identifiers remain in server-side adapter code and response evidence.

**Tech Stack:** Static HTML, CSS, browser ES modules, Node/Vitest, existing Edge browser verification.

---

## Scope and invariants

Files in scope:

- Modify `/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/freightcom-quote/index.html` for the neutral shell and semantic layout.
- Modify `/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/freightcom-quote/styles.css` for the new design system, layout, states, and responsive behavior.
- Modify `/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/freightcom-quote/app.js` only where visible copy or DOM structure changes require it.
- Create `/Users/autumn/Documents/ChatGPT/物流产品MCP/tests/apps/freightcom-quote/ui-contract.test.ts` for visible-brand and required-hook checks.

Files not to modify:

- `/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/freightcom-quote/form-model.mjs`
- `/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/freightcom-quote/server.mjs`
- `/Users/autumn/Documents/ChatGPT/物流产品MCP/src/logistics_mcp/adapters/quote/**`

The following hooks must remain available after the markup rewrite: `#quote-form`, `#pallet-list`, `#dangerous-goods`, `#dangerous-goods-toggle`, `#limited-access`, `#limited-access-toggle`, `#in-bond`, `#amazon-fba`, `#add-pallet`, `#pallet-quantity`, `#submit-quote`, `#reset-form`, `#stop-polling`, `#empty-state`, `#progress-card`, `#results-card`, `#results-table-body`, `#evidence-card`, and all form `name`/`data-name` attributes currently consumed by `app.js`.

## Task 1: Add the neutral UI markup contract test

**Files:**
- Create: `/Users/autumn/Documents/ChatGPT/物流产品MCP/tests/apps/freightcom-quote/ui-contract.test.ts`

- [ ] **Step 1: Write the failing test for visible branding and required hooks**

Read the body of `index.html`, assert that the visible shell does not contain `Freightcom`, `Quote Workbench`, or `Freightcom TEST`, and assert that the neutral shell contains `Quote Desk`, `New Quote`, `Quote History`, and `Quote Overview`. Keep provider-specific evidence allowed by limiting the brand assertion to the shell selectors/data attributes, not the whole document.

Use this test shape:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const indexPath = new URL("../../../apps/freightcom-quote/index.html", import.meta.url);

describe("neutral Quote Desk UI contract", () => {
  it("uses neutral visible shell copy", async () => {
    const html = await readFile(indexPath, "utf8");
    const shell = html.match(/<body[\\s\\S]*?<main[\\s\\S]*?<\\/main>/u)?.[0] ?? "";
    expect(shell).toContain("Quote Desk");
    expect(shell).toContain("New Quote");
    expect(shell).toContain("Quote History");
    expect(shell).not.toContain("Freightcom TEST");
    expect(shell).not.toContain("Quote Workbench");
  });

  it("keeps the request and response hooks used by the existing app logic", async () => {
    const html = await readFile(indexPath, "utf8");
    for (const hook of [
      'id="quote-form"', 'id="pallet-list"', 'id="submit-quote"',
      'id="results-table-body"', 'id="evidence-card"',
      'name="origin.address_line_1"', 'name="destination.address_line_1"',
      'data-name="weightValue"', 'data-name="dimensionUnit"',
    ]) expect(html).toContain(hook);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails against the current branded shell**

Run:

```bash
npm test -- --run tests/apps/freightcom-quote/ui-contract.test.ts
```

Expected: the neutral shell test fails because the current document still contains the Freightcom branded workbench shell.

## Task 2: Replace the document shell with the neutral workflow layout

**Files:**
- Modify: `/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/freightcom-quote/index.html`

- [ ] **Step 1: Replace the dark rail with a semantic top navigation**

Use this structure while preserving the existing form and result IDs below it:

```html
<div class="app-shell">
  <header class="topbar">
    <a class="wordmark" href="#quote-form" aria-label="Quote Desk home">Quote Desk</a>
    <nav class="topnav" aria-label="Internal navigation">
      <a class="topnav-link is-active" href="#quote-form">New Quote</a>
      <a class="topnav-link" href="#results-panel">Quote History</a>
      <a class="topnav-link" href="#shipping-details">Shipments</a>
      <a class="topnav-link" href="#results-panel">Tracking</a>
      <a class="topnav-link" href="#evidence-card">Billing</a>
      <a class="topnav-link" href="#evidence-card">Claims</a>
    </nav>
    <div class="topbar-state"><span class="status-dot" id="api-dot"></span><span id="api-environment">TEST</span></div>
  </header>
  <main id="main-content" class="main-content" tabindex="-1">
    <section class="page-intro" aria-labelledby="form-title">
      <div><h1>New Quote</h1><p>Enter shipment details to compare pallet delivery options.</p></div>
      <span class="route-chip">POST /rate</span>
    </section>
    <div class="quote-layout">
      <section class="panel form-panel" aria-labelledby="form-title">…existing form…</section>
      <aside class="overview-panel" aria-labelledby="quote-overview-title">…Quote Overview…</aside>
    </div>
  </main>
</div>
```

Do not use a logo mark, Freightcom wordmark, provider name in the title, or an invented marketing hero. Keep the UI copy short and operational.

- [ ] **Step 2: Reorder the form to match the observed quote flow**

Keep the existing `name` and `id` values but place sections in this order: Shipping Details, From/To, Dimensions & Weight, Additional Services, Additional Insurance, actions. Put the complete API address/contact fields in explicit `<details class="address-details">` blocks under each location so the Postal/ZIP workflow is the first visible interaction without hiding required fields from the DOM or validation.

Use `Quote Overview` as a non-duplicating aside with three anchored rows: Shipping Details, Packaging Details, Shipping Rates. Keep `#results-panel` and `#evidence-card` in the page so the existing app logic and evidence readback remain intact.

- [ ] **Step 3: Replace visible provider branding and stale copy**

Remove visible instances of `Freightcom`, `Quote Workbench`, `Freightcom TEST`, and provider marketing language from the shell, form headings, empty state, footer, and primary actions. Use `Quote Desk`, `New Quote`, `Get Rates`, `Clear`, `Waiting for a quote request`, `Provider response`, and `Manual review` as neutral copy. Keep provider-specific text only inside the evidence panel and error messages where it explains the upstream source.

- [ ] **Step 4: Run the focused UI contract test**

Run:

```bash
npm test -- --run tests/apps/freightcom-quote/ui-contract.test.ts
```

Expected: 2 tests pass, and the existing app-specific tests remain unchanged.

## Task 3: Rebuild the visual system and responsive layout

**Files:**
- Modify: `/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/freightcom-quote/styles.css`

- [ ] **Step 1: Replace the visual tokens**

Set the neutral tokens exactly as defined in the approved design: true white surfaces, `#f5f7fa` workspace background, `#203448` primary text, `#6f8190` secondary text, `#d9e2e9` borders, `#2f78b7` action blue, teal success, amber warning, and high-contrast red errors. Remove the dark rail tokens and the decorative shadow stack.

- [ ] **Step 2: Implement the topbar and two-column container**

Use a 64px topbar, max content width 1440px, 24px desktop gutter, and a `minmax(0, 2fr) minmax(280px, .85fr)` quote layout. The main form is one open surface with section separators, not a stack of nested cards. The overview is sticky only above 1024px.

- [ ] **Step 3: Style controls for operational scanning**

Use 40px desktop and 44px mobile controls, visible labels, clear focus rings, selected/disabled states, compact section headers, and tabular numerals for money/progress. Keep the primary action visually dominant and make error summaries high contrast with recovery text.

- [ ] **Step 4: Add responsive rules and reduced-motion support**

At 1024px compress gutters while retaining two columns; at 760px stack the overview and form; at 375px use one-column fields, 44px controls, and a horizontally scrollable results table without body overflow. Add a `prefers-reduced-motion: reduce` rule that disables nonessential transitions.

- [ ] **Step 5: Run lint and the focused tests**

Run:

```bash
npm run lint
npm test -- --run tests/apps/freightcom-quote
```

Expected: lint exits 0 and all Freightcom quote tests pass.

## Task 4: Align app copy and DOM-dependent interactions without changing data mapping

**Files:**
- Modify: `/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/freightcom-quote/app.js`

- [ ] **Step 1: Update only visible copy and stable selectors**

Keep `readForm`, `buildFreightcomRequest`, `fetch`, polling, `formatDisplayMoney`, and result status logic intact. Change only strings that name the old branded shell and selectors that moved with the topbar/overview. Preserve all existing form names and `data-name` selectors.

- [ ] **Step 2: Verify core local interactions in Edge**

With the no-token local server, verify: Quantity creates the requested pallet rows; Metric/Imperial changes units; Location Type maps to the two existing checkboxes; Dangerous Goods and Limited Access reveal their conditional inputs; Quote Overview anchors scroll to the correct sections; empty state and validation error state render with neutral copy.

## Task 5: Browser visual QA and regression verification

**Files:**
- Modify only if visual QA finds a concrete mismatch: `/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/freightcom-quote/index.html`, `/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/freightcom-quote/styles.css`, `/Users/autumn/Documents/ChatGPT/物流产品MCP/apps/freightcom-quote/app.js`

- [ ] **Step 1: Start the no-token local preview**

Run:

```bash
FREIGHTCOM_QUOTE_PORT=56575 npm run start:freightcom-quote
```

Expected: the local page starts with `Freightcom test token configured: no`; this is a visual-only server and must not make an upstream call.

- [ ] **Step 2: Verify the first viewport in Edge**

Open `http://127.0.0.1:56575/` in Edge and capture a screenshot at the current desktop viewport. Check: no visible provider branding, topbar hierarchy, first-view form density, white surfaces, neutral text, action hierarchy, and overview alignment.

- [ ] **Step 3: Verify the mobile viewport in Edge**

Check a 375px-wide viewport. Confirm no horizontal body overflow, controls remain at least 44px high, overview placement is readable, and results table overflow is local to the table wrapper.

- [ ] **Step 4: Verify full repository gates**

Run:

```bash
git diff --check
npm run typecheck
npm run lint
npm test -- --run
npm run validate:schemas
npm run validate:agent-standards
npm run build:agent-pack
npm run build
```

Expected: all commands exit 0; the full suite reports 55 test files and 397 tests plus the new UI contract tests, with only the existing SQLite experimental warnings allowed.

- [ ] **Step 5: Confirm the adapter boundary**

Inspect the final diff and confirm there are no changes under `src/logistics_mcp/adapters/quote/**`, no token/API key literals, no new browser-side credential path, and no claim that the upstream test environment is ready.

## Commit checkpoints

Use focused commits after each verified slice:

```bash
git add tests/apps/freightcom-quote/ui-contract.test.ts apps/freightcom-quote/index.html
git commit -m "feat: add neutral quote desk shell"

git add apps/freightcom-quote/styles.css apps/freightcom-quote/app.js
git commit -m "feat: restyle quote desk workflow"

git add tests/apps/freightcom-quote/ui-contract.test.ts apps/freightcom-quote/index.html apps/freightcom-quote/styles.css apps/freightcom-quote/app.js
git commit -m "test: verify neutral quote desk UI"
```

Do not stage `.superpowers/` or unrelated existing changes.
