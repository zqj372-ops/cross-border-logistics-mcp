import { Buffer } from "node:buffer";
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
import { TenantAccessError } from "./tenant-access-errors";
import type {
  ClientRecord,
  ClientStatus,
  StoredCredentialRecord,
  TenantAccessEventRecord,
  TenantAccessRepository,
  TenantAccessResponseContext,
  TenantAccessStateRecord,
  TenantAccessWriteResult,
  TenantRecord,
  TenantStatus,
} from "./tenant-access-repository";
import { TenantAccessRepositoryError } from "./tenant-access-repository";
import {
  normalizeStoredTenantApiKeyScopes,
  type TenantApiKeyScope,
} from "./tenant-access-contracts";

const DIRECTORY_MODE = 0o700;
const DATABASE_MODE = 0o600;
const MARKER_MODE = 0o400;
const MARKER_FORMAT = "mcp-tenant-access-identity/v1" as const;
const LEGACY_DATABASE_SCHEMA_VERSION = 1 as const;
const CLIENT_DATABASE_SCHEMA_VERSION = 2 as const;
const PEPPER_DATABASE_SCHEMA_VERSION = 3 as const;
const DATABASE_SCHEMA_VERSION = 4 as const;
const RESULT_SNAPSHOT_FORMAT = "mcp-tenant-access-result/v1" as const;
const SNAPSHOT_BYTES_KEY = "__mcp_bytes_base64" as const;

const SCHEMA_SQL = `
CREATE TABLE access_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  access_store_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  management_tenant_id TEXT NOT NULL
) STRICT;

CREATE TABLE tenants (
  tenant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE clients (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  client_id TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id)
) STRICT;

CREATE TABLE credentials (
  credential_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  client_id TEXT NOT NULL,
  label TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role = 'service'),
  roles_json TEXT NOT NULL CHECK (roles_json = '["service"]'),
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  key_prefix TEXT NOT NULL,
  secret_last_four TEXT NOT NULL,
  secret_salt BLOB NOT NULL,
  secret_hash BLOB NOT NULL,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  rotated_from_id TEXT REFERENCES credentials(credential_id),
  pepper_version TEXT NOT NULL CHECK (
    length(pepper_version) BETWEEN 8 AND 128
  )
) STRICT;

CREATE TABLE access_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  credential_id TEXT REFERENCES credentials(credential_id),
  actor_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  client_id TEXT
) STRICT;

CREATE TABLE access_idempotency (
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (action, idempotency_key)
) STRICT;

CREATE INDEX credentials_tenant_status_idx
  ON credentials(tenant_id, status, expires_at);
CREATE INDEX clients_tenant_status_idx
  ON clients(tenant_id, status, client_id);
CREATE INDEX access_events_created_idx
  ON access_events(created_at DESC, event_id DESC);
`;

export interface TenantAccessStoreOptions {
  readonly applicationRoot: string;
  readonly instanceId: string;
  readonly managementTenantId: string;
  readonly legacyCredentialPepperVersion?: string;
}

export interface TenantAccessStorePaths {
  readonly runtimeDir: string;
  readonly stateDir: string;
  readonly databasePath: string;
  readonly markerPath: string;
}

interface Marker {
  readonly marker_format: typeof MARKER_FORMAT;
  readonly schema_version:
    | typeof LEGACY_DATABASE_SCHEMA_VERSION
    | typeof CLIENT_DATABASE_SCHEMA_VERSION
    | typeof PEPPER_DATABASE_SCHEMA_VERSION
    | typeof DATABASE_SCHEMA_VERSION;
  readonly access_store_id: string;
  readonly application_root: string;
  readonly database_path: string;
  readonly instance_id: string;
  readonly management_tenant_id: string;
}

type SqlRow = Record<string, SQLInputValue>;

type ResultSnapshotMetadata = TenantAccessResponseContext;

type SnapshotEntityKind = "tenant" | "client" | "credential";

type IdempotentWriteResult<T> = Readonly<{
  readonly resultId: string;
  readonly value: T;
  readonly operation: TenantAccessEventRecord;
  readonly snapshot: ResultSnapshotMetadata;
}>;

type ResultSnapshotPayload = Readonly<{
  readonly snapshot_format: typeof RESULT_SNAPSHOT_FORMAT;
  readonly entity_kind: SnapshotEntityKind;
  readonly entity: unknown;
  readonly operation: unknown;
  readonly snapshot: unknown;
}>;

function makeSnapshotMetadata(
  tenantStatus: TenantStatus | null,
  clientStatus: ClientStatus | null,
  deliveryAcknowledgedAt: string | null,
): ResultSnapshotMetadata {
  return Object.freeze({ tenantStatus, clientStatus, deliveryAcknowledgedAt });
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isPepperVersion(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value);
}

function validateOptions(options: TenantAccessStoreOptions): TenantAccessStoreOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    !isAbsolute(options.applicationRoot) ||
    !isIdentifier(options.instanceId) ||
    !isIdentifier(options.managementTenantId) ||
    (options.legacyCredentialPepperVersion !== undefined &&
      !isPepperVersion(options.legacyCredentialPepperVersion))
  ) {
    throw new TenantAccessError("invalid_options");
  }
  return options;
}

function normalizedRoot(applicationRoot: string): string {
  try {
    const candidate = realpathSync(resolve(applicationRoot));
    const entry = lstatSync(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new TenantAccessError("invalid_options");
    }
    return candidate;
  } catch (error) {
    if (error instanceof TenantAccessError) throw error;
    throw new TenantAccessError("invalid_options", { cause: error });
  }
}

export function tenantAccessPaths(applicationRoot: string): TenantAccessStorePaths {
  const root = resolve(applicationRoot);
  const runtimeDir = join(root, ".runtime");
  const stateDir = join(runtimeDir, "mcp-tenant-access");
  return Object.freeze({
    runtimeDir,
    stateDir,
    databasePath: join(stateDir, "access.sqlite"),
    markerPath: join(stateDir, "access-identity.json"),
  });
}

function assertEntry(
  path: string,
  kind: "directory" | "file",
  mode: number,
  missingCode: "state_missing" | "database_open_failed",
): void {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    throw new TenantAccessError(missingCode, { cause: error });
  }
  const correctKind = kind === "directory" ? entry.isDirectory() : entry.isFile();
  if (entry.isSymbolicLink() || !correctKind) {
    throw new TenantAccessError("identity_mismatch");
  }
  if ((entry.mode & 0o777) !== mode) {
    throw new TenantAccessError("permission_mismatch");
  }
}

