import { types as nodeUtilTypes } from "node:util";

import { z } from "zod";

import { ENVELOPE_STATUSES } from "../platform/envelope";
import {
  DESCRIPTOR_DIGEST_PATTERN,
  IDENTIFIER_PATTERN,
  VERSION_PATTERN,
} from "./lexical-contracts";
import {
  ADMIN_CONTROL_RFC3339_PATTERN,
  compareRfc3339Instants,
} from "./rfc3339-instant";
import { ADMIN_CONTROL_SCHEMA_VERSION } from "./types";

export { ADMIN_CONTROL_RFC3339_PATTERN } from "./rfc3339-instant";
export { ADMIN_CONTROL_SCHEMA_VERSION } from "./types";

const identifierSchema = z.string().regex(IDENTIFIER_PATTERN);
const versionSchema = z.string().regex(VERSION_PATTERN);
const descriptorDigestSchema = z.string().regex(DESCRIPTOR_DIGEST_PATTERN);

export const activeModuleRefSchema = z
  .object({
    module_id: identifierSchema,
    version: versionSchema,
    descriptor_digest: descriptorDigestSchema,
  })
  .strict();

const schemaVersionSchema = z.literal(ADMIN_CONTROL_SCHEMA_VERSION);

export const CONTROL_STATE_MAX_MODULES = 64 as const;
export const CONTROL_STATE_MAX_TOOLS_PER_MODULE = 128 as const;
export const CONTROL_STATE_MAX_STANDARDS_PER_MODULE = 64 as const;
export const CONTROL_STATE_MAX_RELEASE_HISTORY = 128 as const;
export const CONTROL_STATE_MAX_EVENTS = 256 as const;
export const CONTROL_STATE_MAX_REASON_CODES = 32 as const;

const previewCanonicalHashSchema = z
  .string()
  .regex(/^mcp-control-hash\/v1\/preview\/sha256:[a-f0-9]{64}$/);

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
    desired_modules: createModuleRefArraySchema(1),
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

const nonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .safe();
const positiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .safe();
const timestampSchema = z.string().regex(ADMIN_CONTROL_RFC3339_PATTERN);
const reasonCodesSchema = z
  .array(identifierSchema)
  .max(CONTROL_STATE_MAX_REASON_CODES);
const emptyReasonCodesSchema = reasonCodesSchema.max(0);
const nonEmptyReasonCodesSchema = reasonCodesSchema.min(1);

function createModuleRefArraySchema(minimumItems = 0) {
  return z
    .array(activeModuleRefSchema)
    .min(minimumItems)
    .max(CONTROL_STATE_MAX_MODULES)
    .superRefine((items, context) => {
      const seen = new Set<string>();
      for (const [index, item] of items.entries()) {
        const key = `${item.module_id}\u0000${item.version}`;
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            message: "duplicate_logical_module_ref",
            path: [index],
          });
        }
        seen.add(key);
      }
    });
}

function createUniqueIdentifierArraySchema(maximumItems: number) {
  return z
    .array(identifierSchema)
    .max(maximumItems)
    .superRefine((items, context) => {
      const seen = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (seen.has(item)) {
          context.addIssue({
            code: "custom",
            message: "duplicate_identifier",
            path: [index],
          });
        }
        seen.add(item);
      }
    });
}

const moduleRefArraySchema = createModuleRefArraySchema();
const nonEmptyModuleRefArraySchema = createModuleRefArraySchema(1);

const moduleRiskLevelSchema = z.enum(["T0", "T1", "T2", "T3"]);

const registrationSummarySchema = z
  .object({
    registered_by_actor_ref: identifierSchema,
    registered_at: timestampSchema,
  })
  .strict();

const inventoryModuleSchema = z
  .object({
    module_id: identifierSchema,
    version: versionSchema,
    risk_level: moduleRiskLevelSchema,
    descriptor_digest: descriptorDigestSchema,
    evidence_level: z.literal("local_build"),
    production_eligible: z.literal(false),
    tool_names: createUniqueIdentifierArraySchema(
      CONTROL_STATE_MAX_TOOLS_PER_MODULE,
    ),
    standard_ids: createUniqueIdentifierArraySchema(
      CONTROL_STATE_MAX_STANDARDS_PER_MODULE,
    ),
    registration: registrationSummarySchema.nullable(),
  })
  .strict();

const previewDiffSchema = z
  .object({
    added: moduleRefArraySchema,
    removed: moduleRefArraySchema,
    retained: moduleRefArraySchema,
  })
  .strict();

const previewValidationSchema = z
  .object({
    base_matches: z.boolean(),
    desired_modules_valid: z.boolean(),
    inventory_matches: z.boolean(),
    minimum_active_modules: z.boolean(),
    reason_codes: reasonCodesSchema,
  })
  .strict();

const previewSnapshotBaseSchema = z
  .object({
    preview_ref: identifierSchema,
    canonical_hash: previewCanonicalHashSchema,
    base_release_id: identifierSchema.nullable(),
    base_revision: nonnegativeIntegerSchema,
    desired_modules: nonEmptyModuleRefArraySchema,
    diff: previewDiffSchema,
    validation: previewValidationSchema,
    creator_actor_ref: identifierSchema,
    created_at: timestampSchema,
    expires_at: timestampSchema,
    consumed: z.boolean(),
  })
  .strict();

const latestPreviewSchema = z.discriminatedUnion("intent", [
  previewSnapshotBaseSchema
    .extend({
      intent: z.literal("change"),
    })
    .strict(),
  previewSnapshotBaseSchema
    .extend({
      intent: z.literal("rollback"),
      target_release_id: identifierSchema,
    })
    .strict(),
]);

const latestApprovalBaseSchema = z
  .object({
    approval_id: identifierSchema,
    preview_ref: identifierSchema,
    reason_code: identifierSchema,
    approver_actor_ref: identifierSchema,
    decided_at: timestampSchema,
  })
  .strict();

