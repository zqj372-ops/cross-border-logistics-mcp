import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import * as controlContracts from "../../src/logistics_mcp/control-plane/contracts";

const {
  ADMIN_CONTROL_RFC3339_PATTERN,
  approvalRequestSchema,
  controlEnvelopeSchema,
  deploymentPreviewRequestSchema,
  publishRequestSchema,
  reconcileRequestSchema,
  registerPackageRequestSchema,
} = controlContracts;

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

const validModuleRef = {
  module_id: "cargo",
  version: "2026-08-21.v0",
  descriptor_digest: `sha256:${"a".repeat(64)}`,
} as const;

const secondModuleRef = {
  module_id: "container",
  version: "2026-08-21.v0",
  descriptor_digest: `sha256:${"b".repeat(64)}`,
} as const;

const validControlState = {
  kind: "control_state",
  activation: {
    state: "active",
    release_id: "release_2026_08_22_003",
    revision: 3,
    active_modules: [validModuleRef],
  },
  inventory_modules: [
    {
      module_id: "cargo",
      version: "2026-08-21.v0",
      risk_level: "T0",
      descriptor_digest: validModuleRef.descriptor_digest,
      evidence_level: "local_build",
      production_eligible: false,
      tool_names: ["cargo.calculate"],
      standard_ids: ["cargo.contract.v1"],
      registration: {
        registered_by_actor_ref: "actor_operator",
        registered_at: "2026-08-22T17:30:00Z",
      },
    },
    {
      module_id: "container",
      version: "2026-08-21.v0",
      risk_level: "T1",
      descriptor_digest: secondModuleRef.descriptor_digest,
      evidence_level: "local_build",
      production_eligible: false,
      tool_names: ["container.plan"],
      standard_ids: ["container.contract.v1"],
      registration: null,
    },
  ],
  latest_preview: {
    intent: "change",
    preview_ref: "preview_2026_08_22_003",
    canonical_hash: `mcp-control-hash/v1/preview/sha256:${"c".repeat(64)}`,
    base_release_id: "release_2026_08_22_003",
    base_revision: 3,
    desired_modules: [validModuleRef],
    diff: {
      added: [],
      removed: [secondModuleRef],
      retained: [validModuleRef],
    },
    validation: {
      base_matches: true,
      desired_modules_valid: true,
      inventory_matches: true,
      minimum_active_modules: true,
      reason_codes: [],
    },
    creator_actor_ref: "actor_operator",
    created_at: "2026-08-22T17:30:00Z",
    expires_at: "2026-08-22T18:30:00Z",
    consumed: false,
  },
  latest_approval: {
    approval_id: "approval_2026_08_22_003",
    preview_ref: "preview_2026_08_22_003",
    decision: "approve",
    reason_code: "release_reviewed",
    approver_actor_ref: "actor_approver",
    decided_at: "2026-08-22T17:35:00Z",
    consumed: false,
  },
  latest_readback: {
    release_id: "release_2026_08_22_003",
    revision: 3,
    readback_ref: "readback_2026_08_22_003",
    applied_modules: [validModuleRef],
    status: "verified",
    reason_codes: [],
    checked_at: "2026-08-22T17:40:00Z",
  },
  release_history: [
    {
      release_id: "release_2026_08_22_003",
      revision: 3,
      desired_modules: [validModuleRef],
      previous_release_id: "release_2026-08_22_002",
      preview_ref: "preview_2026_08_22_003",
      approval_id: "approval_2026_08_22_003",
      publisher_actor_ref: "actor_operator",
      intent: "change",
      status: "active_verified",
      created_at: "2026-08-22T17:35:00Z",
      published_at: "2026-08-22T17:40:00Z",
      readback_ref: "readback_2026_08_22_003",
      reason_codes: [],
      superseded_by_release_id: null,
    },
  ],
  events: [
    {
      sequence: 1,
      event_id: "event_2026_08_22_003",
      actor_ref: "actor_operator",
      action: "deployments.preview",
      object_ref: "preview_2026_08_22_003",
      kind: "preview",
      status: "previewed",
      reason_codes: [],
      occurred_at: "2026-08-22T17:30:00Z",
    },
  ],
  events_truncated: false,
} as const;

function createPreReviewControlState() {
  return {
    kind: "control_state",
    active_release_id: validControlState.activation.release_id,
    active_revision: validControlState.activation.revision,
    active_modules: validControlState.activation.active_modules,
    inventory_modules: validControlState.inventory_modules.map((module) => ({
      module_id: module.module_id,
      version: module.version,
      risk_level: module.risk_level,
      descriptor_digest: module.descriptor_digest,
      evidence_level: module.evidence_level,
      production_eligible: module.production_eligible,
      registration: module.registration,
    })),
    latest_preview: validControlState.latest_preview,
    latest_approval: validControlState.latest_approval,
    latest_readback: {
      ...validControlState.latest_readback,
      applied_release_id: validControlState.latest_readback.release_id,
      applied_revision: validControlState.latest_readback.revision,
    },
    release_history: validControlState.release_history.map((release) => ({
      release_id: release.release_id,
      revision: release.revision,
      desired_modules: release.desired_modules,
      previous_release_id: release.previous_release_id,
      preview_ref: release.preview_ref,
      approval_id: release.approval_id,
      publisher_actor_ref: release.publisher_actor_ref,
      status: release.status,
      created_at: release.created_at,
      published_at: release.published_at,
      readback_ref: release.readback_ref,
      reason_codes: release.reason_codes,
      superseded_by_release_id: release.superseded_by_release_id,
    })),
    events: validControlState.events,
    events_truncated: validControlState.events_truncated,
  };
}

