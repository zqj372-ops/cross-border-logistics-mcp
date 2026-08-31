import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { IDENTIFIER_PATTERN } from "./lexical-contracts";
import {
  configDigestForValues,
  FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES,
  pluginConfigOperationResponseSchema,
  validatePluginConfigValues,
  type PluginConfigApprovalDecision,
  type PluginConfigIntent,
  type PluginConfigOperationResponse,
  type PluginConfigReleaseState,
  type PluginConfigTypedValue,
} from "./plugin-config-contracts";

const DIRECTORY_MODE = 0o700;
const DATABASE_MODE = 0o600;
const MARKER_MODE = 0o400;
const MARKER_FORMAT = "mcp-plugin-config-identity/v1" as const;
const DATABASE_SCHEMA_VERSION = 1 as const;

const TABLES = [
  "config_apply_attempts",
  "config_approvals",
  "config_events",
  "config_idempotency",
  "config_meta",
  "config_previews",
  "config_readbacks",
  "config_releases",
  "config_validations",
  "plugin_current",
] as const;

const SCHEMA_SQL = `
CREATE TABLE config_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  config_store_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  management_tenant_id TEXT NOT NULL
) STRICT;

CREATE TABLE plugin_current (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  module_id TEXT NOT NULL CHECK (module_id = 'freightcom-ltl'),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  config_digest TEXT NOT NULL,
  module_generation TEXT NOT NULL,
  request_timeout_ms INTEGER NOT NULL CHECK (request_timeout_ms BETWEEN 1000 AND 30000),
  poll_interval_ms INTEGER NOT NULL CHECK (poll_interval_ms BETWEEN 100 AND 5000),
  max_poll_attempts INTEGER NOT NULL CHECK (max_poll_attempts BETWEEN 1 AND 30),
  egress_profile_id TEXT NOT NULL CHECK (egress_profile_id = 'freightcom_test_fixed'),
  credential_slot_id TEXT NOT NULL CHECK (credential_slot_id = 'freightcom_test_credential'),
  active_release_id TEXT NOT NULL,
  checked_at TEXT NOT NULL
) STRICT;

CREATE TABLE config_validations (
  validation_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  config_digest TEXT NOT NULL,
  request_timeout_ms INTEGER NOT NULL,
  poll_interval_ms INTEGER NOT NULL,
  max_poll_attempts INTEGER NOT NULL,
  egress_profile_id TEXT NOT NULL,
  credential_slot_id TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('validated', 'blocked')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE config_previews (
  preview_ref TEXT PRIMARY KEY,
  intent TEXT NOT NULL CHECK (intent IN ('change', 'rollback')),
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  target_release_id TEXT,
  config_digest TEXT NOT NULL,
  request_timeout_ms INTEGER NOT NULL,
  poll_interval_ms INTEGER NOT NULL,
  max_poll_attempts INTEGER NOT NULL,
  egress_profile_id TEXT NOT NULL,
  credential_slot_id TEXT NOT NULL,
  changed_field_ids_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  creator_actor_id TEXT NOT NULL,
  consumed INTEGER NOT NULL CHECK (consumed IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE config_approvals (
  approval_id TEXT PRIMARY KEY,
  preview_ref TEXT NOT NULL REFERENCES config_previews(preview_ref),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  approver_actor_id TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  reason_code TEXT NOT NULL
) STRICT;

CREATE TABLE config_releases (
  release_id TEXT PRIMARY KEY,
  preview_ref TEXT NOT NULL REFERENCES config_previews(preview_ref),
  approval_id TEXT NOT NULL REFERENCES config_approvals(approval_id),
  revision INTEGER NOT NULL UNIQUE CHECK (revision > 0),
  intent TEXT NOT NULL CHECK (intent IN ('change', 'rollback')),
  config_digest TEXT NOT NULL,
  request_timeout_ms INTEGER NOT NULL,
  poll_interval_ms INTEGER NOT NULL,
  max_poll_attempts INTEGER NOT NULL,
  egress_profile_id TEXT NOT NULL,
  credential_slot_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'published_pending_apply', 'applying', 'restarting', 'readback_verified',
    'manual_review', 'blocked', 'unavailable', 'superseded'
  )),
  published_at TEXT NOT NULL
) STRICT;

CREATE TABLE config_apply_attempts (
  attempt_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES config_releases(release_id),
  revision INTEGER NOT NULL,
  config_digest TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('created', 'claimed', 'finalized')),
  terminal_status TEXT CHECK (terminal_status IN (
    'readback_verified', 'mismatch', 'unknown', 'blocked', 'unavailable'
  )),
  reason_code TEXT,
  owner_boot_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finalized_at TEXT
) STRICT;

CREATE TABLE config_readbacks (
  readback_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES config_apply_attempts(attempt_id),
  release_id TEXT NOT NULL REFERENCES config_releases(release_id),
  revision INTEGER NOT NULL,
  config_digest TEXT NOT NULL,
  module_generation TEXT,
  status TEXT NOT NULL CHECK (status IN ('verified', 'mismatch', 'unknown')),
  reason_code TEXT,
  checked_at TEXT NOT NULL
) STRICT;

CREATE TABLE config_idempotency (
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_id TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (action, idempotency_key)
) STRICT;

CREATE TABLE config_events (
  sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
  event_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  object_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX config_events_time_idx ON config_events(occurred_at DESC, sequence DESC);
CREATE INDEX config_attempts_phase_idx ON config_apply_attempts(phase, created_at);
CREATE INDEX config_readbacks_release_idx ON config_readbacks(release_id, checked_at DESC);
`;

type SqlRow = Record<string, SQLInputValue>;

