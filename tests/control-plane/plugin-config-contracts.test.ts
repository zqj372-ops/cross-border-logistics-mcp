import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  PLUGIN_CONFIG_SCHEMA_VERSION,
  PLUGIN_CONFIG_REGISTRY,
  freightcomLtlConfigSpec,
  pluginConfigCreatePreviewRequestSchema,
  pluginConfigOperationResponseSchema,
  pluginConfigRegistrySchema,
  pluginConfigRequestSchema,
  pluginConfigSpecSchema,
  pluginConfigStateSchema,
  pluginConfigValidateDraftRequestSchema,
  snapshotPluginConfigInput,
  type PluginConfigCreatePreviewRequest,
  type PluginConfigTypedValue,
} from "../../src/logistics_mcp/control-plane/plugin-config-contracts";
import { configDigestForValues } from "../../src/logistics_mcp/control-plane/plugin-config-contracts";

const schemasDirectory = fileURLToPath(
  new URL("../../schemas/admin-control/", import.meta.url),
);

const validValues: readonly PluginConfigTypedValue[] = [
  { field_id: "request_timeout_ms", kind: "integer", value: 15000 },
  { field_id: "poll_interval_ms", kind: "integer", value: 1000 },
  { field_id: "max_poll_attempts", kind: "integer", value: 10 },
  { field_id: "egress_profile_id", kind: "enum", value: "freightcom_test_fixed" },
  { field_id: "credential_slot_id", kind: "secret_slot", value: "freightcom_test_credential" },
];

type PluginConfigChangePreviewRequest = Extract<
  PluginConfigCreatePreviewRequest,
  { readonly intent: "change" }
>;

function changeRequest(
  overrides: Partial<PluginConfigChangePreviewRequest> = {},
): PluginConfigChangePreviewRequest {
  return {
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: "freightcom-ltl",
    intent: "change",
    base_revision: 0,
    values: validValues,
    ...overrides,
  };
}

function createAjv(): Ajv2020 {
  return new Ajv2020({ allErrors: true, strict: true });
}

