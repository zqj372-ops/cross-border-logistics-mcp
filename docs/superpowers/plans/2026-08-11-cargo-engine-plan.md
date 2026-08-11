# Cargo and Chargeable Weight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic CargoLine, CBM, dimensional weight, bubble-share, and chargeable-weight engine without reading customer prose as a trusted number or mixing incompatible weight evidence.

**Architecture:** Cargo calculation is a pure TypeScript domain package. It accepts versioned structured lines and a versioned channel rule, uses decimal arithmetic, returns either a complete CargoResult or a typed `needs_input`/`manual_review` diagnostic, and never calls an MCP transport or persistence adapter. `CargoLine` and the response models mirror the shared JSON Schemas.

**Tech Stack:** Node.js 22, TypeScript strict mode, `decimal.js`, Vitest, and the shared platform envelope types from `src/logistics_mcp/platform`.

---

### Task 1: Define cargo types and the mutually exclusive weight evidence test

**Files:**
- Create: `src/logistics_mcp/domains/cargo/models.ts`
- Create: `src/logistics_mcp/domains/cargo/diagnostics.ts`
- Test: `tests/cargo/weight-evidence.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { validateCargoLine } from "../../src/logistics_mcp/domains/cargo/models";

describe("CargoLine weight evidence", () => {
  it("accepts exactly one weight evidence mode", () => {
    expect(validateCargoLine({ line_id: "line_1", version: "cargo-line@1", description: "carton", quantity: 2, quantity_unit: "carton", package_type: "carton", unit_weight: { value: "10", unit: "kg" }, stackable: true, fragile: false, sensitive: false, source_ref_ids: ["src_1"] }).ok).toBe(true);
  });

  it("fails closed when unit and line-total weights are mixed", () => {
    const result = validateCargoLine({ line_id: "line_1", version: "cargo-line@1", description: "carton", quantity: 2, quantity_unit: "carton", package_type: "carton", unit_weight: { value: "10", unit: "kg" }, line_total_weight: { value: "20", unit: "kg" }, stackable: true, fragile: false, sensitive: false, source_ref_ids: ["src_1"] });
    expect(result).toMatchObject({ ok: false, code: "cargo.weight_evidence_mixed" });
  });
});
```

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/cargo/weight-evidence.test.ts`.

Expected: FAIL because `validateCargoLine` is not defined.

- [ ] **Step 3: Implement strict models**

Define `CargoLine`, `CargoMetrics`, `ChargeableWeight`, `BubbleRule`, `CargoResult`, and `CargoDiagnostic`. `validateCargoLine` must reject unknown fields, negative decimal strings, non-kg weight evidence, and more than one of `unit_weight`, `piece_weights`, and `line_total_weight`; it may accept none only as an incomplete input that the calculation service will turn into `needs_input`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- --run tests/cargo/weight-evidence.test.ts && npm run typecheck`.

Expected: PASS and exit 0.

- [ ] **Step 5: Commit the types**

```bash
git add src/logistics_mcp/domains/cargo/models.ts src/logistics_mcp/domains/cargo/diagnostics.ts tests/cargo/weight-evidence.test.ts
git commit -m "feat: define deterministic cargo models"
```

### Task 2: Implement exact unit conversion, volume, and actual-weight aggregation

**Files:**
- Create: `src/logistics_mcp/domains/cargo/decimal.ts`
- Create: `src/logistics_mcp/domains/cargo/units.ts`
- Create: `src/logistics_mcp/domains/cargo/metrics.ts`
- Test: `tests/cargo/metrics.test.ts`

- [ ] **Step 1: Write the failing metric tests**

Cover: two cartons with `60 cm × 50 cm × 40 cm` produce `0.240000 cbm` for each carton group; a line-total `1800 kg` remains 1800 kg; unit-weight `12.5 kg × 4` produces `50.0 kg`; dimensions in mm convert to cm before volume; unsupported units return a diagnostic.

- [ ] **Step 2: Run the red tests**

Run: `npm test -- --run tests/cargo/metrics.test.ts`.

Expected: FAIL because `calculateCargoMetrics` is not defined.

- [ ] **Step 3: Implement decimal-only arithmetic**

Use `Decimal` for every calculation and serialize only with `toFixed`/normalized decimal strings. Implement explicit conversion tables for `mm`, `cm`, `m`, `g`, `kg`, `lb`, `cbm`, and `m3`. `calculateCargoMetrics(lines)` must compute volume from dimensions when `volume` is absent, sum actual weight from exactly one evidence mode per line, and return `weight_evidence="missing"` or `"conflicting"` rather than manufacturing a number.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run tests/cargo/metrics.test.ts`.

Expected: PASS with exact decimal strings and no float rounding drift.

- [ ] **Step 5: Commit metrics**

```bash
git add src/logistics_mcp/domains/cargo/decimal.ts src/logistics_mcp/domains/cargo/units.ts src/logistics_mcp/domains/cargo/metrics.ts tests/cargo/metrics.test.ts
git commit -m "feat: calculate cargo metrics with explicit units"
```

### Task 3: Implement channel-scoped dimensional weight and bubble-share rules

**Files:**
- Create: `src/logistics_mcp/domains/cargo/chargeable.ts`
- Test: `tests/cargo/chargeable-weight.test.ts`

- [ ] **Step 1: Write red tests for every supported mode**

```ts
import { describe, expect, it } from "vitest";
import { calculateChargeableWeight } from "../../src/logistics_mcp/domains/cargo/chargeable";