export type PluginConfigStoreErrorCode =
  | "invalid_options"
  | "state_exists"
  | "state_missing"
  | "permission_mismatch"
  | "identity_mismatch"
  | "schema_mismatch"
  | "database_open_failed"
  | "closed"
  | "corrupt"
  | "not_found"
  | "idempotency_conflict"
  | "state_conflict";

export class PluginConfigStoreError extends Error {
  readonly code: PluginConfigStoreErrorCode;

  constructor(code: PluginConfigStoreErrorCode, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "PluginConfigStoreError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface PluginConfigStoreOptions {
  readonly applicationRoot: string;
  readonly instanceId: string;
  readonly managementTenantId: string;
  readonly clock?: () => string;
}

export interface PluginConfigStorePaths {
  readonly runtimeDir: string;
  readonly stateDir: string;
  readonly databasePath: string;
  readonly markerPath: string;
}

interface Marker {
  readonly marker_format: typeof MARKER_FORMAT;
  readonly schema_version: typeof DATABASE_SCHEMA_VERSION;
  readonly config_store_id: string;
  readonly application_root: string;
  readonly database_path: string;
  readonly instance_id: string;
  readonly management_tenant_id: string;
}

export interface StoredPluginConfigValues {
  readonly values: readonly PluginConfigTypedValue[];
  readonly requestTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly maxPollAttempts: number;
  readonly egressProfileId: "freightcom_test_fixed";
  readonly credentialSlotId: "freightcom_test_credential";
}

export interface PluginConfigCurrentRecord extends StoredPluginConfigValues {
  readonly revision: number;
  readonly configDigest: string;
  readonly moduleGeneration: string;
  readonly activeReleaseId: string;
  readonly checkedAt: string;
}

export interface PluginConfigValidationRecord extends StoredPluginConfigValues {
  readonly validationId: string;
  readonly actorId: string;
  readonly baseRevision: number;
  readonly configDigest: string;
  readonly validationStatus: "validated" | "blocked";
  readonly createdAt: string;
}

export interface PluginConfigPreviewRecord extends StoredPluginConfigValues {
  readonly previewRef: string;
  readonly intent: PluginConfigIntent;
  readonly baseRevision: number;
  readonly targetReleaseId: string | null;
  readonly configDigest: string;
  readonly changedFieldIds: readonly string[];
  readonly expiresAt: string;
  readonly creatorActorId: string;
  readonly consumed: boolean;
  readonly createdAt: string;
}

export interface PluginConfigApprovalRecord {
  readonly approvalId: string;
  readonly previewRef: string;
  readonly decision: PluginConfigApprovalDecision;
  readonly approverActorId: string;
  readonly decidedAt: string;
  readonly reasonCode: string;
}

export interface PluginConfigReleaseRecord extends StoredPluginConfigValues {
  readonly releaseId: string;
  readonly previewRef: string;
  readonly approvalId: string;
  readonly revision: number;
  readonly intent: PluginConfigIntent;
  readonly configDigest: string;
  readonly state: PluginConfigReleaseState;
  readonly publishedAt: string;
}

export interface PluginConfigAttemptRecord {
  readonly attemptId: string;
  readonly releaseId: string;
  readonly revision: number;
  readonly configDigest: string;
  readonly phase: "created" | "claimed" | "finalized";
  readonly terminalStatus:
    | "readback_verified"
    | "mismatch"
    | "unknown"
    | "blocked"
    | "unavailable"
    | null;
  readonly reasonCode: string | null;
  readonly ownerBootId: string;
  readonly createdAt: string;
  readonly finalizedAt: string | null;
}

export interface PluginConfigReadbackRecord {
  readonly readbackId: string;
  readonly attemptId: string;
  readonly releaseId: string;
  readonly revision: number;
  readonly configDigest: string;
  readonly moduleGeneration: string | null;
  readonly status: "verified" | "mismatch" | "unknown";
  readonly reasonCode: string | null;
  readonly checkedAt: string;
}

export interface PluginConfigEventRecord {
  readonly sequence: number;
  readonly eventId: string;
  readonly actorId: string;
  readonly action: string;
  readonly objectRef: string;
  readonly status: string;
  readonly reasonCode: string;
  readonly occurredAt: string;
}

export interface PluginConfigIdempotencyRecord {
  readonly action: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly resultId: string;
  readonly response: PluginConfigOperationResponse | null;
  readonly createdAt: string;
}

export interface PluginConfigStoreSnapshot {
  readonly current: PluginConfigCurrentRecord;
  readonly latestValidation: PluginConfigValidationRecord | null;
  readonly latestPreview: PluginConfigPreviewRecord | null;
  readonly latestApproval: PluginConfigApprovalRecord | null;
  readonly latestRelease: PluginConfigReleaseRecord | null;
  readonly latestReadback: PluginConfigReadbackRecord | null;
  readonly events: readonly PluginConfigEventRecord[];
  readonly eventsTruncated: boolean;
}

export interface PluginConfigWriteIdentity {
  readonly action: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly resultId: string;
  readonly createdAt: string;
}

export interface PluginConfigPublishStart {
  readonly release: PluginConfigReleaseRecord;
  readonly attempt: PluginConfigAttemptRecord;
  readonly identity: PluginConfigWriteIdentity;
  readonly event: Omit<PluginConfigEventRecord, "sequence">;
}

export interface PluginConfigFinalization {
  readonly releaseId: string;
  readonly attemptId: string;
  readonly releaseState: PluginConfigReleaseState;
  readonly terminalStatus: NonNullable<PluginConfigAttemptRecord["terminalStatus"]>;
  readonly reasonCode: string;
  readonly finalizedAt: string;
  readonly readback: PluginConfigReadbackRecord;
  readonly activateCurrent: boolean;
  readonly response: PluginConfigOperationResponse;
  readonly event: Omit<PluginConfigEventRecord, "sequence">;
}

function fail(code: PluginConfigStoreErrorCode, cause?: unknown): never {
  throw new PluginConfigStoreError(code, cause === undefined ? {} : { cause });
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validateOptions(options: PluginConfigStoreOptions): PluginConfigStoreOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    !isAbsolute(options.applicationRoot) ||
    !isIdentifier(options.instanceId) ||
    !isIdentifier(options.managementTenantId) ||
    (options.clock !== undefined && typeof options.clock !== "function")
  ) {
    fail("invalid_options");
  }
  return options;
}

