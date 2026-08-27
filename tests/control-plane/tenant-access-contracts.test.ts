import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  acknowledgeCredentialDeliveryRequestSchema,
  createTenantRequestSchema,
  issueCredentialRequestSchema,
  normalizeStoredTenantApiKeyScopes,
  revokeCredentialRequestSchema,
  rotateCredentialRequestSchema,
  setTenantStatusRequestSchema,
  TENANT_ACCESS_SCHEMA_VERSION,
  TENANT_API_KEY_TOOL_CATALOG,
} from "../../src/logistics_mcp/control-plane/tenant-access-contracts";

const schemaDir = resolve(import.meta.dirname, "../../schemas/admin-control");
const schemas = {
  create: ["tenant-create-request.schema.json", createTenantRequestSchema],
  status: ["tenant-status-request.schema.json", setTenantStatusRequestSchema],
  issue: ["credential-issue-request.schema.json", issueCredentialRequestSchema],
  rotate: ["credential-rotate-request.schema.json", rotateCredentialRequestSchema],
  revoke: ["credential-revoke-request.schema.json", revokeCredentialRequestSchema],
  acknowledge: [
    "credential-delivery-ack-request.schema.json",
    acknowledgeCredentialDeliveryRequestSchema,
  ],
} as const;

function readSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(schemaDir, name), "utf8")) as Record<string, unknown>;
}

const validRequests = {
  create: {
    schema_version: TENANT_ACCESS_SCHEMA_VERSION,
    tenant_id: "tenant_demo_a",
    display_name: "北美演示租户",
  },
  status: {
    schema_version: TENANT_ACCESS_SCHEMA_VERSION,
    status: "suspended",
    reason_code: "operator_suspended",
  },
  issue: {
    schema_version: TENANT_ACCESS_SCHEMA_VERSION,
    tenant_id: "tenant_demo_a",
    client_id: "codex_ops",
    label: "运营 Codex",
    tool_names: ["cargo.calculate", "container.plan_summary"],
    expires_in_seconds: 86_400,
  },
  rotate: {
    schema_version: TENANT_ACCESS_SCHEMA_VERSION,
    tool_names: ["system.agent_context.get"],
    expires_in_seconds: 86_400,
    reason_code: "scheduled_rotation",
  },
  revoke: {
    schema_version: TENANT_ACCESS_SCHEMA_VERSION,
    reason_code: "operator_revoked",
  },
  acknowledge: {
    schema_version: TENANT_ACCESS_SCHEMA_VERSION,
    reason_code: "operator_confirmed_secure_storage",
  },
} as const;

describe("Tenant Access Draft 2020-12 contracts", () => {
  it("keeps exact tool scopes and rejects broad legacy scopes", () => {
    expect(normalizeStoredTenantApiKeyScopes(["tool:cargo.calculate"])).toEqual([
      "tool:cargo.calculate",
    ]);
    expect(normalizeStoredTenantApiKeyScopes(["quote:calculate"])).toBeNull();
    expect(normalizeStoredTenantApiKeyScopes([
      "quote:calculate",
      "tool:cargo.calculate",
    ])).toBeNull();
    expect(normalizeStoredTenantApiKeyScopes(["platform:admin"])).toBeNull();
  });

  it("keeps every request schema closed and aligned with Zod", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    for (const [kind, [file, runtimeSchema]] of Object.entries(schemas)) {
      const validate = ajv.compile(readSchema(file));
      const valid = validRequests[kind as keyof typeof validRequests];
      expect(validate(valid), `${file} should accept its valid request`).toBe(true);
      expect(runtimeSchema.safeParse(valid).success).toBe(true);
      const extra = { ...valid, tenant_override: "forbidden" };
      expect(validate(extra), `${file} must reject unknown fields`).toBe(false);
      expect(runtimeSchema.safeParse(extra).success).toBe(false);
    }
  });

  it("validates redacted state and one-time credential envelopes", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(readSchema("tenant-access-envelope.schema.json"));
    const tenant = {
      tenant_id: "tenant_demo_a",
      display_name: "北美演示租户",
      status: "active",
      created_at: "2026-08-27T00:00:00.000Z",
      updated_at: "2026-08-27T00:00:00.000Z",
      allowed_actions: ["suspend"],
    };
    const credential = {
      credential_id: "key_00000001",
      tenant_id: "tenant_demo_a",
      client_id: "codex_ops",
      label: "运营 Codex",
      actor_role: "service",
      roles: ["service"],
      tool_names: ["system.agent_context.get"],
      status: "active",
      delivery_status: "pending",
      delivery_acknowledged_at: null,
      effective_status: "pending_delivery",
      allowed_actions: ["acknowledge_delivery", "revoke"],
      key_prefix: "lmcpk_key_00000001",
      secret_last_four: "AAAA",
      created_at: "2026-08-27T00:00:00.000Z",
      expires_at: 1_802_505_600,
      last_used_at: null,
      revoked_at: null,
      rotated_from_id: null,
    };
    const state = {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      status: "success",
      data: {
        available_tools: TENANT_API_KEY_TOOL_CATALOG,
        tenants: [tenant],
        credentials: [credential],
        operations: [],
      },
      reason_codes: [],
    };
    expect(validate(state), JSON.stringify(validate.errors)).toBe(true);

    const issued = {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      status: "success",
      replayed: false,
      data: {
        credential,
        api_key: `lmcpk_key_00000001_${"A".repeat(43)}`,
        operation: {
          operation_id: "event_00000001",
          tenant_id: "tenant_demo_a",
          credential_id: "key_00000001",
          actor_ref: "admin_operator:admin_console",
          action: "credential.issue",
          from_status: "absent",
          to_status: "pending_delivery",
          status: "success",
          reason_code: "operator_issued",
          created_at: "2026-08-27T00:00:00.000Z",
        },
      },
      reason_codes: [],
      secret_delivery: { status: "one_time", credential_id: "key_00000001" },
    };
    expect(validate(issued), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      ...state,
      data: {
        ...state.data,
        credentials: [{ ...credential, secret_hash: "must-not-leak" }],
      },
    })).toBe(false);
    expect(validate({
      ...state,
      data: {
        ...state.data,
        credentials: [{ ...credential, tool_names: ["quote.save_draft"] }],
      },
    }), "credential tools must stay inside the server allowlist").toBe(false);
    expect(validate({
      ...issued,
      data: {
        ...issued.data,
        operation: { ...issued.data.operation, to_status: "active" },
      },
    }), "issue must terminate at pending_delivery").toBe(false);
    expect(validate({
      ...state,
      data: {
        ...state.data,
        credentials: [{ ...credential, allowed_actions: ["rotate", "revoke"] }],
      },
    }), "pending delivery must not allow rotation").toBe(false);
    expect(validate({
      ...state,
      data: {
        ...state.data,
        tenants: [{ ...tenant, allowed_actions: ["activate"] }],
      },
    }), "active tenant must only allow suspension").toBe(false);
  });
});
