import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  approvalRequestSchema,
  controlEnvelopeSchema,
  deploymentPreviewRequestSchema,
  publishRequestSchema,
  reconcileRequestSchema,
  registerPackageRequestSchema,
} from "../../src/logistics_mcp/control-plane/contracts";

const rootDir = resolve(import.meta.dirname, "../..");
const schemaDir = resolve(rootDir, "schemas/admin-control");
const schemaNames = [
  "register-package-request.schema.json",
  "deployment-preview-request.schema.json",
  "approval-request.schema.json",
  "publish-request.schema.json",
  "reconcile-request.schema.json",
  "control-envelope.schema.json",
] as const;

const validRequests = [
  {
    schemaName: "register-package-request.schema.json",
    schema: registerPackageRequestSchema,
    json: {
      schema_version: "2026-08-22.v1",
      module_id: "cargo",
      version: "2026-08-21.v0",
      descriptor_digest: `sha256:${"a".repeat(64)}`,
    },
  },
  {
    schemaName: "deployment-preview-request.schema.json",
    schema: deploymentPreviewRequestSchema,
    json: {
      schema_version: "2026-08-22.v1",
      intent: "change",
      desired_modules: [
        {
          module_id: "cargo",
          version: "2026-08-21.v0",
          descriptor_digest: `sha256:${"a".repeat(64)}`,
        },
      ],
    },
  },
  {
    schemaName: "deployment-preview-request.schema.json",
    schema: deploymentPreviewRequestSchema,
    json: {
      schema_version: "2026-08-22.v1",
      intent: "rollback",
      target_release_id: "release_2026_08_22_001",
    },
  },
  {
    schemaName: "approval-request.schema.json",
    schema: approvalRequestSchema,
    json: {
      schema_version: "2026-08-22.v1",
      preview_ref: "preview_2026_08_22_001",
      decision: "approve",
      reason_code: "release_reviewed",
    },
  },
  {
    schemaName: "publish-request.schema.json",
    schema: publishRequestSchema,
    json: {
      schema_version: "2026-08-22.v1",
      preview_ref: "preview_2026_08_22_001",
      approval_id: "approval_2026_08_22_001",
    },
  },
  {
    schemaName: "reconcile-request.schema.json",
    schema: reconcileRequestSchema,
    json: {
      schema_version: "2026-08-22.v1",
      release_id: "release_2026_08_22_001",
    },
  },
] as const;

const validEnvelope = {
  schema_version: "2026-08-22.v1",
  request_id: "request_2026_08_22_001",
  trace_id: "trace_2026_08_22_001",
  audit_id: "audit_2026_08_22_001",
  status: "success",
  data: { kind: "registration", module_id: "cargo" },
  reason_codes: [],
  readback: {
    status: "not_applicable",
    release_id: null,
    revision: null,
  },
} as const;

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