function canonicalRoot(applicationRoot: string): string {
  try {
    const root = realpathSync(resolve(applicationRoot));
    const entry = lstatSync(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("invalid_options");
    return root;
  } catch (error) {
    if (error instanceof PluginConfigStoreError) throw error;
    fail("invalid_options", error);
  }
}

export function pluginConfigPaths(applicationRoot: string): PluginConfigStorePaths {
  const runtimeDir = join(realpathSync(resolve(applicationRoot)), ".runtime");
  const stateDir = join(runtimeDir, "mcp-plugin-config");
  return Object.freeze({
    runtimeDir,
    stateDir,
    databasePath: join(stateDir, "config.sqlite"),
    markerPath: join(stateDir, "config-identity.json"),
  });
}

function assertEntry(
  path: string,
  kind: "directory" | "file",
  mode: number,
  missingCode: "state_missing" | "database_open_failed",
): void {
  try {
    const entry = lstatSync(path);
    if (
      entry.isSymbolicLink() ||
      (kind === "directory" ? !entry.isDirectory() : !entry.isFile())
    ) {
      fail("identity_mismatch");
    }
    if ((entry.mode & 0o777) !== mode) fail("permission_mismatch");
  } catch (error) {
    if (error instanceof PluginConfigStoreError) throw error;
    fail(missingCode, error);
  }
}

function markerFor(
  root: string,
  paths: PluginConfigStorePaths,
  options: PluginConfigStoreOptions,
): Marker {
  return Object.freeze({
    marker_format: MARKER_FORMAT,
    schema_version: DATABASE_SCHEMA_VERSION,
    config_store_id: `plugin_config_${randomBytes(16).toString("hex")}`,
    application_root: root,
    database_path: paths.databasePath,
    instance_id: options.instanceId,
    management_tenant_id: options.managementTenantId,
  });
}

function readMarker(path: string): Marker {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("marker_not_object");
    }
    const value = parsed as Record<string, unknown>;
    const expected = [
      "application_root",
      "config_store_id",
      "database_path",
      "instance_id",
      "management_tenant_id",
      "marker_format",
      "schema_version",
    ].sort();
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
      throw new Error("marker_keys");
    }
    if (
      value.marker_format !== MARKER_FORMAT ||
      value.schema_version !== DATABASE_SCHEMA_VERSION ||
      !isIdentifier(value.config_store_id) ||
      typeof value.application_root !== "string" ||
      typeof value.database_path !== "string" ||
      !isIdentifier(value.instance_id) ||
      !isIdentifier(value.management_tenant_id)
    ) {
      throw new Error("marker_values");
    }
    return value as unknown as Marker;
  } catch (error) {
    fail("identity_mismatch", error);
  }
}

function generationFor(revision: number, digest: string): string {
  const suffix = digest.split(":").at(-1)?.slice(0, 16) ?? "unknown";
  return `freightcom_generation_${revision}_${suffix}`;
}

function expectText(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") fail("corrupt");
  return value;
}

function nullableText(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") fail("corrupt");
  return value;
}

function expectInteger(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail("corrupt");
  return value;
}

function valuesFromRow(row: SqlRow): StoredPluginConfigValues {
  const requestTimeoutMs = expectInteger(row, "request_timeout_ms");
  const pollIntervalMs = expectInteger(row, "poll_interval_ms");
  const maxPollAttempts = expectInteger(row, "max_poll_attempts");
  const egressProfileId = expectText(row, "egress_profile_id");
  const credentialSlotId = expectText(row, "credential_slot_id");
  if (
    egressProfileId !== "freightcom_test_fixed" ||
    credentialSlotId !== "freightcom_test_credential"
  ) {
    fail("corrupt");
  }
  const values = validatePluginConfigValues([
    { field_id: "request_timeout_ms", kind: "integer", value: requestTimeoutMs },
    { field_id: "poll_interval_ms", kind: "integer", value: pollIntervalMs },
    { field_id: "max_poll_attempts", kind: "integer", value: maxPollAttempts },
    { field_id: "egress_profile_id", kind: "enum", value: egressProfileId },
    { field_id: "credential_slot_id", kind: "secret_slot", value: credentialSlotId },
  ]);
  return Object.freeze({
    values,
    requestTimeoutMs,
    pollIntervalMs,
    maxPollAttempts,
    egressProfileId,
    credentialSlotId,
  });
}

export function storedPluginConfigValues(
  input: readonly PluginConfigTypedValue[],
): StoredPluginConfigValues {
  const values = validatePluginConfigValues(input);
  const byId = new Map(values.map((value) => [value.field_id, value]));
  const requestTimeout = byId.get("request_timeout_ms");
  const pollInterval = byId.get("poll_interval_ms");
  const maxPoll = byId.get("max_poll_attempts");
  const egress = byId.get("egress_profile_id");
  const credential = byId.get("credential_slot_id");
  if (
    requestTimeout?.kind !== "integer" ||
    pollInterval?.kind !== "integer" ||
    maxPoll?.kind !== "integer" ||
    egress?.kind !== "enum" ||
    egress.value !== "freightcom_test_fixed" ||
    credential?.kind !== "secret_slot" ||
    credential.value !== "freightcom_test_credential"
  ) {
    fail("corrupt");
  }
  return Object.freeze({
    values,
    requestTimeoutMs: requestTimeout.value,
    pollIntervalMs: pollInterval.value,
    maxPollAttempts: maxPoll.value,
    egressProfileId: egress.value,
    credentialSlotId: credential.value,
  });
}