function readMarker(path: string): Marker {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid marker");
    }
    const value = parsed as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    const expectedKeys = [
      "access_store_id",
      "application_root",
      "database_path",
      "instance_id",
      "management_tenant_id",
      "marker_format",
      "schema_version",
    ].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      throw new Error("invalid marker keys");
    }
    if (
      value.marker_format !== MARKER_FORMAT ||
      (value.schema_version !== LEGACY_DATABASE_SCHEMA_VERSION &&
        value.schema_version !== CLIENT_DATABASE_SCHEMA_VERSION &&
        value.schema_version !== PEPPER_DATABASE_SCHEMA_VERSION &&
        value.schema_version !== DATABASE_SCHEMA_VERSION) ||
      !isIdentifier(value.access_store_id) ||
      typeof value.application_root !== "string" ||
      typeof value.database_path !== "string" ||
      !isIdentifier(value.instance_id) ||
      !isIdentifier(value.management_tenant_id)
    ) {
      throw new Error("invalid marker values");
    }
    return value as unknown as Marker;
  } catch (error) {
    throw new TenantAccessError("identity_mismatch", { cause: error });
  }
}

function writeMarker(path: string, marker: Marker): void {
  const parent = resolve(join(path, ".."));
  const temporaryPath = join(parent, `.access-identity-${randomBytes(12).toString("hex")}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: MARKER_MODE,
    });
    chmodSync(temporaryPath, MARKER_MODE);
    renameSync(temporaryPath, path);
    chmodSync(path, MARKER_MODE);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the marker write error.
    }
    throw error;
  }
}

function markerFor(
  root: string,
  paths: TenantAccessStorePaths,
  options: TenantAccessStoreOptions,
): Marker {
  return Object.freeze({
    marker_format: MARKER_FORMAT,
    schema_version: DATABASE_SCHEMA_VERSION,
    access_store_id: `access_${randomBytes(16).toString("hex")}`,
    application_root: root,
    database_path: paths.databasePath,
    instance_id: options.instanceId,
    management_tenant_id: options.managementTenantId,
  });
}

function expectText(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") repositoryFailure("corrupt");
  return value;
}

function expectNullableText(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") repositoryFailure("corrupt");
  return value;
}

function expectInteger(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    repositoryFailure("corrupt");
  }
  return value;
}

function expectBytes(row: SqlRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array)) repositoryFailure("corrupt");
  return new Uint8Array(value);
}

function repositoryFailure(
  code: ConstructorParameters<typeof TenantAccessRepositoryError>[0],
): never {
  throw new TenantAccessRepositoryError(code);
}

function isPlainSnapshotObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactSnapshotObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isPlainSnapshotObject(value)) repositoryFailure("corrupt");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) repositoryFailure("corrupt");
  return value;
}

function snapshotString(value: unknown): string {
  if (typeof value !== "string") repositoryFailure("corrupt");
  return value;
}

function snapshotIdentifier(value: unknown): string {
  const identifier = snapshotString(value);
  if (!isIdentifier(identifier)) repositoryFailure("corrupt");
  return identifier;
}

function snapshotNullableIdentifier(value: unknown): string | null {
  if (value === null) return null;
  return snapshotIdentifier(value);
}

function snapshotTimestamp(value: unknown): string {
  const timestamp = snapshotString(value);
  if (
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    repositoryFailure("corrupt");
  }
  return timestamp;
}

function snapshotNullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  return snapshotTimestamp(value);
}

function snapshotStatus<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) repositoryFailure("corrupt");
  return value as T;
}

function snapshotBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    repositoryFailure("corrupt");
  }
  return new Uint8Array(value);
}

function snapshotScopes(value: unknown): readonly TenantApiKeyScope[] {
  if (!Array.isArray(value)) repositoryFailure("corrupt");
  const scopes = normalizeStoredTenantApiKeyScopes(value);
  if (scopes === null || JSON.stringify(scopes) !== JSON.stringify(value)) {
    repositoryFailure("corrupt");
  }
  return scopes;
}

function snapshotEntityKind(action: string): SnapshotEntityKind {
  switch (action) {
    case "tenant.create":
    case "tenant.status":
      return "tenant";
    case "client.status":
      return "client";
    case "credential.issue":
    case "credential.rotate":
    case "credential.revoke":
    case "credential.delivery_acknowledge":
      return "credential";
    default:
      repositoryFailure("corrupt");
  }
}

function expectedEventActions(action: string): readonly string[] {
  switch (action) {
    case "tenant.create":
      return ["tenant.created"];
    case "tenant.status":
      return ["tenant.active", "tenant.suspended"];
    case "client.status":
      return ["client.active", "client.disabled"];
    case "credential.issue":
      return ["credential.issued"];
    case "credential.rotate":
      return ["credential.rotated"];
    case "credential.revoke":
      return ["credential.revoked"];
    case "credential.delivery_acknowledge":
      return ["credential.delivery_acknowledged"];
    default:
      repositoryFailure("corrupt");
  }
}

function snapshotTenant(value: unknown): TenantRecord {
  const entity = exactSnapshotObject(value, [
    "tenantId", "displayName", "status", "createdAt", "updatedAt",
  ]);
  return Object.freeze({
    tenantId: snapshotIdentifier(entity.tenantId),
    displayName: snapshotString(entity.displayName),
    status: snapshotStatus(entity.status, ["active", "suspended"] as const),
    createdAt: snapshotTimestamp(entity.createdAt),
    updatedAt: snapshotTimestamp(entity.updatedAt),
  });
}

function snapshotClient(value: unknown): ClientRecord {
  const entity = exactSnapshotObject(value, [
    "clientId", "tenantId", "label", "status", "createdAt", "updatedAt",
  ]);
  return Object.freeze({
    clientId: snapshotIdentifier(entity.clientId),
    tenantId: snapshotIdentifier(entity.tenantId),
    label: snapshotString(entity.label),
    status: snapshotStatus(entity.status, ["active", "disabled"] as const),
    createdAt: snapshotTimestamp(entity.createdAt),
    updatedAt: snapshotTimestamp(entity.updatedAt),
  });
}

function snapshotCredential(value: unknown): StoredCredentialRecord {
  const entity = exactSnapshotObject(value, [
    "credentialId", "tenantId", "clientId", "label", "actorRole", "roles", "scopes",
    "status", "keyPrefix", "secretLastFour", "secretSalt", "secretHash", "pepperVersion",
    "createdAt", "expiresAt", "lastUsedAt", "revokedAt", "rotatedFromId",
  ]);
  const roles = entity.roles;
  if (!Array.isArray(roles) || JSON.stringify(roles) !== '["service"]') {
    repositoryFailure("corrupt");
  }
  const secretLastFour = snapshotString(entity.secretLastFour);
  if (!/^[A-Za-z0-9_-]{4}$/u.test(secretLastFour)) repositoryFailure("corrupt");
  const keyPrefix = snapshotString(entity.keyPrefix);
  if (!/^lmcpk_[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(keyPrefix)) {
    repositoryFailure("corrupt");
  }
  const expiresAt = entity.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 1) {
    repositoryFailure("corrupt");
  }
  return Object.freeze({
    credentialId: snapshotIdentifier(entity.credentialId),
    tenantId: snapshotIdentifier(entity.tenantId),
    clientId: snapshotIdentifier(entity.clientId),
    label: snapshotString(entity.label),
    actorRole: snapshotStatus(entity.actorRole, ["service"] as const),
    roles: Object.freeze(["service"] as const),
    scopes: snapshotScopes(entity.scopes),
    status: snapshotStatus(entity.status, ["active", "revoked"] as const),
    keyPrefix,
    secretLastFour,
    secretSalt: snapshotBytes(entity.secretSalt),
    secretHash: snapshotBytes(entity.secretHash),
    pepperVersion: (() => {
      const pepperVersion = snapshotString(entity.pepperVersion);
      if (!isPepperVersion(pepperVersion)) repositoryFailure("corrupt");
      return pepperVersion;
    })(),
    createdAt: snapshotTimestamp(entity.createdAt),
    expiresAt,
    lastUsedAt: snapshotNullableTimestamp(entity.lastUsedAt),
    revokedAt: snapshotNullableTimestamp(entity.revokedAt),
    rotatedFromId: snapshotNullableIdentifier(entity.rotatedFromId),
  });
}

function snapshotOperation(
  value: unknown,
  action: string,
  resultId: string,
  createdAt: string,
): TenantAccessEventRecord {
  const operation = exactSnapshotObject(value, [
    "eventId", "tenantId", "clientId", "credentialId", "actorRef", "action",
    "reasonCode", "createdAt",
  ]);
  const operationAction = snapshotString(operation.action);
  if (!expectedEventActions(action).includes(operationAction)) repositoryFailure("corrupt");
  const normalized = Object.freeze({
    eventId: snapshotIdentifier(operation.eventId),
    tenantId: snapshotIdentifier(operation.tenantId),
    clientId: snapshotNullableIdentifier(operation.clientId),
    credentialId: snapshotNullableIdentifier(operation.credentialId),
    actorRef: snapshotIdentifier(operation.actorRef),
    action: operationAction,
    reasonCode: snapshotIdentifier(operation.reasonCode),
    createdAt: snapshotTimestamp(operation.createdAt),
  });
  if (normalized.createdAt !== createdAt) repositoryFailure("corrupt");
  if (action === "tenant.create" || action === "tenant.status") {
    if (normalized.clientId !== null || normalized.credentialId !== null) {
      repositoryFailure("corrupt");
    }
  } else if (action === "client.status") {
    if (normalized.clientId !== resultId || normalized.credentialId !== null) {
      repositoryFailure("corrupt");
    }
  } else if (normalized.credentialId !== resultId || normalized.clientId === null) {
    repositoryFailure("corrupt");
  }
  return normalized;
}

function snapshotMetadata(value: unknown): ResultSnapshotMetadata {
  const metadata = exactSnapshotObject(value, [
    "tenantStatus", "clientStatus", "deliveryAcknowledgedAt",
  ]);
  return Object.freeze({
    tenantStatus: metadata.tenantStatus === null
      ? null
      : snapshotStatus(metadata.tenantStatus, ["active", "suspended"] as const),
    clientStatus: metadata.clientStatus === null
      ? null
      : snapshotStatus(metadata.clientStatus, ["active", "disabled"] as const),
    deliveryAcknowledgedAt: snapshotNullableTimestamp(metadata.deliveryAcknowledgedAt),
  });
}

function snapshotPayload(
  value: unknown,
  action: string,
  resultId: string,
  createdAt: string,
): {
  readonly value: TenantRecord | ClientRecord | StoredCredentialRecord;
  readonly operation: TenantAccessEventRecord;
  readonly snapshot: ResultSnapshotMetadata;
} {
  const payload = exactSnapshotObject(value, [
    "snapshot_format", "entity_kind", "entity", "operation", "snapshot",
  ]) as unknown as ResultSnapshotPayload;
  if (payload.snapshot_format !== RESULT_SNAPSHOT_FORMAT) repositoryFailure("corrupt");
  const entityKind = payload.entity_kind;
  if (entityKind !== snapshotEntityKind(action)) repositoryFailure("corrupt");
  const normalizedOperation = snapshotOperation(payload.operation, action, resultId, createdAt);
  const normalizedSnapshot = snapshotMetadata(payload.snapshot);
  const normalizedValue = entityKind === "tenant"
    ? snapshotTenant(payload.entity)
    : entityKind === "client"
      ? snapshotClient(payload.entity)
      : snapshotCredential(payload.entity);
  const normalizedEntityId = entityKind === "tenant"
    ? normalizedValue.tenantId
    : entityKind === "client"
      ? (normalizedValue as ClientRecord).clientId
      : (normalizedValue as StoredCredentialRecord).credentialId;
  if (normalizedEntityId !== resultId || normalizedOperation.tenantId !== normalizedValue.tenantId) {
    repositoryFailure("corrupt");
  }
  if (entityKind === "tenant") {
    if (
      normalizedOperation.clientId !== null ||
      normalizedOperation.credentialId !== null ||
      normalizedSnapshot.tenantStatus !== (normalizedValue as TenantRecord).status ||
      normalizedSnapshot.clientStatus !== null ||
      normalizedSnapshot.deliveryAcknowledgedAt !== null
    ) repositoryFailure("corrupt");
  } else if (entityKind === "client") {
    const client = normalizedValue as ClientRecord;
    if (
      normalizedOperation.clientId !== client.clientId ||
      normalizedOperation.credentialId !== null ||
      normalizedSnapshot.tenantStatus === null ||
      normalizedSnapshot.clientStatus !== client.status ||
      normalizedSnapshot.deliveryAcknowledgedAt !== null
    ) repositoryFailure("corrupt");
  } else {
    const credential = normalizedValue as StoredCredentialRecord;
    if (
      normalizedOperation.clientId !== credential.clientId ||
      normalizedOperation.credentialId !== credential.credentialId ||
      normalizedSnapshot.tenantStatus === null ||
      normalizedSnapshot.clientStatus === null
    ) repositoryFailure("corrupt");
    if (action === "credential.delivery_acknowledge") {
      if (normalizedSnapshot.deliveryAcknowledgedAt !== normalizedOperation.createdAt) {
        repositoryFailure("corrupt");
      }
    } else if (action === "credential.issue" || action === "credential.rotate") {
      if (normalizedSnapshot.deliveryAcknowledgedAt !== null) repositoryFailure("corrupt");
    }
  }
  return {
    value: normalizedValue,
    operation: normalizedOperation,
    snapshot: normalizedSnapshot,
  };
}

function snapshotReviver(_key: string, value: unknown): unknown {
  if (!isPlainSnapshotObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== SNAPSHOT_BYTES_KEY) return value;
  const encoded = value[SNAPSHOT_BYTES_KEY];
  if (typeof encoded !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    return value;
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return value;
  return new Uint8Array(bytes);
}

function snapshotReplacer(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array
    ? { [SNAPSHOT_BYTES_KEY]: Buffer.from(value).toString("base64") }
    : value;
}

function decodeResultSnapshot<T>(
  json: string,
  action: string,
  resultId: string,
  createdAt: string,
): {
  readonly value: T;
  readonly operation: TenantAccessEventRecord;
  readonly snapshot: ResultSnapshotMetadata;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json, snapshotReviver) as unknown;
  } catch {
    repositoryFailure("corrupt");
  }
  const normalized = snapshotPayload(parsed, action, resultId, createdAt);
  return {
    value: normalized.value as T,
    operation: normalized.operation,
    snapshot: normalized.snapshot,
  };
}

function serializeResultSnapshot<T>(
  action: string,
  resultId: string,
  createdAt: string,
  value: T,
  operation: TenantAccessEventRecord,
  snapshot: ResultSnapshotMetadata,
): string {
  const payload = {
    snapshot_format: RESULT_SNAPSHOT_FORMAT,
    entity_kind: snapshotEntityKind(action),
    entity: value,
    operation,
    snapshot,
  } satisfies ResultSnapshotPayload;
  const json = JSON.stringify(payload, snapshotReplacer);
  if (json === undefined) repositoryFailure("corrupt");
  decodeResultSnapshot<T>(json, action, resultId, createdAt);
  return json;
}

function tenantFromRow(row: SqlRow): TenantRecord {
  const status = expectText(row, "status");
  if (status !== "active" && status !== "suspended") repositoryFailure("corrupt");
  return Object.freeze({
    tenantId: expectText(row, "tenant_id"),
    displayName: expectText(row, "display_name"),
    status,
    createdAt: expectText(row, "created_at"),
    updatedAt: expectText(row, "updated_at"),
  });
}

function clientFromRow(row: SqlRow): ClientRecord {
  const status = expectText(row, "status");
  if (status !== "active" && status !== "disabled") repositoryFailure("corrupt");
  return Object.freeze({
    clientId: expectText(row, "client_id"),
    tenantId: expectText(row, "tenant_id"),
    label: expectText(row, "label"),
    status,
    createdAt: expectText(row, "created_at"),
    updatedAt: expectText(row, "updated_at"),
  });
}

function parseScopes(value: string): readonly TenantApiKeyScope[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) repositoryFailure("corrupt");
    const scopes = normalizeStoredTenantApiKeyScopes(parsed);
    if (scopes === null) repositoryFailure("corrupt");
    return scopes;
  } catch (error) {
    if (error instanceof TenantAccessRepositoryError) throw error;
    repositoryFailure("corrupt");
  }
}

function credentialFromRow(row: SqlRow): StoredCredentialRecord {
  const status = expectText(row, "status");
  if (status !== "active" && status !== "revoked") repositoryFailure("corrupt");
  if (expectText(row, "actor_role") !== "service") repositoryFailure("corrupt");
  if (expectText(row, "roles_json") !== '["service"]') repositoryFailure("corrupt");
  const pepperVersion = expectText(row, "pepper_version");
  if (!isPepperVersion(pepperVersion)) repositoryFailure("corrupt");
  return Object.freeze({
    credentialId: expectText(row, "credential_id"),
    tenantId: expectText(row, "tenant_id"),
    clientId: expectText(row, "client_id"),
    label: expectText(row, "label"),
    actorRole: "service",
    roles: Object.freeze(["service"] as const),
    scopes: parseScopes(expectText(row, "scopes_json")),
    status,
    keyPrefix: expectText(row, "key_prefix"),
    secretLastFour: expectText(row, "secret_last_four"),
    secretSalt: expectBytes(row, "secret_salt"),
    secretHash: expectBytes(row, "secret_hash"),
    pepperVersion,
    createdAt: expectText(row, "created_at"),
    expiresAt: expectInteger(row, "expires_at"),
    lastUsedAt: expectNullableText(row, "last_used_at"),
    revokedAt: expectNullableText(row, "revoked_at"),
    rotatedFromId: expectNullableText(row, "rotated_from_id"),
  });
}

function eventFromRow(row: SqlRow): TenantAccessEventRecord {
  return Object.freeze({
    eventId: expectText(row, "event_id"),
    tenantId: expectText(row, "tenant_id"),
    clientId: expectNullableText(row, "client_id"),
    credentialId: expectNullableText(row, "credential_id"),
    actorRef: expectText(row, "actor_ref"),
    action: expectText(row, "action"),
    reasonCode: expectText(row, "reason_code"),
    createdAt: expectText(row, "created_at"),
  });
}

function insertEvent(database: DatabaseSync, event: TenantAccessEventRecord): void {
  database.prepare(`
    INSERT INTO access_events (
      event_id, tenant_id, client_id, credential_id, actor_ref, action, reason_code, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.eventId,
    event.tenantId,
    event.clientId,
    event.credentialId,
    event.actorRef,
    event.action,
    event.reasonCode,
    event.createdAt,
  );
}

function insertCredential(database: DatabaseSync, value: StoredCredentialRecord): void {
  database.prepare(`
    INSERT INTO credentials (
      credential_id, tenant_id, client_id, label, actor_role, roles_json,
      scopes_json, status, key_prefix, secret_last_four, secret_salt,
      secret_hash, created_at, expires_at, last_used_at, revoked_at,
      rotated_from_id, pepper_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.credentialId,
    value.tenantId,
    value.clientId,
    value.label,
    value.actorRole,
    JSON.stringify(value.roles),
    JSON.stringify(value.scopes),
    value.status,
    value.keyPrefix,
    value.secretLastFour,
    value.secretSalt,
    value.secretHash,
    value.createdAt,
    value.expiresAt,
    value.lastUsedAt,
    value.revokedAt,
    value.rotatedFromId,
    value.pepperVersion,
  );
}

export function initializeSqliteTenantAccessState(
  rawOptions: TenantAccessStoreOptions,
): Promise<void> {
  const options = validateOptions(rawOptions);
  const root = normalizedRoot(options.applicationRoot);
  const paths = tenantAccessPaths(root);
  try {
    mkdirSync(paths.runtimeDir, { recursive: false, mode: DIRECTORY_MODE });
  } catch {
    // The runtime directory may already be owned by another explicit store.
  }
  assertEntry(paths.runtimeDir, "directory", DIRECTORY_MODE, "state_missing");
  try {
    lstatSync(paths.stateDir);
    throw new TenantAccessError("state_exists");
  } catch (error) {
    if (error instanceof TenantAccessError) throw error;
  }

  const stagingDir = mkdtempSync(join(paths.runtimeDir, ".mcp-tenant-access-staging-"));
  chmodSync(stagingDir, DIRECTORY_MODE);
  const stagingDatabase = join(stagingDir, "access.sqlite");
  const stagingMarker = join(stagingDir, "access-identity.json");
  const marker = markerFor(root, paths, options);
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
      INSERT INTO access_meta (
        singleton, schema_version, access_store_id, instance_id, management_tenant_id
      ) VALUES (1, ?, ?, ?, ?)
    `).run(
      DATABASE_SCHEMA_VERSION,
      marker.access_store_id,
      options.instanceId,
      options.managementTenantId,
    );
    const quickCheck = database.prepare("PRAGMA quick_check").get() as SqlRow | undefined;
    if (quickCheck === undefined || Object.values(quickCheck)[0] !== "ok") {
      throw new TenantAccessError("schema_mismatch");
    }
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
    if (error instanceof TenantAccessError) throw error;
    throw new TenantAccessError("database_open_failed", { cause: error });
  }
  return Promise.resolve();
}