describe("admin control contracts", () => {
  it("declares every checked-in schema as a closed Draft 2020-12 object", () => {
    const ajv = createAjv();

    for (const schemaName of schemaNames) {
      const schema = JSON.parse(
        readFileSync(resolve(schemaDir, schemaName), "utf8"),
      ) as Record<string, unknown>;

      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(() => ajv.compile(schema)).not.toThrow();
    }
  });

  it("rejects identity, URL, path, source, and secret fields in every request", () => {
    const ajv = createAjv();
    const forbiddenFields = [
      "tenant_id",
      "actor_id",
      "role",
      "scope",
      "url",
      "path",
      "source",
      "token",
      "secret",
    ] as const;

    const validators = new Map(
      schemaNames.map((schemaName) => {
        const schema = JSON.parse(
          readFileSync(resolve(schemaDir, schemaName), "utf8"),
        ) as Record<string, unknown>;
        return [schemaName, ajv.compile(schema)] as const;
      }),
    );

    for (const { schemaName, schema, json } of validRequests) {
      expect(schema.safeParse(json).success).toBe(true);
      expect(validators.get(schemaName)?.(json)).toBe(true);
      for (const field of forbiddenFields) {
        const candidate = { ...json, [field]: "must-not-be-client-controlled" };
        expect(schema.safeParse(candidate).success).toBe(false);
        expect(validators.get(schemaName)?.(candidate)).toBe(false);
      }
    }
  });

  it("accepts only the documented request union and rejects cross-branch fields", () => {
    for (const { schema, json } of validRequests) {
      expect(schema.safeParse(json).success).toBe(true);
    }

    expect(deploymentPreviewRequestSchema.safeParse({
      schema_version: "2026-08-22.v1",
      intent: "change",
      desired_modules: [],
      target_release_id: "release_should_not_be_here",
    }).success).toBe(false);
    expect(deploymentPreviewRequestSchema.safeParse({
      schema_version: "2026-08-22.v1",
      intent: "rollback",
      target_release_id: "release_2026_08_22_001",
      desired_modules: [],
    }).success).toBe(false);
    expect(deploymentPreviewRequestSchema.safeParse({
      schema_version: "2026-08-22.v1",
      intent: "change",
    }).success).toBe(false);
    expect(deploymentPreviewRequestSchema.safeParse({
      schema_version: "2026-08-22.v1",
      intent: "rollback",
    }).success).toBe(false);

    const deploymentSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "deployment-preview-request.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateDeployment = createAjv().compile(deploymentSchema);
    expect(validateDeployment(validRequests[1].json)).toBe(true);
    expect(validateDeployment({
      schema_version: "2026-08-22.v1",
      intent: "change",
      desired_modules: [],
      target_release_id: "release_should_not_be_here",
    })).toBe(false);
    expect(validateDeployment({
      schema_version: "2026-08-22.v1",
      intent: "rollback",
      target_release_id: "release_2026_08_22_001",
      desired_modules: [],
    })).toBe(false);

    const malformedRegister = {
      ...validRequests[0].json,
      descriptor_digest: "sha256:not-a-digest",
    };
    expect(registerPackageRequestSchema.safeParse(malformedRegister).success).toBe(false);
    const registerSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "register-package-request.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(createAjv().compile(registerSchema)(malformedRegister)).toBe(false);
  });

  it("keeps the response envelope closed and limited to the five platform statuses", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);

    const statuses = [
      "success",
      "needs_input",
      "manual_review",
      "blocked",
      "unavailable",
    ] as const;

    for (const status of statuses) {
      expect(controlEnvelopeSchema.safeParse({ ...validEnvelope, status }).success).toBe(true);
      expect(validateEnvelope({ ...validEnvelope, status })).toBe(true);
    }
    expect(controlEnvelopeSchema.safeParse({ ...validEnvelope, status: "accepted" }).success).toBe(false);
    expect(validateEnvelope({ ...validEnvelope, status: "accepted" })).toBe(false);
    expect(controlEnvelopeSchema.safeParse({ ...validEnvelope, tenant_id: "not-allowed" }).success).toBe(false);
    expect(validateEnvelope({ ...validEnvelope, tenant_id: "not-allowed" })).toBe(false);
    expect(controlEnvelopeSchema.safeParse({
      ...validEnvelope,
      data: { kind: "registration", secret: "not-allowed" },
    }).success).toBe(false);
    expect(validateEnvelope({
      ...validEnvelope,
      data: { kind: "registration", secret: "not-allowed" },
    })).toBe(false);
    expect(controlEnvelopeSchema.safeParse({
      ...validEnvelope,
      readback: { status: "verified", release_id: "release_1", revision: 1, extra: true },
    }).success).toBe(false);
    expect(validateEnvelope({
      ...validEnvelope,
      readback: { status: "verified", release_id: "release_1", revision: 1, extra: true },
    })).toBe(false);
    expect(controlEnvelopeSchema.safeParse({
      ...validEnvelope,
      audit_id: undefined,
    }).success).toBe(false);
    expect(validateEnvelope({
      ...validEnvelope,
      audit_id: undefined,
    })).toBe(false);
  });

  it("rejects malformed preview datetimes in both runtime and JSON Schema contracts", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const malformed = {
      ...validEnvelope,
      data: { kind: "preview", expires_at: "not-a-date" },
    };

    expect(controlEnvelopeSchema.safeParse(malformed).success).toBe(false);
    expect(validateEnvelope(malformed)).toBe(false);
  });

  it("rejects every revision above the JavaScript safe-integer maximum", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const unsafeRevision = 9_007_199_254_740_992;
    const candidates = [
      { ...validEnvelope, data: { kind: "control_state", active_revision: unsafeRevision } },
      { ...validEnvelope, data: { kind: "preview", base_revision: unsafeRevision } },
      { ...validEnvelope, data: { kind: "release", revision: unsafeRevision } },
      { ...validEnvelope, data: { kind: "reconciliation", revision: unsafeRevision } },
      {
        ...validEnvelope,
        readback: { status: "verified", release_id: "release_1", revision: unsafeRevision },
      },
    ];

    for (const candidate of candidates) {
      expect(controlEnvelopeSchema.safeParse(candidate).success).toBe(false);
      expect(validateEnvelope(candidate)).toBe(false);
    }
  });
});
