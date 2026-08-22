import { z } from "zod";

import { ENVELOPE_STATUSES } from "../platform/envelope";
import { ADMIN_CONTROL_SCHEMA_VERSION } from "./types";

export { ADMIN_CONTROL_SCHEMA_VERSION } from "./types";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const descriptorDigestPattern = /^sha256:[a-f0-9]{64}$/;

const identifierSchema = z.string().regex(identifierPattern);
const versionSchema = z.string().regex(versionPattern);
const descriptorDigestSchema = z.string().regex(descriptorDigestPattern);

export const activeModuleRefSchema = z
  .object({
    module_id: identifierSchema,
    version: versionSchema,
    descriptor_digest: descriptorDigestSchema,
  })
  .strict();

const schemaVersionSchema = z.literal(ADMIN_CONTROL_SCHEMA_VERSION);

export const registerPackageRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    module_id: identifierSchema,
    version: versionSchema,
    descriptor_digest: descriptorDigestSchema,
  })
  .strict();

const deploymentChangeRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    intent: z.literal("change"),
    desired_modules: z.array(activeModuleRefSchema).min(1),
  })
  .strict();

const deploymentRollbackRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    intent: z.literal("rollback"),
    target_release_id: identifierSchema,
  })
  .strict();

export const deploymentPreviewRequestSchema = z.discriminatedUnion("intent", [
  deploymentChangeRequestSchema,
  deploymentRollbackRequestSchema,
]);

export const approvalRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    preview_ref: identifierSchema,
    decision: z.enum(["approve", "reject"]),
    reason_code: identifierSchema,
  })
  .strict();

export const publishRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    preview_ref: identifierSchema,
    approval_id: identifierSchema,
  })
  .strict();

export const reconcileRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    release_id: identifierSchema,
  })
  .strict();

const nonnegativeIntegerSchema = z.number().int().nonnegative().safe();

const controlStateDataSchema = z
  .object({
    kind: z.literal("control_state"),
    active_release_id: identifierSchema.nullable().optional(),
    active_revision: nonnegativeIntegerSchema.optional(),
    active_modules: z.array(activeModuleRefSchema).optional(),
    inventory_module_ids: z.array(identifierSchema).optional(),
  })
  .strict();

const registrationDataSchema = z
  .object({
    kind: z.literal("registration"),
    module_id: identifierSchema.optional(),
    version: versionSchema.optional(),
    descriptor_digest: descriptorDigestSchema.optional(),
    evidence_level: z.literal("local_build").optional(),
    production_eligible: z.literal(false).optional(),
  })
  .strict();

const previewDataSchema = z
  .object({
    kind: z.literal("preview"),
    preview_ref: identifierSchema.optional(),
    intent: z.enum(["change", "rollback"]).optional(),
    base_release_id: identifierSchema.nullable().optional(),
    base_revision: nonnegativeIntegerSchema.optional(),
    desired_modules: z.array(activeModuleRefSchema).optional(),
    target_release_id: identifierSchema.nullable().optional(),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const approvalDataSchema = z
  .object({
    kind: z.literal("approval"),
    approval_id: identifierSchema.optional(),
    preview_ref: identifierSchema.optional(),
    decision: z.enum(["approve", "reject"]).optional(),
  })
  .strict();

const releaseDataSchema = z
  .object({
    kind: z.literal("release"),
    release_id: identifierSchema.optional(),
    revision: nonnegativeIntegerSchema.optional(),
    active_modules: z.array(activeModuleRefSchema).optional(),
  })
  .strict();

const reconciliationDataSchema = z
  .object({
    kind: z.literal("reconciliation"),
    release_id: identifierSchema.nullable().optional(),
    revision: nonnegativeIntegerSchema.nullable().optional(),
    status: z.enum(["pending", "verified", "mismatch", "unknown"]).optional(),
  })
  .strict();

export const controlDataSchema = z.discriminatedUnion("kind", [
  controlStateDataSchema,
  registrationDataSchema,
  previewDataSchema,
  approvalDataSchema,
  releaseDataSchema,
  reconciliationDataSchema,
]);

export const readbackSchema = z
  .object({
    status: z.enum(["not_applicable", "pending", "verified", "mismatch", "unknown"]),
    release_id: identifierSchema.nullable(),
    revision: nonnegativeIntegerSchema.nullable(),
  })
  .strict();

export const controlEnvelopeSchema = z
  .object({
    schema_version: schemaVersionSchema,
    request_id: identifierSchema,
    trace_id: identifierSchema,
    audit_id: identifierSchema,
    status: z.enum(ENVELOPE_STATUSES),
    data: controlDataSchema.nullable(),
    reason_codes: z.array(identifierSchema),
    readback: readbackSchema,
  })
  .strict();

export type RegisterPackageRequest = z.infer<typeof registerPackageRequestSchema>;
export type DeploymentPreviewRequest = z.infer<typeof deploymentPreviewRequestSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type PublishRequest = z.infer<typeof publishRequestSchema>;
export type ReconcileRequest = z.infer<typeof reconcileRequestSchema>;
export type ControlData = z.infer<typeof controlDataSchema>;
export type ControlReadback = z.infer<typeof readbackSchema>;
export type ControlEnvelope = z.infer<typeof controlEnvelopeSchema>;

export type ActiveModuleRefInput = z.infer<typeof activeModuleRefSchema>;