export class SqliteTenantAccessStore implements TenantAccessRepository {
  readonly managementTenantId: string;
  readonly #database: DatabaseSync;
  readonly #legacyCredentialPepperVersion: string | undefined;
  #marker: Marker;
  readonly #paths: TenantAccessStorePaths;
  #closed = false;

  constructor(rawOptions: TenantAccessStoreOptions) {
    const options = validateOptions(rawOptions);
    const root = normalizedRoot(options.applicationRoot);
    this.#paths = tenantAccessPaths(root);
    this.managementTenantId = options.managementTenantId;
    this.#legacyCredentialPepperVersion = options.legacyCredentialPepperVersion;
    assertEntry(this.#paths.stateDir, "directory", DIRECTORY_MODE, "state_missing");
    assertEntry(this.#paths.databasePath, "file", DATABASE_MODE, "database_open_failed");
    assertEntry(this.#paths.markerPath, "file", MARKER_MODE, "database_open_failed");
    this.#marker = readMarker(this.#paths.markerPath);
    if (
      this.#marker.application_root !== root ||
      this.#marker.database_path !== this.#paths.databasePath ||
      this.#marker.instance_id !== options.instanceId ||
      this.#marker.management_tenant_id !== options.managementTenantId
    ) {
      throw new TenantAccessError("identity_mismatch");
    }
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.#paths.databasePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
      });
      this.#database = database;
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec("PRAGMA journal_mode = WAL");
      this.#database.exec("PRAGMA synchronous = FULL");
      this.#database.exec("PRAGMA trusted_schema = OFF");
      this.#migrateDatabaseIfRequired();
      this.#verifyDatabase();
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the stable initialization or migration error.
      }
      if (error instanceof TenantAccessError) throw error;
      throw new TenantAccessError("database_open_failed", { cause: error });
    }
  }

  #activeDatabase(): DatabaseSync {
    if (this.#closed) repositoryFailure("closed");
    return this.#database;
  }

  #migrateDatabaseIfRequired(): void {
    const row = this.#database.prepare(`
      SELECT schema_version, access_store_id, instance_id, management_tenant_id
      FROM access_meta WHERE singleton = 1
    `).get() as SqlRow | undefined;
    if (
      row === undefined ||
      row.access_store_id !== this.#marker.access_store_id ||
      row.instance_id !== this.#marker.instance_id ||
      row.management_tenant_id !== this.#marker.management_tenant_id
    ) {
      throw new TenantAccessError("schema_mismatch");
    }
    let databaseVersion = row.schema_version;
    if (
      databaseVersion !== LEGACY_DATABASE_SCHEMA_VERSION &&
      databaseVersion !== CLIENT_DATABASE_SCHEMA_VERSION &&
      databaseVersion !== PEPPER_DATABASE_SCHEMA_VERSION &&
      databaseVersion !== DATABASE_SCHEMA_VERSION
    ) {
      throw new TenantAccessError("schema_mismatch");
    }
    if (this.#marker.schema_version > databaseVersion) {
      throw new TenantAccessError("schema_mismatch");
    }
    if (
      (databaseVersion === LEGACY_DATABASE_SCHEMA_VERSION ||
        databaseVersion === CLIENT_DATABASE_SCHEMA_VERSION) &&
      this.#legacyCredentialPepperVersion === undefined
    ) {
      throw new TenantAccessError("invalid_options");
    }
    if (databaseVersion === LEGACY_DATABASE_SCHEMA_VERSION) {
      const legacyTables = (this.#database.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
      `).all() as SqlRow[]).map((value) => expectText(value, "name"));
      if (JSON.stringify(legacyTables) !== JSON.stringify([
        "access_events",
        "access_idempotency",
        "access_meta",
        "credentials",
        "tenants",
      ])) {
        throw new TenantAccessError("schema_mismatch");
      }
      this.#database.exec("BEGIN IMMEDIATE");
      try {
          this.#database.exec(`
          CREATE TABLE clients (
            tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
            client_id TEXT NOT NULL,
            label TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, client_id)
          ) STRICT;
          CREATE INDEX clients_tenant_status_idx
            ON clients(tenant_id, status, client_id);
          INSERT INTO clients (
            tenant_id, client_id, label, status, created_at, updated_at
          )
          SELECT
            credential.tenant_id,
            credential.client_id,
            (
              SELECT first_credential.label
              FROM credentials AS first_credential
              WHERE first_credential.tenant_id = credential.tenant_id
                AND first_credential.client_id = credential.client_id
              ORDER BY first_credential.created_at, first_credential.credential_id
              LIMIT 1
            ),
            'active',
            MIN(credential.created_at),
            MAX(COALESCE(credential.last_used_at, credential.created_at))
          FROM credentials AS credential
          GROUP BY credential.tenant_id, credential.client_id;
          ALTER TABLE access_events ADD COLUMN client_id TEXT;
          UPDATE access_events
          SET client_id = (
            SELECT credentials.client_id
            FROM credentials
            WHERE credentials.credential_id = access_events.credential_id
          )
          WHERE credential_id IS NOT NULL;
          UPDATE access_meta SET schema_version = 2 WHERE singleton = 1;
        `);
        this.#database.exec("COMMIT");
      } catch (error) {
        try {
          this.#database.exec("ROLLBACK");
        } catch {
          // Preserve the migration error.
        }
        throw error;
      }
      databaseVersion = CLIENT_DATABASE_SCHEMA_VERSION;
    }
    if (databaseVersion === CLIENT_DATABASE_SCHEMA_VERSION) {
      const pepperVersion = this.#legacyCredentialPepperVersion;
      if (pepperVersion === undefined) throw new TenantAccessError("invalid_options");
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(`
          ALTER TABLE credentials ADD COLUMN pepper_version TEXT NOT NULL
            DEFAULT '${pepperVersion}' CHECK (length(pepper_version) BETWEEN 8 AND 128);
          UPDATE access_meta SET schema_version = 3 WHERE singleton = 1;
        `);
        this.#database.exec("COMMIT");
      } catch (error) {
        try {
          this.#database.exec("ROLLBACK");
        } catch {
          // Preserve the migration error.
        }
        throw error;
      }
      databaseVersion = PEPPER_DATABASE_SCHEMA_VERSION;
    }
    if (databaseVersion === PEPPER_DATABASE_SCHEMA_VERSION) {
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(`
          ALTER TABLE access_idempotency ADD COLUMN result_json TEXT;
          UPDATE access_meta SET schema_version = 4 WHERE singleton = 1;
        `);
        this.#database.exec("COMMIT");
      } catch (error) {
        try {
          this.#database.exec("ROLLBACK");
        } catch {
          // Preserve the migration error.
        }
        throw error;
      }
    }
    if (this.#marker.schema_version !== DATABASE_SCHEMA_VERSION) {
      const nextMarker: Marker = Object.freeze({
        ...this.#marker,
        schema_version: DATABASE_SCHEMA_VERSION,
      });
      writeMarker(this.#paths.markerPath, nextMarker);
      this.#marker = nextMarker;
    }
  }

  #verifyDatabase(): void {
    const row = this.#database.prepare(`
      SELECT schema_version, access_store_id, instance_id, management_tenant_id
      FROM access_meta WHERE singleton = 1
    `).get() as SqlRow | undefined;
    if (
      row === undefined ||
      row.schema_version !== DATABASE_SCHEMA_VERSION ||
      row.access_store_id !== this.#marker.access_store_id ||
      row.instance_id !== this.#marker.instance_id ||
      row.management_tenant_id !== this.#marker.management_tenant_id
    ) {
      throw new TenantAccessError("schema_mismatch");
    }
    const requiredTables = [
      "access_events",
      "access_idempotency",
      "access_meta",
      "clients",
      "credentials",
      "tenants",
    ];
    const rows = this.#database.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
    `).all() as SqlRow[];
    const observed = rows.map((value) => expectText(value, "name"));
    if (JSON.stringify(observed) !== JSON.stringify(requiredTables)) {
      throw new TenantAccessError("schema_mismatch");
    }
    const clientColumns = (this.#database.prepare("PRAGMA table_info(clients)").all() as SqlRow[])
      .map((value) => expectText(value, "name"));
    const eventColumns = (this.#database.prepare("PRAGMA table_info(access_events)").all() as SqlRow[])
      .map((value) => expectText(value, "name"));
    const credentialColumns = (this.#database.prepare("PRAGMA table_info(credentials)").all() as SqlRow[])
      .map((value) => expectText(value, "name"));
    const idempotencyColumns = (this.#database.prepare("PRAGMA table_info(access_idempotency)").all() as SqlRow[])
      .map((value) => expectText(value, "name"));
    if (
      JSON.stringify(clientColumns) !== JSON.stringify([
        "tenant_id", "client_id", "label", "status", "created_at", "updated_at",
      ]) ||
      JSON.stringify(eventColumns) !== JSON.stringify([
        "event_id", "tenant_id", "credential_id", "actor_ref", "action", "reason_code",
        "created_at", "client_id",
      ]) ||
      JSON.stringify(credentialColumns) !== JSON.stringify([
        "credential_id", "tenant_id", "client_id", "label", "actor_role", "roles_json",
        "scopes_json", "status", "key_prefix", "secret_last_four", "secret_salt",
        "secret_hash", "created_at", "expires_at", "last_used_at", "revoked_at",
        "rotated_from_id", "pepper_version",
      ]) ||
      JSON.stringify(idempotencyColumns) !== JSON.stringify([
        "action", "idempotency_key", "request_hash", "result_id", "created_at", "result_json",
      ])
    ) {
      throw new TenantAccessError("schema_mismatch");
    }
  }

  #transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.#activeDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation(database);
      database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Keep the domain error from the failed operation.
      }
      throw error;
    }
  }

  #idempotent<T>(
    database: DatabaseSync,
    action: string,
    idempotencyKey: string,
    requestHash: string,
    createdAt: string,
    write: () => IdempotentWriteResult<T>,
  ): TenantAccessWriteResult<T> {
    const existing = database.prepare(`
      SELECT request_hash, result_id, created_at, result_json FROM access_idempotency
      WHERE action = ? AND idempotency_key = ?
    `).get(action, idempotencyKey) as SqlRow | undefined;
    if (existing !== undefined) {
      if (expectText(existing, "request_hash") !== requestHash) {
        repositoryFailure("idempotency_conflict");
      }
      const resultId = expectText(existing, "result_id");
      const createdAt = expectText(existing, "created_at");
      const loaded = decodeResultSnapshot<T>(
        expectText(existing, "result_json"),
        action,
        resultId,
        createdAt,
      );
      return Object.freeze({
        replayed: true,
        value: loaded.value,
        operation: loaded.operation,
        snapshot: loaded.snapshot,
      });
    }
    const result = write();
    const resultJson = serializeResultSnapshot(
      action,
      result.resultId,
      createdAt,
      result.value,
      result.operation,
      result.snapshot,
    );
    database.prepare(`
      INSERT INTO access_idempotency (
        action, idempotency_key, request_hash, result_id, created_at, result_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(action, idempotencyKey, requestHash, result.resultId, createdAt, resultJson);
    return Object.freeze({
      replayed: false,
      value: result.value,
      operation: result.operation,
      snapshot: result.snapshot,
    });
  }

  #tenant(database: DatabaseSync, tenantId: string): TenantRecord {
    const row = database.prepare("SELECT * FROM tenants WHERE tenant_id = ?")
      .get(tenantId) as SqlRow | undefined;
    if (row === undefined) repositoryFailure("tenant_not_found");
    return tenantFromRow(row);
  }

  #credential(database: DatabaseSync, credentialId: string): StoredCredentialRecord {
    const row = database.prepare("SELECT * FROM credentials WHERE credential_id = ?")
      .get(credentialId) as SqlRow | undefined;
    if (row === undefined) repositoryFailure("credential_not_found");
    return credentialFromRow(row);
  }

  #client(database: DatabaseSync, tenantId: string, clientId: string): ClientRecord {
    const row = database.prepare(`
      SELECT * FROM clients WHERE tenant_id = ? AND client_id = ?
    `).get(tenantId, clientId) as SqlRow | undefined;
    if (row === undefined) repositoryFailure("client_not_found");
    return clientFromRow(row);
  }

  #deliveryAcknowledgedAt(database: DatabaseSync, credentialId: string): string | null {
    const row = database.prepare(`
      SELECT created_at FROM access_events
      WHERE credential_id = ? AND action = 'credential.delivery_acknowledged'
      ORDER BY created_at DESC, event_id DESC LIMIT 1
    `).get(credentialId) as SqlRow | undefined;
    return row === undefined ? null : expectText(row, "created_at");
  }

  getState(): Promise<TenantAccessStateRecord> {
    const database = this.#activeDatabase();
    const tenants = (database.prepare("SELECT * FROM tenants ORDER BY tenant_id").all() as SqlRow[])
      .map(tenantFromRow);
    const clients = (database.prepare(`
      SELECT * FROM clients ORDER BY tenant_id, client_id
    `).all() as SqlRow[]).map(clientFromRow);
    const credentials = (database.prepare(`
      SELECT * FROM credentials ORDER BY created_at DESC, credential_id DESC
    `).all() as SqlRow[]).map(credentialFromRow);
    const events = (database.prepare(`
      SELECT * FROM access_events ORDER BY created_at DESC, event_id DESC LIMIT 256
    `).all() as SqlRow[]).map(eventFromRow);
    const acknowledgementRows = database.prepare(`
      SELECT credential_id, MAX(created_at) AS acknowledged_at
      FROM access_events
      WHERE action = 'credential.delivery_acknowledged'
        AND credential_id IS NOT NULL
      GROUP BY credential_id
      ORDER BY credential_id
    `).all() as SqlRow[];
    const deliveryAcknowledgements = Object.freeze(Object.fromEntries(
      acknowledgementRows.map((row) => [
        expectText(row, "credential_id"),
        expectText(row, "acknowledged_at"),
      ]),
    ));
    return Promise.resolve(Object.freeze({
      tenants: Object.freeze(tenants),
      clients: Object.freeze(clients),
      credentials: Object.freeze(credentials),
      events: Object.freeze(events),
      deliveryAcknowledgements,
    }));
  }

  createTenant(request: {
    readonly tenant: TenantRecord;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<TenantRecord>> {
    return Promise.resolve(this.#transaction((database) => this.#idempotent(
      database,
      "tenant.create",
      request.idempotencyKey,
      request.requestHash,
      request.tenant.createdAt,
      () => {
        const exists = database.prepare("SELECT 1 AS present FROM tenants WHERE tenant_id = ?")
          .get(request.tenant.tenantId);
        if (exists !== undefined) repositoryFailure("tenant_already_exists");
        database.prepare(`
          INSERT INTO tenants (tenant_id, display_name, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          request.tenant.tenantId,
          request.tenant.displayName,
          request.tenant.status,
          request.tenant.createdAt,
          request.tenant.updatedAt,
        );
        insertEvent(database, request.event);
        return {
          resultId: request.tenant.tenantId,
          value: request.tenant,
          operation: request.event,
          snapshot: makeSnapshotMetadata(request.tenant.status, null, null),
        };
      },
    )));
  }

  setTenantStatus(request: {
    readonly tenantId: string;
    readonly status: TenantStatus;
    readonly updatedAt: string;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<TenantRecord>> {
    return Promise.resolve(this.#transaction((database) => this.#idempotent(
      database,
      "tenant.status",
      request.idempotencyKey,
      request.requestHash,
      request.updatedAt,
      () => {
        const tenant = this.#tenant(database, request.tenantId);
        if (tenant.status === request.status) repositoryFailure("tenant_status_unchanged");
        database.prepare("UPDATE tenants SET status = ?, updated_at = ? WHERE tenant_id = ?")
          .run(request.status, request.updatedAt, request.tenantId);
        insertEvent(database, request.event);
        return {
          resultId: request.tenantId,
          value: this.#tenant(database, request.tenantId),
          operation: request.event,
          snapshot: makeSnapshotMetadata(request.status, null, null),
        };
      },
    )));
  }

  setClientStatus(request: {
    readonly tenantId: string;
    readonly clientId: string;
    readonly status: ClientStatus;
    readonly updatedAt: string;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<ClientRecord>> {
    return Promise.resolve(this.#transaction((database) => this.#idempotent(
      database,
      "client.status",
      request.idempotencyKey,
      request.requestHash,
      request.updatedAt,
      () => {
        const tenant = this.#tenant(database, request.tenantId);
        if (request.status === "active" && tenant.status !== "active") {
          repositoryFailure("tenant_not_active");
        }
        const client = this.#client(database, request.tenantId, request.clientId);
        if (client.status === request.status) repositoryFailure("client_status_unchanged");
        database.prepare(`
          UPDATE clients SET status = ?, updated_at = ?
          WHERE tenant_id = ? AND client_id = ?
        `).run(request.status, request.updatedAt, request.tenantId, request.clientId);
        insertEvent(database, request.event);
        return {
          resultId: request.clientId,
          value: this.#client(database, request.tenantId, request.clientId),
          operation: request.event,
          snapshot: makeSnapshotMetadata(tenant.status, request.status, null),
        };
      },
    )));
  }

  issueCredential(request: {
    readonly credential: StoredCredentialRecord;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<StoredCredentialRecord>> {
    return Promise.resolve(this.#transaction((database) => this.#idempotent(
      database,
      "credential.issue",
      request.idempotencyKey,
      request.requestHash,
      request.credential.createdAt,
      () => {
        const tenant = this.#tenant(database, request.credential.tenantId);
        if (tenant.status !== "active") repositoryFailure("tenant_not_active");
        const clientRow = database.prepare(`
          SELECT * FROM clients WHERE tenant_id = ? AND client_id = ?
        `).get(request.credential.tenantId, request.credential.clientId) as SqlRow | undefined;
        if (clientRow === undefined) {
          database.prepare(`
            INSERT INTO clients (
              tenant_id, client_id, label, status, created_at, updated_at
            ) VALUES (?, ?, ?, 'active', ?, ?)
          `).run(
            request.credential.tenantId,
            request.credential.clientId,
            request.credential.label,
            request.credential.createdAt,
            request.credential.createdAt,
          );
          insertEvent(database, Object.freeze({
            eventId: `${request.event.eventId}_client_created`,
            tenantId: request.credential.tenantId,
            clientId: request.credential.clientId,
            credentialId: null,
            actorRef: request.event.actorRef,
            action: "client.created",
            reasonCode: "credential_issue_created_client",
            createdAt: request.credential.createdAt,
          }));
        } else if (clientFromRow(clientRow).status !== "active") {
          repositoryFailure("client_not_active");
        }
        insertCredential(database, request.credential);
        insertEvent(database, request.event);
        return {
          resultId: request.credential.credentialId,
          value: request.credential,
          operation: request.event,
          snapshot: makeSnapshotMetadata("active", "active", null),
        };
      },
    )));
  }

  rotateCredential(request: {
    readonly previousCredentialId: string;
    readonly credential: StoredCredentialRecord;
    readonly revokedAt: string;
    readonly nowSeconds: number;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<StoredCredentialRecord>> {
    return Promise.resolve(this.#transaction((database) => this.#idempotent(
      database,
      "credential.rotate",
      request.idempotencyKey,
      request.requestHash,
      request.credential.createdAt,
      () => {
        const previous = this.#credential(database, request.previousCredentialId);
        if (previous.status !== "active") repositoryFailure("credential_not_active");
        if (previous.expiresAt <= request.nowSeconds) repositoryFailure("credential_expired");
        if (this.#deliveryAcknowledgedAt(database, previous.credentialId) === null) {
          repositoryFailure("credential_delivery_pending");
        }
        const tenant = this.#tenant(database, previous.tenantId);
        if (tenant.status !== "active") repositoryFailure("tenant_not_active");
        const client = this.#client(database, previous.tenantId, previous.clientId);
        if (client.status !== "active") {
          repositoryFailure("client_not_active");
        }
        if (
          request.credential.tenantId !== previous.tenantId ||
          request.credential.clientId !== previous.clientId ||
          request.credential.rotatedFromId !== previous.credentialId
        ) {
          repositoryFailure("corrupt");
        }
        database.prepare(`
          UPDATE credentials SET status = 'revoked', revoked_at = ?
          WHERE credential_id = ?
        `).run(request.revokedAt, previous.credentialId);
        insertCredential(database, request.credential);
        insertEvent(database, request.event);
        return {
          resultId: request.credential.credentialId,
          value: request.credential,
          operation: request.event,
          snapshot: makeSnapshotMetadata(tenant.status, client.status, null),
        };
      },
    )));
  }

  revokeCredential(request: {
    readonly credentialId: string;
    readonly revokedAt: string;
    readonly nowSeconds: number;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<StoredCredentialRecord>> {
    return Promise.resolve(this.#transaction((database) => this.#idempotent(
      database,
      "credential.revoke",
      request.idempotencyKey,
      request.requestHash,
      request.revokedAt,
      () => {
        const credential = this.#credential(database, request.credentialId);
        if (credential.status !== "active") repositoryFailure("credential_not_active");
        if (credential.expiresAt <= request.nowSeconds) repositoryFailure("credential_expired");
        const tenant = this.#tenant(database, credential.tenantId);
        const client = this.#client(database, credential.tenantId, credential.clientId);
        const deliveryAcknowledgedAt = this.#deliveryAcknowledgedAt(
          database,
          credential.credentialId,
        );
        database.prepare(`
          UPDATE credentials SET status = 'revoked', revoked_at = ?
          WHERE credential_id = ?
        `).run(request.revokedAt, credential.credentialId);
        insertEvent(database, request.event);
        return {
          resultId: credential.credentialId,
          value: this.#credential(database, credential.credentialId),
          operation: request.event,
          snapshot: makeSnapshotMetadata(tenant.status, client.status, deliveryAcknowledgedAt),
        };
      },
    )));
  }

  acknowledgeCredentialDelivery(request: {
    readonly credentialId: string;
    readonly nowSeconds: number;
    readonly event: TenantAccessEventRecord;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<TenantAccessWriteResult<StoredCredentialRecord>> {
    return Promise.resolve(this.#transaction((database) => this.#idempotent(
      database,
      "credential.delivery_acknowledge",
      request.idempotencyKey,
      request.requestHash,
      request.event.createdAt,
      () => {
        const credential = this.#credential(database, request.credentialId);
        if (credential.status !== "active") repositoryFailure("credential_not_active");
        if (credential.expiresAt <= request.nowSeconds) repositoryFailure("credential_expired");
        if (this.#tenant(database, credential.tenantId).status !== "active") {
          repositoryFailure("tenant_not_active");
        }
        if (this.#client(database, credential.tenantId, credential.clientId).status !== "active") {
          repositoryFailure("client_not_active");
        }
        if (this.#deliveryAcknowledgedAt(database, credential.credentialId) !== null) {
          repositoryFailure("credential_delivery_acknowledged");
        }
        insertEvent(database, request.event);
        return {
          resultId: credential.credentialId,
          value: credential,
          operation: request.event,
          snapshot: makeSnapshotMetadata("active", "active", request.event.createdAt),
        };
      },
    )));
  }

  findCredentialForAuthentication(credentialId: string): Promise<{
    readonly tenant: TenantRecord;
    readonly client: ClientRecord;
    readonly credential: StoredCredentialRecord;
    readonly deliveryAcknowledgedAt: string | null;
  } | null> {
    const database = this.#activeDatabase();
    const row = database.prepare("SELECT * FROM credentials WHERE credential_id = ?")
      .get(credentialId) as SqlRow | undefined;
    if (row === undefined) return Promise.resolve(null);
    const credential = credentialFromRow(row);
    const tenantRow = database.prepare("SELECT * FROM tenants WHERE tenant_id = ?")
      .get(credential.tenantId) as SqlRow | undefined;
    if (tenantRow === undefined) repositoryFailure("corrupt");
    return Promise.resolve(Object.freeze({
      tenant: tenantFromRow(tenantRow),
      client: this.#client(database, credential.tenantId, credential.clientId),
      credential,
      deliveryAcknowledgedAt: this.#deliveryAcknowledgedAt(database, credential.credentialId),
    }));
  }

  markCredentialUsed(
    credentialId: string,
    usedAt: string,
    nowSeconds: number,
  ): Promise<boolean> {
    const database = this.#activeDatabase();
    const result = database.prepare(`
      UPDATE credentials SET last_used_at = ?
      WHERE credential_id = ?
        AND status = 'active'
        AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM access_events
          WHERE access_events.credential_id = credentials.credential_id
            AND access_events.action = 'credential.delivery_acknowledged'
        )
        AND EXISTS (
          SELECT 1 FROM tenants
          WHERE tenants.tenant_id = credentials.tenant_id
            AND tenants.status = 'active'
        )
        AND EXISTS (
          SELECT 1 FROM clients
          WHERE clients.tenant_id = credentials.tenant_id
            AND clients.client_id = credentials.client_id
            AND clients.status = 'active'
        )
    `).run(usedAt, credentialId, nowSeconds);
    return Promise.resolve(Number(result.changes) === 1);
  }

  health(): Promise<{ readonly ready: boolean }> {
    const database = this.#activeDatabase();
    const quickCheck = database.prepare("PRAGMA quick_check").get() as SqlRow | undefined;
    if (quickCheck === undefined || Object.values(quickCheck)[0] !== "ok") {
      return Promise.resolve(Object.freeze({ ready: false }));
    }
    this.#verifyDatabase();
    return Promise.resolve(Object.freeze({ ready: true }));
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    try {
      this.#database.close();
    } catch (error) {
      throw new TenantAccessError("closed", { cause: error });
    }
    return Promise.resolve();
  }
}
