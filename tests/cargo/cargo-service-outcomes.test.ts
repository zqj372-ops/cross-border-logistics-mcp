import { describe, expect, it } from "vitest";

import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  executeRegisteredToolWithResult,
  registerPhaseOneTools,
} from "../../src/logistics_mcp/server/tool-registry";
import {
  calculateCargo,
} from "../../src/logistics_mcp/domains/cargo/service";
import {
  cargoToolContract,
  cargoToolHandler,
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
    locator: sourceId.includes("rule") ? "channel/CAQ-HP/dimensional-weight" : "opaque://request/demo",
    version,
    retrieved_at: "2026-08-11T09:00:00Z",
    authority: sourceId.includes("rule") ? "authoritative" : "user_provided",
    content_hash: `sha256:${sourceId.replace(/[^A-Za-z0-9]/g, "")}`,
  };
}

function cargoLine(overrides: Record<string, unknown> = {}) {
  return {
    version: "cargo-line@2026-08-11.v1",
    line_id: "line_1",
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
    source_ref_ids: ["src_input_1"],
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "2026-08-11.v1",
    version: "cargo.calculate@2026-08-11.v1",
    cargo_lines: [cargoLine()],
    dimensional_divisor: null,
    bubble_rule: {
      channel: "CAQ-HP",
      mode: "full",
      ratio: null,
      rule_version: "CAQ-HP@2026-01-01",
      source_ref_ids: ["src_rule_1"],
      density: { value: "1000", unit: "kg_per_cbm" },
      unit: "kg",
      rounding: { mode: "none", decimals: 6 },
    },
    channel_code: "CAQ-HP",
    source_refs: [
      sourceRef("src_input_1", "input@2026-08-11"),
      sourceRef("src_rule_1", "CAQ-HP@2026-01-01"),
    ],
    ...overrides,
  };
}

describe("cargo.calculate service outcomes", () => {
  it("returns a versioned success with complete metrics, chargeable weight, sources, and trace", () => {
    const result = calculateCargo(request(), context);

    expect(result.status).toBe("success");
    expect(result.data).not.toBeNull();
    if (result.data === null) {
      throw new Error("expected cargo data");
    }
    expect(result.data.version).toBe("cargo-result@2026-08-11.v1");
    const data = result.data as {
      metrics: {
        total_volume: { value: string; unit: string };
        actual_weight: { value: string; unit: string };
        volumetric_weight: { value: string; unit: string };
      };
      chargeable_weight: {
        customer_chargeable_weight: { value: string; unit: string };
      };
    };
    expect(data.metrics.total_volume).toEqual({ value: "0.240000", unit: "cbm" });
    expect(data.metrics.actual_weight).toEqual({ value: "25.0", unit: "kg" });
    expect(data.metrics.volumetric_weight).toEqual({ value: "240", unit: "kg" });
    expect(data.chargeable_weight.customer_chargeable_weight).toEqual({ value: "240", unit: "kg" });
    expect(result.sourceRefs).toHaveLength(2);
    expect(result.calculationTrace).toBeDefined();
    expect(result.calculationTrace!.length).toBeGreaterThan(5);
    expect(result.calculationTrace!.every((step) => step.source_ref_ids.length > 0)).toBe(true);
    expect(result.blockers ?? []).toHaveLength(0);
  });

  it("returns needs_input and no numeric result when weight evidence is missing", () => {
    const result = calculateCargo(
      request({ cargo_lines: [cargoLine({ unit_weight: undefined })] }),
      context,
    );

    expect(result).toMatchObject({ status: "needs_input", data: null });
    expect(result.blockers?.some((blocker) => blocker.field?.includes("weight"))).toBe(true);
  });

  it("returns manual_review and no numeric result for mixed weight evidence", () => {
    const result = calculateCargo(
      request({
        cargo_lines: [
          cargoLine({ line_total_weight: { value: "25", unit: "kg" } }),
        ],
      }),
      context,
    );

    expect(result).toMatchObject({ status: "manual_review", data: null });
    expect(result.blockers?.some((blocker) => blocker.code === "cargo.weight_evidence_mixed")).toBe(true);
  });

  it("returns needs_input when the dimensional basis is not versioned and explicit", () => {
    const incomplete = request({
      bubble_rule: {
        mode: "full",
        ratio: null,
        rule_version: "",
      },
    });
    const result = calculateCargo(incomplete, context);

    expect(result).toMatchObject({ status: "needs_input", data: null });
    expect(result.blockers?.some((blocker) => blocker.code === "cargo.rule_version_missing")).toBe(true);
  });

  it("binds a strict Zod input schema and rejects unknown fields and numeric decimal values", () => {
    expect(cargoToolContract.inputSchema.safeParse(request()).success).toBe(true);
    expect(
      cargoToolContract.inputSchema.safeParse({ ...request(), unexpected: true }).success,
    ).toBe(false);
    expect(
      cargoToolContract.inputSchema.safeParse(
        request({
          cargo_lines: [cargoLine({ unit_weight: { value: 12.5, unit: "kg" } })],
        }),
      ).success,
    ).toBe(false);
  });

  it("injects only cargo.calculate handler and contract into the phase-one registry", () => {
    const definitions = registerPhaseOneTools(
      { "cargo.calculate": cargoToolHandler },
      { "cargo.calculate": cargoToolContract },
    );
    const cargoDefinition = definitions.find((definition) => definition.name === "cargo.calculate");

    expect(cargoDefinition?.handler).toBe(cargoToolHandler);
    expect(cargoDefinition?.inputSchema).toBe(cargoToolContract.inputSchema);
    expect(cargoDefinition?.validateOutput).toBe(cargoToolContract.validateOutput);
    expect(definitions.filter((definition) => definition.handler !== undefined)).toHaveLength(1);
    expect(definitions.filter((definition) => definition.name !== "cargo.calculate" && definition.inputSchema !== undefined)).toHaveLength(0);
  });

  it("executes through the existing platform registry and validates the cargo output contract", async () => {
    const definition = registerPhaseOneTools(
      { "cargo.calculate": cargoToolHandler },
      { "cargo.calculate": cargoToolContract },
    ).find((candidate) => candidate.name === "cargo.calculate");
    const result = await executeRegisteredToolWithResult(definition!, request(), context, {
      requestId: "req_cargo_service_001",
      auditId: "audit_cargo_service_001",
    });

    expect(result.envelope.status).toBe("success");
    expect(result.envelope.data).not.toBeNull();
    if (result.envelope.data === null) {
      throw new Error("expected envelope data");
    }
    const envelopeData = result.envelope.data;
    expect(() => cargoToolContract.validateOutput(envelopeData)).not.toThrow();
    expect(() =>
      cargoToolContract.validateOutput({
        ...envelopeData,
        metrics: {
          ...(envelopeData.metrics as Record<string, unknown>),
          actual_weight: { value: 25, unit: "kg" },
        },
      }),
    ).toThrow();
  });
});
