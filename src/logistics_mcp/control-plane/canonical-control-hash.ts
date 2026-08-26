import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  DESCRIPTOR_DIGEST_PATTERN,
  hasExactOwnKeys,
  IDENTIFIER_PATTERN,
  isPlainRecord,
  VERSION_PATTERN,
} from "./lexical-contracts";

export type ControlHashDomain = "request" | "preview";
export type CanonicalControlHash =
  `mcp-control-hash/v1/${ControlHashDomain}/sha256:${string}`;

export interface ControlHashModuleRef {
  readonly module_id: string;
  readonly version: string;
  readonly descriptor_digest: `sha256:${string}`;
}

interface RequestHashPayloadBase {
  readonly management_tenant_id: string;
  readonly actor_ref: string;
}

export interface RegisterRequestHashPayload extends RequestHashPayloadBase {
  readonly action: "packages.register";
  readonly request: Readonly<{
    schema_version: string;
    module_id: string;
    version: string;
    descriptor_digest: `sha256:${string}`;
  }>;
}

export interface PreviewRequestHashPayload extends RequestHashPayloadBase {
  readonly action: "deployments.preview";
  readonly request:
    | Readonly<{
        schema_version: string;
        intent: "change";
        desired_modules: readonly ControlHashModuleRef[];
      }>
    | Readonly<{
        schema_version: string;
        intent: "rollback";
        target_release_id: string;
      }>;
}

export interface ApprovalRequestHashPayload extends RequestHashPayloadBase {
  readonly action: "approvals.decide";
  readonly request: Readonly<{
    schema_version: string;
    preview_ref: string;
    decision: "approve" | "reject";
    reason_code: string;
  }>;
}

export interface PublishRequestHashPayload extends RequestHashPayloadBase {
  readonly action: "deployments.publish";
  readonly request: Readonly<{
    schema_version: string;
    preview_ref: string;
    approval_id: string;
  }>;
}

export interface ReconcileRequestHashPayload extends RequestHashPayloadBase {
  readonly action: "deployments.reconcile";
  readonly request: Readonly<{
    schema_version: string;
    release_id: string;
  }>;
}

interface PreviewHashPayloadBase {
  readonly action: "deployments.preview";
  readonly management_tenant_id: string;
  readonly creator_actor_ref: string;
  readonly base_release_revision: number;
  readonly inventory_refs: readonly ControlHashModuleRef[];
  readonly desired_modules: readonly ControlHashModuleRef[];
  readonly policy_version: "writable-module-control-plane-v1";
  readonly schema_version: string;
  readonly validation: Readonly<{
    base_matches: boolean;
    desired_modules_valid: boolean;
    inventory_matches: boolean;
    minimum_active_modules: boolean;
    reason_codes: readonly string[];
  }>;
  readonly preview_ttl_seconds: number;
}

export interface PreviewChangeHashPayload extends PreviewHashPayloadBase {
  readonly intent: "change";
}

export interface PreviewRollbackHashPayload extends PreviewHashPayloadBase {
  readonly intent: "rollback";
  readonly target_release_id: string;
}

export type ControlHashPayload =
  | RegisterRequestHashPayload
  | PreviewRequestHashPayload
  | ApprovalRequestHashPayload
  | PublishRequestHashPayload
  | ReconcileRequestHashPayload
  | PreviewChangeHashPayload
  | PreviewRollbackHashPayload;

export interface CanonicalControlHashInput {
  readonly domain: ControlHashDomain;
  readonly schemaVersion: string;
  readonly payload: ControlHashPayload;
}

export interface CanonicalControlHashResult {
  readonly hash: CanonicalControlHash;
  readonly canonicalJson: string;
  readonly frameHex: string;
}

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

type NormalizedModuleRef = Readonly<{
  module_id: string;
  version: string;
  descriptor_digest: `sha256:${string}`;
}>;

type HashErrorCode =
  | "input_fields_invalid"
  | "domain_invalid"
  | "schema_version_invalid"
  | "schema_version_mismatch"
  | "payload_fields_invalid"
  | "action_invalid"
  | "identifier_invalid"
  | "version_invalid"
  | "descriptor_digest_invalid"
  | "text_invalid"
  | "integer_invalid"
  | "boolean_invalid"
  | "array_invalid"
  | "set_duplicate";

export class CanonicalControlHashError extends Error {
  constructor(readonly code: HashErrorCode) {
    super("The canonical control hash input is invalid.");
    this.name = "CanonicalControlHashError";
  }
}