function bindValues(values: StoredPluginConfigValues): readonly SQLInputValue[] {
  return [
    values.requestTimeoutMs,
    values.pollIntervalMs,
    values.maxPollAttempts,
    values.egressProfileId,
    values.credentialSlotId,
  ];
}

function currentFromRow(row: SqlRow): PluginConfigCurrentRecord {
  return Object.freeze({
    ...valuesFromRow(row),
    revision: expectInteger(row, "revision"),
    configDigest: expectText(row, "config_digest"),
    moduleGeneration: expectText(row, "module_generation"),
    activeReleaseId: expectText(row, "active_release_id"),
    checkedAt: expectText(row, "checked_at"),
  });
}

function validationFromRow(row: SqlRow): PluginConfigValidationRecord {
  const validationStatus = expectText(row, "validation_status");
  if (validationStatus !== "validated" && validationStatus !== "blocked") fail("corrupt");
  return Object.freeze({
    ...valuesFromRow(row),
    validationId: expectText(row, "validation_id"),
    actorId: expectText(row, "actor_id"),
    baseRevision: expectInteger(row, "base_revision"),
    configDigest: expectText(row, "config_digest"),
    validationStatus,
    createdAt: expectText(row, "created_at"),
  });
}

function parseChangedFields(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length > 5 ||
      parsed.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(item))
    ) {
      fail("corrupt");
    }
    const fields: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") fail("corrupt");
      fields.push(item);
    }
    return Object.freeze(fields);
  } catch (error) {
    if (error instanceof PluginConfigStoreError) throw error;
    fail("corrupt", error);
  }
}

function previewFromRow(row: SqlRow): PluginConfigPreviewRecord {
  const intent = expectText(row, "intent");
  if (intent !== "change" && intent !== "rollback") fail("corrupt");
  const consumed = expectInteger(row, "consumed");
  if (consumed !== 0 && consumed !== 1) fail("corrupt");
  return Object.freeze({
    ...valuesFromRow(row),
    previewRef: expectText(row, "preview_ref"),
    intent,
    baseRevision: expectInteger(row, "base_revision"),
    targetReleaseId: nullableText(row, "target_release_id"),
    configDigest: expectText(row, "config_digest"),
    changedFieldIds: parseChangedFields(expectText(row, "changed_field_ids_json")),
    expiresAt: expectText(row, "expires_at"),
    creatorActorId: expectText(row, "creator_actor_id"),
    consumed: consumed === 1,
    createdAt: expectText(row, "created_at"),
  });
}

function approvalFromRow(row: SqlRow): PluginConfigApprovalRecord {
  const decision = expectText(row, "decision");
  if (decision !== "approve" && decision !== "reject") fail("corrupt");
  return Object.freeze({
    approvalId: expectText(row, "approval_id"),
    previewRef: expectText(row, "preview_ref"),
    decision,
    approverActorId: expectText(row, "approver_actor_id"),
    decidedAt: expectText(row, "decided_at"),
    reasonCode: expectText(row, "reason_code"),
  });
}

function releaseFromRow(row: SqlRow): PluginConfigReleaseRecord {
  const intent = expectText(row, "intent");
  const state = expectText(row, "state");
  if (intent !== "change" && intent !== "rollback") fail("corrupt");
  if (![
    "published_pending_apply", "applying", "restarting", "readback_verified",
    "manual_review", "blocked", "unavailable", "superseded",
  ].includes(state)) fail("corrupt");
  return Object.freeze({
    ...valuesFromRow(row),
    releaseId: expectText(row, "release_id"),
    previewRef: expectText(row, "preview_ref"),
    approvalId: expectText(row, "approval_id"),
    revision: expectInteger(row, "revision"),
    intent,
    configDigest: expectText(row, "config_digest"),
    state: state as PluginConfigReleaseState,
    publishedAt: expectText(row, "published_at"),
  });
}

function attemptFromRow(row: SqlRow): PluginConfigAttemptRecord {
  const phase = expectText(row, "phase");
  const terminalStatus = nullableText(row, "terminal_status");
  if (phase !== "created" && phase !== "claimed" && phase !== "finalized") fail("corrupt");
  if (
    terminalStatus !== null &&
    !["readback_verified", "mismatch", "unknown", "blocked", "unavailable"].includes(terminalStatus)
  ) fail("corrupt");
  return Object.freeze({
    attemptId: expectText(row, "attempt_id"),
    releaseId: expectText(row, "release_id"),
    revision: expectInteger(row, "revision"),
    configDigest: expectText(row, "config_digest"),
    phase,
    terminalStatus: terminalStatus as PluginConfigAttemptRecord["terminalStatus"],
    reasonCode: nullableText(row, "reason_code"),
    ownerBootId: expectText(row, "owner_boot_id"),
    createdAt: expectText(row, "created_at"),
    finalizedAt: nullableText(row, "finalized_at"),
  });
}