const latestApprovalSchema = z.discriminatedUnion("decision", [
  latestApprovalBaseSchema
    .extend({
      decision: z.literal("approve"),
      consumed: z.boolean(),
    })
    .strict(),
  latestApprovalBaseSchema
    .extend({
      decision: z.literal("reject"),
      consumed: z.literal(false),
    })
    .strict(),
]);

const latestReadbackBaseSchema = z
  .object({
    release_id: identifierSchema,
    revision: positiveIntegerSchema,
    readback_ref: identifierSchema,
    applied_modules: moduleRefArraySchema,
    checked_at: timestampSchema,
  })
  .strict();

const observedActivationSchema = z.union([
  z
    .object({
      release_id: z.null(),
      revision: z.null(),
    })
    .strict(),
  z
    .object({
      release_id: identifierSchema,
      revision: positiveIntegerSchema,
    })
    .strict(),
]);

const latestReadbackSchema = z.discriminatedUnion("status", [
  latestReadbackBaseSchema
    .extend({
      status: z.literal("pending"),
      observed_activation: z.null(),
      reason_codes: emptyReasonCodesSchema,
    })
    .strict(),
  latestReadbackBaseSchema
    .extend({
      status: z.literal("verified"),
      applied_modules: nonEmptyModuleRefArraySchema,
      reason_codes: emptyReasonCodesSchema,
    })
    .strict(),
  latestReadbackBaseSchema
    .extend({
      status: z.literal("mismatch"),
      observed_activation: observedActivationSchema,
      reason_codes: nonEmptyReasonCodesSchema,
    })
    .strict(),
  latestReadbackBaseSchema
    .extend({
      status: z.literal("unknown"),
      observed_activation: observedActivationSchema,
      reason_codes: nonEmptyReasonCodesSchema,
    })
    .strict(),
]);

const releaseSummaryBaseSchema = z
  .object({
    release_id: identifierSchema,
    revision: positiveIntegerSchema,
    desired_modules: nonEmptyModuleRefArraySchema,
    previous_release_id: identifierSchema.nullable(),
    preview_ref: identifierSchema,
    approval_id: identifierSchema,
    publisher_actor_ref: identifierSchema,
    created_at: timestampSchema,
  })
  .strict();

const releaseSummaryPendingSchema = releaseSummaryBaseSchema
  .extend({
    status: z.literal("published_pending_readback"),
    published_at: timestampSchema.nullable(),
    readback_ref: z.null(),
    reason_codes: emptyReasonCodesSchema,
    superseded_by_release_id: z.null(),
  })
  .strict();

const releaseSummaryManualReviewSchema = releaseSummaryBaseSchema
  .extend({
    status: z.literal("manual_review"),
    published_at: timestampSchema,
    readback_ref: identifierSchema,
    reason_codes: nonEmptyReasonCodesSchema,
    superseded_by_release_id: z.null(),
  })
  .strict();

const releaseSummaryActiveSchema = releaseSummaryBaseSchema
  .extend({
    status: z.literal("active_verified"),
    published_at: timestampSchema,
    readback_ref: identifierSchema,
    reason_codes: emptyReasonCodesSchema,
    superseded_by_release_id: z.null(),
  })
  .strict();

const releaseSummarySupersededSchema = releaseSummaryBaseSchema
  .extend({
    status: z.literal("superseded"),
    published_at: timestampSchema,
    readback_ref: identifierSchema,
    reason_codes: emptyReasonCodesSchema,
    superseded_by_release_id: identifierSchema,
  })
  .strict();

const releaseSummarySchema = z.union([
  releaseSummaryPendingSchema.extend({ intent: z.literal("change") }).strict(),
  releaseSummaryManualReviewSchema.extend({ intent: z.literal("change") }).strict(),
  releaseSummaryActiveSchema.extend({ intent: z.literal("change") }).strict(),
  releaseSummarySupersededSchema.extend({ intent: z.literal("change") }).strict(),
  releaseSummaryPendingSchema
    .extend({
      intent: z.literal("rollback"),
      rollback_target_release_id: identifierSchema,
    })
    .strict(),
  releaseSummaryManualReviewSchema
    .extend({
      intent: z.literal("rollback"),
      rollback_target_release_id: identifierSchema,
    })
    .strict(),
  releaseSummaryActiveSchema
    .extend({
      intent: z.literal("rollback"),
      rollback_target_release_id: identifierSchema,
    })
    .strict(),
  releaseSummarySupersededSchema
    .extend({
      intent: z.literal("rollback"),
      rollback_target_release_id: identifierSchema,
    })
    .strict(),
]);

const controlEventActionSchema = z.enum([
  "packages.register",
  "deployments.preview",
  "approvals.decide",
  "deployments.publish",
  "deployments.reconcile",
]);
const eventSummaryBaseSchema = z
  .object({
    sequence: positiveIntegerSchema,
    event_id: identifierSchema,
    actor_ref: identifierSchema,
    object_ref: identifierSchema,
    reason_codes: reasonCodesSchema,
    occurred_at: timestampSchema,
  })
  .strict();

const reconciliationEventStatusSchema = z.enum([
  "pending",
  "verified",
  "mismatch",
  "unknown",
]);