const INPUT_KEYS = ["domain", "schemaVersion", "payload"] as const;
const REQUEST_PAYLOAD_KEYS = [
  "action",
  "management_tenant_id",
  "actor_ref",
  "request",
] as const;
const MODULE_REF_KEYS = ["module_id", "version", "descriptor_digest"] as const;
const VALIDATION_KEYS = [
  "base_matches",
  "desired_modules_valid",
  "inventory_matches",
  "minimum_active_modules",
  "reason_codes",
] as const;
const PREVIEW_CHANGE_KEYS = [
  "action",
  "base_release_revision",
  "creator_actor_ref",
  "desired_modules",
  "intent",
  "inventory_refs",
  "management_tenant_id",
  "policy_version",
  "preview_ttl_seconds",
  "schema_version",
  "validation",
] as const;
const PREVIEW_ROLLBACK_KEYS = [
  ...PREVIEW_CHANGE_KEYS,
  "target_release_id",
] as const;
const SCHEMA_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}\.v[1-9]\d*$/;

function fail(code: HashErrorCode): never {
  throw new CanonicalControlHashError(code);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: HashErrorCode,
): Record<string, unknown> {
  try {
    if (nodeUtilTypes.isProxy(value)) fail(code);
    if (!isPlainRecord(value)) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (nodeUtilTypes.isProxy(descriptors) || !hasExactOwnKeys(descriptors, keys)) {
      fail(code);
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        fail(code);
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof CanonicalControlHashError) throw error;
    fail(code);
  }
}

function ownEnumerableDataValue(
  value: unknown,
  key: string,
  code: HashErrorCode,
): unknown {
  try {
    if (nodeUtilTypes.isProxy(value)) fail(code);
    if (!isPlainRecord(value)) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail(code);
    }
    return descriptor.value;
  } catch (error: unknown) {
    if (error instanceof CanonicalControlHashError) throw error;
    fail(code);
  }
}

function exactArray(value: unknown): readonly unknown[] {
  try {
    if (nodeUtilTypes.isProxy(value)) fail("array_invalid");
    if (!Array.isArray(value)) fail("array_invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const lengthDescriptor = descriptors["length"];
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      nodeUtilTypes.isProxy(descriptors) ||
      Reflect.ownKeys(descriptors).length !== lengthDescriptor.value + 1
    ) {
      fail("array_invalid");
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        fail("array_invalid");
      }
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof CanonicalControlHashError) throw error;
    fail("array_invalid");
  }
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !hasWellFormedUnicode(value)) {
    fail("text_invalid");
  }
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string") fail("identifier_invalid");
  if (!hasWellFormedUnicode(value)) fail("text_invalid");
  if (!IDENTIFIER_PATTERN.test(value)) fail("identifier_invalid");
  return value;
}

function version(value: unknown): string {
  if (typeof value !== "string") fail("version_invalid");
  if (!hasWellFormedUnicode(value)) fail("text_invalid");
  if (!VERSION_PATTERN.test(value)) fail("version_invalid");
  return value;
}

function digest(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !DESCRIPTOR_DIGEST_PATTERN.test(value)) {
    fail("descriptor_digest_invalid");
  }
  return value as `sha256:${string}`;
}

function schemaVersion(value: unknown): string {
  const result = text(value);
  if (!SCHEMA_VERSION_PATTERN.test(result)) fail("schema_version_invalid");
  return result;
}

function safeInteger(value: unknown, positive = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < (positive ? 1 : 0)
  ) {
    fail("integer_invalid");
  }
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") fail("boolean_invalid");
  return value;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function moduleTuple(ref: ControlHashModuleRef): string {
  return `${ref.module_id}\u0000${ref.version}\u0000${ref.descriptor_digest}`;
}

function normalizeModuleRefs(value: unknown): readonly NormalizedModuleRef[] {
  const candidates = exactArray(value);
  if (candidates.length === 0) fail("array_invalid");
  const refs = candidates.map((candidate) => {
    const record = exactRecord(candidate, MODULE_REF_KEYS, "payload_fields_invalid");
    return Object.freeze({
      module_id: identifier(record.module_id),
      version: version(record.version),
      descriptor_digest: digest(record.descriptor_digest),
    });
  });
  const tuples = refs.map(moduleTuple);
  if (new Set(tuples).size !== tuples.length) fail("set_duplicate");
  return Object.freeze(
    [...refs].sort((left, right) =>
      compareUtf8(moduleTuple(left), moduleTuple(right)),
    ),
  );
}