function readbackFromRow(row: SqlRow): PluginConfigReadbackRecord {
  const status = expectText(row, "status");
  if (status !== "verified" && status !== "mismatch" && status !== "unknown") fail("corrupt");
  return Object.freeze({
    readbackId: expectText(row, "readback_id"),
    attemptId: expectText(row, "attempt_id"),
    releaseId: expectText(row, "release_id"),
    revision: expectInteger(row, "revision"),
    configDigest: expectText(row, "config_digest"),
    moduleGeneration: nullableText(row, "module_generation"),
    status,
    reasonCode: nullableText(row, "reason_code"),
    checkedAt: expectText(row, "checked_at"),
  });
}

function eventFromRow(row: SqlRow): PluginConfigEventRecord {
  return Object.freeze({
    sequence: expectInteger(row, "sequence"),
    eventId: expectText(row, "event_id"),
    actorId: expectText(row, "actor_id"),
    action: expectText(row, "action"),
    objectRef: expectText(row, "object_ref"),
    status: expectText(row, "status"),
    reasonCode: expectText(row, "reason_code"),
    occurredAt: expectText(row, "occurred_at"),
  });
}

function idempotencyFromRow(row: SqlRow): PluginConfigIdempotencyRecord {
  const responseJson = nullableText(row, "response_json");
  let response: PluginConfigOperationResponse | null = null;
  if (responseJson !== null) {
    try {
      response = pluginConfigOperationResponseSchema.parse(JSON.parse(responseJson));
    } catch (error) {
      fail("corrupt", error);
    }
  }
  return Object.freeze({
    action: expectText(row, "action"),
    idempotencyKey: expectText(row, "idempotency_key"),
    requestHash: expectText(row, "request_hash"),
    resultId: expectText(row, "result_id"),
    response,
    createdAt: expectText(row, "created_at"),
  });
}

