# Container Plan Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, theory-only container planning summary that keeps physical capacity, operational target, payload limit, loading constraints, and overflow visible without making a 3D packing or field-loading promise.

**Architecture:** The container domain consumes `CargoMetrics` and an approved, versioned `ContainerProfile`. It computes volume/weight utilization and an explainable priority order. Constraint violations return `manual_review` with a usable non-final summary; the domain never writes warehouse records and never emits coordinates.

**Tech Stack:** Node.js 22, TypeScript strict mode, `decimal.js`, Vitest, shared CargoMetrics/ContainerPlan JSON Schemas, and the platform envelope.

---

### Task 1: Define the container profile and constraint types

**Files:**
- Create: `src/logistics_mcp/domains/container/models.ts`
- Create: `src/logistics_mcp/domains/container/constraints.ts`
- Test: `tests/container/profile-validation.test.ts`

- [ ] **Step 1: Write failing validation tests**

```ts
import { describe, expect, it } from "vitest";
import { validateContainerProfile } from "../../src/logistics_mcp/domains/container/models";

describe("container profile", () => {
  it("requires separate physical capacity, operational target, and payload units", () => {
    expect(validateContainerProfile({ version: "container-config@1", container_type: "40HQ", physical_capacity: { value: "76", unit: "cbm" }, operational_target: { value: "75", unit: "cbm" }, max_payload: { value: "26000", unit: "kg" }, source_ref_ids: ["src_config"] }).ok).toBe(true);
  });

  it("rejects a capacity expressed in kilograms", () => {
    expect(validateContainerProfile({ version: "container-config@1", container_type: "40HQ", physical_capacity: { value: "76", unit: "kg" }, operational_target: { value: "75", unit: "cbm" }, max_payload: { value: "26000", unit: "kg" }, source_ref_ids: ["src_config"] })).toMatchObject({ ok: false, code: "container.capacity_unit_invalid" });
  });
});
```

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/container/profile-validation.test.ts`.

Expected: FAIL because the profile validator is absent.

- [ ] **Step 3: Implement strict profile models**

`ContainerProfile` must require `version`, `container_type`, physical capacity in `cbm`, operational target in `cbm`, max payload in `kg`, and `source_ref_ids`. `LoadingConstraints` must require booleans for sensitive-at-head, declaration-at-tail, FIFO-other, and a nullable integer customer priority. Set `theoretical_only=true` in the domain result, not from the caller.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run tests/container/profile-validation.test.ts && npm run typecheck`.

Expected: PASS and typecheck exit 0.

- [ ] **Step 5: Commit profile types**

```bash
git add src/logistics_mcp/domains/container/models.ts src/logistics_mcp/domains/container/constraints.ts tests/container/profile-validation.test.ts
git commit -m "feat: define versioned container profiles"
```

### Task 2: Implement deterministic utilization and overflow calculations

**Files:**
- Create: `src/logistics_mcp/domains/container/summary.ts`
- Test: `tests/container/utilization.test.ts`

- [ ] **Step 1: Write red calculation tests**

Cover a 40HQ profile with `physical=76 cbm`, `operational=75 cbm`, `payload=26000 kg`, cargo `60 cbm/18000 kg` returning utilization `0.8000`, remaining volume `15 cbm`, `over_capacity=false`, and `overweight=false`. Add tests for `76 cbm` returning `over_capacity=true` because the operational target is exceeded, and `26001 kg` returning `overweight=true`.

- [ ] **Step 2: Run the red tests**

Run: `npm test -- --run tests/container/utilization.test.ts`.

Expected: FAIL because `summarizeContainer` is absent.

- [ ] **Step 3: Implement decimal summary logic**

