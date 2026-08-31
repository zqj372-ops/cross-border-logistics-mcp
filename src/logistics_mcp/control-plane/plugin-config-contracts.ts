import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { z } from "zod";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export const PLUGIN_CONFIG_SCHEMA_VERSION = "2026-08-31.v1" as const;
export const PLUGIN_CONFIG_DIGEST_DOMAIN = "mcp-plugin-config-digest/v1" as const;
export const PLUGIN_CONFIG_REQUEST_HASH_DOMAIN = "mcp-plugin-config-request/v1" as const;

export const PLUGIN_CONFIG_MODULE_IDS = [
  "cargo",
  "container",
  "agent-access",
  "freightcom-ltl",
] as const;

export type PluginConfigModuleId = (typeof PLUGIN_CONFIG_MODULE_IDS)[number];
export type PluginConfigIntent = "change" | "rollback";
export type PluginConfigRestartPolicy = "restart_required" | "controlled_restart";
export type PluginConfigOutcomeStatus =
  | "success"
  | "manual_review"
  | "blocked"
  | "unavailable";
export type PluginConfigValidationStatus = "validated" | "blocked";
export type PluginConfigApprovalDecision = "approve" | "reject";
export type PluginConfigReleaseState =
  | "published_pending_apply"
  | "applying"
  | "restarting"
  | "readback_verified"
  | "manual_review"
  | "blocked"
  | "unavailable"
  | "superseded";
export type PluginConfigApplyAttemptPhase = "created" | "claimed" | "finalized";
export type PluginConfigApplyObservationStatus =
  | "readback_verified"
  | "mismatch"
  | "unknown"
  | "blocked"
  | "unavailable";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const hashPattern = /^mcp-plugin-config-hash\/v1\/[a-z_]+\/sha256:[a-f0-9]{64}$/u;
const fieldIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
const moduleIdSchema = z.enum(PLUGIN_CONFIG_MODULE_IDS);
const schemaVersionSchema = z.literal(PLUGIN_CONFIG_SCHEMA_VERSION);

export type PluginConfigTypedValue =
  | Readonly<{ field_id: string; kind: "integer"; value: number }>
  | Readonly<{ field_id: string; kind: "boolean"; value: boolean }>
  | Readonly<{ field_id: string; kind: "enum"; value: string }>
  | Readonly<{ field_id: string; kind: "secret_slot"; value: string }>;

const integerValueSchema = z
  .object({
    field_id: fieldIdSchema,
    kind: z.literal("integer"),
    value: z.number().int().finite(),
  })
  .strict();

const booleanValueSchema = z
  .object({
    field_id: fieldIdSchema,
    kind: z.literal("boolean"),
    value: z.boolean(),
  })
  .strict();

const enumValueSchema = z
  .object({
    field_id: fieldIdSchema,
    kind: z.literal("enum"),
    value: z.string().min(1).max(128),
  })
  .strict();

const secretSlotValueSchema = z
  .object({
    field_id: fieldIdSchema,
    kind: z.literal("secret_slot"),
    value: z.string().regex(identifierPattern),
  })
  .strict();

export const pluginConfigTypedValueSchema: z.ZodType<PluginConfigTypedValue> =
  z.discriminatedUnion("kind", [
    integerValueSchema,
    booleanValueSchema,
    enumValueSchema,
    secretSlotValueSchema,
  ]);

const optionSchema = z
  .object({
    value: z.string().regex(identifierPattern),
    label: z.string().min(1).max(128),
  })
  .strict();

const baseFieldSchema = z
  .object({
    field_id: fieldIdSchema,
    label: z.string().min(1).max(128),
    description: z.string().min(1).max(512),
    restart_policy: z.literal("restart_required"),
  })
  .strict();

const integerFieldSchema = baseFieldSchema
  .extend({
    kind: z.literal("integer"),
    unit: z.enum(["ms", "attempts"]),
    minimum: z.number().int().finite(),
    maximum: z.number().int().finite(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.minimum > field.maximum) {
      ctx.addIssue({ code: "custom", message: "minimum must not exceed maximum" });
    }
  });

const enumFieldSchema = baseFieldSchema
  .extend({
    kind: z.literal("enum"),
    allowed_options: z.array(optionSchema).min(1).max(32),
  })
  .strict();

const secretSlotFieldSchema = baseFieldSchema
  .extend({
    kind: z.literal("secret_slot"),
    allowed_slots: z.array(optionSchema).min(1).max(32),
  })
  .strict();