const validControlDataCases = [
  {
    kind: "control_state",
    data: validControlState,
  },
  {
    kind: "registration",
    data: {
      kind: "registration",
      module_id: "cargo",
      version: "2026-08-21.v0",
      descriptor_digest: `sha256:${"a".repeat(64)}`,
      evidence_level: "local_build",
      production_eligible: false,
    },
  },
  {
    kind: "preview",
    data: {
      kind: "preview",
      preview_ref: "preview_2026_08_22_001",
      intent: "change",
      base_release_id: null,
      base_revision: 0,
      desired_modules: [validModuleRef],
      target_release_id: null,
      expires_at: "2026-08-22T17:54:00Z",
    },
  },
  {
    kind: "approval",
    data: {
      kind: "approval",
      approval_id: "approval_2026_08_22_001",
      preview_ref: "preview_2026_08_22_001",
      decision: "approve",
    },
  },
  {
    kind: "release",
    data: {
      kind: "release",
      release_id: "release_2026_08_22_001",
      revision: 1,
      active_modules: [validModuleRef],
    },
  },
  {
    kind: "reconciliation",
    data: {
      kind: "reconciliation",
      release_id: "release_2026_08_22_001",
      revision: 1,
      status: "verified",
    },
  },
] as const;

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

  it("keeps every control data variant in parity between Zod and checked-in Ajv", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);

    for (const { kind, data } of validControlDataCases) {
      const candidate = { ...validEnvelope, data };
      expect(controlEnvelopeSchema.safeParse(candidate).success, `${kind}: Zod valid`).toBe(true);
      expect(validateEnvelope(candidate), `${kind}: Ajv valid`).toBe(true);

      const withUnknownField = {
        ...validEnvelope,
        data: { ...data, unknown_control_field: true },
      };
      expect(controlEnvelopeSchema.safeParse(withUnknownField).success, `${kind}: Zod unknown`).toBe(false);
      expect(validateEnvelope(withUnknownField), `${kind}: Ajv unknown`).toBe(false);
    }
  });

  it("rejects the pre-review null release with positive active revision", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const candidate = {
      ...validEnvelope,
      data: {
        ...createPreReviewControlState(),
        active_release_id: null,
        active_revision: 1,
        active_modules: [validModuleRef],
      },
    };

    expect(controlEnvelopeSchema.safeParse(candidate).success, "Zod").toBe(false);
    expect(validateEnvelope(candidate), "Ajv").toBe(false);
  });

  it("rejects the pre-review verified readback whose applied identity differs", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const preReviewState = createPreReviewControlState();
    const candidate = {
      ...validEnvelope,
      data: {
        ...preReviewState,
        latest_readback: {
          ...preReviewState.latest_readback,
          applied_release_id: "release_2026_08_22_002",
          applied_revision: 2,
        },
      },
    };

    expect(controlEnvelopeSchema.safeParse(candidate).success, "Zod").toBe(false);
    expect(validateEnvelope(candidate), "Ajv").toBe(false);
  });

  it("rejects a pre-review event with an impossible action-kind-status tuple", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const preReviewState = createPreReviewControlState();
    const candidate = {
      ...validEnvelope,
      data: {
        ...preReviewState,
        events: [{
          ...preReviewState.events[0],
          action: "packages.register",
          kind: "release",
          status: "approved",
        }],
      },
    };

    expect(controlEnvelopeSchema.safeParse(candidate).success, "Zod").toBe(false);
    expect(validateEnvelope(candidate), "Ajv").toBe(false);
  });

  it("closes inactive and active activation shapes in both contract stacks", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const assertState = (data: unknown, expected: boolean, label: string): void => {
      const candidate = { ...validEnvelope, data };
      expect(controlEnvelopeSchema.safeParse(candidate).success, `${label}: Zod`).toBe(expected);
      expect(validateEnvelope(candidate), `${label}: Ajv`).toBe(expected);
    };

    assertState(validControlState, true, "active activation");
    assertState(
      {
        ...validControlState,
        activation: {
          state: "inactive",
          release_id: null,
          revision: 0,
          active_modules: [],
        },
        latest_preview: null,
        latest_approval: null,
        latest_readback: null,
        release_history: [],
        events: [],
      },
      true,
      "inactive activation",
    );

    const contradictoryPreReviewShape = {
      ...createPreReviewControlState(),
      active_release_id: null,
      active_revision: 1,
      active_modules: [validModuleRef],
    };
    assertState(
      contradictoryPreReviewShape,
      false,
      "null release with positive revision and active modules",
    );
    assertState(
      {
        ...validControlState,
        activation: {
          state: "active",
          release_id: "release_2026_08_22_003",
          revision: 3,
          active_modules: [],
        },
      },
      false,
      "active activation without modules",
    );
    assertState(
      {
        ...validControlState,
        activation: {
          state: "inactive",
          release_id: null,
          revision: 1,
          active_modules: [],
        },
      },
      false,
      "inactive activation with positive revision",
    );
    assertState(
      { ...validControlState, events_truncated: undefined },
      false,
      "authoritative events_truncated is required",
    );
  });

  it("closes readback observed pairs and removes duplicate verified identity fields", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const assertState = (data: unknown, expected: boolean, label: string): void => {
      const candidate = { ...validEnvelope, data };
      expect(controlEnvelopeSchema.safeParse(candidate).success, `${label}: Zod`).toBe(expected);
      expect(validateEnvelope(candidate), `${label}: Ajv`).toBe(expected);
    };

    assertState(validControlState, true, "verified shape implies exact target identity");
    assertState(
      {
        ...createPreReviewControlState(),
        latest_readback: {
          ...createPreReviewControlState().latest_readback,
          applied_release_id: "release_2026_08_22_002",
          applied_revision: 2,
        },
      },
      false,
      "verified repeated identity differs from target",
    );
    assertState(
      {
        ...validControlState,
        latest_readback: {
          ...validControlState.latest_readback,
          observed_activation: {
            release_id: "release_2026_08_22_002",
            revision: 2,
          },
        },
      },
      false,
      "verified branch rejects observed pair",
    );
    assertState(
      {
        ...validControlState,
        latest_readback: {
          ...validControlState.latest_readback,
          status: "mismatch",
          observed_activation: {
            release_id: "release_2026_08_22_002",
            revision: null,
          },
          reason_codes: ["runtime_readback_mismatch"],
        },
      },
      false,
      "mismatch rejects half-null observed pair",
    );
    assertState(
      {
        ...validControlState,
        latest_readback: {
          ...validControlState.latest_readback,
          status: "mismatch",
          observed_activation: { release_id: null, revision: null },
          reason_codes: ["runtime_readback_mismatch"],
        },
      },
      true,
      "mismatch accepts all-null observed pair",
    );
    assertState(
      {
        ...validControlState,
        latest_readback: {
          ...validControlState.latest_readback,
          status: "unknown",
          observed_activation: {
            release_id: "release_2026_08_22_002",
            revision: 2,
          },
          reason_codes: ["runtime_readback_unknown"],
        },
      },
      true,
      "unknown accepts complete observed pair",
    );
    assertState(
      {
        ...validControlState,
        latest_readback: { ...validControlState.latest_readback, revision: 0 },
      },
      false,
      "readback revision zero",
    );

    const invalidRootReadback = {
      ...validEnvelope,
      readback: { status: "verified", release_id: null, revision: 0 },
    };
    expect(controlEnvelopeSchema.safeParse(invalidRootReadback).success, "root readback: Zod").toBe(false);
    expect(validateEnvelope(invalidRootReadback), "root readback: Ajv").toBe(false);
  });

  it("accepts only exact action, kind, and status event combinations", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const validCombinations = [
      ["packages.register", "registration", "registered"],
      ["deployments.preview", "preview", "previewed"],
      ["approvals.decide", "approval", "approved"],
      ["approvals.decide", "approval", "rejected"],
      ["deployments.publish", "release", "published_pending_readback"],
      ["deployments.publish", "release", "manual_review"],
      ["deployments.publish", "release", "active_verified"],
      ["deployments.publish", "release", "superseded"],
      ["deployments.publish", "reconciliation", "pending"],
      ["deployments.publish", "reconciliation", "verified"],
      ["deployments.publish", "reconciliation", "mismatch"],
      ["deployments.publish", "reconciliation", "unknown"],
      ["deployments.reconcile", "reconciliation", "pending"],
      ["deployments.reconcile", "reconciliation", "verified"],
      ["deployments.reconcile", "reconciliation", "mismatch"],
      ["deployments.reconcile", "reconciliation", "unknown"],
      ...[
        "packages.register",
        "deployments.preview",
        "approvals.decide",
        "deployments.publish",
        "deployments.reconcile",
      ].flatMap((action) => [
        [action, "idempotency", "reserved"],
        [action, "idempotency", "domain_committed"],
        [action, "idempotency", "completed"],
      ]),
    ] as const;

    for (const [index, [action, kind, status]] of validCombinations.entries()) {
      const candidate = {
        ...validEnvelope,
        data: {
          ...validControlState,
          events: [{
            ...validControlState.events[0],
            sequence: index + 1,
            event_id: `event_combination_${index}`,
            action,
            kind,
            status,
          }],
        },
      };
      expect(controlEnvelopeSchema.safeParse(candidate).success, `${action}/${kind}/${status}: Zod`).toBe(true);
      expect(validateEnvelope(candidate), `${action}/${kind}/${status}: Ajv`).toBe(true);
    }

    const wrongCombinations = [
      ["packages.register", "preview", "registered"],
      ["deployments.preview", "preview", "approved"],
      ["approvals.decide", "approval", "previewed"],
      ["deployments.publish", "release", "verified"],
      ["deployments.publish", "reconciliation", "active_verified"],
      ["deployments.reconcile", "release", "manual_review"],
    ] as const;
    for (const [action, kind, status] of wrongCombinations) {
      const candidate = {
        ...validEnvelope,
        data: {
          ...validControlState,
          events: [{ ...validControlState.events[0], action, kind, status }],
        },
      };
      expect(controlEnvelopeSchema.safeParse(candidate).success, `${action}/${kind}/${status}: Zod`).toBe(false);
      expect(validateEnvelope(candidate), `${action}/${kind}/${status}: Ajv`).toBe(false);
    }
  });

  it("closes approval decisions, release intents and statuses, and duplicate module refs", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const assertState = (data: unknown, expected: boolean, label: string): void => {
      const candidate = { ...validEnvelope, data };
      expect(controlEnvelopeSchema.safeParse(candidate).success, `${label}: Zod`).toBe(expected);
      expect(validateEnvelope(candidate), `${label}: Ajv`).toBe(expected);
    };

    assertState(
      {
        ...validControlState,
        latest_approval: {
          ...validControlState.latest_approval,
          decision: "reject",
          consumed: true,
        },
      },
      false,
      "rejected approval cannot be consumed",
    );
    assertState(
      {
        ...validControlState,
        latest_approval: {
          ...validControlState.latest_approval,
          decision: "reject",
          consumed: false,
        },
      },
      true,
      "rejected approval remains unconsumed",
    );
    assertState(
      {
        ...validControlState,
        release_history: [{
          ...validControlState.release_history[0],
          status: "manual_review",
          published_at: null,
          readback_ref: "readback_2026_08_22_003",
          reason_codes: ["runtime_readback_mismatch"],
        }],
      },
      false,
      "manual review release requires published_at",
    );
    assertState(
      {
        ...validControlState,
        release_history: [{ ...validControlState.release_history[0], revision: 0 }],
      },
      false,
      "release revision zero",
    );
    assertState(
      {
        ...validControlState,
        activation: {
          ...validControlState.activation,
          active_modules: [validModuleRef, validModuleRef],
        },
      },
      false,
      "duplicate active module refs",
    );
    assertState(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          desired_modules: [validModuleRef, validModuleRef],
        },
      },
      false,
      "duplicate preview desired refs",
    );
    assertState(
      {
        ...validControlState,
        latest_readback: {
          ...validControlState.latest_readback,
          applied_modules: [validModuleRef, validModuleRef],
        },
      },
      false,
      "duplicate readback applied refs",
    );
    assertState(
      {
        ...validControlState,
        release_history: [{
          ...validControlState.release_history[0],
          desired_modules: [validModuleRef, validModuleRef],
        }],
      },
      false,
      "duplicate release desired refs",
    );
    for (const status of ["active_verified", "manual_review", "superseded"] as const) {
      assertState(
        {
          ...validControlState,
          release_history: [{
            ...validControlState.release_history[0],
            status,
            published_at: null,
            readback_ref: "readback_2026_08_22_003",
            reason_codes: status === "manual_review"
              ? ["runtime_readback_mismatch"]
              : [],
            superseded_by_release_id: status === "superseded"
              ? "release_2026_08_22_004"
              : null,
          }],
        },
        false,
        `${status} release requires published_at`,
      );
    }

    assertState(
      {
        ...validControlState,
        release_history: [{
          ...validControlState.release_history[0],
          intent: "rollback",
          rollback_target_release_id: "release_2026_08_22_001",
        }],
      },
      true,
      "rollback release intent",
    );
    assertState(
      {
        ...validControlState,
        release_history: [{
          ...validControlState.release_history[0],
          rollback_target_release_id: "release_should_not_leak",
        }],
      },
      false,
      "change release rejects rollback target",
    );
    assertState(
      {
        ...validControlState,
        release_history: [{
          ...validControlState.release_history[0],
          intent: "rollback",
        }],
      },
      false,
      "rollback release requires target",
    );

    const duplicateLegacyRelease = {
      ...validEnvelope,
      data: {
        kind: "release",
        release_id: "release_2026_08_22_003",
        revision: 3,
        active_modules: [validModuleRef, validModuleRef],
      },
    };
    expect(controlEnvelopeSchema.safeParse(duplicateLegacyRelease).success, "legacy release: Zod").toBe(false);
    expect(validateEnvelope(duplicateLegacyRelease), "legacy release: Ajv").toBe(false);
  });

  it("requires bounded safe inventory inspector fields while preserving trusted version syntax", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const assertState = (data: unknown, expected: boolean, label: string): void => {
      const candidate = { ...validEnvelope, data };
      expect(controlEnvelopeSchema.safeParse(candidate).success, `${label}: Zod`).toBe(expected);
      expect(validateEnvelope(candidate), `${label}: Ajv`).toBe(expected);
    };

    assertState(
      {
        ...validControlState,
        inventory_modules: [{
          ...validControlState.inventory_modules[0],
          version: "https://trusted/inventory",
        }],
      },
      true,
      "trusted inventory version remains lexical text",
    );
    assertState(
      {
        ...validControlState,
        inventory_modules: [{
          ...validControlState.inventory_modules[0],
          tool_names: undefined,
        }],
      },
      false,
      "tool names required",
    );
    assertState(
      {
        ...validControlState,
        inventory_modules: [{
          ...validControlState.inventory_modules[0],
          standard_ids: undefined,
        }],
      },
      false,
      "standard ids required",
    );
    assertState(
      {
        ...validControlState,
        inventory_modules: [{
          ...validControlState.inventory_modules[0],
          tool_names: Array.from({ length: 129 }, (_, index) => `tool_${index}`),
        }],
      },
      false,
      "tool name bound",
    );
    assertState(
      {
        ...validControlState,
        inventory_modules: [{
          ...validControlState.inventory_modules[0],
          standard_ids: Array.from({ length: 65 }, (_, index) => `standard_${index}`),
        }],
      },
      false,
      "standard id bound",
    );
    assertState(
      {
        ...validControlState,
        inventory_modules: [{
          ...validControlState.inventory_modules[0],
          tool_names: ["https://not-a-tool-name"],
        }],
      },
      false,
      "tool name URL",
    );
    assertState(
      {
        ...validControlState,
        inventory_modules: [{
          ...validControlState.inventory_modules[0],
          tool_names: ["cargo.calculate", "cargo.calculate"],
        }],
      },
      false,
      "duplicate tool names",
    );
    assertState(
      {
        ...validControlState,
        inventory_modules: [
          validControlState.inventory_modules[0],
          validControlState.inventory_modules[0],
        ],
      },
      false,
      "duplicate inventory modules",
    );
    assertState(
      {
        ...validControlState,
        inventory_modules: [{
          ...validControlState.inventory_modules[0],
          standard_ids: ["standard.contract", "standard.contract"],
        }],
      },
      false,
      "duplicate standard ids",
    );
  });

  it("requires producer semantics for logical module identity and strict projection ordering", () => {
    type StateProducerAssertion = (data: unknown) => void;
    const stateProducerAssertion = (
      controlContracts as typeof controlContracts & {
        assertControlStateProducerSemantics?: StateProducerAssertion;
      }
    ).assertControlStateProducerSemantics;

    expect.soft(typeof stateProducerAssertion).toBe("function");
    if (typeof stateProducerAssertion !== "function") {
      return;
    }

    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const assertSchemaAccepts = (data: unknown, label: string): void => {
      const candidate = { ...validEnvelope, data };
      expect(controlEnvelopeSchema.safeParse(candidate).success, `${label}: Zod`).toBe(true);
      expect(validateEnvelope(candidate), `${label}: Ajv`).toBe(true);
    };

    expect(() => stateProducerAssertion(validControlState)).not.toThrow();

    const conflictingDigestState = {
      ...validControlState,
      latest_preview: {
        ...validControlState.latest_preview,
        desired_modules: [
          validModuleRef,
          { ...validModuleRef, descriptor_digest: `sha256:${"e".repeat(64)}` },
        ],
      },
    };
    const conflictingDigestEnvelope = {
      ...validEnvelope,
      data: conflictingDigestState,
    };
    expect(
      controlEnvelopeSchema.safeParse(conflictingDigestEnvelope).success,
      "cross-digest logical duplicate: Zod",
    ).toBe(false);
    expect(
      validateEnvelope(conflictingDigestEnvelope),
      "cross-digest logical duplicate: Ajv exact-only uniqueItems",
    ).toBe(true);
    expect(() => stateProducerAssertion(conflictingDigestState)).toThrow();

    const olderRelease = {
      ...validControlState.release_history[0],
      release_id: "release_2026_08_22_002",
      revision: 2,
      previous_release_id: "release_2026_08_22_001",
      preview_ref: "preview_2026_08_22_002",
      approval_id: "approval_2026_08_22_002",
      status: "superseded",
      superseded_by_release_id: "release_2026_08_22_003",
    } as const;
    const oldestFirstState = {
      ...validControlState,
      release_history: [olderRelease, validControlState.release_history[0]],
    };
    assertSchemaAccepts(oldestFirstState, "oldest-first release history");
    expect(() => stateProducerAssertion(oldestFirstState)).toThrow(/release_history_not_newest_first/u);

    const outOfOrderEventsState = {
      ...validControlState,
      events: [
        { ...validControlState.events[0], sequence: 2, event_id: "event_2" },
        { ...validControlState.events[0], sequence: 1, event_id: "event_1" },
      ],
    };
    assertSchemaAccepts(outOfOrderEventsState, "out-of-order events");
    expect(() => stateProducerAssertion(outOfOrderEventsState)).toThrow(/events_not_strictly_ascending/u);

    const mismatchedVerifiedTargetState = {
      ...validControlState,
      latest_readback: {
        ...validControlState.latest_readback,
        release_id: "release_2026_08_22_002",
        revision: 2,
      },
    };
    assertSchemaAccepts(mismatchedVerifiedTargetState, "verified target differs from activation");
    expect(() => stateProducerAssertion(mismatchedVerifiedTargetState)).toThrow(/verified_readback_not_active/u);
  });

  it("keeps legacy envelopes parseable but rejects action-specific shell success outputs", () => {
    type ProducerAction =
      | "packages.register"
      | "deployments.preview"
      | "approvals.decide"
      | "deployments.publish"
      | "deployments.reconcile";
    type ProducerAssertion = (action: ProducerAction, envelope: unknown) => void;
    type ProducerSchema = {
      safeParse(value: unknown): { readonly success: boolean };
    };
    const producerAssertion = (
      controlContracts as typeof controlContracts & {
        assertControlProducerEnvelope?: ProducerAssertion;
      }
    ).assertControlProducerEnvelope;
    const producerSchema = (
      controlContracts as typeof controlContracts & {
        controlProducerEnvelopeSchema?: ProducerSchema;
      }
    ).controlProducerEnvelopeSchema;

    expect.soft(typeof producerAssertion).toBe("function");
    expect.soft(typeof producerSchema?.safeParse).toBe("function");
    if (typeof producerAssertion !== "function" || producerSchema === undefined) {
      return;
    }

    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const notApplicableReadback = {
      status: "not_applicable",
      release_id: null,
      revision: null,
    } as const;
    const verifiedReadback = {
      status: "verified",
      release_id: "release_2026_08_22_003",
      revision: 3,
    } as const;
    const successCases = [
      {
        action: "packages.register",
        envelope: {
          ...validEnvelope,
          data: {
            kind: "registration",
            module_id: validModuleRef.module_id,
            version: validModuleRef.version,
            descriptor_digest: validModuleRef.descriptor_digest,
            evidence_level: "local_build",
            production_eligible: false,
          },
          readback: notApplicableReadback,
        },
      },
      {
        action: "deployments.preview",
        envelope: {
          ...validEnvelope,
          data: {
            kind: "preview",
            preview_ref: validControlState.latest_preview.preview_ref,
            intent: "change",
            base_release_id: validControlState.latest_preview.base_release_id,
            base_revision: validControlState.latest_preview.base_revision,
            desired_modules: validControlState.latest_preview.desired_modules,
            target_release_id: null,
            expires_at: validControlState.latest_preview.expires_at,
            canonical_hash: validControlState.latest_preview.canonical_hash,
            diff: validControlState.latest_preview.diff,
            validation: validControlState.latest_preview.validation,
            creator_actor_ref: validControlState.latest_preview.creator_actor_ref,
            created_at: validControlState.latest_preview.created_at,
            consumed: validControlState.latest_preview.consumed,
          },
          readback: notApplicableReadback,
        },
      },
      {
        action: "approvals.decide",
        envelope: {
          ...validEnvelope,
          data: {
            kind: "approval",
            approval_id: validControlState.latest_approval.approval_id,
            preview_ref: validControlState.latest_approval.preview_ref,
            decision: validControlState.latest_approval.decision,
          },
          readback: notApplicableReadback,
        },
      },
      {
        action: "deployments.publish",
        envelope: {
          ...validEnvelope,
          data: {
            kind: "release",
            release_id: "release_2026_08_22_003",
            revision: 3,
            active_modules: [validModuleRef],
          },
          readback: verifiedReadback,
        },
      },
      {
        action: "deployments.reconcile",
        envelope: {
          ...validEnvelope,
          data: {
            kind: "reconciliation",
            release_id: "release_2026_08_22_003",
            revision: 3,
            status: "verified",
          },
          readback: verifiedReadback,
        },
      },
    ] as const;

    for (const { action, envelope } of successCases) {
      expect(() => producerAssertion(action, envelope), `${action}: assertion`).not.toThrow();
      expect(producerSchema.safeParse({ action, envelope }).success, `${action}: schema`).toBe(true);
    }

    const shellCases = [
      ["packages.register", "registration"],
      ["deployments.preview", "preview"],
      ["approvals.decide", "approval"],
      ["deployments.publish", "release"],
      ["deployments.reconcile", "reconciliation"],
    ] as const;
    for (const [action, kind] of shellCases) {
      const shellEnvelope = { ...validEnvelope, data: { kind } };
      expect(controlEnvelopeSchema.safeParse(shellEnvelope).success, `${action}: legacy Zod`).toBe(true);
      expect(validateEnvelope(shellEnvelope), `${action}: legacy Ajv`).toBe(true);
      expect(() => producerAssertion(action, shellEnvelope), `${action}: producer assertion`).toThrow();
      expect(producerSchema.safeParse({ action, envelope: shellEnvelope }).success, `${action}: producer schema`).toBe(false);
    }

    const mismatchedPublish = {
      ...successCases[3].envelope,
      readback: {
        status: "verified",
        release_id: "release_2026_08_22_002",
        revision: 2,
      },
    };
    expect(() => producerAssertion("deployments.publish", mismatchedPublish)).toThrow(/publish_readback_mismatch/u);
    expect(producerSchema.safeParse({
      action: "deployments.publish",
      envelope: mismatchedPublish,
    }).success).toBe(false);
  });

  it("keeps identifier and descriptor digest boundaries aligned", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const cases = [
      {
        label: "maximum identifier",
        candidate: {
          ...validEnvelope,
          request_id: `a${"b".repeat(127)}`,
        },
        valid: true,
      },
      {
        label: "identifier over maximum",
        candidate: {
          ...validEnvelope,
          request_id: `a${"b".repeat(128)}`,
        },
        valid: false,
      },
      {
        label: "exact descriptor digest",
        candidate: {
          ...validEnvelope,
          data: {
            kind: "registration",
            descriptor_digest: `sha256:${"f".repeat(64)}`,
          },
        },
        valid: true,
      },
      {
        label: "short descriptor digest",
        candidate: {
          ...validEnvelope,
          data: {
            kind: "registration",
            descriptor_digest: `sha256:${"f".repeat(63)}`,
          },
        },
        valid: false,
      },
      {
        label: "uppercase descriptor digest",
        candidate: {
          ...validEnvelope,
          data: {
            kind: "registration",
            descriptor_digest: `sha256:${"F".repeat(64)}`,
          },
        },
        valid: false,
      },
    ] as const;

    for (const testCase of cases) {
      const zodAccepted = controlEnvelopeSchema.safeParse(testCase.candidate).success;
      const ajvAccepted = validateEnvelope(testCase.candidate);
      expect(zodAccepted, `${testCase.label}: Zod`).toBe(testCase.valid);
      expect(ajvAccepted, `${testCase.label}: Ajv`).toBe(testCase.valid);
      expect(ajvAccepted, `${testCase.label}: parity`).toBe(zodAccepted);
    }
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

  it("rejects nested control-state leaks and unknown fields in both contracts", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const assertRejected = (data: unknown, label: string): void => {
      const candidate = { ...validEnvelope, data };
      expect(controlEnvelopeSchema.safeParse(candidate).success, `${label}: Zod`).toBe(false);
      expect(validateEnvelope(candidate), `${label}: Ajv`).toBe(false);
    };

    assertRejected(
      {
        ...validControlState,
        activation: { ...validControlState.activation, source: "runtime" },
      },
      "activation source",
    );
    assertRejected(
      {
        ...validControlState,
        inventory_modules: [
          { ...validControlState.inventory_modules[0], evidenceRefs: "opaque" },
          validControlState.inventory_modules[1],
        ],
      },
      "inventory evidenceRefs",
    );
    assertRejected(
      {
        ...validControlState,
        inventory_modules: [
          { ...validControlState.inventory_modules[0], source: "https://example.invalid" },
          validControlState.inventory_modules[1],
        ],
      },
      "inventory source",
    );
    assertRejected(
      {
        ...validControlState,
        inventory_modules: [
          {
            ...validControlState.inventory_modules[0],
            registration: {
              ...validControlState.inventory_modules[0].registration,
              evidence_ref: "opaque",
            },
          },
          validControlState.inventory_modules[1],
        ],
      },
      "registration evidence_ref",
    );
    assertRejected(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          diff: { ...validControlState.latest_preview.diff, detail: "raw payload" },
        },
      },
      "preview diff detail",
    );
    assertRejected(
      {
        ...validControlState,
        latest_preview: { ...validControlState.latest_preview, token: "not-a-token" },
      },
      "preview token",
    );
    assertRejected(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          validation: { ...validControlState.latest_preview.validation, path: "/tmp/module" },
        },
      },
      "preview validation path",
    );
    assertRejected(
      {
        ...validControlState,
        latest_approval: { ...validControlState.latest_approval, email: "operator@example.invalid" },
      },
      "approval email",
    );
    assertRejected(
      {
        ...validControlState,
        latest_readback: { ...validControlState.latest_readback, raw_payload: "secret" },
      },
      "readback raw payload",
    );
    assertRejected(
      {
        ...validControlState,
        latest_readback: {
          ...validControlState.latest_readback,
          status: "mismatch",
          observed_activation: {
            release_id: null,
            revision: null,
            path: "/runtime/state",
          },
          reason_codes: ["runtime_readback_mismatch"],
        },
      },
      "observed activation path",
    );
    assertRejected(
      {
        ...validControlState,
        release_history: [
          { ...validControlState.release_history[0], url: "https://example.invalid/release" },
        ],
      },
      "release URL",
    );
    assertRejected(
      {
        ...validControlState,
        events: [{ ...validControlState.events[0], secret: "do-not-log" }],
      },
      "event secret",
    );
  });

  it("bounds every control-state collection and reason-code list", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const assertRejected = (data: unknown, label: string): void => {
      const candidate = { ...validEnvelope, data };
      expect(controlEnvelopeSchema.safeParse(candidate).success, `${label}: Zod`).toBe(false);
      expect(validateEnvelope(candidate), `${label}: Ajv`).toBe(false);
    };
    const manyModules = Array.from({ length: 65 }, (_, index) => ({
      module_id: `module_${index}`,
      version: "2026-08-21.v0",
      descriptor_digest: `sha256:${"d".repeat(64)}`,
    }));
    const manyInventoryModules = Array.from({ length: 65 }, (_, index) => ({
      module_id: `module_${index}`,
      version: "2026-08-21.v0",
      risk_level: "T0",
      descriptor_digest: `sha256:${"d".repeat(64)}`,
      evidence_level: "local_build",
      production_eligible: false,
      tool_names: [],
      standard_ids: [],
      registration: null,
    }));
    const manyHistory = Array.from({ length: 129 }, (_, index) => ({
      ...validControlState.release_history[0],
      release_id: `release_${index}`,
    }));
    const manyEvents = Array.from({ length: 257 }, (_, index) => ({
      ...validControlState.events[0],
      sequence: index + 1,
      event_id: `event_${index}`,
    }));
    const manyReasons = Array.from({ length: 33 }, (_, index) => `reason_${index}`);

    assertRejected({
      ...validControlState,
      activation: { ...validControlState.activation, active_modules: manyModules },
    }, "active modules");
    assertRejected({ ...validControlState, inventory_modules: manyInventoryModules }, "inventory modules");
    assertRejected({
      ...validControlState,
      latest_preview: { ...validControlState.latest_preview, desired_modules: manyModules },
    }, "preview desired modules");
    assertRejected({ ...validControlState, release_history: manyHistory }, "release history");
    assertRejected({ ...validControlState, events: manyEvents }, "events");
    assertRejected({ ...validControlState, latest_readback: { ...validControlState.latest_readback, reason_codes: manyReasons } }, "readback reasons");
    assertRejected({ ...validControlState, latest_preview: {
      ...validControlState.latest_preview,
      validation: { ...validControlState.latest_preview.validation, reason_codes: manyReasons },
    } }, "preview reasons");
    assertRejected({ ...validEnvelope, reason_codes: manyReasons }, "envelope reasons");
  });

  it("enforces preview change/rollback and readback status unions", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const assertRejected = (data: unknown, label: string): void => {
      const candidate = { ...validEnvelope, data };
      expect(controlEnvelopeSchema.safeParse(candidate).success, `${label}: Zod`).toBe(false);
      expect(validateEnvelope(candidate), `${label}: Ajv`).toBe(false);
    };
    const assertAccepted = (data: unknown, label: string): void => {
      const candidate = { ...validEnvelope, data };
      expect(controlEnvelopeSchema.safeParse(candidate).success, `${label}: Zod`).toBe(true);
      expect(validateEnvelope(candidate), `${label}: Ajv`).toBe(true);
    };

    assertAccepted(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          intent: "rollback",
          target_release_id: "release_2026_08_22_001",
        },
      },
      "valid rollback preview",
    );
    assertAccepted(
      {
        ...validControlState,
        latest_readback: {
          ...validControlState.latest_readback,
          status: "pending",
          observed_activation: null,
          applied_modules: [],
          reason_codes: [],
        },
      },
      "valid pending readback",
    );
    assertAccepted(
      {
        ...validControlState,
        latest_readback: {
          ...validControlState.latest_readback,
          status: "mismatch",
          observed_activation: { release_id: null, revision: null },
          reason_codes: ["runtime_readback_mismatch"],
        },
      },
      "valid mismatch readback",
    );
    assertAccepted(
      {
        ...validControlState,
        latest_readback: {
          ...validControlState.latest_readback,
          status: "unknown",
          observed_activation: {
            release_id: "release_2026_08_22_002",
            revision: 2,
          },
          reason_codes: ["runtime_readback_unknown"],
        },
      },
      "valid unknown readback",
    );
    assertAccepted(
      {
        ...validControlState,
        activation: {
          state: "inactive",
          release_id: null,
          revision: 0,
          active_modules: [],
        },
        latest_preview: null,
        latest_approval: null,
        latest_readback: null,
        release_history: [],
        events: [],
        events_truncated: false,
      },
      "valid empty control state",
    );
    assertAccepted(
      {
        ...validControlState,
        release_history: [{
          ...validControlState.release_history[0],
          status: "published_pending_readback",
          published_at: null,
          readback_ref: null,
          reason_codes: [],
          superseded_by_release_id: null,
        }],
      },
      "valid pending release summary",
    );
    assertAccepted(
      {
        ...validControlState,
        release_history: [{
          ...validControlState.release_history[0],
          status: "manual_review",
          readback_ref: "readback_2026_08_22_004",
          reason_codes: ["runtime_readback_mismatch"],
          superseded_by_release_id: null,
        }],
      },
      "valid manual-review release summary",
    );
    assertAccepted(
      {
        ...validControlState,
        release_history: [{
          ...validControlState.release_history[0],
          status: "superseded",
          superseded_by_release_id: "release_2026_08_22_004",
        }],
      },
      "valid superseded release summary",
    );

    assertRejected({
      ...validControlState,
      latest_preview: { ...validControlState.latest_preview, target_release_id: "release_should_not_leak" },
    }, "change target release");
    assertRejected({
      ...validControlState,
      latest_preview: { ...validControlState.latest_preview, intent: "rollback" },
    }, "rollback without target release");
    assertRejected({
      ...validControlState,
      latest_readback: {
        ...validControlState.latest_readback,
        observed_activation: {
          release_id: "release_2026_08_22_002",
          revision: 2,
        },
      },
    }, "verified with repeated observed release");
    assertRejected({
      ...validControlState,
      latest_readback: {
        ...validControlState.latest_readback,
        status: "pending",
        observed_activation: {
          release_id: "release_2026_08_22_003",
          revision: 3,
        },
      },
    }, "pending with observed release");
    assertRejected({
      ...validControlState,
      latest_readback: { ...validControlState.latest_readback, status: "mismatch", reason_codes: [] },
    }, "mismatch without reason");
  });

  it("keeps the strict RFC3339 datetime subset identical in Zod and JSON Schema", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const definitions = envelopeSchema.$defs as Record<string, Record<string, unknown>>;
    const preview = definitions.preview;
    if (preview === undefined) {
      throw new Error("control-envelope schema is missing the preview definition");
    }
    const previewProperties = preview.properties as Record<string, Record<string, unknown>>;
    expect(previewProperties.expires_at?.pattern).toBe(ADMIN_CONTROL_RFC3339_PATTERN.source);
    expect(previewProperties.expires_at).not.toHaveProperty("format");
    const cases = [
      { label: "UTC Z", value: "2026-08-22T17:54:00Z", valid: true },
      { label: "colon offset", value: "2026-08-22T17:54:00+08:00", valid: true },
      { label: "fractional seconds", value: "2026-08-22T17:54:00.123456789Z", valid: true },
      { label: "offset without colon", value: "2026-08-22T17:54:00+0000", valid: false },
      { label: "lowercase separators", value: "2026-08-22t17:54:00z", valid: false },
      { label: "missing timezone", value: "2026-08-22T17:54:00", valid: false },
      { label: "invalid hour", value: "2026-08-22T24:00:00Z", valid: false },
      { label: "invalid month", value: "2026-13-22T17:54:00Z", valid: false },
    ] as const;

    for (const testCase of cases) {
      const candidate = {
        ...validEnvelope,
        data: { kind: "preview", expires_at: testCase.value },
      };
      const zodAccepted = controlEnvelopeSchema.safeParse(candidate).success;
      const jsonSchemaAccepted = validateEnvelope(candidate);

      expect.soft(zodAccepted, `${testCase.label}: Zod result`).toBe(testCase.valid);
      expect.soft(jsonSchemaAccepted, `${testCase.label}: JSON Schema result`).toBe(testCase.valid);
      expect.soft(jsonSchemaAccepted, `${testCase.label}: contract parity`).toBe(zodAccepted);
    }
  });

  it("enforces the complete action-by-status producer matrix and preview invariants", () => {
    type ProducerAction =
      | "packages.register"
      | "deployments.preview"
      | "approvals.decide"
      | "deployments.publish"
      | "deployments.reconcile";
    type EnvelopeStatus =
      | "success"
      | "needs_input"
      | "manual_review"
      | "blocked"
      | "unavailable";
    type ProducerCase = {
      readonly label: string;
      readonly action: ProducerAction;
      readonly envelope: unknown;
    };

    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const makeEnvelope = (
      status: EnvelopeStatus,
      data: unknown,
      reasonCodes: readonly string[],
      readback: unknown,
    ): unknown => ({
      ...validEnvelope,
      status,
      data,
      reason_codes: [...reasonCodes],
      readback,
    });
    const assertionAccepts = (
      action: ProducerAction,
      envelope: unknown,
    ): boolean => {
      try {
        controlContracts.assertControlProducerEnvelope(action, envelope);
        return true;
      } catch {
        return false;
      }
    };

    const notApplicableReadback = {
      status: "not_applicable",
      release_id: null,
      revision: null,
    } as const;
    const verifiedReadback = {
      status: "verified",
      release_id: "release_2026_08_22_003",
      revision: 3,
    } as const;
    const completeRegistration = {
      kind: "registration",
      module_id: validModuleRef.module_id,
      version: validModuleRef.version,
      descriptor_digest: validModuleRef.descriptor_digest,
      evidence_level: "local_build",
      production_eligible: false,
    } as const;
    const completePreview = {
      kind: "preview",
      preview_ref: validControlState.latest_preview.preview_ref,
      intent: "change",
      base_release_id: validControlState.activation.release_id,
      base_revision: validControlState.activation.revision,
      desired_modules: [validModuleRef],
      target_release_id: null,
      expires_at: "2026-08-22T18:30:00Z",
      canonical_hash: validControlState.latest_preview.canonical_hash,
      diff: {
        added: [],
        removed: [secondModuleRef],
        retained: [validModuleRef],
      },
      validation: {
        base_matches: true,
        desired_modules_valid: true,
        inventory_matches: true,
        minimum_active_modules: true,
        reason_codes: [],
      },
      creator_actor_ref: "actor_operator",
      created_at: "2026-08-22T17:30:00Z",
      consumed: false,
    } as const;
    const needsInputPreview = {
      ...completePreview,
      validation: {
        ...completePreview.validation,
        base_matches: false,
        reason_codes: ["base_revision_changed"],
      },
    } as const;
    const completeApproval = {
      kind: "approval",
      approval_id: "approval_2026_08_22_003",
      preview_ref: "preview_2026_08_22_003",
      decision: "approve",
    } as const;
    const rejectedApproval = {
      ...completeApproval,
      decision: "reject",
    } as const;
    const completeRelease = {
      kind: "release",
      release_id: "release_2026_08_22_003",
      revision: 3,
      active_modules: [validModuleRef],
    } as const;
    const verifiedReconciliation = {
      kind: "reconciliation",
      release_id: "release_2026_08_22_003",
      revision: 3,
      status: "verified",
    } as const;
    const mismatchReadback = {
      status: "mismatch",
      release_id: "release_2026_08_22_003",
      revision: 3,
    } as const;
    const unknownReadback = {
      status: "unknown",
      release_id: "release_2026_08_22_003",
      revision: 3,
    } as const;
    const mismatchReconciliation = {
      ...verifiedReconciliation,
      status: "mismatch",
    } as const;
    const unknownReconciliation = {
      ...verifiedReconciliation,
      status: "unknown",
    } as const;
    const blockedEnvelope = makeEnvelope(
      "blocked",
      null,
      ["policy_blocked"],
      notApplicableReadback,
    );
    const unavailableEnvelope = makeEnvelope(
      "unavailable",
      null,
      ["authority_unavailable"],
      notApplicableReadback,
    );

    const acceptedCases: readonly ProducerCase[] = [
      {
        label: "register success",
        action: "packages.register",
        envelope: makeEnvelope(
          "success",
          completeRegistration,
          [],
          notApplicableReadback,
        ),
      },
      {
        label: "register blocked",
        action: "packages.register",
        envelope: blockedEnvelope,
      },
      {
        label: "register unavailable",
        action: "packages.register",
        envelope: unavailableEnvelope,
      },
      {
        label: "preview success",
        action: "deployments.preview",
        envelope: makeEnvelope(
          "success",
          completePreview,
          [],
          notApplicableReadback,
        ),
      },
      {
        label: "preview needs input",
        action: "deployments.preview",
        envelope: makeEnvelope(
          "needs_input",
          needsInputPreview,
          ["base_revision_changed"],
          notApplicableReadback,
        ),
      },
      {
        label: "preview blocked",
        action: "deployments.preview",
        envelope: blockedEnvelope,
      },
      {
        label: "preview unavailable",
        action: "deployments.preview",
        envelope: unavailableEnvelope,
      },
      {
        label: "approval approve success",
        action: "approvals.decide",
        envelope: makeEnvelope(
          "success",
          completeApproval,
          [],
          notApplicableReadback,
        ),
      },
      {
        label: "approval reject success",
        action: "approvals.decide",
        envelope: makeEnvelope(
          "success",
          rejectedApproval,
          [],
          notApplicableReadback,
        ),
      },
      {
        label: "approval blocked",
        action: "approvals.decide",
        envelope: blockedEnvelope,
      },
      {
        label: "approval unavailable",
        action: "approvals.decide",
        envelope: unavailableEnvelope,
      },
      {
        label: "publish success",
        action: "deployments.publish",
        envelope: makeEnvelope(
          "success",
          completeRelease,
          [],
          verifiedReadback,
        ),
      },
      {
        label: "publish mismatch manual review",
        action: "deployments.publish",
        envelope: makeEnvelope(
          "manual_review",
          completeRelease,
          ["runtime_readback_mismatch"],
          mismatchReadback,
        ),
      },
      {
        label: "publish unknown manual review",
        action: "deployments.publish",
        envelope: makeEnvelope(
          "manual_review",
          completeRelease,
          ["runtime_readback_unknown"],
          unknownReadback,
        ),
      },
      {
        label: "publish blocked",
        action: "deployments.publish",
        envelope: blockedEnvelope,
      },
      {
        label: "publish unavailable",
        action: "deployments.publish",
        envelope: unavailableEnvelope,
      },
      {
        label: "reconcile success",
        action: "deployments.reconcile",
        envelope: makeEnvelope(
          "success",
          verifiedReconciliation,
          [],
          verifiedReadback,
        ),
      },
      {
        label: "reconcile mismatch manual review",
        action: "deployments.reconcile",
        envelope: makeEnvelope(
          "manual_review",
          mismatchReconciliation,
          ["runtime_readback_mismatch"],
          mismatchReadback,
        ),
      },
      {
        label: "reconcile unknown manual review",
        action: "deployments.reconcile",
        envelope: makeEnvelope(
          "manual_review",
          unknownReconciliation,
          ["runtime_readback_unknown"],
          unknownReadback,
        ),
      },
      {
        label: "reconcile blocked",
        action: "deployments.reconcile",
        envelope: blockedEnvelope,
      },
      {
        label: "reconcile unavailable",
        action: "deployments.reconcile",
        envelope: unavailableEnvelope,
      },
    ];

    const rejectedCases: readonly ProducerCase[] = [
      {
        label: "register needs input",
        action: "packages.register",
        envelope: makeEnvelope(
          "needs_input",
          null,
          ["module_input_required"],
          notApplicableReadback,
        ),
      },
      {
        label: "register manual review",
        action: "packages.register",
        envelope: makeEnvelope(
          "manual_review",
          completeRegistration,
          ["operator_review"],
          notApplicableReadback,
        ),
      },
      {
        label: "register blocked with data",
        action: "packages.register",
        envelope: makeEnvelope(
          "blocked",
          completeRegistration,
          ["policy_blocked"],
          notApplicableReadback,
        ),
      },
      {
        label: "register blocked without reason",
        action: "packages.register",
        envelope: makeEnvelope("blocked", null, [], notApplicableReadback),
      },
      {
        label: "register blocked with verified readback",
        action: "packages.register",
        envelope: makeEnvelope(
          "blocked",
          null,
          ["policy_blocked"],
          verifiedReadback,
        ),
      },
      {
        label: "preview manual review",
        action: "deployments.preview",
        envelope: makeEnvelope(
          "manual_review",
          completePreview,
          ["operator_review"],
          notApplicableReadback,
        ),
      },
      {
        label: "preview success with failed validation",
        action: "deployments.preview",
        envelope: makeEnvelope(
          "success",
          needsInputPreview,
          [],
          notApplicableReadback,
        ),
      },
      {
        label: "preview success with overlapping diff",
        action: "deployments.preview",
        envelope: makeEnvelope(
          "success",
          {
            ...completePreview,
            diff: {
              ...completePreview.diff,
              added: [validModuleRef],
            },
          },
          [],
          notApplicableReadback,
        ),
      },
      {
        label: "preview success with wrong desired set",
        action: "deployments.preview",
        envelope: makeEnvelope(
          "success",
          {
            ...completePreview,
            desired_modules: [secondModuleRef],
          },
          [],
          notApplicableReadback,
        ),
      },
      {
        label: "preview success with reversed expiry",
        action: "deployments.preview",
        envelope: makeEnvelope(
          "success",
          {
            ...completePreview,
            created_at: "2026-08-22T19:30:00Z",
          },
          [],
          notApplicableReadback,
        ),
      },
      {
        label: "preview success already consumed",
        action: "deployments.preview",
        envelope: makeEnvelope(
          "success",
          { ...completePreview, consumed: true },
          [],
          notApplicableReadback,
        ),
      },
      {
        label: "preview success with root reason",
        action: "deployments.preview",
        envelope: makeEnvelope(
          "success",
          completePreview,
          ["unexpected_warning"],
          notApplicableReadback,
        ),
      },
      {
        label: "preview needs input with all validations true",
        action: "deployments.preview",
        envelope: makeEnvelope(
          "needs_input",
          {
            ...completePreview,
            validation: {
              ...completePreview.validation,
              reason_codes: ["base_revision_changed"],
            },
          },
          ["base_revision_changed"],
          notApplicableReadback,
        ),
      },
      {
        label: "preview needs input with mismatched reason set",
        action: "deployments.preview",
        envelope: makeEnvelope(
          "needs_input",
          needsInputPreview,
          ["different_reason"],
          notApplicableReadback,
        ),
      },
      {
        label: "preview needs input already consumed",
        action: "deployments.preview",
        envelope: makeEnvelope(
          "needs_input",
          { ...needsInputPreview, consumed: true },
          ["base_revision_changed"],
          notApplicableReadback,
        ),
      },
      {
        label: "approval needs input",
        action: "approvals.decide",
        envelope: makeEnvelope(
          "needs_input",
          null,
          ["decision_required"],
          notApplicableReadback,
        ),
      },
      {
        label: "approval manual review",
        action: "approvals.decide",
        envelope: makeEnvelope(
          "manual_review",
          completeApproval,
          ["operator_review"],
          notApplicableReadback,
        ),
      },
      {
        label: "approval unavailable with wrong data kind",
        action: "approvals.decide",
        envelope: makeEnvelope(
          "unavailable",
          completePreview,
          ["authority_unavailable"],
          notApplicableReadback,
        ),
      },
      {
        label: "publish needs input",
        action: "deployments.publish",
        envelope: makeEnvelope(
          "needs_input",
          null,
          ["release_input_required"],
          notApplicableReadback,
        ),
      },
      {
        label: "publish manual review with verified readback",
        action: "deployments.publish",
        envelope: makeEnvelope(
          "manual_review",
          completeRelease,
          ["runtime_readback_mismatch"],
          verifiedReadback,
        ),
      },
      {
        label: "publish manual review with wrong data kind",
        action: "deployments.publish",
        envelope: makeEnvelope(
          "manual_review",
          mismatchReconciliation,
          ["runtime_readback_mismatch"],
          mismatchReadback,
        ),
      },
      {
        label: "publish unavailable with verified readback",
        action: "deployments.publish",
        envelope: makeEnvelope(
          "unavailable",
          null,
          ["authority_unavailable"],
          verifiedReadback,
        ),
      },
      {
        label: "reconcile needs input",
        action: "deployments.reconcile",
        envelope: makeEnvelope(
          "needs_input",
          null,
          ["release_input_required"],
          notApplicableReadback,
        ),
      },
      {
        label: "reconcile success with mismatch status",
        action: "deployments.reconcile",
        envelope: makeEnvelope(
          "success",
          mismatchReconciliation,
          [],
          verifiedReadback,
        ),
      },
      {
        label: "reconcile manual review with status disagreement",
        action: "deployments.reconcile",
        envelope: makeEnvelope(
          "manual_review",
          mismatchReconciliation,
          ["runtime_readback_mismatch"],
          unknownReadback,
        ),
      },
      {
        label: "reconcile manual review with identity disagreement",
        action: "deployments.reconcile",
        envelope: makeEnvelope(
          "manual_review",
          mismatchReconciliation,
          ["runtime_readback_mismatch"],
          {
            ...mismatchReadback,
            release_id: "release_2026_08_22_002",
            revision: 2,
          },
        ),
      },
      {
        label: "reconcile blocked with data",
        action: "deployments.reconcile",
        envelope: makeEnvelope(
          "blocked",
          mismatchReconciliation,
          ["policy_blocked"],
          notApplicableReadback,
        ),
      },
    ];

    for (const testCase of [...acceptedCases, ...rejectedCases]) {
      expect.soft(
        controlEnvelopeSchema.safeParse(testCase.envelope).success,
        `${testCase.label}: legacy Zod`,
      ).toBe(true);
      expect.soft(
        validateEnvelope(testCase.envelope),
        `${testCase.label}: legacy Ajv`,
      ).toBe(true);
    }

    for (const testCase of acceptedCases) {
      expect.soft(
        controlContracts.controlProducerEnvelopeSchema.safeParse({
          action: testCase.action,
          envelope: testCase.envelope,
        }).success,
        `${testCase.label}: producer schema`,
      ).toBe(true);
      expect.soft(
        assertionAccepts(testCase.action, testCase.envelope),
        `${testCase.label}: producer assertion`,
      ).toBe(true);
    }

    for (const testCase of rejectedCases) {
      expect.soft(
        controlContracts.controlProducerEnvelopeSchema.safeParse({
          action: testCase.action,
          envelope: testCase.envelope,
        }).success,
        `${testCase.label}: producer schema`,
      ).toBe(false);
      expect.soft(
        assertionAccepts(testCase.action, testCase.envelope),
        `${testCase.label}: producer assertion`,
      ).toBe(false);
    }
  });

  it("orders preview TTL instants at RFC3339 nanosecond precision", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const makePreviewEnvelope = (createdAt: string, expiresAt: string) => ({
      ...validEnvelope,
      data: {
        kind: "preview",
        preview_ref: validControlState.latest_preview.preview_ref,
        intent: "change",
        base_release_id: validControlState.activation.release_id,
        base_revision: validControlState.activation.revision,
        desired_modules: validControlState.latest_preview.desired_modules,
        target_release_id: null,
        expires_at: expiresAt,
        canonical_hash: validControlState.latest_preview.canonical_hash,
        diff: validControlState.latest_preview.diff,
        validation: validControlState.latest_preview.validation,
        creator_actor_ref: validControlState.latest_preview.creator_actor_ref,
        created_at: createdAt,
        consumed: false,
      },
    });
    const makeState = (createdAt: string, expiresAt: string) => ({
      ...validControlState,
      latest_preview: {
        ...validControlState.latest_preview,
        created_at: createdAt,
        expires_at: expiresAt,
      },
    });
    const actionProducerAccepts = (envelope: unknown): boolean =>
      controlContracts.controlProducerEnvelopeSchema.safeParse({
        action: "deployments.preview",
        envelope,
      }).success;
    const stateProducerAccepts = (state: unknown): boolean => {
      try {
        controlContracts.assertControlStateProducerSemantics(state);
        return true;
      } catch {
        return false;
      }
    };

    const acceptedCases = [
      {
        label: "one nanosecond in Z",
        createdAt: "2026-08-22T17:30:00.000000001Z",
        expiresAt: "2026-08-22T17:30:00.000000002Z",
      },
      {
        label: "one nanosecond across positive offset",
        createdAt: "2026-08-22T17:30:00.000000001Z",
        expiresAt: "2026-08-22T18:30:00.000000002+01:00",
      },
      {
        label: "one nanosecond across leap-day midnight",
        createdAt: "2024-02-29T23:59:59.999999999Z",
        expiresAt: "2024-03-01T00:00:00Z",
      },
    ] as const;
    const rejectedCases = [
      {
        label: "equal nanosecond instant",
        createdAt: "2026-08-22T17:30:00.000000001Z",
        expiresAt: "2026-08-22T17:30:00.000000001Z",
      },
      {
        label: "reversed nanosecond instant",
        createdAt: "2026-08-22T17:30:00.000000002Z",
        expiresAt: "2026-08-22T17:30:00.000000001Z",
      },
      {
        label: "equivalent instant through positive offset",
        createdAt: "2026-08-22T17:30:00.000000001Z",
        expiresAt: "2026-08-22T18:30:00.000000001+01:00",
      },
      {
        label: "equivalent instant through negative offset",
        createdAt: "2026-08-22T17:30:00.000000001Z",
        expiresAt: "2026-08-22T16:30:00.000000001-01:00",
      },
    ] as const;

    for (const testCase of [...acceptedCases, ...rejectedCases]) {
      const envelope = makePreviewEnvelope(
        testCase.createdAt,
        testCase.expiresAt,
      );
      const state = makeState(testCase.createdAt, testCase.expiresAt);
      expect.soft(
        controlEnvelopeSchema.safeParse(envelope).success,
        `${testCase.label}: envelope Zod structure`,
      ).toBe(true);
      expect.soft(
        validateEnvelope(envelope),
        `${testCase.label}: envelope Ajv structure`,
      ).toBe(true);
      expect.soft(
        controlEnvelopeSchema.safeParse({ ...validEnvelope, data: state }).success,
        `${testCase.label}: state Zod structure`,
      ).toBe(true);
      expect.soft(
        validateEnvelope({ ...validEnvelope, data: state }),
        `${testCase.label}: state Ajv structure`,
      ).toBe(true);
    }

    for (const testCase of acceptedCases) {
      expect.soft(
        actionProducerAccepts(
          makePreviewEnvelope(testCase.createdAt, testCase.expiresAt),
        ),
        `${testCase.label}: action producer`,
      ).toBe(true);
      expect.soft(
        stateProducerAccepts(makeState(testCase.createdAt, testCase.expiresAt)),
        `${testCase.label}: state producer`,
      ).toBe(true);
    }

    for (const testCase of rejectedCases) {
      expect.soft(
        actionProducerAccepts(
          makePreviewEnvelope(testCase.createdAt, testCase.expiresAt),
        ),
        `${testCase.label}: action producer`,
      ).toBe(false);
      expect.soft(
        stateProducerAccepts(makeState(testCase.createdAt, testCase.expiresAt)),
        `${testCase.label}: state producer`,
      ).toBe(false);
    }
  });

  it("returns detached deep-frozen producer snapshots and redacts hostile input failures", () => {
    type FrozenEnvelope = {
      readonly status: string;
      readonly data: {
        readonly kind: string;
        readonly module_id?: string;
      } | null;
      readonly readback: object;
    };
    type FrozenState = {
      readonly activation: {
        readonly state: string;
        readonly active_modules: readonly unknown[];
      };
      readonly inventory_modules: readonly {
        readonly module_id: string;
        readonly tool_names: readonly string[];
      }[];
    };
    const producerAssertion = controlContracts.assertControlProducerEnvelope as unknown as (
      action: "packages.register",
      envelope: unknown,
    ) => FrozenEnvelope;
    const stateAssertion = controlContracts.assertControlStateProducerSemantics as unknown as (
      data: unknown,
    ) => FrozenState;
    const registrationEnvelope = {
      ...validEnvelope,
      data: {
        kind: "registration",
        module_id: validModuleRef.module_id,
        version: validModuleRef.version,
        descriptor_digest: validModuleRef.descriptor_digest,
        evidence_level: "local_build",
        production_eligible: false,
      },
    };

    const mutableEnvelope = structuredClone(registrationEnvelope);
    const frozenEnvelope = producerAssertion(
      "packages.register",
      mutableEnvelope,
    );
    expect.soft(frozenEnvelope).toBeDefined();
    if (frozenEnvelope !== undefined) {
      expect.soft(frozenEnvelope).not.toBe(mutableEnvelope);
      expect.soft(Object.isFrozen(frozenEnvelope)).toBe(true);
      expect.soft(Object.isFrozen(frozenEnvelope.data)).toBe(true);
      expect.soft(Object.isFrozen(frozenEnvelope.readback)).toBe(true);
      expect.soft(Object.getPrototypeOf(frozenEnvelope)).toBe(Object.prototype);
      expect.soft(Object.getPrototypeOf(frozenEnvelope.readback)).toBe(
        Object.prototype,
      );
      if (frozenEnvelope.data !== null) {
        expect.soft(Object.getPrototypeOf(frozenEnvelope.data)).toBe(
          Object.prototype,
        );
      }
      expect.soft(Reflect.set(mutableEnvelope, "status", "blocked")).toBe(true);
      expect.soft(
        Reflect.set(mutableEnvelope.data, "module_id", "mutated_module"),
      ).toBe(true);
      expect.soft(frozenEnvelope.status).toBe("success");
      expect.soft(frozenEnvelope.data?.module_id).toBe("cargo");
      expect.soft(Reflect.set(frozenEnvelope, "status", "blocked")).toBe(false);
      if (frozenEnvelope.data !== null) {
        expect.soft(
          Reflect.set(frozenEnvelope.data, "module_id", "mutated_module"),
        ).toBe(false);
      }
    }

    const mutableState = structuredClone(validControlState);
    const frozenState = stateAssertion(mutableState);
    expect.soft(frozenState).toBeDefined();
    if (frozenState !== undefined) {
      expect.soft(frozenState).not.toBe(mutableState);
      expect.soft(Object.isFrozen(frozenState)).toBe(true);
      expect.soft(Object.isFrozen(frozenState.activation)).toBe(true);
      expect.soft(Object.isFrozen(frozenState.activation.active_modules)).toBe(true);
      expect.soft(Object.isFrozen(frozenState.inventory_modules)).toBe(true);
      expect.soft(Object.isFrozen(frozenState.inventory_modules[0])).toBe(true);
      expect.soft(Object.getPrototypeOf(frozenState)).toBe(Object.prototype);
      expect.soft(Object.getPrototypeOf(frozenState.inventory_modules)).toBe(
        Array.prototype,
      );
      expect.soft(Object.getPrototypeOf(frozenState.inventory_modules[0])).toBe(
        Object.prototype,
      );
      expect.soft(
        Object.isFrozen(frozenState.inventory_modules[0]?.tool_names),
      ).toBe(true);
      expect.soft(
        Reflect.set(
          mutableState.inventory_modules[0],
          "module_id",
          "mutated_module",
        ),
      ).toBe(true);
      expect.soft(
        Reflect.set(
          mutableState.inventory_modules[0].tool_names,
          mutableState.inventory_modules[0].tool_names.length,
          "mutated.tool",
        ),
      ).toBe(true);
      expect.soft(frozenState.inventory_modules[0]?.module_id).toBe("cargo");
      expect.soft(frozenState.inventory_modules[0]?.tool_names).toEqual([
        "cargo.calculate",
      ]);
      expect.soft(
        Reflect.set(
          frozenState.inventory_modules[0] ?? {},
          "module_id",
          "mutated_module",
        ),
      ).toBe(false);
    }

    const captureError = (operation: () => unknown): unknown => {
      try {
        operation();
        return null;
      } catch (error) {
        return error;
      }
    };
    const expectStableContractError = (
      operation: () => unknown,
      label: string,
    ): void => {
      const error = captureError(operation);
      expect.soft(error, `${label}: error type`).toBeInstanceOf(
        controlContracts.ControlContractError,
      );
      if (error instanceof controlContracts.ControlContractError) {
        expect.soft(error.code, `${label}: error code`).toBe(
          "control_contract_input_invalid",
        );
        expect.soft(error.message, `${label}: error message`).toBe(
          "control_contract_input_invalid",
        );
      }
    };

    const getterEnvelope = { ...registrationEnvelope };
    let getterCalls = 0;
    Object.defineProperty(getterEnvelope, "status", {
      configurable: true,
      enumerable: true,
      get(): never {
        getterCalls += 1;
        throw new Error("getter_secret_must_not_escape");
      },
    });
    expectStableContractError(
      () => producerAssertion("packages.register", getterEnvelope),
      "plain accessor",
    );
    expect.soft(getterCalls, "plain accessor is never invoked").toBe(0);

    const transparentEnvelope = new Proxy(registrationEnvelope, {});
    expectStableContractError(
      () => producerAssertion("packages.register", transparentEnvelope),
      "transparent root proxy",
    );
    const nestedTransparentEnvelope = {
      ...registrationEnvelope,
      data: new Proxy(registrationEnvelope.data, {}),
    };
    expectStableContractError(
      () => producerAssertion("packages.register", nestedTransparentEnvelope),
      "transparent nested proxy",
    );

    let proxyTrapCalls = 0;
    let proxyTargetGetterCalls = 0;
    const trappedProxyTarget = { ...registrationEnvelope };
    Object.defineProperty(trappedProxyTarget, "status", {
      configurable: true,
      enumerable: true,
      get() {
        proxyTargetGetterCalls += 1;
        return "success";
      },
    });
    const trappedEnvelope = new Proxy(trappedProxyTarget, {
      get(target, property, receiver) {
        proxyTrapCalls += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
      getOwnPropertyDescriptor(target, property) {
        proxyTrapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf(target) {
        proxyTrapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        proxyTrapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    expectStableContractError(
      () => producerAssertion("packages.register", trappedEnvelope),
      "trapped root proxy",
    );
    expect.soft(proxyTrapCalls, "proxy traps are never invoked").toBe(0);
    expect.soft(
      proxyTargetGetterCalls,
      "proxy target getters are never invoked",
    ).toBe(0);

    let statusReads = 0;
    const switchingEnvelope = new Proxy(registrationEnvelope, {
      get(target, property, receiver) {
        if (property === "status") {
          statusReads += 1;
          return statusReads % 2 === 1 ? "success" : "blocked";
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expectStableContractError(
      () => producerAssertion("packages.register", switchingEnvelope),
      "value-switching proxy",
    );
    expect.soft(statusReads, "value-switching get trap is never invoked").toBe(0);

    const transparentState = new Proxy(validControlState, {});
    expectStableContractError(
      () => stateAssertion(transparentState),
      "transparent state proxy",
    );

    const nullPrototypeEnvelope = Object.assign(
      Object.create(null) as object,
      registrationEnvelope,
    );
    expectStableContractError(
      () => producerAssertion("packages.register", nullPrototypeEnvelope),
      "null-prototype envelope",
    );
    const customPrototypeEnvelope = Object.assign(
      Object.create({ inherited_contract_value: true }) as object,
      registrationEnvelope,
    );
    expectStableContractError(
      () => producerAssertion("packages.register", customPrototypeEnvelope),
      "custom-prototype envelope",
    );
  });

  it("requires published release instants not to precede creation while keeping the generic parser lexical", () => {
    const release = validControlState.release_history[0];
    const cases = [
      {
        label: "offset-equivalent instant",
        created_at: "2026-08-22T17:30:00.000000001Z",
        published_at: "2026-08-22T18:30:00.000000001+01:00",
        accepted: true,
      },
      {
        label: "equal instant",
        created_at: "2026-08-22T17:30:00.000000001Z",
        published_at: "2026-08-22T17:30:00.000000001Z",
        accepted: true,
      },
      {
        label: "reverse one nanosecond",
        created_at: "2026-08-22T17:30:00.000000002Z",
        published_at: "2026-08-22T17:30:00.000000001Z",
        accepted: false,
      },
    ] as const;

    for (const testCase of cases) {
      const state = {
        ...validControlState,
        release_history: [{
          ...release,
          created_at: testCase.created_at,
          published_at: testCase.published_at,
        }],
      };
      const envelope = { ...validEnvelope, data: state };
      expect(controlEnvelopeSchema.safeParse(envelope).success, `${testCase.label}: parser`).toBe(true);
      if (testCase.accepted) {
        expect(
          controlContracts.assertControlStateProducerSemantics(state),
          `${testCase.label}: producer`,
        ).toBeDefined();
      } else {
        expect(() => controlContracts.assertControlStateProducerSemantics(state)).toThrow(
          /release_published_at_before_created_at/u,
        );
      }
    }

    const pendingState = {
      ...validControlState,
      activation: {
        state: "inactive",
        release_id: null,
        revision: 0,
        active_modules: [],
      },
      latest_preview: null,
      latest_approval: null,
      latest_readback: null,
      release_history: [{
        ...release,
        status: "published_pending_readback",
        published_at: null,
        readback_ref: null,
        reason_codes: [],
        superseded_by_release_id: null,
      }],
      events: [],
      events_truncated: false,
    } as const;
    expect(controlEnvelopeSchema.safeParse({ ...validEnvelope, data: pendingState }).success).toBe(true);
    expect(() => controlContracts.assertControlStateProducerSemantics(pendingState)).not.toThrow();
  });

  it("requires a rollback preview target in bounded history to be strictly older than its base release", () => {
    const activeRelease = validControlState.release_history[0];
    const olderSupersededRelease = {
      ...activeRelease,
      release_id: "release_2026_08_22_002",
      revision: 2,
      previous_release_id: "release_2026_08_22_001",
      preview_ref: "preview_2026_08_22_002",
      approval_id: "approval_2026_08_22_002",
      created_at: "2026-08-22T16:30:00Z",
      published_at: "2026-08-22T16:40:00Z",
      readback_ref: "readback_2026_08_22_002",
      status: "superseded",
      superseded_by_release_id: activeRelease.release_id,
    } as const;
    const linkedActiveRelease = {
      ...activeRelease,
      previous_release_id: olderSupersededRelease.release_id,
    } as const;
    const rollbackPreview = {
      ...validControlState.latest_preview,
      intent: "rollback",
      target_release_id: olderSupersededRelease.release_id,
      base_release_id: linkedActiveRelease.release_id,
      base_revision: linkedActiveRelease.revision,
      desired_modules: olderSupersededRelease.desired_modules,
      diff: {
        added: [],
        removed: [],
        retained: olderSupersededRelease.desired_modules,
      },
    } as const;
    const validRollbackState = {
      ...validControlState,
      latest_preview: rollbackPreview,
      release_history: [linkedActiveRelease, olderSupersededRelease],
    } as const;
    const newerPendingRelease = {
      ...activeRelease,
      release_id: "release_2026_08_22_004",
      revision: 4,
      previous_release_id: linkedActiveRelease.release_id,
      preview_ref: "preview_2026_08_22_004",
      approval_id: "approval_2026_08_22_004",
      created_at: "2026-08-22T18:30:00Z",
      published_at: null,
      status: "published_pending_readback",
      readback_ref: null,
      reason_codes: [],
      superseded_by_release_id: null,
    } as const;
    const cases = [
      {
        label: "target omitted from bounded release history",
        state: {
          ...validRollbackState,
          latest_preview: {
            ...rollbackPreview,
            target_release_id: "release_outside_bounded_history",
          },
        },
      },
      {
        label: "target is the current active base release",
        state: {
          ...validRollbackState,
          latest_preview: {
            ...rollbackPreview,
            target_release_id: linkedActiveRelease.release_id,
          },
        },
      },
      {
        label: "target is newer than the current base release",
        state: {
          ...validRollbackState,
          latest_preview: {
            ...rollbackPreview,
            target_release_id: newerPendingRelease.release_id,
          },
          release_history: [
            newerPendingRelease,
            linkedActiveRelease,
            olderSupersededRelease,
          ],
        },
      },
    ] as const;

    expect(
      controlEnvelopeSchema.safeParse({ ...validEnvelope, data: validRollbackState }).success,
      "bounded older rollback target: generic parser",
    ).toBe(true);
    expect(() =>
      controlContracts.assertControlStateProducerSemantics(validRollbackState),
    ).not.toThrow();

    for (const testCase of cases) {
      expect(
        controlEnvelopeSchema.safeParse({ ...validEnvelope, data: testCase.state }).success,
        `${testCase.label}: generic parser`,
      ).toBe(true);
      expect(
        () => controlContracts.assertControlStateProducerSemantics(testCase.state),
        `${testCase.label}: producer`,
      ).toThrow();
    }
  });

  it("enforces the authoritative control-state activation, history, readback, and preview index", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const producerAccepts = (data: unknown): boolean => {
      try {
        controlContracts.assertControlStateProducerSemantics(data);
        return true;
      } catch {
        return false;
      }
    };
    const expectStructuralAcceptance = (data: unknown, label: string): void => {
      const envelope = { ...validEnvelope, data };
      expect.soft(
        controlEnvelopeSchema.safeParse(envelope).success,
        `${label}: generic Zod`,
      ).toBe(true);
      expect.soft(validateEnvelope(envelope), `${label}: generic Ajv`).toBe(true);
    };
    const expectProducerRejection = (data: unknown, label: string): void => {
      expectStructuralAcceptance(data, label);
      expect.soft(producerAccepts(data), `${label}: producer`).toBe(false);
    };

    const activeRelease = validControlState.release_history[0];
    const olderSupersededRelease = {
      ...activeRelease,
      release_id: "release_2026_08_22_002",
      revision: 2,
      previous_release_id: "release_2026_08_22_001",
      preview_ref: "preview_2026_08_22_002",
      approval_id: "approval_2026_08_22_002",
      created_at: "2026-08-22T16:30:00Z",
      published_at: "2026-08-22T16:40:00Z",
      readback_ref: "readback_2026_08_22_002",
      status: "superseded",
      superseded_by_release_id: activeRelease.release_id,
    } as const;
    const linkedActiveRelease = {
      ...activeRelease,
      previous_release_id: olderSupersededRelease.release_id,
    } as const;
    const validChainedState = {
      ...validControlState,
      release_history: [linkedActiveRelease, olderSupersededRelease],
    };
    const unresolvedRelease = {
      ...activeRelease,
      release_id: "release_2026_08_22_004",
      revision: 4,
      previous_release_id: activeRelease.release_id,
      preview_ref: "preview_2026_08_22_004",
      approval_id: "approval_2026_08_22_004",
      created_at: "2026-08-22T18:35:00Z",
      published_at: "2026-08-22T18:40:00Z",
      readback_ref: "readback_2026_08_22_004",
      status: "manual_review",
      reason_codes: ["runtime_readback_mismatch"],
      superseded_by_release_id: null,
    } as const;
    const validManualReviewState = {
      ...validControlState,
      latest_readback: {
        release_id: unresolvedRelease.release_id,
        revision: unresolvedRelease.revision,
        readback_ref: unresolvedRelease.readback_ref,
        applied_modules: unresolvedRelease.desired_modules,
        status: "mismatch",
        observed_activation: {
          release_id: validControlState.activation.release_id,
          revision: validControlState.activation.revision,
        },
        reason_codes: unresolvedRelease.reason_codes,
        checked_at: "2026-08-22T18:45:00Z",
      },
      release_history: [unresolvedRelease, activeRelease],
    } as const;
    const observedDigestDriftModule = {
      ...validModuleRef,
      descriptor_digest: `sha256:${"d".repeat(64)}`,
    } as const;
    const validMismatchDigestDriftState = {
      ...validManualReviewState,
      latest_readback: {
        ...validManualReviewState.latest_readback,
        applied_modules: [observedDigestDriftModule],
      },
    } as const;
    const inactiveState = {
      ...validControlState,
      activation: {
        state: "inactive",
        release_id: null,
        revision: 0,
        active_modules: [],
      },
      latest_preview: null,
      latest_approval: null,
      latest_readback: null,
      release_history: [],
      events: [],
      events_truncated: false,
    } as const;
    const pendingRelease = {
      ...activeRelease,
      release_id: "release_2026_08_22_001",
      revision: 1,
      previous_release_id: null,
      preview_ref: "preview_2026_08_22_001",
      approval_id: "approval_2026_08_22_001",
      status: "published_pending_readback",
      published_at: null,
      readback_ref: null,
      reason_codes: [],
      superseded_by_release_id: null,
    } as const;
    const validPendingState = {
      ...inactiveState,
      latest_readback: null,
      release_history: [pendingRelease],
    } as const;
    const pendingAfterActiveRelease = {
      ...pendingRelease,
      release_id: "release_2026_08_22_004",
      revision: 4,
      previous_release_id: activeRelease.release_id,
      preview_ref: "preview_2026_08_22_004",
      approval_id: "approval_2026_08_22_004",
    } as const;
    const validPendingAfterActiveState = {
      ...validControlState,
      release_history: [pendingAfterActiveRelease, activeRelease],
    } as const;
    const validPersistedPendingReadbackState = {
      ...validPendingAfterActiveState,
      latest_readback: {
        release_id: pendingAfterActiveRelease.release_id,
        revision: pendingAfterActiveRelease.revision,
        readback_ref: "readback_2026_08_22_004_attempt",
        applied_modules: [],
        status: "pending",
        observed_activation: null,
        reason_codes: [],
        checked_at: "2026-08-22T18:45:00Z",
      },
    } as const;
    const validUnapprovedPreviewState = {
      ...validControlState,
      latest_preview: {
        ...validControlState.latest_preview,
        preview_ref: "preview_2026_08_22_unapproved",
      },
      latest_approval: null,
    } as const;
    const validConsumedPreviewState = {
      ...validControlState,
      latest_preview: {
        ...validControlState.latest_preview,
        consumed: true,
      },
      latest_approval: {
        ...validControlState.latest_approval,
        decision: "approve",
        consumed: true,
      },
    } as const;

    for (const [label, state] of [
      ["single active projection", validControlState],
      ["linked active and superseded projection", validChainedState],
      ["durable unresolved publish projection", validManualReviewState],
      ["manual-review observed descriptor digest drift", validMismatchDigestDriftState],
      ["inactive empty projection", inactiveState],
      ["repository-shaped initial pending projection", validPendingState],
      [
        "repository-shaped pending projection retaining old verified readback",
        validPendingAfterActiveState,
      ],
      ["unconsumed preview without an approval", validUnapprovedPreviewState],
      ["consumed validated preview with approved decision", validConsumedPreviewState],
    ] as const) {
      expectStructuralAcceptance(state, label);
      expect.soft(producerAccepts(state), `${label}: producer`).toBe(true);
    }
    expectStructuralAcceptance(
      validPersistedPendingReadbackState,
      "legacy persisted pending readback fixture",
    );
    expectProducerRejection(
      validPersistedPendingReadbackState,
      "service producer must not persist pending readback",
    );
    const preservedDriftSnapshot =
      controlContracts.assertControlStateProducerSemantics(
        validMismatchDigestDriftState,
      );
    expect.soft(
      preservedDriftSnapshot.latest_readback?.applied_modules[0]
        ?.descriptor_digest,
      "observed mismatch digest is preserved",
    ).toBe(observedDigestDriftModule.descriptor_digest);

    const ghostModuleRef = {
      module_id: "ghost_module",
      version: "2026-08-21.v0",
      descriptor_digest: `sha256:${"f".repeat(64)}`,
    } as const;
    expectProducerRejection(
      {
        ...validControlState,
        activation: {
          ...validControlState.activation,
          active_modules: [ghostModuleRef],
        },
        latest_readback: {
          ...validControlState.latest_readback,
          applied_modules: [ghostModuleRef],
        },
        release_history: [{ ...activeRelease, desired_modules: [ghostModuleRef] }],
      },
      "ghost active module absent from inventory",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_readback: null,
        release_history: [{
          ...activeRelease,
          status: "published_pending_readback",
          published_at: null,
          readback_ref: null,
          reason_codes: [],
          superseded_by_release_id: null,
        }],
      },
      "active activation points at pending history",
    );
    expectProducerRejection(
      {
        ...validControlState,
        release_history: [
          linkedActiveRelease,
          {
            ...olderSupersededRelease,
            status: "active_verified",
            superseded_by_release_id: null,
          },
        ],
      },
      "two active history rows",
    );
    expectProducerRejection(
      {
        ...validControlState,
        release_history: [{
          ...activeRelease,
          desired_modules: [secondModuleRef],
        }],
      },
      "active history modules disagree with activation",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_approval: {
          ...validControlState.latest_approval,
          preview_ref: "preview_2026_08_22_other",
        },
      },
      "latest approval points at another preview",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_preview: null,
      },
      "latest approval exists without latest preview",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          consumed: true,
        },
      },
      "preview consumed while approval is unconsumed",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_approval: {
          ...validControlState.latest_approval,
          consumed: true,
        },
      },
      "approval consumed while preview is unconsumed",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          consumed: true,
        },
        latest_approval: {
          ...validControlState.latest_approval,
          decision: "reject",
          consumed: false,
        },
      },
      "rejected approval cannot accompany a consumed preview",
    );
    expectProducerRejection(
      {
        ...validUnapprovedPreviewState,
        latest_preview: {
          ...validUnapprovedPreviewState.latest_preview,
          consumed: true,
        },
      },
      "consumed preview cannot lose its approval projection",
    );
    expectProducerRejection(
      {
        ...validConsumedPreviewState,
        latest_preview: {
          ...validConsumedPreviewState.latest_preview,
          validation: {
            ...validConsumedPreviewState.latest_preview.validation,
            inventory_matches: false,
            reason_codes: ["inventory_changed_after_preview"],
          },
        },
      },
      "consumed preview cannot retain failed validation",
    );
    expectProducerRejection(
      {
        ...validControlState,
        release_history: [
          linkedActiveRelease,
          {
            ...olderSupersededRelease,
            release_id: linkedActiveRelease.release_id,
          },
        ],
      },
      "duplicate history release id",
    );
    expectProducerRejection(
      {
        ...validControlState,
        release_history: [
          {
            ...linkedActiveRelease,
            previous_release_id: "release_2026_08_22_001",
          },
          {
            ...olderSupersededRelease,
            release_id: "release_2026_08_22_001",
            revision: 1,
          },
        ],
      },
      "history revision gap",
    );
    expectProducerRejection(
      {
        ...validControlState,
        release_history: [
          {
            ...activeRelease,
            previous_release_id: "release_2026_08_22_002",
          },
          {
            ...olderSupersededRelease,
            status: "manual_review",
            reason_codes: ["runtime_readback_unknown"],
            superseded_by_release_id: null,
          },
        ],
      },
      "unresolved history row is not newest",
    );
    expectProducerRejection(
      {
        ...validControlState,
        release_history: [
          {
            ...linkedActiveRelease,
            previous_release_id: "release_wrong_previous",
          },
          olderSupersededRelease,
        ],
      },
      "history previous release chain mismatch",
    );
    expectProducerRejection(
      {
        ...validControlState,
        release_history: [
          linkedActiveRelease,
          {
            ...olderSupersededRelease,
            superseded_by_release_id: "release_wrong_successor",
          },
        ],
      },
      "history superseded chain mismatch",
    );
    expectProducerRejection(
      {
        ...inactiveState,
        release_history: [activeRelease],
      },
      "inactive state contains active history",
    );
    expectProducerRejection(
      {
        ...inactiveState,
        latest_readback: validControlState.latest_readback,
        release_history: [activeRelease],
      },
      "inactive state contains verified readback",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_readback: null,
      },
      "newest active release has no verified latest readback",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_readback: {
          ...validControlState.latest_readback,
          applied_modules: [observedDigestDriftModule],
        },
      },
      "verified readback contains descriptor digest drift",
    );
    expectProducerRejection(
      {
        ...validManualReviewState,
        latest_readback: null,
      },
      "newest manual-review release has no latest readback",
    );
    expectProducerRejection(
      {
        ...validManualReviewState,
        latest_readback: validControlState.latest_readback,
      },
      "newest manual-review release exposes only old verified readback",
    );
    expectProducerRejection(
      {
        ...validPersistedPendingReadbackState,
        latest_readback: {
          ...validPersistedPendingReadbackState.latest_readback,
          release_id: "release_wrong_pending_target",
        },
      },
      "persisted pending readback targets the wrong release",
    );
    expectProducerRejection(
      {
        ...validPersistedPendingReadbackState,
        latest_readback: {
          ...validPersistedPendingReadbackState.latest_readback,
          revision: pendingAfterActiveRelease.revision + 1,
        },
      },
      "persisted pending readback targets the wrong revision",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_readback: {
          ...validControlState.latest_readback,
          readback_ref: "readback_wrong_projection",
        },
      },
      "latest readback ref disagrees with history",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_readback: {
          ...validControlState.latest_readback,
          status: "pending",
          observed_activation: null,
          applied_modules: [],
          reason_codes: [],
        },
      },
      "pending readback points at active history",
    );
    expectProducerRejection(
      {
        ...validManualReviewState,
        latest_readback: {
          ...validManualReviewState.latest_readback,
          observed_activation: {
            release_id: unresolvedRelease.release_id,
            revision: unresolvedRelease.revision,
          },
        },
      },
      "mismatch observation is completely exact",
    );
    expectProducerRejection(
      {
        ...validManualReviewState,
        latest_readback: {
          ...validManualReviewState.latest_readback,
          status: "unknown",
          observed_activation: {
            release_id: unresolvedRelease.release_id,
            revision: unresolvedRelease.revision,
          },
          reason_codes: ["runtime_readback_unknown"],
        },
        release_history: [{
          ...unresolvedRelease,
          reason_codes: ["runtime_readback_unknown"],
        }, activeRelease],
      },
      "unknown observation is completely exact",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          base_release_id: null,
          base_revision: 3,
        },
      },
      "preview base pair is half null",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          base_release_id: "release_2026_08_22_002",
          base_revision: 2,
        },
      },
      "unconsumed preview base is stale",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          created_at: validControlState.latest_preview.expires_at,
        },
      },
      "preview expiry is not after creation",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          diff: {
            ...validControlState.latest_preview.diff,
            added: [validModuleRef],
          },
        },
      },
      "preview diff logical sets overlap",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          desired_modules: [secondModuleRef],
        },
      },
      "preview desired set differs from added and retained",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          validation: {
            ...validControlState.latest_preview.validation,
            reason_codes: ["unexpected_reason"],
          },
        },
      },
      "preview all-valid flags have reasons",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          validation: {
            ...validControlState.latest_preview.validation,
            base_matches: false,
            reason_codes: [],
          },
        },
      },
      "preview failed validation has no reason",
    );
    expectProducerRejection(
      {
        ...validControlState,
        latest_preview: {
          ...validControlState.latest_preview,
          preview_ref: "preview_2026_08_22_004",
          consumed: true,
        },
        latest_approval: {
          ...validControlState.latest_approval,
          approval_id: "approval_2026_08_22_004",
          preview_ref: "preview_2026_08_22_004",
          consumed: true,
        },
      },
      "consumed preview and approval have no history row",
    );
    expectProducerRejection(
      {
        ...validControlState,
        release_history: [{
          ...activeRelease,
          intent: "rollback",
          rollback_target_release_id: activeRelease.release_id,
        }],
      },
      "rollback targets its own release",
    );
    expectProducerRejection(
      {
        ...validChainedState,
        release_history: [
          linkedActiveRelease,
          {
            ...olderSupersededRelease,
            intent: "rollback",
            rollback_target_release_id: linkedActiveRelease.release_id,
          },
        ],
      },
      "rollback history targets a newer bounded release",
    );
  });

  it("preserves superseded modules outside current inventory without making them reactivatable", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const producerAccepts = (data: unknown): boolean => {
      try {
        controlContracts.assertControlStateProducerSemantics(data);
        return true;
      } catch {
        return false;
      }
    };
    const assertGenericStacksAccept = (data: unknown, label: string): void => {
      const envelope = { ...validEnvelope, data };
      expect.soft(
        controlEnvelopeSchema.safeParse(envelope).success,
        `${label}: generic Zod`,
      ).toBe(true);
      expect.soft(validateEnvelope(envelope), `${label}: generic Ajv`).toBe(true);
    };
    const assertProducerRejects = (data: unknown, label: string): void => {
      assertGenericStacksAccept(data, label);
      expect.soft(producerAccepts(data), `${label}: producer`).toBe(false);
    };

    const legacyModuleRef = {
      module_id: "legacy_module",
      version: "2025-12-01.v0",
      descriptor_digest: `sha256:${"9".repeat(64)}`,
    } as const;
    const activeRelease = {
      ...validControlState.release_history[0],
      previous_release_id: "release_2026_08_22_002",
    } as const;
    const supersededLegacyRelease = {
      ...validControlState.release_history[0],
      release_id: "release_2026_08_22_002",
      revision: 2,
      desired_modules: [legacyModuleRef],
      previous_release_id: "release_2026_08_22_001",
      preview_ref: "preview_2026_08_22_002",
      approval_id: "approval_2026_08_22_002",
      created_at: "2026-08-22T16:30:00Z",
      published_at: "2026-08-22T16:40:00Z",
      readback_ref: "readback_2026_08_22_002",
      status: "superseded",
      superseded_by_release_id: activeRelease.release_id,
    } as const;
    const stateWithHistoricalModule = {
      ...validControlState,
      release_history: [activeRelease, supersededLegacyRelease],
    };

    assertGenericStacksAccept(
      stateWithHistoricalModule,
      "superseded old module absent from current inventory",
    );
    expect.soft(
      producerAccepts(stateWithHistoricalModule),
      "superseded old module absent from current inventory: producer",
    ).toBe(true);

    assertProducerRejects(
      {
        ...stateWithHistoricalModule,
        release_history: [
          activeRelease,
          {
            ...supersededLegacyRelease,
            desired_modules: [{
              ...validModuleRef,
              descriptor_digest: `sha256:${"8".repeat(64)}`,
            }],
          },
        ],
      },
      "superseded history conflicts with a current logical digest",
    );
    assertProducerRejects(
      {
        ...validControlState,
        activation: {
          ...validControlState.activation,
          active_modules: [legacyModuleRef],
        },
        latest_readback: {
          ...validControlState.latest_readback,
          applied_modules: [legacyModuleRef],
        },
        release_history: [{
          ...validControlState.release_history[0],
          desired_modules: [legacyModuleRef],
        }],
      },
      "active old module absent from current inventory",
    );

    const unresolvedLegacyRelease = {
      ...validControlState.release_history[0],
      release_id: "release_2026_08_22_004",
      revision: 4,
      desired_modules: [legacyModuleRef],
      previous_release_id: validControlState.activation.release_id,
      preview_ref: "preview_2026_08_22_004",
      approval_id: "approval_2026_08_22_004",
      created_at: "2026-08-22T18:35:00Z",
      published_at: "2026-08-22T18:40:00Z",
      readback_ref: "readback_2026_08_22_004",
      status: "manual_review",
      reason_codes: ["runtime_readback_mismatch"],
      superseded_by_release_id: null,
    } as const;
    assertProducerRejects(
      {
        ...validControlState,
        latest_readback: {
          release_id: unresolvedLegacyRelease.release_id,
          revision: unresolvedLegacyRelease.revision,
          readback_ref: unresolvedLegacyRelease.readback_ref,
          applied_modules: [legacyModuleRef],
          status: "mismatch",
          observed_activation: {
            release_id: validControlState.activation.release_id,
            revision: validControlState.activation.revision,
          },
          reason_codes: unresolvedLegacyRelease.reason_codes,
          checked_at: "2026-08-22T18:45:00Z",
        },
        release_history: [
          unresolvedLegacyRelease,
          validControlState.release_history[0],
        ],
      },
      "newest unresolved old module absent from current inventory",
    );
    assertProducerRejects(
      {
        ...stateWithHistoricalModule,
        latest_preview: {
          ...validControlState.latest_preview,
          intent: "rollback",
          target_release_id: supersededLegacyRelease.release_id,
          desired_modules: [legacyModuleRef],
          diff: {
            added: [legacyModuleRef],
            removed: [validModuleRef],
            retained: [],
          },
        },
      },
      "unconsumed rollback preview targets module absent from inventory",
    );
  });

  it("enforces logical inventory uniqueness and the authoritative event window", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const producerAccepts = (data: unknown): boolean => {
      try {
        controlContracts.assertControlStateProducerSemantics(data);
        return true;
      } catch {
        return false;
      }
    };
    const assertGenericStacksAccept = (data: unknown, label: string): void => {
      const envelope = { ...validEnvelope, data };
      expect.soft(
        controlEnvelopeSchema.safeParse(envelope).success,
        `${label}: Zod`,
      ).toBe(true);
      expect.soft(validateEnvelope(envelope), `${label}: Ajv`).toBe(true);
    };
    const assertSemanticRejection = (data: unknown, label: string): void => {
      assertGenericStacksAccept(data, label);
      expect.soft(producerAccepts(data), `${label}: producer`).toBe(false);
    };
    const assertSemanticAcceptance = (data: unknown, label: string): void => {
      assertGenericStacksAccept(data, label);
      expect.soft(producerAccepts(data), `${label}: producer`).toBe(true);
    };
    const makeTwoEventState = (previousAt: string, currentAt: string) => ({
      ...validControlState,
      events: [
        {
          ...validControlState.events[0],
          occurred_at: previousAt,
        },
        {
          ...validControlState.events[0],
          sequence: 2,
          event_id: "event_time_2",
          occurred_at: currentAt,
        },
      ],
    });

    const crossDigestInventory = {
      ...validControlState,
      inventory_modules: [
        ...validControlState.inventory_modules,
        {
          ...validControlState.inventory_modules[0],
          descriptor_digest: `sha256:${"e".repeat(64)}`,
          tool_names: ["cargo.calculate.alternate"],
        },
      ],
    };
    const crossDigestInventoryEnvelope = {
      ...validEnvelope,
      data: crossDigestInventory,
    };
    expect.soft(
      controlEnvelopeSchema.safeParse(crossDigestInventoryEnvelope).success,
      "logical inventory duplicate: Zod",
    ).toBe(false);
    expect.soft(
      validateEnvelope(crossDigestInventoryEnvelope),
      "logical inventory duplicate: Ajv exact-only uniqueItems",
    ).toBe(true);
    expect.soft(
      producerAccepts(crossDigestInventory),
      "logical inventory duplicate: producer",
    ).toBe(false);

    const truncatedEvents = Array.from({ length: 256 }, (_, index) => ({
      ...validControlState.events[0],
      sequence: index + 2,
      event_id: `event_window_${index + 2}`,
    }));
    const validTruncatedState = {
      ...validControlState,
      events: truncatedEvents,
      events_truncated: true,
    };
    assertGenericStacksAccept(validTruncatedState, "full truncated event window");
    expect.soft(
      producerAccepts(validTruncatedState),
      "full truncated event window: producer",
    ).toBe(true);

    assertSemanticAcceptance(
      makeTwoEventState(
        "2026-08-22T17:30:00.000000001Z",
        "2026-08-22T18:30:00.000000001+01:00",
      ),
      "event instants equal through different offsets",
    );
    assertSemanticAcceptance(
      makeTwoEventState(
        "2026-08-22T17:30:00.000000001Z",
        "2026-08-22T18:30:00.000000002+01:00",
      ),
      "event instant increases one nanosecond through an offset",
    );
    assertSemanticRejection(
      makeTwoEventState(
        "2026-08-22T17:30:00.000000002Z",
        "2026-08-22T17:30:00.000000001Z",
      ),
      "event instant reverses by one nanosecond",
    );
    assertSemanticRejection(
      makeTwoEventState(
        "2026-08-22T17:30:00.000000002Z",
        "2026-08-22T18:30:00.000000001+01:00",
      ),
      "event instant reverses by one nanosecond through an offset",
    );

    assertSemanticRejection(
      {
        ...validControlState,
        events: [
          validControlState.events[0],
          {
            ...validControlState.events[0],
            sequence: 2,
          },
        ],
      },
      "duplicate event id",
    );
    assertSemanticRejection(
      {
        ...validControlState,
        events: [
          validControlState.events[0],
          {
            ...validControlState.events[0],
            sequence: 3,
            event_id: "event_sequence_3",
          },
        ],
      },
      "event sequence gap",
    );
    assertSemanticRejection(
      {
        ...validControlState,
        events: [
          {
            ...validControlState.events[0],
            occurred_at: "2026-08-22T17:31:00Z",
          },
          {
            ...validControlState.events[0],
            sequence: 2,
            event_id: "event_time_2",
            occurred_at: "2026-08-22T17:30:00Z",
          },
        ],
      },
      "event timestamps decrease",
    );
    assertSemanticRejection(
      {
        ...validControlState,
        events_truncated: true,
      },
      "truncated flag on a partial event window",
    );
    assertSemanticRejection(
      {
        ...validControlState,
        events: [{
          ...validControlState.events[0],
          sequence: 2,
        }],
      },
      "non-truncated event window does not start at one",
    );
    assertSemanticRejection(
      {
        ...validControlState,
        events: Array.from({ length: 256 }, (_, index) => ({
          ...validControlState.events[0],
          sequence: index + 1,
          event_id: `event_untruncated_origin_${index + 1}`,
        })),
        events_truncated: true,
      },
      "truncated event window still starts at one",
    );
  });

  it("rejects every revision above the JavaScript safe-integer maximum", () => {
    const envelopeSchema = JSON.parse(
      readFileSync(resolve(schemaDir, "control-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validateEnvelope = createAjv().compile(envelopeSchema);
    const unsafeRevision = 9_007_199_254_740_992;
    const candidates = [
      {
        ...validEnvelope,
        data: {
          ...validControlState,
          activation: { ...validControlState.activation, revision: unsafeRevision },
        },
      },
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