Use `Decimal`, calculate `total_volume / operational_target` and clamp only the displayed ratio to the declared policy; do not hide over-capacity values. Calculate remaining volume as `max(operational_target-total_volume, 0)` and include an overflow/overweight flag. Use the CargoMetrics version and profile version in `ContainerPlan.version` and source refs.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run tests/container/utilization.test.ts`.

Expected: PASS with exact decimal serialization and visible violations.

- [ ] **Step 5: Commit utilization**

```bash
git add src/logistics_mcp/domains/container/summary.ts tests/container/utilization.test.ts
git commit -m "feat: calculate container utilization summary"
```

### Task 3: Implement explainable loading order without 3D packing

**Files:**
- Create: `src/logistics_mcp/domains/container/loading-order.ts`
- Test: `tests/container/loading-order.test.ts`

- [ ] **Step 1: Write failing ordering tests**

Use four lines: sensitive priority 3, ordinary priority 1, customer priority 1, and declaration-required priority 2. Assert that the output puts sensitive lines first, customer priority next, ordinary lines in stable FIFO order, and declaration-required lines at the tail. Assert that no output field named `x`, `y`, `z`, `rotation`, `center_of_mass`, or `stacking_coordinates` is present.

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/container/loading-order.test.ts`.

Expected: FAIL because `deriveLoadingOrder` is absent.

- [ ] **Step 3: Implement stable priority ordering**

Build a comparator from explicit constraints: sensitive-at-head rank 0, customer priority ascending rank 1, ordinary FIFO rank 2, declaration-at-tail rank 3. Preserve source line order as a tie-breaker. Emit warnings for incompatible constraints rather than silently reordering. The function returns line IDs only and never accepts coordinates.

- [ ] **Step 4: Run ordering tests and a forbidden-field scan**

Run: `npm test -- --run tests/container/loading-order.test.ts && rg -n "center_of_mass|stacking_coordinates|\brotation\b|\bx\b|\by\b|\bz\b" src/logistics_mcp/domains/container tests/container`.

Expected: tests PASS; the ripgrep command returns no domain coordinate implementation lines.

- [ ] **Step 5: Commit loading order**

```bash
git add src/logistics_mcp/domains/container/loading-order.ts tests/container/loading-order.test.ts
git commit -m "feat: derive explainable container loading order"
```

### Task 4: Expose `container.plan_summary` outcomes

**Files:**
- Create: `src/logistics_mcp/domains/container/service.ts`
- Create: `src/logistics_mcp/domains/container/index.ts`
- Test: `tests/container/container-service-outcomes.test.ts`

- [ ] **Step 1: Write failing outcome tests**

Assert: a complete profile and CargoMetrics return `success`; missing operational target returns `needs_input`; over-capacity or conflicting sensitive/declaration ordering returns `manual_review`; a request to calculate coordinates returns `blocked` before any summary calculation.

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/container/container-service-outcomes.test.ts`.

Expected: FAIL because `planContainerSummary` is absent.

- [ ] **Step 3: Implement the service**

Validate the profile and cargo metrics, calculate summary, apply loading order, attach `CalculationStep` records for utilization/remaining volume/weight limit, and wrap the result in the envelope. Always set `theoretical_only=true`; do not accept a caller override. Return `manual_review` for any limit violation or constraint conflict while preserving the computed summary as non-final data.

- [ ] **Step 4: Run all container tests**

Run: `npm test -- --run tests/container && npm run typecheck`.

Expected: all container tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit the container service**

```bash
git add src/logistics_mcp/domains/container/service.ts src/logistics_mcp/domains/container/index.ts tests/container/container-service-outcomes.test.ts
git commit -m "feat: expose theory-only container plan summary"
```

### Task 5: Validate container contract and non-promise language

**Files:**
- Create: `tests/container/contract-language.test.ts`
- Modify: `scripts/validate-contracts.mjs`

- [ ] **Step 1: Write the contract guard test**

Read the generated ContainerPlan and assert `theoretical_only===true`, both physical and operational measurements are present, every special warning has a source context, and the serialized result does not contain `3D`, `coordinate`, `center of mass`, `guaranteed load`, or `field confirmed`.

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/container/contract-language.test.ts`.

Expected: FAIL until the service serialization and validator are connected.

- [ ] **Step 3: Implement the validation hook**

Add a container entry to `scripts/validate-contracts.mjs` that validates `container-plan.schema.json` and `examples/success-container.json`, and fails if the result has theory-only or language guards violated.

- [ ] **Step 4: Run the complete container gate**

Run: `npm test -- --run tests/container && npm run typecheck && npm run validate:schemas && git diff --check`.

Expected: all tests PASS, all commands exit 0, and no whitespace errors are printed.

- [ ] **Step 5: Commit the gate**

```bash
git add tests/container/contract-language.test.ts scripts/validate-contracts.mjs
git commit -m "test: enforce theory-only container contract"
```