const booleanFieldSchema = baseFieldSchema
  .extend({
    kind: z.literal("boolean"),
  })
  .strict();

export const pluginConfigFieldSchema = z.discriminatedUnion("kind", [
  integerFieldSchema,
  booleanFieldSchema,
  enumFieldSchema,
  secretSlotFieldSchema,
]);

export type PluginConfigField = DeepReadonly<z.infer<typeof pluginConfigFieldSchema>>;

export const pluginConfigSpecSchema = z
  .object({
    schema_version: schemaVersionSchema,
    module_id: z.literal("freightcom-ltl"),
    scope: z.literal("deployment"),
    production_eligible: z.literal(false),
    manual_review: z.literal(true),
    fields: z.array(pluginConfigFieldSchema).length(5),
  })
  .strict();

export type PluginConfigSpec = DeepReadonly<z.infer<typeof pluginConfigSpecSchema>>;

export const pluginConfigRegistryEntrySchema = z
  .object({
    schema_version: schemaVersionSchema,
    module_id: moduleIdSchema,
    config_spec: pluginConfigSpecSchema.nullable(),
  })
  .strict();

export const pluginConfigRegistrySchema = z
  .array(pluginConfigRegistryEntrySchema)
  .length(4);

export type PluginConfigRegistryEntry = DeepReadonly<z.infer<typeof pluginConfigRegistryEntrySchema>>;

const valuesSchema = z.array(pluginConfigTypedValueSchema).min(1).max(32);
const baseClientRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    module_id: moduleIdSchema,
  })
  .strict();

export const pluginConfigValidateDraftRequestSchema = baseClientRequestSchema
  .extend({
    base_revision: z.number().int().nonnegative(),
    values: valuesSchema,
  })
  .strict();

export type PluginConfigValidateDraftRequest = DeepReadonly<z.infer<
  typeof pluginConfigValidateDraftRequestSchema
>>;

const changePreviewRequestSchema = baseClientRequestSchema
  .extend({
    intent: z.literal("change"),
    base_revision: z.number().int().nonnegative(),
    values: valuesSchema,
  })
  .strict();

const rollbackPreviewRequestSchema = baseClientRequestSchema
  .extend({
    intent: z.literal("rollback"),
    target_release_id: z.string().regex(identifierPattern),
  })
  .strict();

export const pluginConfigCreatePreviewRequestSchema = z.discriminatedUnion("intent", [
  changePreviewRequestSchema,
  rollbackPreviewRequestSchema,
]);

export type PluginConfigCreatePreviewRequest = DeepReadonly<z.infer<
  typeof pluginConfigCreatePreviewRequestSchema
>>;

export const pluginConfigApprovalRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    module_id: moduleIdSchema,
    preview_ref: z.string().regex(identifierPattern),
    decision: z.enum(["approve", "reject"]),
    reason_code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  })
  .strict();
export type PluginConfigApprovalRequest = DeepReadonly<z.infer<typeof pluginConfigApprovalRequestSchema>>;

export const pluginConfigPublishRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    module_id: moduleIdSchema,
    preview_ref: z.string().regex(identifierPattern),
    approval_id: z.string().regex(identifierPattern),
  })
  .strict();
export type PluginConfigPublishRequest = DeepReadonly<z.infer<typeof pluginConfigPublishRequestSchema>>;

export const pluginConfigReconcileRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    module_id: moduleIdSchema,
    release_id: z.string().regex(identifierPattern),
  })
  .strict();
export type PluginConfigReconcileRequest = DeepReadonly<z.infer<typeof pluginConfigReconcileRequestSchema>>;

export const pluginConfigGetStateRequestSchema = baseClientRequestSchema;
export type PluginConfigGetStateRequest = DeepReadonly<z.infer<typeof pluginConfigGetStateRequestSchema>>;

export const pluginConfigRequestSchema = z.union([
  pluginConfigValidateDraftRequestSchema,
  pluginConfigCreatePreviewRequestSchema,
  pluginConfigApprovalRequestSchema,
  pluginConfigPublishRequestSchema,
  pluginConfigReconcileRequestSchema,
]);

export const pluginConfigWriteMetaSchema = z
  .object({
    idempotency_key: z.string().regex(identifierPattern).min(16),
    request_id: z.string().regex(identifierPattern),
    trace_id: z.string().regex(identifierPattern),
    audit_id: z.string().regex(identifierPattern),
  })
  .strict();