const eventSummarySchema = z.union([
  eventSummaryBaseSchema
    .extend({
      action: z.literal("packages.register"),
      kind: z.literal("registration"),
      status: z.literal("registered"),
    })
    .strict(),
  eventSummaryBaseSchema
    .extend({
      action: z.literal("deployments.preview"),
      kind: z.literal("preview"),
      status: z.literal("previewed"),
    })
    .strict(),
  eventSummaryBaseSchema
    .extend({
      action: z.literal("approvals.decide"),
      kind: z.literal("approval"),
      status: z.enum(["approved", "rejected"]),
    })
    .strict(),
  eventSummaryBaseSchema
    .extend({
      action: z.literal("deployments.publish"),
      kind: z.literal("release"),
      status: z.enum([
        "published_pending_readback",
        "manual_review",
        "active_verified",
        "superseded",
      ]),
    })
    .strict(),
  eventSummaryBaseSchema
    .extend({
      action: z.literal("deployments.publish"),
      kind: z.literal("reconciliation"),
      status: reconciliationEventStatusSchema,
    })
    .strict(),
  eventSummaryBaseSchema
    .extend({
      action: z.literal("deployments.reconcile"),
      kind: z.literal("reconciliation"),
      status: reconciliationEventStatusSchema,
    })
    .strict(),
  eventSummaryBaseSchema
    .extend({
      action: controlEventActionSchema,
      kind: z.literal("idempotency"),
      status: z.enum(["reserved", "domain_committed", "completed"]),
    })
    .strict(),
]);

const inactiveActivationSchema = z
  .object({
    state: z.literal("inactive"),
    release_id: z.null(),
    revision: z.literal(0),
    active_modules: z.array(activeModuleRefSchema).max(0),
  })
  .strict();

const activeActivationSchema = z
  .object({
    state: z.literal("active"),
    release_id: identifierSchema,
    revision: positiveIntegerSchema,
    active_modules: nonEmptyModuleRefArraySchema,
  })
  .strict();

const controlActivationSchema = z.discriminatedUnion("state", [
  inactiveActivationSchema,
  activeActivationSchema,
]);