describe("P1.5 plugin config contracts", () => {
  it("keeps a closed four-module registry and only one ConfigSpec", () => {
    expect(PLUGIN_CONFIG_REGISTRY.map((entry) => entry.module_id)).toEqual([
      "cargo",
      "container",
      "agent-access",
      "freightcom-ltl",
    ]);
    expect(PLUGIN_CONFIG_REGISTRY.filter((entry) => entry.config_spec !== null)).toHaveLength(1);
    expect(freightcomLtlConfigSpec.fields.map((field) => field.field_id)).toEqual([
      "request_timeout_ms",
      "poll_interval_ms",
      "max_poll_attempts",
      "egress_profile_id",
      "credential_slot_id",
    ]);
    expect(freightcomLtlConfigSpec.production_eligible).toBe(false);
    expect(freightcomLtlConfigSpec.manual_review).toBe(true);
    expect(Object.isFrozen(PLUGIN_CONFIG_REGISTRY)).toBe(true);
    expect(Object.isFrozen(freightcomLtlConfigSpec)).toBe(true);
    expect(pluginConfigRegistrySchema.parse(PLUGIN_CONFIG_REGISTRY)).toEqual(PLUGIN_CONFIG_REGISTRY);
    expect(() => pluginConfigSpecSchema.parse({
      ...freightcomLtlConfigSpec,
      endpoint_url: "https://not-allowed.example",
    })).toThrow();
  });

  it("matches checked-in Draft 2020-12 schemas for registry, requests, state and responses", () => {
    const ajv = createAjv();
    const registrySchema = JSON.parse(
      readFileSync(join(schemasDirectory, "plugin-config-spec.schema.json"), "utf8"),
    ) as object;
    const requestSchema = JSON.parse(
      readFileSync(join(schemasDirectory, "plugin-config-request.schema.json"), "utf8"),
    ) as object;
    const stateSchema = JSON.parse(
      readFileSync(join(schemasDirectory, "plugin-config-state.schema.json"), "utf8"),
    ) as object;
    const operationSchema = JSON.parse(
      readFileSync(join(schemasDirectory, "plugin-config-operation.schema.json"), "utf8"),
    ) as object;
    const validateRegistry = ajv.compile(registrySchema);
    const validateRequest = ajv.compile(requestSchema);
    const validateState = ajv.compile(stateSchema);
    const validateOperation = ajv.compile(operationSchema);

    expect(validateRegistry(PLUGIN_CONFIG_REGISTRY)).toBe(true);
    const request = changeRequest();
    expect(pluginConfigCreatePreviewRequestSchema.parse(request)).toEqual(request);
    expect(validateRequest(request)).toBe(true);
    expect(pluginConfigValidateDraftRequestSchema.parse({
      schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
      module_id: "freightcom-ltl",
      base_revision: 0,
      values: validValues,
    })).toBeTruthy();
    expect(validateRequest({
      schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
      module_id: "freightcom-ltl",
      base_revision: 0,
      values: validValues,
    })).toBe(true);

    const state = {
      schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
      module_id: "freightcom-ltl",
      status: "success",
      config_spec: freightcomLtlConfigSpec,
      current_revision: 0,
      current_config_digest: null,
      current_module_generation: null,
      current_values: validValues,
      current_readback: null,
      latest_validation: null,
      latest_preview: null,
      latest_approval: null,
      latest_release: null,
      allowed_actions: ["validate_draft", "create_preview"],
      reason_codes: [],
      events: [],
      events_truncated: false,
    };
    expect(pluginConfigStateSchema.parse(state)).toEqual(state);
    expect(validateState(state)).toBe(true);

    const operation = {
      schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
      action: "validate_draft",
      request_id: "req_plugin_config_contract_001",
      status: "success",
      data: {
        kind: "validation",
        validation_id: "validation_contract_001",
        module_id: "freightcom-ltl",
        base_revision: 0,
        config_digest: configDigestForValues(validValues),
        values: validValues,
        restart_policy: "controlled_restart",
        validation_status: "validated",
      },
      reason_codes: [],
      replayed: false,
    };
    expect(pluginConfigOperationResponseSchema.parse(operation)).toEqual(operation);
    expect(validateOperation(operation)).toBe(true);
  });

  it("rejects unknown fields, wrong kinds, URL-like values and non-plain inputs before traps", () => {
    const unknownField = changeRequest({
      values: [...validValues, { field_id: "endpoint_url", kind: "enum", value: "https://evil.example" }],
    });
    expect(pluginConfigCreatePreviewRequestSchema.safeParse(unknownField).success).toBe(true);
    expect(() => snapshotPluginConfigInput(unknownField)).not.toThrow();

    expect(pluginConfigValidateDraftRequestSchema.safeParse({
      schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
      module_id: "freightcom-ltl",
      base_revision: 0,
      values: [
        ...validValues.slice(0, 4),
        { field_id: "credential_slot_id", kind: "secret_slot", value: "https://evil.example/key" },
      ],
    }).success).toBe(true);

    expect(pluginConfigRequestSchema.safeParse({
      ...changeRequest(),
      desired_config: { endpoint_url: "https://evil.example" },
    }).success).toBe(false);

    let traps = 0;
    const proxy = new Proxy(changeRequest(), {
      get() {
        traps += 1;
        throw new Error("proxy trap");
      },
      ownKeys() {
        traps += 1;
        throw new Error("proxy trap");
      },
    });
    expect(() => snapshotPluginConfigInput(proxy)).toThrow(/proxy/u);
    expect(traps).toBe(0);

    const accessorInput = changeRequest();
    Object.defineProperty(accessorInput, "module_id", {
      configurable: true,
      enumerable: true,
      get() {
        traps += 1;
        return "freightcom-ltl";
      },
    });
    expect(() => snapshotPluginConfigInput(accessorInput)).toThrow(/accessor/u);
    expect(traps).toBe(0);
  });

  it("uses domain-separated digesting over sorted typed values", () => {
    const forward = configDigestForValues(validValues);
    const reverse = configDigestForValues([...validValues].reverse());
    expect(forward).toBe(reverse);
    expect(forward).toMatch(/^mcp-plugin-config-hash\/v1\/config\/sha256:[a-f0-9]{64}$/u);
    const changed = validValues.map((value): PluginConfigTypedValue =>
      value.field_id === "request_timeout_ms" && value.kind === "integer"
        ? { ...value, value: 16000 }
        : value,
    );
    expect(configDigestForValues(changed)).not.toBe(forward);
  });
});