export type PluginConfigWriteMeta = DeepReadonly<z.infer<typeof pluginConfigWriteMetaSchema>>;

export const freightcomLtlConfigSpec: PluginConfigSpec = Object.freeze({
  schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
  module_id: "freightcom-ltl",
  scope: "deployment",
  production_eligible: false,
  manual_review: true,
  fields: Object.freeze([
    Object.freeze({
      field_id: "request_timeout_ms",
      kind: "integer",
      label: "Request timeout",
      description: "Freightcom test request timeout in milliseconds.",
      unit: "ms",
      minimum: 1000,
      maximum: 30000,
      restart_policy: "restart_required",
    }),
    Object.freeze({
      field_id: "poll_interval_ms",
      kind: "integer",
      label: "Poll interval",
      description: "Freightcom test polling interval in milliseconds.",
      unit: "ms",
      minimum: 100,
      maximum: 5000,
      restart_policy: "restart_required",
    }),
    Object.freeze({
      field_id: "max_poll_attempts",
      kind: "integer",
      label: "Maximum poll attempts",
      description: "Freightcom test maximum polling attempts.",
      unit: "attempts",
      minimum: 1,
      maximum: 30,
      restart_policy: "restart_required",
    }),
    Object.freeze({
      field_id: "egress_profile_id",
      kind: "enum",
      label: "Egress profile",
      description: "The approved Freightcom test egress profile.",
      allowed_options: Object.freeze([
        Object.freeze({ value: "freightcom_test_fixed", label: "Freightcom test fixed" }),
      ]),
      restart_policy: "restart_required",
    }),
    Object.freeze({
      field_id: "credential_slot_id",
      kind: "secret_slot",
      label: "Credential slot",
      description: "The approved opaque Freightcom test credential slot.",
      allowed_slots: Object.freeze([
        Object.freeze({ value: "freightcom_test_credential", label: "Freightcom test credential" }),
      ]),
      restart_policy: "restart_required",
    }),
  ]),
});

export const FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES: readonly PluginConfigTypedValue[] =
  Object.freeze([
    Object.freeze({ field_id: "request_timeout_ms", kind: "integer", value: 20_000 }),
    Object.freeze({ field_id: "poll_interval_ms", kind: "integer", value: 750 }),
    Object.freeze({ field_id: "max_poll_attempts", kind: "integer", value: 12 }),
    Object.freeze({
      field_id: "egress_profile_id",
      kind: "enum",
      value: "freightcom_test_fixed",
    }),
    Object.freeze({
      field_id: "credential_slot_id",
      kind: "secret_slot",
      value: "freightcom_test_credential",
    }),
  ] as const);

export const PLUGIN_CONFIG_REGISTRY: readonly PluginConfigRegistryEntry[] = Object.freeze([
  Object.freeze({
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: "cargo",
    config_spec: null,
  }),
  Object.freeze({
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: "container",
    config_spec: null,
  }),
  Object.freeze({
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: "agent-access",
    config_spec: null,
  }),
  Object.freeze({
    schema_version: PLUGIN_CONFIG_SCHEMA_VERSION,
    module_id: "freightcom-ltl",
    config_spec: freightcomLtlConfigSpec,
  }),
]);

export class PluginConfigContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginConfigContractError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function assertPlainContainer(value: object, path: string): void {
  if (nodeTypes.isProxy(value)) {
    throw new PluginConfigContractError("proxy_input", `${path} is a proxy`);
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
    throw new PluginConfigContractError("custom_prototype", `${path} has a custom prototype`);
  }
}