function normalizeStringSet(value: unknown): readonly string[] {
  const values = exactArray(value).map(identifier);
  if (new Set(values).size !== values.length) fail("set_duplicate");
  return Object.freeze([...values].sort(compareUtf8));
}

function normalizeValidation(value: unknown): CanonicalValue {
  const record = exactRecord(value, VALIDATION_KEYS, "payload_fields_invalid");
  return Object.freeze({
    base_matches: booleanValue(record.base_matches),
    desired_modules_valid: booleanValue(record.desired_modules_valid),
    inventory_matches: booleanValue(record.inventory_matches),
    minimum_active_modules: booleanValue(record.minimum_active_modules),
    reason_codes: normalizeStringSet(record.reason_codes),
  });
}

function normalizeStrictRequest(
  action: string,
  value: unknown,
): { readonly value: CanonicalValue; readonly schemaVersion: string } {
  if (action === "packages.register") {
    const record = exactRecord(
      value,
      ["schema_version", "module_id", "version", "descriptor_digest"],
      "payload_fields_invalid",
    );
    const normalizedSchemaVersion = schemaVersion(record.schema_version);
    return {
      schemaVersion: normalizedSchemaVersion,
      value: Object.freeze({
        schema_version: normalizedSchemaVersion,
        module_id: identifier(record.module_id),
        version: version(record.version),
        descriptor_digest: digest(record.descriptor_digest),
      }),
    };
  }
  if (action === "deployments.preview") {
    const intent = ownEnumerableDataValue(
      value,
      "intent",
      "payload_fields_invalid",
    );
    if (intent === "change") {
      const record = exactRecord(
        value,
        ["schema_version", "intent", "desired_modules"],
        "payload_fields_invalid",
      );
      const normalizedSchemaVersion = schemaVersion(record.schema_version);
      return {
        schemaVersion: normalizedSchemaVersion,
        value: Object.freeze({
          schema_version: normalizedSchemaVersion,
          intent: "change",
          desired_modules: normalizeModuleRefs(record.desired_modules),
        }),
      };
    }
    if (intent === "rollback") {
      const record = exactRecord(
        value,
        ["schema_version", "intent", "target_release_id"],
        "payload_fields_invalid",
      );
      const normalizedSchemaVersion = schemaVersion(record.schema_version);
      return {
        schemaVersion: normalizedSchemaVersion,
        value: Object.freeze({
          schema_version: normalizedSchemaVersion,
          intent: "rollback",
          target_release_id: identifier(record.target_release_id),
        }),
      };
    }
    fail("payload_fields_invalid");
  }
  if (action === "approvals.decide") {
    const record = exactRecord(
      value,
      ["schema_version", "preview_ref", "decision", "reason_code"],
      "payload_fields_invalid",
    );
    if (record.decision !== "approve" && record.decision !== "reject") {
      fail("payload_fields_invalid");
    }
    const normalizedSchemaVersion = schemaVersion(record.schema_version);
    return {
      schemaVersion: normalizedSchemaVersion,
      value: Object.freeze({
        schema_version: normalizedSchemaVersion,
        preview_ref: identifier(record.preview_ref),
        decision: record.decision,
        reason_code: identifier(record.reason_code),
      }),
    };
  }
  if (action === "deployments.publish") {
    const record = exactRecord(
      value,
      ["schema_version", "preview_ref", "approval_id"],
      "payload_fields_invalid",
    );
    const normalizedSchemaVersion = schemaVersion(record.schema_version);
    return {
      schemaVersion: normalizedSchemaVersion,
      value: Object.freeze({
        schema_version: normalizedSchemaVersion,
        preview_ref: identifier(record.preview_ref),
        approval_id: identifier(record.approval_id),
      }),
    };
  }
  if (action === "deployments.reconcile") {
    const record = exactRecord(
      value,
      ["schema_version", "release_id"],
      "payload_fields_invalid",
    );
    const normalizedSchemaVersion = schemaVersion(record.schema_version);
    return {
      schemaVersion: normalizedSchemaVersion,
      value: Object.freeze({
        schema_version: normalizedSchemaVersion,
        release_id: identifier(record.release_id),
      }),
    };
  }
  fail("action_invalid");
}