const inventoryModulesSchema = z
  .array(inventoryModuleSchema)
  .max(CONTROL_STATE_MAX_MODULES)
  .superRefine((items, context) => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      const key = `${item.module_id}\u0000${item.version}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "duplicate_logical_inventory_module",
          path: [index],
        });
      }
      seen.add(key);
    }
  });

export const controlStateDataSchema = z
  .object({
    kind: z.literal("control_state"),
    activation: controlActivationSchema,
    inventory_modules: inventoryModulesSchema,
    latest_preview: latestPreviewSchema.nullable(),
    latest_approval: latestApprovalSchema.nullable(),
    latest_readback: latestReadbackSchema.nullable(),
    release_history: z
      .array(releaseSummarySchema)
      .max(CONTROL_STATE_MAX_RELEASE_HISTORY),
    events: z.array(eventSummarySchema).max(CONTROL_STATE_MAX_EVENTS),
    events_truncated: z.boolean(),
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
    desired_modules: moduleRefArraySchema.optional(),
    target_release_id: identifierSchema.nullable().optional(),
    expires_at: z.string().regex(ADMIN_CONTROL_RFC3339_PATTERN).nullable().optional(),
    canonical_hash: previewCanonicalHashSchema.optional(),
    diff: previewDiffSchema.optional(),
    validation: previewValidationSchema.optional(),
    creator_actor_ref: identifierSchema.optional(),
    created_at: timestampSchema.optional(),
    consumed: z.boolean().optional(),
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
    revision: positiveIntegerSchema.optional(),
    active_modules: moduleRefArraySchema.optional(),
  })
  .strict();

const reconciliationDataSchema = z
  .object({
    kind: z.literal("reconciliation"),
    release_id: identifierSchema.nullable().optional(),
    revision: positiveIntegerSchema.nullable().optional(),
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

const applicableReadbackBaseSchema = z
  .object({
    release_id: identifierSchema,
    revision: positiveIntegerSchema,
  })
  .strict();

export const readbackSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("not_applicable"),
      release_id: z.null(),
      revision: z.null(),
    })
    .strict(),
  applicableReadbackBaseSchema
    .extend({ status: z.literal("pending") })
    .strict(),
  applicableReadbackBaseSchema
    .extend({ status: z.literal("verified") })
    .strict(),
  applicableReadbackBaseSchema
    .extend({ status: z.literal("mismatch") })
    .strict(),
  applicableReadbackBaseSchema
    .extend({ status: z.literal("unknown") })
    .strict(),
]);

export const controlEnvelopeSchema = z
  .object({
    schema_version: schemaVersionSchema,
    request_id: identifierSchema,
    trace_id: identifierSchema,
    audit_id: identifierSchema,
    status: z.enum(ENVELOPE_STATUSES),
    data: controlDataSchema.nullable(),
    reason_codes: reasonCodesSchema,
    readback: readbackSchema,
  })
  .strict();

const producerActionEnvelopeBranches = [
  "packages.register",
  "deployments.preview",
  "approvals.decide",
  "deployments.publish",
  "deployments.reconcile",
] as const;

function addProducerIssue(
  context: z.RefinementCtx,
  message: string,
): void {
  context.addIssue({
    code: "custom",
    message,
    path: ["envelope"],
  });
}

type ModuleRef = z.infer<typeof activeModuleRefSchema>;
type ParsedControlEnvelope = z.infer<typeof controlEnvelopeSchema>;
type ParsedControlState = z.infer<typeof controlStateDataSchema>;

export type DeepFrozen<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepFrozen<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepFrozen<T[Key]> }
      : T;

export class ControlContractError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "ControlContractError";
    this.code = code;
  }
}

function failControlContract(code: string): never {
  throw new ControlContractError(code);
}

function isDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return (
    descriptor !== undefined &&
    !("get" in descriptor) &&
    !("set" in descriptor)
  );
}

function snapshotPlainContractInput(input: unknown): unknown {
  const ancestors = new WeakSet<object>();

  const snapshot = (value: unknown): unknown => {
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value !== "object") {
      throw new TypeError("unsupported_contract_input");
    }
    if (nodeUtilTypes.isProxy(value)) {
      throw new TypeError("proxy_contract_input");
    }
    if (ancestors.has(value)) {
      throw new TypeError("cyclic_contract_input");
    }

    const prototype = Reflect.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const descriptorKeys = Reflect.ownKeys(descriptors);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype) {
          throw new TypeError("non_plain_contract_array");
        }
        const lengthDescriptor = Reflect.get(
          descriptors,
          "length",
        ) as PropertyDescriptor | undefined;
        if (
          !isDataDescriptor(lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          typeof lengthDescriptor.value !== "number" ||
          lengthDescriptor.value < 0
        ) {
          throw new TypeError("invalid_contract_array_length");
        }
        const length = lengthDescriptor.value;
        for (const key of descriptorKeys) {
          if (key === "length") continue;
          if (
            typeof key !== "string" ||
            !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
            Number(key) >= length
          ) {
            throw new TypeError("non_json_contract_array_property");
          }
        }

        const result: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Reflect.get(
            descriptors,
            String(index),
          ) as PropertyDescriptor | undefined;
          if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
            throw new TypeError("sparse_or_accessor_contract_array");
          }
          result.push(snapshot(descriptor.value));
        }
        return result;
      }

      if (prototype !== Object.prototype) {
        throw new TypeError("non_plain_contract_object");
      }
      const result = Object.create(null) as object;
      for (const key of descriptorKeys) {
        if (typeof key !== "string") {
          throw new TypeError("symbol_contract_property");
        }
        const descriptor = Reflect.get(
          descriptors,
          key,
        ) as PropertyDescriptor | undefined;
        if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
          throw new TypeError("accessor_or_hidden_contract_property");
        }
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: snapshot(descriptor.value),
          writable: true,
        });
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };

  return snapshot(input);
}

function deepFreeze<T>(value: T): DeepFrozen<T> {
  const seen = new WeakSet<object>();
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(candidate),
    )) {
      if (isDataDescriptor(descriptor)) freeze(descriptor.value);
    }
    Object.freeze(candidate);
  };
  freeze(value);
  return value as DeepFrozen<T>;
}

function throwRedactedContractError(error: unknown): never {
  if (error instanceof ControlContractError) throw error;
  if (error instanceof z.ZodError) {
    const controlledIssue = error.issues.find(
      (issue) =>
        issue.code === "custom" &&
        /^[a-z][a-z0-9_]*$/u.test(issue.message),
    );
    failControlContract(controlledIssue?.message ?? "control_contract_invalid");
  }
  failControlContract("control_contract_invalid");
}

function moduleLogicalKey(module: ModuleRef): string {
  return `${module.module_id}\u0000${module.version}`;
}

function moduleExactKey(module: ModuleRef): string {
  return `${moduleLogicalKey(module)}\u0000${module.descriptor_digest}`;
}

function moduleRefsHaveUniqueLogicalKeys(
  modules: readonly ModuleRef[],
): boolean {
  const keys = new Set(modules.map(moduleLogicalKey));
  return keys.size === modules.length;
}

function moduleRefSetsEqual(
  left: readonly ModuleRef[],
  right: readonly ModuleRef[],
): boolean {
  if (left.length !== right.length) return false;
  const rightKeys = new Set(right.map(moduleExactKey));
  return (
    rightKeys.size === right.length &&
    left.every((module) => rightKeys.has(moduleExactKey(module)))
  );
}

function identifierSetsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    left.every((value) => rightSet.has(value))
  );
}

function previewDiffIsClosed(
  desiredModules: readonly ModuleRef[],
  diff: z.infer<typeof previewDiffSchema>,
): boolean {
  const groups = [diff.added, diff.removed, diff.retained] as const;
  if (groups.some((group) => !moduleRefsHaveUniqueLogicalKeys(group))) {
    return false;
  }
  const allLogicalKeys = groups.flatMap((group) =>
    group.map(moduleLogicalKey),
  );
  if (new Set(allLogicalKeys).size !== allLogicalKeys.length) return false;
  return moduleRefSetsEqual(desiredModules, [
    ...diff.added,
    ...diff.retained,
  ]);
}

function addTerminalProducerIssueWhenInvalid(
  envelope: ParsedControlEnvelope,
  context: z.RefinementCtx,
  code: string,
): void {
  if (
    envelope.data !== null ||
    envelope.reason_codes.length === 0 ||
    envelope.readback.status !== "not_applicable"
  ) {
    addProducerIssue(context, code);
  }
}

function validateRegistrationProducerEnvelope(
  envelope: ParsedControlEnvelope,
  context: z.RefinementCtx,
): void {
  if (envelope.status === "blocked" || envelope.status === "unavailable") {
    addTerminalProducerIssueWhenInvalid(
      envelope,
      context,
      "register_terminal_failure_invalid",
    );
    return;
  }
  if (envelope.status !== "success") {
    addProducerIssue(context, "register_status_not_allowed");
    return;
  }
  const data = envelope.data;
  if (
    envelope.reason_codes.length !== 0 ||
    envelope.readback.status !== "not_applicable" ||
    data?.kind !== "registration" ||
    data.module_id === undefined ||
    data.version === undefined ||
    data.descriptor_digest === undefined ||
    data.evidence_level !== "local_build" ||
    data.production_eligible !== false
  ) {
    addProducerIssue(context, "register_success_incomplete");
  }
}

function validatePreviewProducerEnvelope(
  envelope: ParsedControlEnvelope,
  context: z.RefinementCtx,
): void {
  if (envelope.status === "blocked" || envelope.status === "unavailable") {
    addTerminalProducerIssueWhenInvalid(
      envelope,
      context,
      "preview_terminal_failure_invalid",
    );
    return;
  }
  if (envelope.status !== "success" && envelope.status !== "needs_input") {
    addProducerIssue(context, "preview_status_not_allowed");
    return;
  }

  const data = envelope.data;
  if (
    data?.kind !== "preview" ||
    data.preview_ref === undefined ||
    data.intent === undefined ||
    data.base_release_id === undefined ||
    data.base_revision === undefined ||
    data.desired_modules === undefined ||
    data.desired_modules.length === 0 ||
    data.target_release_id === undefined ||
    data.expires_at === undefined ||
    data.expires_at === null ||
    data.canonical_hash === undefined ||
    data.diff === undefined ||
    data.validation === undefined ||
    data.creator_actor_ref === undefined ||
    data.created_at === undefined ||
    data.consumed !== false
  ) {
    addProducerIssue(context, "preview_output_incomplete");
    return;
  }

  const baseIsClosed =
    (data.base_release_id === null && data.base_revision === 0) ||
    (data.base_release_id !== null && data.base_revision > 0);
  const intentIsClosed =
    (data.intent === "change" && data.target_release_id === null) ||
    (data.intent === "rollback" && data.target_release_id !== null);
  const timestampsAreOrdered =
    compareRfc3339Instants(data.created_at, data.expires_at) === -1;
  if (
    !baseIsClosed ||
    !intentIsClosed ||
    !timestampsAreOrdered ||
    !moduleRefsHaveUniqueLogicalKeys(data.desired_modules) ||
    !previewDiffIsClosed(data.desired_modules, data.diff) ||
    envelope.readback.status !== "not_applicable"
  ) {
    addProducerIssue(context, "preview_output_inconsistent");
    return;
  }

  const validationFlags = [
    data.validation.base_matches,
    data.validation.desired_modules_valid,
    data.validation.inventory_matches,
    data.validation.minimum_active_modules,
  ];
  const allValidationPassed = validationFlags.every(Boolean);
  if (envelope.status === "success") {
    if (
      envelope.reason_codes.length !== 0 ||
      !allValidationPassed ||
      data.validation.reason_codes.length !== 0
    ) {
      addProducerIssue(context, "preview_success_validation_invalid");
    }
    return;
  }
  if (
    allValidationPassed ||
    data.validation.reason_codes.length === 0 ||
    !identifierSetsEqual(
      envelope.reason_codes,
      data.validation.reason_codes,
    )
  ) {
    addProducerIssue(context, "preview_needs_input_validation_invalid");
  }
}

function validateApprovalProducerEnvelope(
  envelope: ParsedControlEnvelope,
  context: z.RefinementCtx,
): void {
  if (envelope.status === "blocked" || envelope.status === "unavailable") {
    addTerminalProducerIssueWhenInvalid(
      envelope,
      context,
      "approval_terminal_failure_invalid",
    );
    return;
  }
  if (envelope.status !== "success") {
    addProducerIssue(context, "approval_status_not_allowed");
    return;
  }
  const data = envelope.data;
  if (
    envelope.reason_codes.length !== 0 ||
    envelope.readback.status !== "not_applicable" ||
    data?.kind !== "approval" ||
    data.approval_id === undefined ||
    data.preview_ref === undefined ||
    data.decision === undefined
  ) {
    addProducerIssue(context, "approval_success_incomplete");
  }
}

function releaseOutputIsComplete(
  data: ParsedControlEnvelope["data"],
): data is Extract<ParsedControlEnvelope["data"], { kind: "release" }> & {
  release_id: string;
  revision: number;
  active_modules: ModuleRef[];
} {
  return (
    data?.kind === "release" &&
    data.release_id !== undefined &&
    data.revision !== undefined &&
    data.active_modules !== undefined &&
    data.active_modules.length > 0
  );
}

function validatePublishProducerEnvelope(
  envelope: ParsedControlEnvelope,
  context: z.RefinementCtx,
): void {
  if (envelope.status === "blocked" || envelope.status === "unavailable") {
    addTerminalProducerIssueWhenInvalid(
      envelope,
      context,
      "publish_terminal_failure_invalid",
    );
    return;
  }
  if (envelope.status !== "success" && envelope.status !== "manual_review") {
    addProducerIssue(context, "publish_status_not_allowed");
    return;
  }
  const data = envelope.data;
  if (!releaseOutputIsComplete(data)) {
    addProducerIssue(context, "publish_output_incomplete");
    return;
  }
  const readback = envelope.readback;
  const identityMatches =
    readback.release_id === data.release_id &&
    readback.revision === data.revision;
  if (envelope.status === "success") {
    if (
      envelope.reason_codes.length !== 0 ||
      readback.status !== "verified" ||
      !identityMatches
    ) {
      addProducerIssue(context, "publish_readback_mismatch");
    }
    return;
  }
  if (
    envelope.reason_codes.length === 0 ||
    (readback.status !== "mismatch" && readback.status !== "unknown") ||
    !identityMatches
  ) {
    addProducerIssue(context, "publish_manual_review_invalid");
  }
}

function reconciliationOutputIsComplete(
  data: ParsedControlEnvelope["data"],
): data is Extract<
  ParsedControlEnvelope["data"],
  { kind: "reconciliation" }
> & {
  release_id: string;
  revision: number;
  status: "pending" | "verified" | "mismatch" | "unknown";
} {
  return (
    data?.kind === "reconciliation" &&
    data.release_id !== undefined &&
    data.release_id !== null &&
    data.revision !== undefined &&
    data.revision !== null &&
    data.status !== undefined
  );
}

function validateReconcileProducerEnvelope(
  envelope: ParsedControlEnvelope,
  context: z.RefinementCtx,
): void {
  if (envelope.status === "blocked" || envelope.status === "unavailable") {
    addTerminalProducerIssueWhenInvalid(
      envelope,
      context,
      "reconcile_terminal_failure_invalid",
    );
    return;
  }
  if (envelope.status !== "success" && envelope.status !== "manual_review") {
    addProducerIssue(context, "reconcile_status_not_allowed");
    return;
  }
  const data = envelope.data;
  if (!reconciliationOutputIsComplete(data)) {
    addProducerIssue(context, "reconcile_output_incomplete");
    return;
  }
  const readback = envelope.readback;
  const identityMatches =
    readback.release_id === data.release_id &&
    readback.revision === data.revision;
  if (envelope.status === "success") {
    if (
      envelope.reason_codes.length !== 0 ||
      data.status !== "verified" ||
      readback.status !== "verified" ||
      !identityMatches
    ) {
      addProducerIssue(context, "reconcile_readback_mismatch");
    }
    return;
  }
  if (
    envelope.reason_codes.length === 0 ||
    (data.status !== "mismatch" && data.status !== "unknown") ||
    readback.status !== data.status ||
    !identityMatches
  ) {
    addProducerIssue(context, "reconcile_manual_review_invalid");
  }
}

export const controlProducerEnvelopeSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal(producerActionEnvelopeBranches[0]),
        envelope: controlEnvelopeSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal(producerActionEnvelopeBranches[1]),
        envelope: controlEnvelopeSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal(producerActionEnvelopeBranches[2]),
        envelope: controlEnvelopeSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal(producerActionEnvelopeBranches[3]),
        envelope: controlEnvelopeSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal(producerActionEnvelopeBranches[4]),
        envelope: controlEnvelopeSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    const { action, envelope } = value;
    switch (action) {
      case "packages.register":
        validateRegistrationProducerEnvelope(envelope, context);
        return;
      case "deployments.preview":
        validatePreviewProducerEnvelope(envelope, context);
        return;
      case "approvals.decide":
        validateApprovalProducerEnvelope(envelope, context);
        return;
      case "deployments.publish":
        validatePublishProducerEnvelope(envelope, context);
        return;
      case "deployments.reconcile":
        validateReconcileProducerEnvelope(envelope, context);
        return;
    }
  });

export type ControlProducerAction =
  (typeof producerActionEnvelopeBranches)[number];

export function assertControlProducerEnvelope(
  action: ControlProducerAction,
  envelope: unknown,
): DeepFrozen<ParsedControlEnvelope> {
  let snapshot: unknown;
  try {
    snapshot = snapshotPlainContractInput(envelope);
  } catch {
    failControlContract("control_contract_input_invalid");
  }
  try {
    const parsed = controlProducerEnvelopeSchema.parse({
      action,
      envelope: snapshot,
    });
    return deepFreeze(parsed.envelope);
  } catch (error) {
    throwRedactedContractError(error);
  }
}

function validateTargetModulesAgainstInventory(
  modules: readonly ModuleRef[],
  inventory: ReadonlyMap<string, string>,
): void {
  for (const module of modules) {
    const inventoryDigest = inventory.get(moduleLogicalKey(module));
    if (inventoryDigest === undefined) {
      failControlContract("target_module_not_in_inventory");
    }
    if (inventoryDigest !== module.descriptor_digest) {
      failControlContract("module_identity_digest_conflict");
    }
  }
}

function validatePreviewStateSemantics(
  state: ParsedControlState,
  inventory: ReadonlyMap<string, string>,
): void {
  const preview = state.latest_preview;
  const approval = state.latest_approval;
  if (preview === null) {
    if (approval !== null) {
      failControlContract("latest_approval_without_preview");
    }
    return;
  }
  const baseIsClosed =
    (preview.base_release_id === null && preview.base_revision === 0) ||
    (preview.base_release_id !== null && preview.base_revision > 0);
  if (!baseIsClosed) failControlContract("preview_base_pair_invalid");
  if (preview.intent === "rollback") {
    const targetRelease = state.release_history.find(
      (release) => release.release_id === preview.target_release_id,
    );
    if (targetRelease === undefined) {
      failControlContract("rollback_preview_target_missing_bounded_history");
    }
    if (targetRelease.revision >= preview.base_revision) {
      failControlContract("rollback_preview_target_not_older_than_base");
    }
  }
  if (
    compareRfc3339Instants(preview.created_at, preview.expires_at) !== -1
  ) {
    failControlContract("preview_expiry_not_after_creation");
  }
  if (!previewDiffIsClosed(preview.desired_modules, preview.diff)) {
    failControlContract("preview_diff_invalid");
  }
  const validationPassed = [
    preview.validation.base_matches,
    preview.validation.desired_modules_valid,
    preview.validation.inventory_matches,
    preview.validation.minimum_active_modules,
  ].every(Boolean);
  if (validationPassed !== (preview.validation.reason_codes.length === 0)) {
    failControlContract("preview_validation_reason_mismatch");
  }
  if (
    preview.consumed &&
    (!validationPassed || preview.validation.reason_codes.length !== 0)
  ) {
    failControlContract("consumed_preview_validation_failed");
  }
  if (
    preview.consumed &&
    (approval === null ||
      approval.decision !== "approve" ||
      approval.consumed !== true)
  ) {
    failControlContract("consumed_preview_approval_invalid");
  }

  if (!preview.consumed) {
    validateTargetModulesAgainstInventory(preview.desired_modules, inventory);
    validateTargetModulesAgainstInventory(preview.diff.added, inventory);
    validateTargetModulesAgainstInventory(preview.diff.removed, inventory);
    validateTargetModulesAgainstInventory(preview.diff.retained, inventory);
    const matchesActivation =
      state.activation.state === "inactive"
        ? preview.base_release_id === null && preview.base_revision === 0
        : preview.base_release_id === state.activation.release_id &&
          preview.base_revision === state.activation.revision;
    if (!matchesActivation) {
      failControlContract("unconsumed_preview_base_not_active");
    }
  }

  if (approval !== null && approval.preview_ref !== preview.preview_ref) {
    failControlContract("latest_approval_preview_mismatch");
  }
  if (approval !== null && approval.consumed !== preview.consumed) {
    failControlContract("preview_approval_consumption_mismatch");
  }
  if (approval?.consumed === true && preview.consumed) {
    const consumedReleaseExists = state.release_history.some(
      (release) =>
        release.preview_ref === preview.preview_ref &&
        release.approval_id === approval.approval_id,
    );
    if (!consumedReleaseExists) {
      failControlContract("consumed_preview_approval_missing_history");
    }
  }
}

function validateReleaseHistorySemantics(
  state: ParsedControlState,
  inventory: ReadonlyMap<string, string>,
): void {
  const releaseIds = new Set<string>();
  const revisions = new Set<number>();
  for (const release of state.release_history) {
    if (release.published_at !== null) {
      const publicationComparison = compareRfc3339Instants(
        release.created_at,
        release.published_at,
      );
      if (publicationComparison === null || publicationComparison === 1) {
        failControlContract("release_published_at_before_created_at");
      }
    }
    if (releaseIds.has(release.release_id)) {
      failControlContract("duplicate_release_id");
    }
    if (revisions.has(release.revision)) {
      failControlContract("duplicate_release_revision");
    }
    releaseIds.add(release.release_id);
    revisions.add(release.revision);
  }

  for (let index = 1; index < state.release_history.length; index += 1) {
    const newer = state.release_history[index - 1]!;
    const older = state.release_history[index]!;
    if (newer.revision <= older.revision) {
      failControlContract("release_history_not_newest_first");
    }
    if (newer.revision !== older.revision + 1) {
      failControlContract("release_history_revision_gap");
    }
    if (newer.previous_release_id !== older.release_id) {
      failControlContract("release_history_previous_release_mismatch");
    }
  }

  const activeIndices: number[] = [];
  const unresolvedIndices: number[] = [];
  for (const [index, release] of state.release_history.entries()) {
    if (release.status === "active_verified") activeIndices.push(index);
    if (
      release.status === "published_pending_readback" ||
      release.status === "manual_review"
    ) {
      unresolvedIndices.push(index);
    }
  }
  if (activeIndices.length > 1) failControlContract("multiple_active_releases");
  if (unresolvedIndices.length > 1) {
    failControlContract("multiple_unresolved_releases");
  }
  if (unresolvedIndices.length === 1 && unresolvedIndices[0] !== 0) {
    failControlContract("unresolved_release_not_newest");
  }
  if (activeIndices.length === 1) {
    const expectedActiveIndex = unresolvedIndices.length === 1 ? 1 : 0;
    if (activeIndices[0] !== expectedActiveIndex) {
      failControlContract("active_release_history_position_invalid");
    }
    validateTargetModulesAgainstInventory(
      state.release_history[activeIndices[0]]!.desired_modules,
      inventory,
    );
  }
  if (unresolvedIndices.length === 1) {
    validateTargetModulesAgainstInventory(
      state.release_history[unresolvedIndices[0]!]!.desired_modules,
      inventory,
    );
  }

  for (const [index, release] of state.release_history.entries()) {
    if (activeIndices.includes(index) || unresolvedIndices.includes(index)) {
      continue;
    }
    if (release.status !== "superseded" || index === 0) {
      failControlContract("release_history_status_chain_invalid");
    }
    if (
      release.superseded_by_release_id !==
      state.release_history[index - 1]!.release_id
    ) {
      failControlContract("release_history_superseded_chain_invalid");
    }
  }

  for (const release of state.release_history) {
    if (release.intent !== "rollback") continue;
    if (release.rollback_target_release_id === release.release_id) {
      failControlContract("rollback_target_is_self");
    }
    const target = state.release_history.find(
      (candidate) =>
        candidate.release_id === release.rollback_target_release_id,
    );
    if (target !== undefined && target.revision >= release.revision) {
      failControlContract("rollback_target_not_older");
    }
  }

  if (state.activation.state === "inactive") {
    if (activeIndices.length !== 0) {
      failControlContract("inactive_state_has_active_history");
    }
    if (state.latest_readback?.status === "verified") {
      failControlContract("inactive_state_has_verified_readback");
    }
    return;
  }

  if (activeIndices.length !== 1) {
    failControlContract("active_state_missing_active_history");
  }
  const activeRelease = state.release_history[activeIndices[0]!]!;
  if (
    activeRelease.release_id !== state.activation.release_id ||
    activeRelease.revision !== state.activation.revision ||
    !moduleRefSetsEqual(
      activeRelease.desired_modules,
      state.activation.active_modules,
    )
  ) {
    failControlContract("active_history_not_activation");
  }
}

function validateNewestReleaseReadbackRelation(state: ParsedControlState): void {
  const newest = state.release_history[0];
  if (newest === undefined) return;
  const readback = state.latest_readback;
  if (newest.status === "manual_review") {
    if (
      readback === null ||
      (readback.status !== "mismatch" && readback.status !== "unknown") ||
      readback.release_id !== newest.release_id ||
      readback.revision !== newest.revision
    ) {
      failControlContract("newest_manual_review_readback_missing");
    }
    return;
  }
  if (newest.status === "active_verified") {
    if (
      readback === null ||
      readback.status !== "verified"
    ) {
      failControlContract("newest_active_readback_missing");
    }
    return;
  }
  if (newest.status === "published_pending_readback") {
    if (readback === null || readback.status === "verified") return;
    failControlContract("pending_release_readback_mismatch");
  }
}

function validateReadbackStateSemantics(state: ParsedControlState): void {
  const readback = state.latest_readback;
  if (readback === null) return;
  if (readback.status === "pending") {
    failControlContract("pending_readback_not_producer_state");
  }
  if (
    readback.status === "verified" &&
    (state.activation.state !== "active" ||
      readback.release_id !== state.activation.release_id ||
      readback.revision !== state.activation.revision ||
      !moduleRefSetsEqual(
        readback.applied_modules,
        state.activation.active_modules,
      ))
  ) {
    failControlContract("verified_readback_not_active");
  }
  const release = state.release_history.find(
    (candidate) =>
      candidate.release_id === readback.release_id &&
      candidate.revision === readback.revision,
  );
  if (release === undefined) {
    failControlContract("latest_readback_release_missing_history");
  }
  if (
    release.readback_ref !== readback.readback_ref ||
    !identifierSetsEqual(release.reason_codes, readback.reason_codes)
  ) {
    failControlContract("latest_readback_history_mismatch");
  }

  if (readback.status === "verified") {
    if (
      release.status !== "active_verified" ||
      state.activation.state !== "active" ||
      readback.release_id !== state.activation.release_id ||
      readback.revision !== state.activation.revision ||
      !moduleRefSetsEqual(
        readback.applied_modules,
        state.activation.active_modules,
      ) ||
      !moduleRefSetsEqual(readback.applied_modules, release.desired_modules)
    ) {
      failControlContract("verified_readback_not_active");
    }
    return;
  }

  if (release.status !== "manual_review") {
    failControlContract("unverified_readback_history_mismatch");
  }
  const observationIsExact =
    readback.observed_activation.release_id === readback.release_id &&
    readback.observed_activation.revision === readback.revision &&
    moduleRefSetsEqual(readback.applied_modules, release.desired_modules);
  if (observationIsExact) {
    failControlContract("unverified_readback_is_exact");
  }
}

function validateEventWindowSemantics(state: ParsedControlState): void {
  const eventIds = new Set<string>();
  for (const event of state.events) {
    if (eventIds.has(event.event_id)) {
      failControlContract("duplicate_event_id");
    }
    eventIds.add(event.event_id);
  }
  for (let index = 1; index < state.events.length; index += 1) {
    const previous = state.events[index - 1]!;
    const current = state.events[index]!;
    if (current.sequence <= previous.sequence) {
      failControlContract("events_not_strictly_ascending");
    }
    if (current.sequence !== previous.sequence + 1) {
      failControlContract("event_sequence_gap");
    }
    const timeComparison = compareRfc3339Instants(
      previous.occurred_at,
      current.occurred_at,
    );
    if (timeComparison === null || timeComparison > 0) {
      failControlContract("event_time_not_monotonic");
    }
  }
  if (state.events_truncated) {
    if (
      state.events.length !== CONTROL_STATE_MAX_EVENTS ||
      state.events[0]!.sequence <= 1
    ) {
      failControlContract("truncated_event_window_invalid");
    }
    return;
  }
  if (state.events.length > 0 && state.events[0]!.sequence !== 1) {
    failControlContract("event_window_origin_invalid");
  }
}

function validateProjectionDigestConsistency(state: ParsedControlState): void {
  const digests = new Map<string, string>();
  const addModules = (modules: readonly ModuleRef[]): void => {
    for (const module of modules) {
      const key = moduleLogicalKey(module);
      const previousDigest = digests.get(key);
      if (
        previousDigest !== undefined &&
        previousDigest !== module.descriptor_digest
      ) {
        failControlContract("module_identity_digest_conflict");
      }
      digests.set(key, module.descriptor_digest);
    }
  };

  addModules(
    state.inventory_modules.map((module) => ({
      module_id: module.module_id,
      version: module.version,
      descriptor_digest: module.descriptor_digest,
    })),
  );
  if (state.activation.state === "active") {
    addModules(state.activation.active_modules);
  }
  if (state.latest_preview !== null) {
    addModules(state.latest_preview.desired_modules);
    addModules(state.latest_preview.diff.added);
    addModules(state.latest_preview.diff.removed);
    addModules(state.latest_preview.diff.retained);
  }
  for (const release of state.release_history) {
    addModules(release.desired_modules);
  }
  if (state.latest_readback?.status === "verified") {
    addModules(state.latest_readback.applied_modules);
  }
}

function validateControlStateProducerSemantics(
  state: ParsedControlState,
): void {
  const inventory = new Map<string, string>();
  for (const module of state.inventory_modules) {
    const key = moduleLogicalKey(module);
    if (inventory.has(key)) {
      failControlContract("duplicate_logical_inventory_module");
    }
    inventory.set(key, module.descriptor_digest);
  }
  validateProjectionDigestConsistency(state);
  if (state.activation.state === "active") {
    validateTargetModulesAgainstInventory(
      state.activation.active_modules,
      inventory,
    );
  }
  validatePreviewStateSemantics(state, inventory);
  validateReleaseHistorySemantics(state, inventory);
  validateNewestReleaseReadbackRelation(state);
  validateReadbackStateSemantics(state);
  validateEventWindowSemantics(state);
}

export function assertControlStateProducerSemantics(
  data: unknown,
): DeepFrozen<ParsedControlState> {
  let snapshot: unknown;
  try {
    snapshot = snapshotPlainContractInput(data);
  } catch {
    failControlContract("control_contract_input_invalid");
  }
  try {
    const state = controlStateDataSchema.parse(snapshot);
    validateControlStateProducerSemantics(state);
    return deepFreeze(state);
  } catch (error) {
    throwRedactedContractError(error);
  }
}

export type RegisterPackageRequest = z.infer<typeof registerPackageRequestSchema>;
export type DeploymentPreviewRequest = z.infer<typeof deploymentPreviewRequestSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type PublishRequest = z.infer<typeof publishRequestSchema>;
export type ReconcileRequest = z.infer<typeof reconcileRequestSchema>;
export type ControlData = z.infer<typeof controlDataSchema>;
export type ControlReadback = z.infer<typeof readbackSchema>;
export type ControlEnvelope = z.infer<typeof controlEnvelopeSchema>;
export type ControlStateData = z.infer<typeof controlStateDataSchema>;

export type ActiveModuleRefInput = z.infer<typeof activeModuleRefSchema>;