function snapshotValue(value: unknown, path: string, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new PluginConfigContractError("non_finite", `${path} is not finite`);
    }
    if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
      throw new PluginConfigContractError("unsupported_value", `${path} has an unsupported value`);
    }
    return value;
  }

  assertPlainContainer(value, path);
  if (seen.has(value)) {
    throw new PluginConfigContractError("cycle", `${path} is cyclic`);
  }
  seen.add(value);

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (Array.isArray(value)) {
    if (descriptors.length === undefined || descriptors.length.get !== undefined || descriptors.length.set !== undefined) {
      throw new PluginConfigContractError("accessor", `${path}.length is an accessor`);
    }
    for (const key of keys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^0$|^[1-9][0-9]*$/u.test(key)) {
        throw new PluginConfigContractError("unknown_key", `${path} has an unknown array key`);
      }
    }
    const arrayOutput: unknown[] = [];
    const length: unknown = descriptors.length.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 1024) {
      throw new PluginConfigContractError("array_length", `${path} has an invalid length`);
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new PluginConfigContractError("accessor", `${path}[${index}] is missing or accessor-backed`);
      }
      arrayOutput.push(snapshotValue(descriptor.value, `${path}[${index}]`, seen));
    }
    seen.delete(value);
    return Object.freeze(arrayOutput);
  }

  const objectOutput: { [key: string]: unknown } = {};
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new PluginConfigContractError("symbol_key", `${path} has a symbol key`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new PluginConfigContractError("accessor", `${path}.${key} is an accessor`);
    }
    if (descriptor.enumerable !== true) {
      throw new PluginConfigContractError("non_enumerable", `${path}.${key} is not enumerable`);
    }
    objectOutput[key] = snapshotValue(descriptor.value, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return Object.freeze(objectOutput);
}

/**
 * Copy only plain, data-property input before validation. It is deliberately
 * defensive: proxy detection occurs before reflection and accessors are never
 * invoked.
 */
export function snapshotPluginConfigInput(value: unknown): unknown {
  return snapshotValue(value, "$", new WeakSet<object>());
}

function fieldForSpec(
  spec: PluginConfigSpec,
  fieldId: string,
): PluginConfigField | null {
  for (const field of spec.fields) {
    if (field.field_id === fieldId) return field;
  }
  return null;
}