function insertEvent(
  database: DatabaseSync,
  event: Omit<PluginConfigEventRecord, "sequence">,
): void {
  const current = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM config_events")
    .get() as SqlRow | undefined;
  if (current === undefined) fail("corrupt");
  const sequence = expectInteger(current, "value") + 1;
  database.prepare(`
    INSERT INTO config_events (
      sequence, event_id, actor_id, action, object_ref, status, reason_code, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sequence,
    event.eventId,
    event.actorId,
    event.action,
    event.objectRef,
    event.status,
    event.reasonCode,
    event.occurredAt,
  );
}

export function initializeSqlitePluginConfigState(
  rawOptions: PluginConfigStoreOptions,
): Promise<void> {
  const options = validateOptions(rawOptions);
  const root = canonicalRoot(options.applicationRoot);
  const paths = pluginConfigPaths(root);
  try {
    mkdirSync(paths.runtimeDir, { recursive: false, mode: DIRECTORY_MODE });
  } catch {
    // The runtime directory may already be owned by another explicit store.
  }
  assertEntry(paths.runtimeDir, "directory", DIRECTORY_MODE, "state_missing");
  try {
    lstatSync(paths.stateDir);
    fail("state_exists");
  } catch (error) {
    if (error instanceof PluginConfigStoreError) throw error;
  }

  const stagingDir = mkdtempSync(join(paths.runtimeDir, ".mcp-plugin-config-staging-"));
  chmodSync(stagingDir, DIRECTORY_MODE);
  const stagingDatabase = join(stagingDir, "config.sqlite");
  const stagingMarker = join(stagingDir, "config-identity.json");
  const marker = markerFor(root, paths, options);
  const now = options.clock?.() ?? new Date().toISOString();
  const defaults = storedPluginConfigValues(FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES);
  const digest = configDigestForValues(defaults.values);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(stagingDatabase, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec(SCHEMA_SQL);
    database.prepare(`
      INSERT INTO config_meta (
        singleton, schema_version, config_store_id, instance_id, management_tenant_id
      ) VALUES (1, ?, ?, ?, ?)
    `).run(
      DATABASE_SCHEMA_VERSION,
      marker.config_store_id,
      options.instanceId,
      options.managementTenantId,
    );
    database.prepare(`
      INSERT INTO plugin_current (
        singleton, module_id, revision, config_digest, module_generation,
        request_timeout_ms, poll_interval_ms, max_poll_attempts,
        egress_profile_id, credential_slot_id, active_release_id, checked_at
      ) VALUES (1, 'freightcom-ltl', 0, ?, ?, ?, ?, ?, ?, ?, 'bootstrap_config', ?)
    `).run(
      digest,
      generationFor(0, digest),
      ...bindValues(defaults),
      now,
    );
    const quickCheck = database.prepare("PRAGMA quick_check").get() as SqlRow | undefined;
    if (quickCheck === undefined || Object.values(quickCheck)[0] !== "ok") fail("schema_mismatch");
    database.close();
    database = undefined;
    chmodSync(stagingDatabase, DATABASE_MODE);
    writeFileSync(stagingMarker, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: MARKER_MODE,
    });
    chmodSync(stagingMarker, MARKER_MODE);
    renameSync(stagingDir, paths.stateDir);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the stable outer error.
    }
    rmSync(stagingDir, { recursive: true, force: true });
    if (error instanceof PluginConfigStoreError) throw error;
    fail("database_open_failed", error);
  }
  return Promise.resolve();
}

export class SqlitePluginConfigStore {
  readonly managementTenantId: string;
  readonly #database: DatabaseSync;
  readonly #marker: Marker;
  #closed = false;

  constructor(rawOptions: PluginConfigStoreOptions) {
    const options = validateOptions(rawOptions);
    const root = canonicalRoot(options.applicationRoot);
    const paths = pluginConfigPaths(root);
    this.managementTenantId = options.managementTenantId;
    assertEntry(paths.stateDir, "directory", DIRECTORY_MODE, "state_missing");
    assertEntry(paths.databasePath, "file", DATABASE_MODE, "database_open_failed");
    assertEntry(paths.markerPath, "file", MARKER_MODE, "database_open_failed");
    this.#marker = readMarker(paths.markerPath);
    if (
      this.#marker.application_root !== root ||
      this.#marker.database_path !== paths.databasePath ||
      this.#marker.instance_id !== options.instanceId ||
      this.#marker.management_tenant_id !== options.managementTenantId
    ) {
      fail("identity_mismatch");
    }
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(paths.databasePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
      });
      this.#database = database;
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec("PRAGMA journal_mode = WAL");
      this.#database.exec("PRAGMA synchronous = FULL");
      this.#database.exec("PRAGMA trusted_schema = OFF");
      this.#verify();
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the stable outer error.
      }
      if (error instanceof PluginConfigStoreError) throw error;
      fail("database_open_failed", error);
    }
  }

  #active(): DatabaseSync {
    if (this.#closed) fail("closed");
    return this.#database;
  }

  #verify(): void {
    const database = this.#database;
    const meta = database.prepare(`
      SELECT schema_version, config_store_id, instance_id, management_tenant_id
      FROM config_meta WHERE singleton = 1
    `).get() as SqlRow | undefined;
    if (
      meta === undefined ||
      meta.schema_version !== DATABASE_SCHEMA_VERSION ||
      meta.config_store_id !== this.#marker.config_store_id ||
      meta.instance_id !== this.#marker.instance_id ||
      meta.management_tenant_id !== this.#marker.management_tenant_id
    ) fail("schema_mismatch");
    const observed = (database.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
    `).all() as SqlRow[]).map((row) => expectText(row, "name"));
    if (JSON.stringify(observed) !== JSON.stringify(TABLES)) fail("schema_mismatch");
    const quickCheck = database.prepare("PRAGMA quick_check").get() as SqlRow | undefined;
    if (quickCheck === undefined || Object.values(quickCheck)[0] !== "ok") fail("schema_mismatch");
    currentFromRow(database.prepare("SELECT * FROM plugin_current WHERE singleton = 1").get() as SqlRow);
  }

  #transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.#active();
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation(database);
      database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the operation error.
      }
      throw error;
    }
  }

  getCurrent(): PluginConfigCurrentRecord {
    const row = this.#active().prepare("SELECT * FROM plugin_current WHERE singleton = 1")
      .get() as SqlRow | undefined;
    if (row === undefined) fail("corrupt");
    return currentFromRow(row);
  }

  getSnapshot(): PluginConfigStoreSnapshot {
    const database = this.#active();
    const latest = (table: string, order: string): SqlRow | undefined =>
      database.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 1`).get();
    const events = (database.prepare(`
      SELECT * FROM config_events ORDER BY sequence DESC LIMIT 51
    `).all() as SqlRow[]).map(eventFromRow);
    const latestRelease = latest("config_releases", "revision DESC");
    const latestReadback = database.prepare(`
      SELECT * FROM config_readbacks ORDER BY checked_at DESC, readback_id DESC LIMIT 1
    `).get() as SqlRow | undefined;
    return Object.freeze({
      current: this.getCurrent(),
      latestValidation: (() => {
        const row = latest("config_validations", "created_at DESC, validation_id DESC");
        return row === undefined ? null : validationFromRow(row);
      })(),
      latestPreview: (() => {
        const row = latest("config_previews", "created_at DESC, preview_ref DESC");
        return row === undefined ? null : previewFromRow(row);
      })(),
      latestApproval: (() => {
        const row = latest("config_approvals", "decided_at DESC, approval_id DESC");
        return row === undefined ? null : approvalFromRow(row);
      })(),
      latestRelease: latestRelease === undefined ? null : releaseFromRow(latestRelease),
      latestReadback: latestReadback === undefined ? null : readbackFromRow(latestReadback),
      events: Object.freeze(events.slice(0, 50)),
      eventsTruncated: events.length > 50,
    });
  }

  getIdempotency(
    action: string,
    idempotencyKey: string,
    requestHash: string,
  ): PluginConfigIdempotencyRecord | null {
    const row = this.#active().prepare(`
      SELECT * FROM config_idempotency WHERE action = ? AND idempotency_key = ?
    `).get(action, idempotencyKey) as SqlRow | undefined;
    if (row === undefined) return null;
    const record = idempotencyFromRow(row);
    if (record.requestHash !== requestHash) fail("idempotency_conflict");
    return record;
  }

  recordValidation(
    record: PluginConfigValidationRecord,
    identity: PluginConfigWriteIdentity,
    response: PluginConfigOperationResponse,
    event: Omit<PluginConfigEventRecord, "sequence">,
  ): void {
    this.#transaction((database) => {
      database.prepare(`
        INSERT INTO config_validations (
          validation_id, actor_id, base_revision, config_digest,
          request_timeout_ms, poll_interval_ms, max_poll_attempts,
          egress_profile_id, credential_slot_id, validation_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.validationId,
        record.actorId,
        record.baseRevision,
        record.configDigest,
        ...bindValues(record),
        record.validationStatus,
        record.createdAt,
      );
      this.#insertIdempotency(database, identity, response);
      insertEvent(database, event);
    });
  }

  recordPreview(
    record: PluginConfigPreviewRecord,
    identity: PluginConfigWriteIdentity,
    response: PluginConfigOperationResponse,
    event: Omit<PluginConfigEventRecord, "sequence">,
  ): void {
    this.#transaction((database) => {
      database.prepare(`
        INSERT INTO config_previews (
          preview_ref, intent, base_revision, target_release_id, config_digest,
          request_timeout_ms, poll_interval_ms, max_poll_attempts,
          egress_profile_id, credential_slot_id, changed_field_ids_json,
          expires_at, creator_actor_id, consumed, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(
        record.previewRef,
        record.intent,
        record.baseRevision,
        record.targetReleaseId,
        record.configDigest,
        ...bindValues(record),
        JSON.stringify(record.changedFieldIds),
        record.expiresAt,
        record.creatorActorId,
        record.createdAt,
      );
      this.#insertIdempotency(database, identity, response);
      insertEvent(database, event);
    });
  }

  getPreview(previewRef: string): PluginConfigPreviewRecord {
    const row = this.#active().prepare("SELECT * FROM config_previews WHERE preview_ref = ?")
      .get(previewRef) as SqlRow | undefined;
    if (row === undefined) fail("not_found");
    return previewFromRow(row);
  }

  recordApproval(
    record: PluginConfigApprovalRecord,
    identity: PluginConfigWriteIdentity,
    response: PluginConfigOperationResponse,
    event: Omit<PluginConfigEventRecord, "sequence">,
  ): void {
    this.#transaction((database) => {
      database.prepare(`
        INSERT INTO config_approvals (
          approval_id, preview_ref, decision, approver_actor_id, decided_at, reason_code
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        record.approvalId,
        record.previewRef,
        record.decision,
        record.approverActorId,
        record.decidedAt,
        record.reasonCode,
      );
      this.#insertIdempotency(database, identity, response);
      insertEvent(database, event);
    });
  }

  getApproval(approvalId: string): PluginConfigApprovalRecord {
    const row = this.#active().prepare("SELECT * FROM config_approvals WHERE approval_id = ?")
      .get(approvalId) as SqlRow | undefined;
    if (row === undefined) fail("not_found");
    return approvalFromRow(row);
  }

  getRelease(releaseId: string): PluginConfigReleaseRecord {
    const row = this.#active().prepare("SELECT * FROM config_releases WHERE release_id = ?")
      .get(releaseId) as SqlRow | undefined;
    if (row === undefined) fail("not_found");
    return releaseFromRow(row);
  }

  getLatestAttemptForRelease(releaseId: string): PluginConfigAttemptRecord {
    const row = this.#active().prepare(`
      SELECT * FROM config_apply_attempts
      WHERE release_id = ? ORDER BY created_at DESC, attempt_id DESC LIMIT 1
    `).get(releaseId) as SqlRow | undefined;
    if (row === undefined) fail("not_found");
    return attemptFromRow(row);
  }

  beginPublish(input: PluginConfigPublishStart): PluginConfigIdempotencyRecord | null {
    return this.#transaction((database) => {
      const existing = database.prepare(`
        SELECT * FROM config_idempotency WHERE action = ? AND idempotency_key = ?
      `).get(input.identity.action, input.identity.idempotencyKey) as SqlRow | undefined;
      if (existing !== undefined) {
        const record = idempotencyFromRow(existing);
        if (record.requestHash !== input.identity.requestHash) fail("idempotency_conflict");
        return record;
      }
      const currentRow = database.prepare("SELECT * FROM plugin_current WHERE singleton = 1")
        .get() as SqlRow | undefined;
      if (currentRow === undefined) fail("corrupt");
      const current = currentFromRow(currentRow);
      if (input.release.revision !== current.revision + 1) fail("state_conflict");
      const preview = database.prepare("SELECT * FROM config_previews WHERE preview_ref = ?")
        .get(input.release.previewRef) as SqlRow | undefined;
      if (preview === undefined || previewFromRow(preview).consumed) fail("state_conflict");
      database.prepare(`
        INSERT INTO config_releases (
          release_id, preview_ref, approval_id, revision, intent, config_digest,
          request_timeout_ms, poll_interval_ms, max_poll_attempts,
          egress_profile_id, credential_slot_id, state, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.release.releaseId,
        input.release.previewRef,
        input.release.approvalId,
        input.release.revision,
        input.release.intent,
        input.release.configDigest,
        ...bindValues(input.release),
        input.release.state,
        input.release.publishedAt,
      );
      database.prepare("UPDATE config_previews SET consumed = 1 WHERE preview_ref = ?")
        .run(input.release.previewRef);
      database.prepare(`
        INSERT INTO config_apply_attempts (
          attempt_id, release_id, revision, config_digest, phase, terminal_status,
          reason_code, owner_boot_id, created_at, finalized_at
        ) VALUES (?, ?, ?, ?, 'claimed', NULL, NULL, ?, ?, NULL)
      `).run(
        input.attempt.attemptId,
        input.attempt.releaseId,
        input.attempt.revision,
        input.attempt.configDigest,
        input.attempt.ownerBootId,
        input.attempt.createdAt,
      );
      this.#insertIdempotency(database, input.identity, null);
      insertEvent(database, input.event);
      return null;
    });
  }

  finalizePublish(input: PluginConfigFinalization): void {
    this.#transaction((database) => {
      const attemptRow = database.prepare("SELECT * FROM config_apply_attempts WHERE attempt_id = ?")
        .get(input.attemptId) as SqlRow | undefined;
      if (attemptRow === undefined || attemptFromRow(attemptRow).phase === "finalized") {
        fail("state_conflict");
      }
      const releaseRow = database.prepare("SELECT * FROM config_releases WHERE release_id = ?")
        .get(input.releaseId) as SqlRow | undefined;
      if (releaseRow === undefined) fail("not_found");
      const release = releaseFromRow(releaseRow);
      database.prepare(`
        INSERT INTO config_readbacks (
          readback_id, attempt_id, release_id, revision, config_digest,
          module_generation, status, reason_code, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.readback.readbackId,
        input.readback.attemptId,
        input.readback.releaseId,
        input.readback.revision,
        input.readback.configDigest,
        input.readback.moduleGeneration,
        input.readback.status,
        input.readback.reasonCode,
        input.readback.checkedAt,
      );
      database.prepare(`
        UPDATE config_apply_attempts
        SET phase = 'finalized', terminal_status = ?, reason_code = ?, finalized_at = ?
        WHERE attempt_id = ?
      `).run(input.terminalStatus, input.reasonCode, input.finalizedAt, input.attemptId);
      database.prepare("UPDATE config_releases SET state = ? WHERE release_id = ?")
        .run(input.releaseState, input.releaseId);
      if (input.activateCurrent) {
        if (input.readback.moduleGeneration === null) fail("state_conflict");
        database.prepare(`
          UPDATE plugin_current SET
            revision = ?, config_digest = ?, module_generation = ?,
            request_timeout_ms = ?, poll_interval_ms = ?, max_poll_attempts = ?,
            egress_profile_id = ?, credential_slot_id = ?, active_release_id = ?, checked_at = ?
          WHERE singleton = 1
        `).run(
          release.revision,
          release.configDigest,
          input.readback.moduleGeneration,
          ...bindValues(release),
          release.releaseId,
          input.readback.checkedAt,
        );
      }
      database.prepare(`
        UPDATE config_idempotency SET response_json = ?
        WHERE action = 'publish' AND result_id = ? AND response_json IS NULL
      `).run(JSON.stringify(input.response), input.releaseId);
      insertEvent(database, input.event);
    });
  }

  recordReconciliation(
    release: PluginConfigReleaseRecord,
    readback: PluginConfigReadbackRecord,
    identity: PluginConfigWriteIdentity,
    response: PluginConfigOperationResponse,
    activateCurrent: boolean,
    event: Omit<PluginConfigEventRecord, "sequence">,
  ): void {
    this.#transaction((database) => {
      database.prepare(`
        INSERT INTO config_readbacks (
          readback_id, attempt_id, release_id, revision, config_digest,
          module_generation, status, reason_code, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        readback.readbackId,
        readback.attemptId,
        readback.releaseId,
        readback.revision,
        readback.configDigest,
        readback.moduleGeneration,
        readback.status,
        readback.reasonCode,
        readback.checkedAt,
      );
      database.prepare("UPDATE config_releases SET state = ? WHERE release_id = ?")
        .run(activateCurrent ? "readback_verified" : "manual_review", release.releaseId);
      if (activateCurrent) {
        if (readback.moduleGeneration === null) fail("state_conflict");
        database.prepare(`
          UPDATE plugin_current SET
            revision = ?, config_digest = ?, module_generation = ?,
            request_timeout_ms = ?, poll_interval_ms = ?, max_poll_attempts = ?,
            egress_profile_id = ?, credential_slot_id = ?, active_release_id = ?, checked_at = ?
          WHERE singleton = 1
        `).run(
          release.revision,
          release.configDigest,
          readback.moduleGeneration,
          ...bindValues(release),
          release.releaseId,
          readback.checkedAt,
        );
      }
      this.#insertIdempotency(database, identity, response);
      insertEvent(database, event);
    });
  }

  listUnfinishedAttempts(): readonly PluginConfigAttemptRecord[] {
    return Object.freeze((this.#active().prepare(`
      SELECT * FROM config_apply_attempts WHERE phase <> 'finalized'
      ORDER BY created_at, attempt_id
    `).all() as SqlRow[]).map(attemptFromRow));
  }

  finalizeInterruptedAttempt(
    attemptId: string,
    readbackId: string,
    checkedAt: string,
    event: Omit<PluginConfigEventRecord, "sequence">,
  ): void {
    this.#transaction((database) => {
      const row = database.prepare("SELECT * FROM config_apply_attempts WHERE attempt_id = ?")
        .get(attemptId) as SqlRow | undefined;
      if (row === undefined) fail("not_found");
      const attempt = attemptFromRow(row);
      if (attempt.phase === "finalized") return;
      database.prepare(`
        INSERT INTO config_readbacks (
          readback_id, attempt_id, release_id, revision, config_digest,
          module_generation, status, reason_code, checked_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'unknown', 'readback_interrupted', ?)
      `).run(
        readbackId,
        attempt.attemptId,
        attempt.releaseId,
        attempt.revision,
        attempt.configDigest,
        checkedAt,
      );
      database.prepare(`
        UPDATE config_apply_attempts
        SET phase = 'finalized', terminal_status = 'unknown',
            reason_code = 'readback_interrupted', finalized_at = ?
        WHERE attempt_id = ?
      `).run(checkedAt, attempt.attemptId);
      database.prepare("UPDATE config_releases SET state = 'manual_review' WHERE release_id = ?")
        .run(attempt.releaseId);
      insertEvent(database, event);
    });
  }

  #insertIdempotency(
    database: DatabaseSync,
    identity: PluginConfigWriteIdentity,
    response: PluginConfigOperationResponse | null,
  ): void {
    database.prepare(`
      INSERT INTO config_idempotency (
        action, idempotency_key, request_hash, result_id, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      identity.action,
      identity.idempotencyKey,
      identity.requestHash,
      identity.resultId,
      response === null ? null : JSON.stringify(response),
      identity.createdAt,
    );
  }

  health(): Readonly<{ ready: boolean; reason_codes: readonly string[] }> {
    try {
      this.#verify();
      return Object.freeze({ ready: true, reason_codes: Object.freeze([]) });
    } catch {
      return Object.freeze({
        ready: false,
        reason_codes: Object.freeze(["plugin_config_store_unavailable"]),
      });
    }
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
    return Promise.resolve();
  }
}

export function pluginConfigGeneration(revision: number, digest: string): string {
  return generationFor(revision, digest);
}
