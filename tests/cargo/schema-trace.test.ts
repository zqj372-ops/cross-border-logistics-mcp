import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import { calculateCargo } from "../../src/logistics_mcp/domains/cargo/service";
import {
  cargoInputSchema,
  validateCargoOutput,
} from "../../src/logistics_mcp/domains/cargo/tool";

const context = parseExecutionContext({
  tenant_id: "tenant_demo",
  actor_id: "actor_sales",
  actor_role: "sales",
  roles: ["sales"],
  scopes: ["quote:calculate"],
  client_id: "client_demo",
  session_id: "session_demo",
  expires_at: Math.floor(Date.now() / 1000) + 300,
});

function sourceRef(sourceId: string, version: string) {
  return {
    source_id: sourceId,
    source_type: sourceId.includes("rule") ? "internal_system" : "user_input",
    system: sourceId.includes("rule") ? "quote-rule-registry" : "mcp-gateway",
    locator: sourceId.includes("rule") ? "channel/CAQ-HP/dimensional-weight" : "opaque://request/schema-test",
    version,
    retrieved_at: "2026-08-11T09:00:00Z",
    authority: sourceId.includes("rule") ? "authoritative" : "user_provided",
    content_hash: `sha256:${sourceId.replace(/[^A-Za-z0-9]/g, "")}`,
  };
}

function request() {
  return {
    schema_version: "2026-08-11.v1",
    version: "cargo.calculate@2026-08-11.v1",
    cargo_lines: [
      {
        version: "cargo-line@2026-08-11.v1",
        line_id: "line_schema_1",
        description: "carton",
        quantity: 2,
        quantity_unit: "carton",
        package_type: "carton",
        unit_weight: { value: "12.5", unit: "kg" },
        dimensions: [
          {
            length: { value: "60", unit: "cm" },
            width: { value: "50", unit: "cm" },
            height: { value: "40", unit: "cm" },
            quantity: 2,
          },
        ],
        stackable: true,
        fragile: false,
        sensitive: false,
        source_ref_ids: ["src_schema_input"],
      },
    ],
    dimensional_divisor: null,
    bubble_rule: {
      channel: "CAQ-HP",
      mode: "full",
      ratio: null,
      rule_version: "CAQ-HP@2026-01-01",
      source_ref_ids: ["src_schema_rule"],
      density: { value: "1000", unit: "kg_per_cbm" },
      unit: "kg",
      rounding: { mode: "none", decimals: 6 },
    },
    channel_code: "CAQ-HP",
    source_refs: [
      sourceRef("src_schema_input", "input@2026-08-11"),
      sourceRef("src_schema_rule", "CAQ-HP@2026-01-01"),
    ],
  };
}

function readSchema(file: string): Record<string, unknown> {
  const schemaPath = fileURLToPath(new URL(`../../docs/contracts/schemas/${file}`, import.meta.url));
  return JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
}

describe("cargo schema and trace boundary", () => {
  it("validates the existing cargo examples with the local Draft 2020-12 schemas", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    addFormats(ajv);
    for (const file of [
      "common.schema.json",
      "envelope.schema.json",
      "cargo-line.schema.json",
      "cargo-metrics.schema.json",
      "chargeable-weight.schema.json",
      "cargo-result.schema.json",
      "container-plan.schema.json",
      "quote-result.schema.json",
      "customs-search-result.schema.json",
      "customs-assessment.schema.json",
      "data-status.schema.json",
      "knowledge-search-result.schema.json",
      "write-result.schema.json",
      "review-task.schema.json",
    ]) {
      ajv.addSchema(readSchema(file));
    }
    const validator = ajv.getSchema(
      "https://schemas.example.invalid/logistics-mcp/2026-08-11/envelope.schema.json",
    );
    expect(validator).toBeDefined();
    for (const file of ["success-cargo.json", "needs-input-cargo.json"]) {
      const example = JSON.parse(
        readFileSync(fileURLToPath(new URL(`../../docs/contracts/examples/${file}`, import.meta.url)), "utf8"),
      ) as unknown;
      expect(validator!(example), `${file}: ${ajv.errorsText(validator!.errors)}`).toBe(true);
    }
  });

  it("requires every successful calculation trace step to cite known sources and versions", () => {
    const result = calculateCargo(request(), context);

    expect(result.status).toBe("success");
    expect(result.data).not.toBeNull();
    if (result.data === null || result.calculationTrace === undefined || result.sourceRefs === undefined) {
      throw new Error("expected a complete cargo success outcome");
    }
    const sourceIds = new Set(result.sourceRefs.map((source) => source.source_id));
    expect(result.calculationTrace.length).toBeGreaterThan(0);
    for (const step of result.calculationTrace) {
      expect(step.source_ref_ids.length).toBeGreaterThan(0);
      expect(new Set(step.source_ref_ids).size).toBe(step.source_ref_ids.length);
      expect(step.source_ref_ids.every((sourceId) => sourceIds.has(sourceId))).toBe(true);
    }
    const data = result.data;
    const metrics = data.metrics as Record<string, unknown>;
    const chargeable = data.chargeable_weight as Record<string, unknown>;
    expect(data.version).toMatch(/@/);
    expect(metrics.version).toMatch(/@/);
    expect(chargeable.version).toMatch(/@/);
    expect(chargeable.rule_version).toBe("CAQ-HP@2026-01-01");
    validateCargoOutput(result.data);
  });

  it("rejects JavaScript numbers in decimal-string output fields", () => {
    expect(() =>
      validateCargoOutput({
        version: "cargo-result@2026-08-11.v1",
        metrics: {
          version: "cargo-metrics@2026-08-11.v1",
          line_count: 1,
          total_quantity: 1,
          total_volume: { value: 0.24, unit: "cbm" },
          actual_weight: { value: "25", unit: "kg" },
          volumetric_weight: { value: "240", unit: "kg" },
          weight_evidence: "unit_weight",
          derived_from_line_ids: ["line_schema_1"],
        },
        chargeable_weight: {
          version: "chargeable-weight@2026-08-11.v1",
          actual_weight: { value: "25", unit: "kg" },
          volumetric_weight: { value: "240", unit: "kg" },
          bubble_weight: { value: "215", unit: "kg" },
          customer_chargeable_weight: { value: "240", unit: "kg" },
          supplier_chargeable_weight: { value: "240", unit: "kg" },
          bubble_share_ratio: "1",
          method: "full",
          rule_version: "CAQ-HP@2026-01-01",
          source_ref_ids: ["src_schema_rule"],
        },
      }),
    ).toThrow();
  });

  it("rejects duplicate top-level source references in the strict input contract", () => {
    const input = request();
    const duplicateSources = [input.source_refs[0], input.source_refs[0]];

    expect(cargoInputSchema.safeParse({ ...input, source_refs: duplicateSources }).success).toBe(false);
  });
});