function optionAllowed(options: readonly { readonly value: string }[], value: string): boolean {
  return options.some((option) => option.value === value);
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * Semantic validation is intentionally separate from the outer Zod/schema
 * validation. The outer contract admits field IDs structurally; this function
 * binds every value to the closed ConfigSpec and rejects unknown/missing/
 * duplicate/kind/range/option violations.
 */
export function validatePluginConfigValues(
  values: readonly PluginConfigTypedValue[],
  spec: PluginConfigSpec = freightcomLtlConfigSpec,
): readonly PluginConfigTypedValue[] {
  if (!isRuntimeArray(values)) {
    throw new PluginConfigContractError("values_not_array", "values must be an array");
  }
  const seen = new Set<string>();
  const validated: PluginConfigTypedValue[] = [];
  for (const value of values) {
    const field = fieldForSpec(spec, value.field_id);
    if (field === null) {
      throw new PluginConfigContractError("unknown_field", `unknown field ${value.field_id}`);
    }
    if (seen.has(value.field_id)) {
      throw new PluginConfigContractError("duplicate_field", `duplicate field ${value.field_id}`);
    }
    seen.add(value.field_id);
    if (field.kind !== value.kind) {
      throw new PluginConfigContractError("wrong_kind", `wrong kind for ${value.field_id}`);
    }
    if (value.kind === "integer") {
      if (field.kind !== "integer") {
        throw new PluginConfigContractError("wrong_kind", `wrong kind for ${value.field_id}`);
      }
      if (value.value < field.minimum || value.value > field.maximum) {
        throw new PluginConfigContractError("range", `value out of range for ${value.field_id}`);
      }
    } else if (value.kind === "enum") {
      if (field.kind !== "enum") {
        throw new PluginConfigContractError("wrong_kind", `wrong kind for ${value.field_id}`);
      }
      if (!optionAllowed(field.allowed_options, value.value)) {
        throw new PluginConfigContractError("option", `option is not allowed for ${value.field_id}`);
      }
    } else if (value.kind === "secret_slot") {
      if (field.kind !== "secret_slot") {
        throw new PluginConfigContractError("wrong_kind", `wrong kind for ${value.field_id}`);
      }
      if (!optionAllowed(field.allowed_slots, value.value)) {
        throw new PluginConfigContractError("secret_slot", `secret slot is not allowed for ${value.field_id}`);
      }
    }
    validated.push(Object.freeze({ ...value }));
  }
  if (seen.size !== spec.fields.length) {
    throw new PluginConfigContractError("missing_field", "one or more ConfigSpec fields are missing");
  }
  return Object.freeze(validated);
}

function compareFieldIds(left: PluginConfigTypedValue, right: PluginConfigTypedValue): number {
  return left.field_id < right.field_id ? -1 : left.field_id > right.field_id ? 1 : 0;
}

function canonicalTypedValues(values: readonly PluginConfigTypedValue[]): string {
  return [...values]
    .sort(compareFieldIds)
    .map((value) => {
      const encodedValue = typeof value.value === "number"
        ? `integer:${value.value.toString(10)}`
        : `string:${value.value}`;
      return `${value.field_id.length}:${value.field_id}|${value.kind}|${encodedValue}`;
    })
    .join(";");
}

export function configDigestForValues(values: readonly PluginConfigTypedValue[]): string {
  const canonical = `${PLUGIN_CONFIG_DIGEST_DOMAIN}\0${PLUGIN_CONFIG_SCHEMA_VERSION}\0deployment\0${canonicalTypedValues(values)}`;
  return `mcp-plugin-config-hash/v1/config/sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function pluginConfigRequestHash(
  action: string,
  actorId: string,
  request: unknown,
): string {
  const snapshot = snapshotPluginConfigInput(request);
  const parsed = pluginConfigRequestSchema.parse(snapshot);
  const canonical = `${PLUGIN_CONFIG_REQUEST_HASH_DOMAIN}\0${PLUGIN_CONFIG_SCHEMA_VERSION}\0${action}\0${actorId}\0${JSON.stringify(parsed)}`;
  return `mcp-plugin-config-hash/v1/request/sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function isPluginConfigHash(value: string): boolean {
  return hashPattern.test(value);
}

export type PluginConfigReadbackSummary = Readonly<{
  readback_id: string;
  release_id: string;
  revision: number;
  config_digest: string;
  module_generation: string | null;
  status: "verified" | "mismatch" | "unknown";
  checked_at: string;
}>;

export type PluginConfigValidationSummary = Readonly<{
  validation_id: string;
  base_revision: number;
  config_digest: string;
  validation_status: PluginConfigValidationStatus;
  created_at: string;
}>;

export type PluginConfigPreviewSummary = Readonly<{
  preview_ref: string;
  intent: PluginConfigIntent;
  base_revision: number;
  config_digest: string;
  changed_field_ids: readonly string[];
  expires_at: string;
  creator_actor_id: string;
  consumed: boolean;
}>;

export type PluginConfigApprovalSummary = Readonly<{
  approval_id: string;
  preview_ref: string;
  decision: PluginConfigApprovalDecision;
  approver_actor_id: string;
  decided_at: string;
  reason_code: string;
}>;

export type PluginConfigReleaseSummary = Readonly<{
  release_id: string;
  revision: number;
  intent: PluginConfigIntent;
  config_digest: string;
  state: PluginConfigReleaseState;
  published_at: string;
}>;

export type PluginConfigEventSummary = Readonly<{
  sequence: number;
  event_id: string;
  action: string;
  object_ref: string;
  status: string;
  occurred_at: string;
}>;

export type PluginConfigConfiguredState = Readonly<{
  schema_version: typeof PLUGIN_CONFIG_SCHEMA_VERSION;
  module_id: "freightcom-ltl";
  status: PluginConfigOutcomeStatus;
  config_spec: PluginConfigSpec;
  current_revision: number;
  current_config_digest: string | null;
  current_module_generation: string | null;
  current_values: readonly PluginConfigTypedValue[];
  current_readback: PluginConfigReadbackSummary | null;
  latest_validation: PluginConfigValidationSummary | null;
  latest_preview: PluginConfigPreviewSummary | null;
  latest_approval: PluginConfigApprovalSummary | null;
  latest_release: PluginConfigReleaseSummary | null;
  allowed_actions: readonly string[];
  reason_codes: readonly string[];
  events: readonly PluginConfigEventSummary[];
  events_truncated: boolean;
}>;

export type PluginConfigUnsupportedState = Readonly<{
  schema_version: typeof PLUGIN_CONFIG_SCHEMA_VERSION;
  module_id: Exclude<PluginConfigModuleId, "freightcom-ltl">;
  status: "success";
  config_spec: null;
  current_revision: 0;
  current_config_digest: null;
  current_module_generation: null;
  current_values: readonly PluginConfigTypedValue[];
  current_readback: null;
  latest_validation: null;
  latest_preview: null;
  latest_approval: null;
  latest_release: null;
  allowed_actions: readonly string[];
  reason_codes: readonly string[];
  events: readonly PluginConfigEventSummary[];
  events_truncated: false;
}>;

export type PluginConfigState = PluginConfigConfiguredState | PluginConfigUnsupportedState;

export const pluginConfigReadbackSummarySchema = z
  .object({
    readback_id: z.string().regex(identifierPattern),
    release_id: z.string().regex(identifierPattern),
    revision: z.number().int().positive(),
    config_digest: z.string().regex(hashPattern),
    module_generation: z.string().regex(identifierPattern).nullable(),
    status: z.enum(["verified", "mismatch", "unknown"]),
    checked_at: z.string().datetime({ offset: true }),
  })
  .strict();

const validationSummarySchema = z
  .object({
    validation_id: z.string().regex(identifierPattern),
    base_revision: z.number().int().nonnegative(),
    config_digest: z.string().regex(hashPattern),
    validation_status: z.enum(["validated", "blocked"]),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

const previewSummarySchema = z
  .object({
    preview_ref: z.string().regex(identifierPattern),
    intent: z.enum(["change", "rollback"]),
    base_revision: z.number().int().nonnegative(),
    config_digest: z.string().regex(hashPattern),
    changed_field_ids: z.array(fieldIdSchema).max(5),
    expires_at: z.string().datetime({ offset: true }),
    creator_actor_id: z.string().regex(identifierPattern),
    consumed: z.boolean(),
  })
  .strict();

const approvalSummarySchema = z
  .object({
    approval_id: z.string().regex(identifierPattern),
    preview_ref: z.string().regex(identifierPattern),
    decision: z.enum(["approve", "reject"]),
    approver_actor_id: z.string().regex(identifierPattern),
    decided_at: z.string().datetime({ offset: true }),
    reason_code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  })
  .strict();

const releaseSummarySchema = z
  .object({
    release_id: z.string().regex(identifierPattern),
    revision: z.number().int().positive(),
    intent: z.enum(["change", "rollback"]),
    config_digest: z.string().regex(hashPattern),
    state: z.enum([
      "published_pending_apply",
      "applying",
      "restarting",
      "readback_verified",
      "manual_review",
      "blocked",
      "unavailable",
      "superseded",
    ]),
    published_at: z.string().datetime({ offset: true }),
  })
  .strict();

const eventSummarySchema = z
  .object({
    sequence: z.number().int().positive(),
    event_id: z.string().regex(identifierPattern),
    action: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    object_ref: z.string().regex(identifierPattern),
    status: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    occurred_at: z.string().datetime({ offset: true }),
  })
  .strict();

const configuredStateSchema = z
  .object({
    schema_version: schemaVersionSchema,
    module_id: z.literal("freightcom-ltl"),
    status: z.enum(["success", "manual_review", "blocked", "unavailable"]),
    config_spec: pluginConfigSpecSchema,
    current_revision: z.number().int().nonnegative(),
    current_config_digest: z.string().regex(hashPattern).nullable(),
    current_module_generation: z.string().regex(identifierPattern).nullable(),
    current_values: z.array(pluginConfigTypedValueSchema).length(5),
    current_readback: pluginConfigReadbackSummarySchema.nullable(),
    latest_validation: validationSummarySchema.nullable(),
    latest_preview: previewSummarySchema.nullable(),
    latest_approval: approvalSummarySchema.nullable(),
    latest_release: releaseSummarySchema.nullable(),
    allowed_actions: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).max(16),
    reason_codes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).max(16),
    events: z.array(eventSummarySchema).max(50),
    events_truncated: z.boolean(),
  })
  .strict();

const unsupportedStateSchema = z
  .object({
    schema_version: schemaVersionSchema,
    module_id: z.enum(["cargo", "container", "agent-access"]),
    status: z.literal("success"),
    config_spec: z.null(),
    current_revision: z.literal(0),
    current_config_digest: z.null(),
    current_module_generation: z.null(),
    current_values: z.array(z.never()),
    current_readback: z.null(),
    latest_validation: z.null(),
    latest_preview: z.null(),
    latest_approval: z.null(),
    latest_release: z.null(),
    allowed_actions: z.array(z.never()),
    reason_codes: z.tuple([z.literal("plugin_config_not_supported")]),
    events: z.array(z.never()),
    events_truncated: z.literal(false),
  })
  .strict();

export const pluginConfigStateSchema = z.union([configuredStateSchema, unsupportedStateSchema]);

type PluginConfigOperationData =
  | Readonly<{
      kind: "validation";
      validation_id: string;
      module_id: "freightcom-ltl";
      base_revision: number;
      config_digest: string;
      values: readonly PluginConfigTypedValue[];
      restart_policy: "controlled_restart";
      validation_status: PluginConfigValidationStatus;
    }>
  | Readonly<{
      kind: "preview";
      preview_ref: string;
      module_id: "freightcom-ltl";
      intent: PluginConfigIntent;
      base_revision: number;
      config_digest: string;
      changed_field_ids: readonly string[];
      expires_at: string;
      restart_policy: "controlled_restart";
    }>
  | Readonly<{
      kind: "approval";
      approval_id: string;
      preview_ref: string;
      decision: PluginConfigApprovalDecision;
      approver_actor_id: string;
      decided_at: string;
    }>
  | Readonly<{
      kind: "release";
      release_id: string;
      revision: number;
      config_digest: string;
      release_state: PluginConfigReleaseState;
      readback: PluginConfigReadbackSummary | null;
    }>
  | Readonly<{
      kind: "reconciliation";
      release_id: string;
      revision: number;
      status: PluginConfigApplyObservationStatus;
      readback: PluginConfigReadbackSummary | null;
    }>;

export type PluginConfigOperationResponse = Readonly<{
  schema_version: typeof PLUGIN_CONFIG_SCHEMA_VERSION;
  action: string;
  request_id: string;
  status: PluginConfigOutcomeStatus;
  data: PluginConfigOperationData | null;
  reason_codes: readonly string[];
  replayed: boolean;
}>;

const validationDataSchema = z
  .object({
    kind: z.literal("validation"),
    validation_id: z.string().regex(identifierPattern),
    module_id: z.literal("freightcom-ltl"),
    base_revision: z.number().int().nonnegative(),
    config_digest: z.string().regex(hashPattern),
    values: z.array(pluginConfigTypedValueSchema).length(5),
    restart_policy: z.literal("controlled_restart"),
    validation_status: z.enum(["validated", "blocked"]),
  })
  .strict();
const previewDataSchema = z
  .object({
    kind: z.literal("preview"),
    preview_ref: z.string().regex(identifierPattern),
    module_id: z.literal("freightcom-ltl"),
    intent: z.enum(["change", "rollback"]),
    base_revision: z.number().int().nonnegative(),
    config_digest: z.string().regex(hashPattern),
    changed_field_ids: z.array(fieldIdSchema).max(5),
    expires_at: z.string().datetime({ offset: true }),
    restart_policy: z.literal("controlled_restart"),
  })
  .strict();
const approvalDataSchema = z
  .object({
    kind: z.literal("approval"),
    approval_id: z.string().regex(identifierPattern),
    preview_ref: z.string().regex(identifierPattern),
    decision: z.enum(["approve", "reject"]),
    approver_actor_id: z.string().regex(identifierPattern),
    decided_at: z.string().datetime({ offset: true }),
  })
  .strict();
const releaseDataSchema = z
  .object({
    kind: z.literal("release"),
    release_id: z.string().regex(identifierPattern),
    revision: z.number().int().positive(),
    config_digest: z.string().regex(hashPattern),
    release_state: z.enum([
      "published_pending_apply",
      "applying",
      "restarting",
      "readback_verified",
      "manual_review",
      "blocked",
      "unavailable",
      "superseded",
    ]),
    readback: pluginConfigReadbackSummarySchema.nullable(),
  })
  .strict();
const reconciliationDataSchema = z
  .object({
    kind: z.literal("reconciliation"),
    release_id: z.string().regex(identifierPattern),
    revision: z.number().int().positive(),
    status: z.enum(["readback_verified", "mismatch", "unknown", "blocked", "unavailable"]),
    readback: pluginConfigReadbackSummarySchema.nullable(),
  })
  .strict();

export const pluginConfigOperationResponseSchema = z
  .object({
    schema_version: schemaVersionSchema,
    action: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    request_id: z.string().regex(identifierPattern),
    status: z.enum(["success", "manual_review", "blocked", "unavailable"]),
    data: z.union([
      validationDataSchema,
      previewDataSchema,
      approvalDataSchema,
      releaseDataSchema,
      reconciliationDataSchema,
    ]).nullable(),
    reason_codes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).max(16),
    replayed: z.boolean(),
  })
  .strict();

export function freezePluginConfigOutput<T>(value: T): T {
  const visited = new WeakSet<object>();
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object" || visited.has(candidate)) return;
    visited.add(candidate);
    for (const child of Object.values(candidate)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(value);
  return value;
}