function normalizeRequestPayload(
  value: Record<string, unknown>,
): { readonly value: CanonicalValue; readonly schemaVersion: string } {
  const record = exactRecord(
    value,
    REQUEST_PAYLOAD_KEYS,
    "payload_fields_invalid",
  );
  if (typeof record.action !== "string") fail("action_invalid");
  const request = normalizeStrictRequest(record.action, record.request);
  return {
    schemaVersion: request.schemaVersion,
    value: Object.freeze({
      action: record.action,
      management_tenant_id: identifier(record.management_tenant_id),
      actor_ref: identifier(record.actor_ref),
      request: request.value,
    }),
  };
}

function normalizePreviewPayload(
  value: Record<string, unknown>,
): { readonly value: CanonicalValue; readonly schemaVersion: string } {
  const intent = ownEnumerableDataValue(
    value,
    "intent",
    "payload_fields_invalid",
  );
  if (intent !== "change" && intent !== "rollback") {
    fail("payload_fields_invalid");
  }
  const keys = intent === "change" ? PREVIEW_CHANGE_KEYS : PREVIEW_ROLLBACK_KEYS;
  const record = exactRecord(value, keys, "payload_fields_invalid");
  if (record.action !== "deployments.preview") fail("action_invalid");
  if (record.policy_version !== "writable-module-control-plane-v1") {
    fail("payload_fields_invalid");
  }
  const normalizedSchemaVersion = schemaVersion(record.schema_version);
  const common = {
    action: "deployments.preview",
    base_release_revision: safeInteger(record.base_release_revision),
    creator_actor_ref: identifier(record.creator_actor_ref),
    desired_modules: normalizeModuleRefs(record.desired_modules),
    intent,
    inventory_refs: normalizeModuleRefs(record.inventory_refs),
    management_tenant_id: identifier(record.management_tenant_id),
    policy_version: "writable-module-control-plane-v1",
    preview_ttl_seconds: safeInteger(record.preview_ttl_seconds, true),
    schema_version: normalizedSchemaVersion,
    validation: normalizeValidation(record.validation),
  } as const;
  return {
    schemaVersion: normalizedSchemaVersion,
    value:
      intent === "change"
        ? Object.freeze(common)
        : Object.freeze({
            ...common,
            target_release_id: identifier(record.target_release_id),
          }),
  };
}

function normalizePayload(
  value: unknown,
): { readonly value: CanonicalValue; readonly schemaVersion: string } {
  try {
    if (nodeUtilTypes.isProxy(value)) fail("payload_fields_invalid");
    if (!isPlainRecord(value)) fail("payload_fields_invalid");
    if (
      hasExactOwnKeys(value, REQUEST_PAYLOAD_KEYS) &&
      Object.hasOwn(value, "actor_ref")
    ) {
      return normalizeRequestPayload(value);
    }
    return normalizePreviewPayload(value);
  } catch (error: unknown) {
    if (error instanceof CanonicalControlHashError) throw error;
    fail("payload_fields_invalid");
  }
}

function jcs(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("integer_invalid");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!hasWellFormedUnicode(value)) fail("text_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  const record = value as { readonly [key: string]: CanonicalValue };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${jcs(record[key]!)}`)
    .join(",")}}`;
}

export function canonicalControlHash(
  input: CanonicalControlHashInput,
): CanonicalControlHashResult {
  const record = exactRecord(input, INPUT_KEYS, "input_fields_invalid");
  if (record.domain !== "request" && record.domain !== "preview") {
    fail("domain_invalid");
  }
  const normalizedSchemaVersion = schemaVersion(record.schemaVersion);
  const normalizedPayload = normalizePayload(record.payload);
  if (normalizedPayload.schemaVersion !== normalizedSchemaVersion) {
    fail("schema_version_mismatch");
  }
  const canonicalJson = jcs(normalizedPayload.value);
  const frame = Buffer.concat([
    Buffer.from("MCP-CONTROL-HASH", "ascii"),
    Buffer.from([0]),
    Buffer.from("v1", "ascii"),
    Buffer.from([0]),
    Buffer.from(record.domain, "ascii"),
    Buffer.from([0]),
    Buffer.from(normalizedSchemaVersion, "ascii"),
    Buffer.from([0]),
    Buffer.from(canonicalJson, "utf8"),
  ]);
  const hash: CanonicalControlHash = `mcp-control-hash/v1/${record.domain}/sha256:${createHash("sha256")
    .update(frame)
    .digest("hex")}`;
  return Object.freeze({
    hash,
    canonicalJson,
    frameHex: frame.toString("hex"),
  });
}