describe("chargeable weight", () => {
  it.each([
    ["none", "1000", "1500", "1500", "0"],
    ["full", "1000", "1500", "1500", "1"],
    ["half", "1000", "1500", "1250", "0.5"],
    ["ratio", "1000", "1500", "1200", "0.4"],
  ])("calculates %s without float arithmetic", (mode, actual, volumetric, expected, ratio) => {
    const result = calculateChargeableWeight({ actual, volumetric, method: mode as "none" | "full" | "half" | "ratio", ratio, ruleVersion: "CAQ-HP@2026-01-01", sourceRefIds: ["src_rule"] });
    expect(result.customer_chargeable_weight.value).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/cargo/chargeable-weight.test.ts`.

Expected: FAIL because the chargeable function is absent.

- [ ] **Step 3: Implement the minimum formula set**

Accept a `DimensionalRule` with `divisor`, `unit`, `rounding`, `method`, `ratio`, and `rule_version`. Calculate `volumetric = volume × density` or `volume / divisor` only when the rule explicitly says so. Calculate `bubble_weight = max(volumetric - actual, 0)`, customer chargeable weight according to the method, and supplier chargeable weight from the supplier rule. Reject ratios outside `[0,1]`, missing rule versions, missing source IDs, and any implicit default divisor.

- [ ] **Step 4: Run focused tests and the regression cases**

Add tests for actual weight above volumetric weight, `ratio=0`, `ratio=1`, missing ratio for ratio mode, and CAD/USD-independent weight output. Run: `npm test -- --run tests/cargo/chargeable-weight.test.ts`.

Expected: PASS; invalid rules produce typed diagnostics rather than a numeric result.

- [ ] **Step 5: Commit chargeable-weight logic**

```bash
git add src/logistics_mcp/domains/cargo/chargeable.ts tests/cargo/chargeable-weight.test.ts
git commit -m "feat: implement channel-scoped chargeable weight"
```

### Task 4: Expose the cargo domain service with envelope outcomes

**Files:**
- Create: `src/logistics_mcp/domains/cargo/service.ts`
- Create: `src/logistics_mcp/domains/cargo/index.ts`
- Test: `tests/cargo/cargo-service-outcomes.test.ts`

- [ ] **Step 1: Write failing outcome tests**

Test that a complete request returns `success` with `CargoResult`; missing weight returns `needs_input` with a field-specific blocker; mixed evidence returns `manual_review`; a caller without `quote:calculate` is rejected by the platform before service invocation.

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/cargo/cargo-service-outcomes.test.ts`.

Expected: FAIL because `calculateCargo` is absent.

- [ ] **Step 3: Implement the pure service**

`calculateCargo(input, context)` must validate the channel rule, calculate metrics, calculate chargeable weight, create calculation steps for unit conversion, volume, dimensional divisor, and bubble mode, and return `createEnvelope` with source refs and versions. It must not accept free-form cargo prose or a model-supplied rule. Preserve `manual_review` when the data is internally inconsistent.

- [ ] **Step 4: Run cargo verification**

Run: `npm test -- --run tests/cargo && npm run typecheck`.

Expected: all cargo tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit the cargo service**

```bash
git add src/logistics_mcp/domains/cargo/service.ts src/logistics_mcp/domains/cargo/index.ts tests/cargo/cargo-service-outcomes.test.ts
git commit -m "feat: expose cargo calculation outcomes"
```

### Task 5: Validate cargo schemas and source trace coverage

**Files:**
- Modify: `scripts/validate-contracts.mjs`
- Test: `tests/cargo/schema-trace.test.ts`

- [ ] **Step 1: Write the failing trace test**

Assert that every successful CargoResult has at least one source ref per calculation step, has `version`/`rule_version`, and never serializes a numeric `amount`, weight, volume, or ratio.

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/cargo/schema-trace.test.ts`.

Expected: FAIL until the trace checker and serializer are implemented.

- [ ] **Step 3: Implement the contract check**

Use the local JSON Schema files under `docs/contracts/schemas/` and a resolver rooted at that directory. The checker must reject an object key named `unit_weight` combined with `piece_weights`/`line_total_weight`, and reject JavaScript numbers for fields declared as decimal strings. Keep the checker read-only over contracts; it must not modify schema files.

- [ ] **Step 4: Run the complete cargo gate**

Run: `npm test -- --run tests/cargo && npm run typecheck && npm run validate:schemas`.

Expected: PASS with all examples and cargo models validating.

- [ ] **Step 5: Commit the cargo verification gate**

```bash
git add scripts/validate-contracts.mjs tests/cargo/schema-trace.test.ts
git commit -m "test: verify cargo trace and schema boundaries"
```
