import { randomBytes, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { types as nodeUtilTypes } from "node:util";
import { isAbsolute, join, normalize, parse, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Stats } from "node:fs";
import { controlEnvelopeSchema } from "./contracts";
import {
  assertControlEventInstantOrder,
  assertControlEventLifecycleCardinality,
  assertControlRequestBinding,
  assertModulePreviewAuthoritySemantics,
  assertReadbackAttemptObservation,
  assertReadbackAttemptRecord,
  createControlEventLifecycleCounts,
  deepFreezeControlRecord,
  deepFreezeReadbackAttempt,
  MODULE_CONTROL_ACTIONS,
  ModuleControlRepositoryError,
  resolveMonotonicControlEventOccurredAt,
} from "./repository";
import {
  compareRfc3339Instants as compareSharedRfc3339Instants,
  formatRfc3339InstantUtc,
  parseRfc3339Instant,
} from "./rfc3339-instant";
import {
  assertExactControlSchema,
  CONTROL_SCHEMA_FINGERPRINT,
  CONTROL_SCHEMA_STATEMENTS,
  fingerprintControlSchema,
  normalizeControlSchema,
} from "./readback-attempt-schema";
import type {
  ApprovalWriteResult,
  ControlEventLifecycleCounts,
  ControlEventRecord,
  ControlFinalResult,
  ControlIdempotencyRecord,
  ControlRecord,
  ControlRequestMetadata,
  DeepReadonly,
  CreatePreviewRecordRequest,
  DecideApprovalRecordRequest,
  GetControlIdempotencyQuery,
  GetModuleApprovalQuery,
  GetModulePreviewQuery,
  GetModuleReadbackQuery,
  GetModuleReleaseQuery,
  ModuleControlAction,
  ModuleControlReadbackAttemptRepository,
  ModuleControlRef,
  CompletedModuleControlIdempotencyRecord,
  ModuleApprovalRecord,
  ModuleChangePreviewRecord,
  ModuleControlRepository,
  ModuleControlState,
  ModuleReleaseHistoryEntry,
  ModuleRollbackPreviewRecord,
  ModulePreviewRecord,
  ModuleReadbackRecord,
  ModuleTerminalReadbackRecord,
  ModuleRegistrationRecord,
  ModuleReleaseRecord,
  PublishReleaseRecordRequest,
  RegistrationWriteResult,
  RegisterModuleRecordRequest,
  PreviewWriteResult,
  ReleaseWriteResult,
  ClaimReadbackAttemptRequest,
  FinalizeReadbackAndCompleteRequest,
  GetReadbackAttemptHistoryQuery,
  GetUnfinishedReadbackAttemptQuery,
  ReadbackAttemptClaimResult,
  ReadbackAttemptObservation,
  ReadbackAttemptRequestMetadata,
  ReadbackAttemptOwnerCapability,
  ReadbackAttemptRecord,
  ReadbackFinalizationResult,
} from "./repository";
import { IDENTIFIER_PATTERN } from "./lexical-contracts";

const DIRECTORY_MODE = 0o700;
const DATABASE_MODE = 0o600;
const MARKER_MODE = 0o400;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = fsConstants.O_DIRECTORY ?? 0;

const MARKER_FORMAT = "mcp-control-identity/v1" as const;
const SCHEMA_VERSION = 1 as const;
const CONTROL_STATE_RELEASE_HISTORY_WINDOW = 128 as const;
const CONTROL_STATE_EVENT_WINDOW = 256 as const;
const CONTROL_STATE_EVENT_QUERY_LIMIT = CONTROL_STATE_EVENT_WINDOW + 1;

assertExactControlSchema(CONTROL_SCHEMA_STATEMENTS);

export interface InitializeSqliteControlStateOptions {
  readonly applicationRoot: string;
  readonly instanceId: string;
  readonly managementTenantId: string;
}

const SQLITE_READBACK_FINALIZE_FAILPOINTS = Object.freeze([
  "after_reconciliation_event",
  "after_completion_event",
  "after_current_readback",
  "after_release",
  "after_attempt_finalized",
  "after_idempotency_completed",
  "before_health_check",
  "after_health_check",
] as const);

type SqliteReadbackFinalizeFailpoint =
  (typeof SQLITE_READBACK_FINALIZE_FAILPOINTS)[number];

const SQLITE_READBACK_RECOVERY_FINALIZE = Symbol(
  "sqlite-readback-recovery-finalize",
);
const SQLITE_READBACK_RECOVERY_SECRET = Symbol(
  "sqlite-readback-recovery-secret",
);
const SQLITE_RECOVERY_ACTOR_REF = "system_startup_recovery";

type SqliteReadbackRecoverySecret = {
  readonly [SQLITE_READBACK_RECOVERY_SECRET]: true;
};

type SqliteRecoveryFinalizeRequest = Omit<
  FinalizeReadbackAndCompleteRequest,
  "ownerCapability"
>;

export interface SqliteReadbackRecoveryDriver {
  finalizePriorBootAttempt(
    request: SqliteRecoveryFinalizeRequest,
  ): Promise<ReadbackFinalizationResult>;
}

export interface SqliteControlStoreWithRecovery {
  readonly repository: SqliteControlStore;
  readonly recoveryDriver: SqliteReadbackRecoveryDriver;
}

const SQLITE_READBACK_RECOVERY_SECRETS = new WeakSet<object>();

function isSqliteFinalizeClock(value: unknown): value is () => string {
  return typeof value === "function";
}

function isSqliteReadbackFinalizeFailpoint(
  value: unknown,
): value is SqliteReadbackFinalizeFailpoint {
  return SQLITE_READBACK_FINALIZE_FAILPOINTS.some((failpoint) => failpoint === value);
}

interface SqliteControlStoreTestOnlyOptions {
  readonly finalizeClock: () => string;
  readonly finalizeFailpoint: SqliteReadbackFinalizeFailpoint | null;
}

export interface OpenSqliteControlStoreOptions {
  readonly applicationRoot: string;
  readonly instanceId: string;
  readonly managementTenantId: string;
  readonly adminControlEnabled: boolean;
  /** Test-only fault/clock injection. It can fail a transaction, never bypass validation. */
  readonly testOnly?: SqliteControlStoreTestOnlyOptions;
}

export interface SqliteControlStore
  extends ModuleControlRepository,
    ModuleControlReadbackAttemptRepository {
  health(): Promise<{ readonly ready: boolean }>;
  close(): Promise<void>;
}

export type SqliteControlStoreErrorCode =
  | "invalid_options"
  | "invalid_application_root"
  | "admin_control_disabled"
  | "state_exists"
  | "state_missing"
  | "marker_missing"
  | "database_missing"
  | "database_open_failed"
  | "marker_invalid"
  | "identity_mismatch"
  | "permission_mismatch"
  | "schema_mismatch"
  | "quick_check_failed"
  | "sidecar_present"
  | "lock_conflict"
  | "initialization_failed"
  | "cleanup_failed"
  | "close_failed";

const ERROR_MESSAGES: Readonly<Record<SqliteControlStoreErrorCode, string>> = {
  invalid_options: "SQLite control store options are invalid.",
  invalid_application_root: "SQLite control store application root is invalid.",
  admin_control_disabled: "SQLite admin control is disabled.",
  state_exists: "SQLite control state already exists.",
  state_missing: "SQLite control state is missing.",
  marker_missing: "SQLite control identity marker is missing.",
  database_missing: "SQLite control database is missing.",
  database_open_failed: "SQLite control database could not be opened safely.",
  marker_invalid: "SQLite control identity marker is invalid.",
  identity_mismatch: "SQLite control identity does not match.",
  permission_mismatch: "SQLite control store permissions are invalid.",
  schema_mismatch: "SQLite control store schema is invalid.",
  quick_check_failed: "SQLite control store integrity check failed.",
  sidecar_present: "SQLite control database sidecar remains present.",
  lock_conflict: "SQLite control store lock is unavailable.",
  initialization_failed: "SQLite control store initialization failed.",
  cleanup_failed: "SQLite control store staging cleanup failed.",
  close_failed: "SQLite control store close failed.",
};

export class SqliteControlStoreError extends Error {
  readonly code: SqliteControlStoreErrorCode;

  constructor(code: SqliteControlStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SqliteControlStoreError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type Marker = {
  readonly control_db_id: string;
  readonly control_db_path: string;
  readonly instance_id: string;
  readonly management_tenant_id: string;
  readonly marker_format: typeof MARKER_FORMAT;
  readonly schema_version: typeof SCHEMA_VERSION;
};

type StorePaths = {
  readonly runtimeDir: string;
  readonly stateDir: string;
  readonly controlDbPath: string;
  readonly markerPath: string;
};

type InitializerLock = {
  readonly fileDescriptor: number;
  readonly path: string;
  readonly entry: Stats;
  readonly runtimeEntry: Stats;
};

type OpenStoreIdentity = {
  readonly applicationRoot: Stats;
  readonly runtimeDir: Stats;
  readonly stateDir: Stats;
  readonly marker: Stats;
  readonly database: Stats;
};

type VerifiedPathHandle = {
  readonly fileDescriptor: number;
  readonly path: string;
  readonly entry: Stats;
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly owner: number;
};

function throwStoreError(code: SqliteControlStoreErrorCode): never {
  throw new SqliteControlStoreError(code);
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return false;
  }

  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return false;
    }
  }
  return true;
}

function assertClosedOptions(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isPlainDataObject(value)) {
    throwStoreError("invalid_options");
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key)) ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throwStoreError("invalid_options");
  }
}

function assertIdentityValue(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    hasLoneSurrogate(value)
  ) {
    throwStoreError("invalid_options");
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function normalizedApplicationRoot(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    hasLoneSurrogate(value)
  ) {
    throwStoreError("invalid_application_root");
  }

  const applicationRoot = normalize(value);
  const parsed = parse(applicationRoot);
  let currentPath = parsed.root;
  const components = applicationRoot.slice(parsed.root.length).split(sep).filter(Boolean);

  for (const component of components) {
    currentPath = join(currentPath, component);
    let entry;
    try {
      entry = lstatSync(currentPath);
    } catch {
      throwStoreError("invalid_application_root");
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throwStoreError("invalid_application_root");
    }
  }

  try {
    const rootEntry = lstatSync(applicationRoot);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      throwStoreError("invalid_application_root");
    }
    if (realpathSync(applicationRoot) !== applicationRoot) {
      throwStoreError("invalid_application_root");
    }
  } catch (error) {
    if (error instanceof SqliteControlStoreError) {
      throw error;
    }
    throwStoreError("invalid_application_root");
  }

  return applicationRoot;
}

function deriveStorePaths(applicationRoot: string): StorePaths {
  const runtimeDir = join(applicationRoot, ".runtime");
  const stateDir = join(runtimeDir, "mcp-instance-state");
  return {
    runtimeDir,
    stateDir,
    controlDbPath: join(stateDir, "control.sqlite"),
    markerPath: join(stateDir, "control-identity.json"),
  };
}

function existingEntry(pathValue: string): Stats | null {
  try {
    return lstatSync(pathValue);
  } catch (error) {
    if (isMissingError(error)) {
      return null;
    }
    throwStoreError("initialization_failed");
  }
}

function sameEntryIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function verifiedDirectoryEntry(
  pathValue: string,
  code: SqliteControlStoreErrorCode,
  expected?: Stats,
  expectedMode?: number,
  expectedOwner?: number,
): Stats {
  let entry: Stats;
  let resolvedPath: string;
  try {
    entry = lstatSync(pathValue);
    resolvedPath = realpathSync(pathValue);
  } catch {
    throwStoreError(code);
  }
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    resolvedPath !== pathValue ||
    (expected !== undefined && !sameEntryIdentity(entry, expected)) ||
    (expectedMode !== undefined && (entry.mode & 0o777) !== expectedMode) ||
    (expectedOwner !== undefined && entry.uid !== expectedOwner)
  ) {
    throwStoreError(code);
  }
  return entry;
}

function verifiedRegularFileEntry(
  pathValue: string,
  code: SqliteControlStoreErrorCode,
  expectedMode: number,
  expected?: Stats,
  expectedOwner?: number,
): Stats {
  let entry: Stats;
  let resolvedPath: string;
  try {
    entry = lstatSync(pathValue);
    resolvedPath = realpathSync(pathValue);
  } catch {
    throwStoreError(code);
  }
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.nlink !== 1 ||
    resolvedPath !== pathValue ||
    (entry.mode & 0o777) !== expectedMode ||
    (expected !== undefined && !sameEntryIdentity(entry, expected)) ||
    (expectedOwner !== undefined && entry.uid !== expectedOwner)
  ) {
    throwStoreError(code);
  }
  return entry;
}

function assertVerifiedHandleEntry(
  handle: VerifiedPathHandle,
  code: SqliteControlStoreErrorCode,
): Stats {
  let entry: Stats;
  try {
    entry = fstatSync(handle.fileDescriptor);
  } catch {
    throwStoreError(code);
  }
  if (
    !sameEntryIdentity(entry, handle.entry) ||
    (entry.mode & 0o777) !== handle.mode ||
    entry.uid !== handle.owner ||
    (handle.kind === "directory" && !entry.isDirectory()) ||
    (handle.kind === "file" && (!entry.isFile() || entry.nlink !== 1))
  ) {
    throwStoreError(code);
  }
  return entry;
}

function verifyHandlePath(
  handle: VerifiedPathHandle,
  pathValue: string,
  code: SqliteControlStoreErrorCode,
): void {
  if (handle.kind === "directory") {
    verifiedDirectoryEntry(
      pathValue,
      code,
      handle.entry,
      handle.mode,
      handle.owner,
    );
  } else {
    verifiedRegularFileEntry(
      pathValue,
      code,
      handle.mode,
      handle.entry,
      handle.owner,
    );
  }
}

function openVerifiedDirectoryHandle(
  pathValue: string,
  code: SqliteControlStoreErrorCode,
  expected: Stats,
  expectedOwner: number,
): VerifiedPathHandle {
  verifiedDirectoryEntry(
    pathValue,
    code,
    expected,
    DIRECTORY_MODE,
    expectedOwner,
  );
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(
      pathValue,
      openFlags(fsConstants.O_RDONLY | DIRECTORY_FLAG),
    );
    const openedEntry = fstatSync(fileDescriptor);
    const handle: VerifiedPathHandle = {
      fileDescriptor,
      path: pathValue,
      entry: openedEntry,
      kind: "directory",
      mode: DIRECTORY_MODE,
      owner: expectedOwner,
    };
    if (!sameEntryIdentity(openedEntry, expected)) throwStoreError(code);
    assertVerifiedHandleEntry(handle, code);
    verifyHandlePath(handle, pathValue, code);
    return handle;
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        throwStoreError(code);
      }
    }
    if (error instanceof SqliteControlStoreError) throw error;
    throwStoreError(code);
  }
}

function fsyncVerifiedHandle(
  handle: VerifiedPathHandle,
  currentPath: string,
  code: SqliteControlStoreErrorCode,
): void {
  try {
    assertVerifiedHandleEntry(handle, code);
    verifyHandlePath(handle, currentPath, code);
    fsyncSync(handle.fileDescriptor);
    assertVerifiedHandleEntry(handle, code);
    verifyHandlePath(handle, currentPath, code);
  } catch (error) {
    if (error instanceof SqliteControlStoreError) throw error;
    throwStoreError(code);
  }
}

function closeVerifiedHandle(
  handle: VerifiedPathHandle | undefined,
  code: SqliteControlStoreErrorCode,
): void {
  if (handle === undefined) return;
  let failed = false;
  try {
    assertVerifiedHandleEntry(handle, code);
  } catch {
    failed = true;
  }
  try {
    closeSync(handle.fileDescriptor);
  } catch {
    failed = true;
  }
  if (failed) throwStoreError(code);
}

function captureOpenStoreIdentity(
  applicationRoot: string,
  paths: StorePaths,
  expected?: OpenStoreIdentity,
): OpenStoreIdentity {
  const applicationRootEntry = verifiedDirectoryEntry(
    applicationRoot,
    "invalid_application_root",
    expected?.applicationRoot,
  );
  const runtimeDir = verifiedDirectoryEntry(
    paths.runtimeDir,
    "permission_mismatch",
    expected?.runtimeDir,
    DIRECTORY_MODE,
    applicationRootEntry.uid,
  );
  const stateDir = verifiedDirectoryEntry(
    paths.stateDir,
    "state_missing",
    expected?.stateDir,
    DIRECTORY_MODE,
    runtimeDir.uid,
  );
  const marker = verifiedRegularFileEntry(
    paths.markerPath,
    "permission_mismatch",
    MARKER_MODE,
    expected?.marker,
    stateDir.uid,
  );
  const database = verifiedRegularFileEntry(
    paths.controlDbPath,
    "permission_mismatch",
    DATABASE_MODE,
    expected?.database,
    stateDir.uid,
  );
  return { applicationRoot: applicationRootEntry, runtimeDir, stateDir, marker, database };
}

function ensureRuntimeDirectory(
  applicationRoot: string,
  runtimeDir: string,
  expectedApplicationRoot: Stats,
): Stats {
  const entry = existingEntry(runtimeDir);
  let created = false;
  if (entry === null) {
    try {
      mkdirSync(runtimeDir, { mode: DIRECTORY_MODE });
      chmodSync(runtimeDir, DIRECTORY_MODE);
      created = true;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { code?: unknown }).code !== "EEXIST"
      ) {
        throwStoreError("initialization_failed");
      }
    }
  }

  const verifiedEntry = verifiedDirectoryEntry(
    runtimeDir,
    "invalid_application_root",
    undefined,
    DIRECTORY_MODE,
    expectedApplicationRoot.uid,
  );
  verifiedDirectoryEntry(
    applicationRoot,
    "invalid_application_root",
    expectedApplicationRoot,
  );
  if (entry === null) {
    fsyncDirectory(applicationRoot);
    verifiedDirectoryEntry(
      applicationRoot,
      "invalid_application_root",
      expectedApplicationRoot,
    );
    verifiedDirectoryEntry(
      runtimeDir,
      "invalid_application_root",
      verifiedEntry,
      DIRECTORY_MODE,
      expectedApplicationRoot.uid,
    );
  }
  if (!created && entry !== null && !sameEntryIdentity(entry, verifiedEntry)) {
    throwStoreError("invalid_application_root");
  }
  return verifiedEntry;
}

const INITIALIZER_LOCK_NAME = ".mcp-instance-state-initialize.lock";
const INITIALIZER_LOCK_TEMP_PREFIX = `${INITIALIZER_LOCK_NAME}.tmp-`;
const INITIALIZER_LOCK_TEMP_PATTERN =
  /^\.mcp-instance-state-initialize\.lock\.tmp-([1-9][0-9]*)-([0-9a-f]{32})$/;

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function lockOwnerPid(contents: Buffer): number | null {
  if (contents.length > 64) return null;
  const match = /^pid:([1-9][0-9]*)\n$/.exec(contents.toString("utf8"));
  if (match === null) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function lockOwnerPidFromDescriptor(fileDescriptor: number): number | null {
  const contents = Buffer.alloc(65);
  let length: number;
  try {
    length = readSync(fileDescriptor, contents, 0, contents.length, 0);
  } catch {
    return null;
  }
  if (length === contents.length) return null;
  return lockOwnerPid(contents.subarray(0, length));
}

function verifiedLockPathEntry(
  pathValue: string,
  expectedRuntimeEntry: Stats,
  expected: Stats | undefined,
  allowedLinkCounts: readonly number[],
  code: "lock_conflict" | "initialization_failed" | "cleanup_failed",
): Stats {
  let entry: Stats;
  let resolvedPath: string;
  try {
    entry = lstatSync(pathValue);
    resolvedPath = realpathSync(pathValue);
  } catch {
    throwStoreError(code);
  }
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    !allowedLinkCounts.includes(entry.nlink) ||
    resolvedPath !== pathValue ||
    (entry.mode & 0o777) !== DATABASE_MODE ||
    entry.uid !== expectedRuntimeEntry.uid ||
    (expected !== undefined && !sameEntryIdentity(entry, expected))
  ) {
    throwStoreError(code);
  }
  return entry;
}

function cleanupAbandonedInitializerLockTemps(
  runtimeDir: string,
  expectedRuntimeEntry: Stats,
  lockPath: string,
): void {
  let entries: readonly string[];
  try {
    entries = readdirSync(runtimeDir).sort();
  } catch {
    throwStoreError("lock_conflict");
  }
  for (const entryName of entries) {
    const match = INITIALIZER_LOCK_TEMP_PATTERN.exec(entryName);
    if (match === null) continue;
    const namePid = Number(match[1]);
    const tempPath = join(runtimeDir, entryName);
    let fileDescriptor: number | undefined;
    try {
      const pathEntry = verifiedLockPathEntry(
        tempPath,
        expectedRuntimeEntry,
        undefined,
        [1, 2],
        "lock_conflict",
      );
      fileDescriptor = openSync(tempPath, openFlags(fsConstants.O_RDONLY));
      const openedEntry = fstatSync(fileDescriptor);
      if (!sameEntryIdentity(openedEntry, pathEntry)) throwStoreError("lock_conflict");
      const ownerPid = lockOwnerPidFromDescriptor(fileDescriptor);
      if (ownerPid === null || ownerPid !== namePid || processIsAlive(ownerPid)) {
        continue;
      }
      if (openedEntry.nlink === 2) {
        verifiedLockPathEntry(
          lockPath,
          expectedRuntimeEntry,
          openedEntry,
          [2],
          "lock_conflict",
        );
      }
      verifiedDirectoryEntry(
        runtimeDir,
        "lock_conflict",
        expectedRuntimeEntry,
        DIRECTORY_MODE,
        expectedRuntimeEntry.uid,
      );
      verifiedLockPathEntry(
        tempPath,
        expectedRuntimeEntry,
        openedEntry,
        [1, 2],
        "lock_conflict",
      );
      unlinkSync(tempPath);
      fsyncDirectory(runtimeDir);
    } catch (error) {
      if (error instanceof SqliteControlStoreError) throw error;
      throwStoreError("lock_conflict");
    } finally {
      if (fileDescriptor !== undefined) {
        try {
          closeSync(fileDescriptor);
        } catch {
          throwStoreError("cleanup_failed");
        }
      }
    }
  }
}

function removeStaleInitializerLock(
  runtimeDir: string,
  expectedRuntimeEntry: Stats,
  lockPath: string,
): boolean {
  let fileDescriptor: number | undefined;
  let stale = false;
  try {
    const runtimeEntry = verifiedDirectoryEntry(
      runtimeDir,
      "lock_conflict",
      expectedRuntimeEntry,
      DIRECTORY_MODE,
      expectedRuntimeEntry.uid,
    );
    const pathEntry = verifiedRegularFileEntry(
      lockPath,
      "lock_conflict",
      DATABASE_MODE,
      undefined,
      runtimeEntry.uid,
    );
    fileDescriptor = openSync(lockPath, openFlags(fsConstants.O_RDONLY));
    const openedEntry = fstatSync(fileDescriptor);
    if (
      !openedEntry.isFile() ||
      openedEntry.nlink !== 1 ||
      (openedEntry.mode & 0o777) !== DATABASE_MODE ||
      openedEntry.uid !== runtimeEntry.uid ||
      !sameEntryIdentity(openedEntry, pathEntry)
    ) {
      throwStoreError("lock_conflict");
    }
    const pid = lockOwnerPidFromDescriptor(fileDescriptor);
    if (pid !== null && !processIsAlive(pid)) {
      verifiedDirectoryEntry(
        runtimeDir,
        "lock_conflict",
        expectedRuntimeEntry,
        DIRECTORY_MODE,
        expectedRuntimeEntry.uid,
      );
      verifiedRegularFileEntry(
        lockPath,
        "lock_conflict",
        DATABASE_MODE,
        openedEntry,
        expectedRuntimeEntry.uid,
      );
      unlinkSync(lockPath);
      fsyncDirectory(runtimeDir);
      verifiedDirectoryEntry(
        runtimeDir,
        "lock_conflict",
        expectedRuntimeEntry,
        DIRECTORY_MODE,
        expectedRuntimeEntry.uid,
      );
      stale = true;
    }
  } catch (error) {
    if (error instanceof SqliteControlStoreError) throw error;
    throwStoreError("lock_conflict");
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        throwStoreError("cleanup_failed");
      }
    }
  }
  return stale;
}

function removeOwnedLockPathIfPresent(
  pathValue: string,
  expectedRuntimeEntry: Stats,
  expectedEntry: Stats,
  allowedLinkCounts: readonly number[],
): boolean {
  let entry: Stats;
  try {
    entry = lstatSync(pathValue);
  } catch (error) {
    if (isMissingError(error)) return false;
    throwStoreError("cleanup_failed");
  }
  verifiedLockPathEntry(
    pathValue,
    expectedRuntimeEntry,
    expectedEntry,
    allowedLinkCounts,
    "cleanup_failed",
  );
  if (!sameEntryIdentity(entry, expectedEntry)) throwStoreError("cleanup_failed");
  unlinkSync(pathValue);
  return true;
}

function acquireInitializerLock(
  runtimeDir: string,
  expectedRuntimeEntry: Stats,
): InitializerLock {
  const lockPath = join(runtimeDir, INITIALIZER_LOCK_NAME);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    cleanupAbandonedInitializerLockTemps(
      runtimeDir,
      expectedRuntimeEntry,
      lockPath,
    );
    verifiedDirectoryEntry(
      runtimeDir,
      "invalid_application_root",
      expectedRuntimeEntry,
      DIRECTORY_MODE,
      expectedRuntimeEntry.uid,
    );
    const tempPath = join(
      runtimeDir,
      `${INITIALIZER_LOCK_TEMP_PREFIX}${process.pid}-${randomBytes(16).toString("hex")}`,
    );
    let fileDescriptor: number | undefined;
    let tempEntry: Stats | undefined;
    let fixedLinked = false;
    try {
      fileDescriptor = openSync(
        tempPath,
        openFlags(fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL),
        DATABASE_MODE,
      );
      fchmodSync(fileDescriptor, DATABASE_MODE);
      tempEntry = fstatSync(fileDescriptor);
      verifiedLockPathEntry(
        tempPath,
        expectedRuntimeEntry,
        tempEntry,
        [1],
        "initialization_failed",
      );
      const contents = Buffer.from(`pid:${process.pid}\n`, "utf8");
      let offset = 0;
      while (offset < contents.length) {
        offset += writeSync(
          fileDescriptor,
          contents,
          offset,
          contents.length - offset,
          null,
        );
      }
      fsyncSync(fileDescriptor);
      const writtenEntry = fstatSync(fileDescriptor);
      if (
        !sameEntryIdentity(writtenEntry, tempEntry) ||
        writtenEntry.nlink !== 1 ||
        (writtenEntry.mode & 0o777) !== DATABASE_MODE ||
        writtenEntry.uid !== expectedRuntimeEntry.uid ||
        lockOwnerPidFromDescriptor(fileDescriptor) !== process.pid
      ) {
        throwStoreError("initialization_failed");
      }
      verifiedLockPathEntry(
        tempPath,
        expectedRuntimeEntry,
        writtenEntry,
        [1],
        "initialization_failed",
      );
      verifiedDirectoryEntry(
        runtimeDir,
        "invalid_application_root",
        expectedRuntimeEntry,
        DIRECTORY_MODE,
        expectedRuntimeEntry.uid,
      );
      linkSync(tempPath, lockPath);
      fixedLinked = true;
      const linkedEntry = fstatSync(fileDescriptor);
      if (!sameEntryIdentity(linkedEntry, writtenEntry) || linkedEntry.nlink !== 2) {
        throwStoreError("initialization_failed");
      }
      verifiedLockPathEntry(
        tempPath,
        expectedRuntimeEntry,
        linkedEntry,
        [2],
        "initialization_failed",
      );
      verifiedLockPathEntry(
        lockPath,
        expectedRuntimeEntry,
        linkedEntry,
        [2],
        "initialization_failed",
      );
      unlinkSync(tempPath);
      fsyncDirectory(runtimeDir);
      const entry = fstatSync(fileDescriptor);
      if (!sameEntryIdentity(entry, linkedEntry) || entry.nlink !== 1) {
        throwStoreError("initialization_failed");
      }
      verifiedRegularFileEntry(
        lockPath,
        "initialization_failed",
        DATABASE_MODE,
        entry,
        expectedRuntimeEntry.uid,
      );
      return { fileDescriptor, path: lockPath, entry, runtimeEntry: expectedRuntimeEntry };
    } catch (error) {
      let cleanupFailed = false;
      let removedPath = false;
      if (tempEntry !== undefined) {
        try {
          if (fixedLinked) {
            removedPath = removeOwnedLockPathIfPresent(
              lockPath,
              expectedRuntimeEntry,
              tempEntry,
              [1, 2],
            ) || removedPath;
          }
          removedPath = removeOwnedLockPathIfPresent(
            tempPath,
            expectedRuntimeEntry,
            tempEntry,
            fixedLinked ? [1, 2] : [1],
          ) || removedPath;
          if (removedPath) fsyncDirectory(runtimeDir);
        } catch {
          cleanupFailed = true;
        }
      }
      if (fileDescriptor !== undefined) {
        try {
          closeSync(fileDescriptor);
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) throwStoreError("cleanup_failed");
      if (errorCode(error) === "EEXIST") {
        if (!removeStaleInitializerLock(runtimeDir, expectedRuntimeEntry, lockPath)) {
          throwStoreError("lock_conflict");
        }
        continue;
      }
      if (error instanceof SqliteControlStoreError) throw error;
      throwStoreError("initialization_failed");
    }
  }
  throwStoreError("lock_conflict");
}

function releaseInitializerLock(lock: InitializerLock, runtimeDir: string): void {
  let failed = false;
  try {
    verifiedDirectoryEntry(
      runtimeDir,
      "cleanup_failed",
      lock.runtimeEntry,
      DIRECTORY_MODE,
      lock.runtimeEntry.uid,
    );
    const openedEntry = fstatSync(lock.fileDescriptor);
    if (!sameEntryIdentity(openedEntry, lock.entry)) throwStoreError("cleanup_failed");
    verifiedRegularFileEntry(
      lock.path,
      "cleanup_failed",
      DATABASE_MODE,
      lock.entry,
      lock.runtimeEntry.uid,
    );
    unlinkSync(lock.path);
    fsyncDirectory(runtimeDir);
  } catch {
    failed = true;
  }
  try {
    closeSync(lock.fileDescriptor);
  } catch {
    failed = true;
  }
  if (failed) throwStoreError("cleanup_failed");
}

function assertExistingDirectory(pathValue: string, code: "state_missing" | "invalid_application_root"): void {
  const parsed = parse(pathValue);
  let currentPath = parsed.root;
  const components = pathValue.slice(parsed.root.length).split(sep).filter(Boolean);

  for (const component of components) {
    currentPath = join(currentPath, component);
    let entry;
    try {
      entry = lstatSync(currentPath);
    } catch {
      throwStoreError(code);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throwStoreError(code);
    }
  }
}

function assertRegularFile(
  pathValue: string,
  missingCode: "marker_missing" | "database_missing",
  expectedMode: number,
): void {
  let entry;
  try {
    entry = lstatSync(pathValue);
  } catch {
    throwStoreError(missingCode);
  }

  if (entry.isSymbolicLink() || !entry.isFile()) {
    throwStoreError("permission_mismatch");
  }

  let mode;
  try {
    mode = statSync(pathValue).mode & 0o777;
  } catch {
    throwStoreError("permission_mismatch");
  }
  if (mode !== expectedMode) {
    throwStoreError("permission_mismatch");
  }
}

function assertStateDirectory(paths: StorePaths): void {
  assertExistingDirectory(paths.runtimeDir, "state_missing");
  assertExistingDirectory(paths.stateDir, "state_missing");
  let mode;
  try {
    mode = statSync(paths.stateDir).mode & 0o777;
  } catch {
    throwStoreError("permission_mismatch");
  }
  if (mode !== DIRECTORY_MODE) {
    throwStoreError("permission_mismatch");
  }
  assertRegularFile(paths.markerPath, "marker_missing", MARKER_MODE);
  assertRegularFile(paths.controlDbPath, "database_missing", DATABASE_MODE);
}

function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throwStoreError("marker_invalid");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throwStoreError("marker_invalid");
}

function markerFor(
  controlDbPath: string,
  instanceId: string,
  managementTenantId: string,
  controlDbId: string,
): Marker {
  return {
    control_db_id: controlDbId,
    control_db_path: controlDbPath,
    instance_id: instanceId,
    management_tenant_id: managementTenantId,
    marker_format: MARKER_FORMAT,
    schema_version: SCHEMA_VERSION,
  };
}

function markerBytes(marker: Marker): Buffer {
  return Buffer.from(`${canonicalJson(marker)}\n`, "utf8");
}

function readAndValidateMarker(
  markerPath: string,
  expected: Omit<Marker, "control_db_id">,
  expectedEntry?: Stats,
): Marker {
  let bytes: Buffer;
  let fileDescriptor: number | undefined;
  try {
    const pathEntry = verifiedRegularFileEntry(
      markerPath,
      "permission_mismatch",
      MARKER_MODE,
      expectedEntry,
    );
    fileDescriptor = openSync(markerPath, openFlags(fsConstants.O_RDONLY));
    const entry = fstatSync(fileDescriptor);
    if (
      !entry.isFile() ||
      entry.nlink !== 1 ||
      (entry.mode & 0o777) !== MARKER_MODE ||
      !sameEntryIdentity(entry, pathEntry)
    ) {
      throwStoreError("permission_mismatch");
    }
    bytes = readFileSync(fileDescriptor);
    verifiedRegularFileEntry(
      markerPath,
      "permission_mismatch",
      MARKER_MODE,
      entry,
    );
  } catch (error) {
    if (error instanceof SqliteControlStoreError) throw error;
    throwStoreError("marker_invalid");
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        throwStoreError("marker_invalid");
      }
    }
  }

  if (bytes.length === 0 || bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throwStoreError("marker_invalid");
  }
  if (bytes[bytes.length - 1] !== 0x0a || bytes.subarray(0, -1).includes(0x0a)) {
    throwStoreError("marker_invalid");
  }

  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throwStoreError("marker_invalid");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throwStoreError("marker_invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throwStoreError("marker_invalid");
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 6 ||
    keys.join("\0") !==
      [
        "control_db_id",
        "control_db_path",
        "instance_id",
        "management_tenant_id",
        "marker_format",
        "schema_version",
      ].join("\0")
  ) {
    throwStoreError("marker_invalid");
  }

  let expectedText: string;
  try {
    expectedText = `${canonicalJson(record)}\n`;
  } catch {
    throwStoreError("marker_invalid");
  }
  if (expectedText !== text) {
    throwStoreError("marker_invalid");
  }

  if (
    record.control_db_path !== expected.control_db_path ||
    record.instance_id !== expected.instance_id ||
    record.management_tenant_id !== expected.management_tenant_id ||
    record.marker_format !== MARKER_FORMAT ||
    record.schema_version !== SCHEMA_VERSION ||
    typeof record.control_db_id !== "string" ||
    !/^db_[0-9a-f]{32}$/.test(record.control_db_id)
  ) {
    throwStoreError("identity_mismatch");
  }

  return record as unknown as Marker;
}

function openFlags(extra: number): number {
  return extra | NO_FOLLOW;
}

function fsyncDirectory(pathValue: string): void {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(pathValue, openFlags(fsConstants.O_RDONLY | DIRECTORY_FLAG));
    fsyncSync(fileDescriptor);
  } catch {
    throwStoreError("initialization_failed");
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        throwStoreError("initialization_failed");
      }
    }
  }
}

function writeExclusiveFile(
  pathValue: string,
  bytes: Buffer,
  mode: number,
  expectedOwner: number,
): VerifiedPathHandle {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(
      pathValue,
      openFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
      mode,
    );
    fchmodSync(fileDescriptor, mode);
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fileDescriptor, bytes, offset, bytes.length - offset, null);
    }
    const entry = fstatSync(fileDescriptor);
    const handle: VerifiedPathHandle = {
      fileDescriptor,
      path: pathValue,
      entry,
      kind: "file",
      mode,
      owner: expectedOwner,
    };
    assertVerifiedHandleEntry(handle, "initialization_failed");
    verifyHandlePath(handle, pathValue, "initialization_failed");
    fsyncVerifiedHandle(handle, pathValue, "initialization_failed");
    return handle;
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        throwStoreError("initialization_failed");
      }
    }
    if (error instanceof SqliteControlStoreError) throw error;
    throwStoreError("initialization_failed");
  }
}

function createDatabaseFile(
  pathValue: string,
  expectedOwner: number,
): VerifiedPathHandle {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(
      pathValue,
      openFlags(fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL),
      DATABASE_MODE,
    );
    fchmodSync(fileDescriptor, DATABASE_MODE);
    const createdEntry = fstatSync(fileDescriptor);
    const handle: VerifiedPathHandle = {
      fileDescriptor,
      path: pathValue,
      entry: createdEntry,
      kind: "file",
      mode: DATABASE_MODE,
      owner: expectedOwner,
    };
    assertVerifiedHandleEntry(handle, "initialization_failed");
    verifyHandlePath(handle, pathValue, "initialization_failed");
    return handle;
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        throwStoreError("initialization_failed");
      }
    }
    if (error instanceof SqliteControlStoreError) throw error;
    throwStoreError("initialization_failed");
  }
}

function pragmaValue(database: DatabaseSync, statement: string, key: string): unknown {
  const row = database.prepare(statement).get() as Record<string, unknown> | undefined;
  return row?.[key];
}

function readWriteDatabaseUrl(pathValue: string): URL {
  const databaseUrl = pathToFileURL(pathValue);
  databaseUrl.searchParams.set("mode", "rw");
  return databaseUrl;
}

function verifyOpenedDatabasePath(
  database: DatabaseSync,
  pathValue: string,
  expectedEntry: Stats,
): void {
  let currentEntry: Stats;
  let resolvedPath: string;
  try {
    currentEntry = lstatSync(pathValue);
    resolvedPath = realpathSync(pathValue);
  } catch {
    throwStoreError("database_missing");
  }
  if (
    currentEntry.isSymbolicLink() ||
    !currentEntry.isFile() ||
    (currentEntry.mode & 0o777) !== DATABASE_MODE ||
    currentEntry.dev !== expectedEntry.dev ||
    currentEntry.ino !== expectedEntry.ino ||
    resolvedPath !== pathValue
  ) {
    throwStoreError("permission_mismatch");
  }

  const databaseRows = database.prepare("PRAGMA database_list").all() as Array<
    Record<string, unknown>
  >;
  const main = databaseRows.find((row) => row.name === "main");
  if (
    main?.file !== resolvedPath ||
    databaseRows.some(
      (row) => row.name !== "main" && !(row.name === "temp" && row.file === ""),
    )
  ) {
    throwStoreError("identity_mismatch");
  }
}

function nativeSqliteFailureCode(error: unknown): SqliteControlStoreErrorCode {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message).toLowerCase()
      : "";
  if (message.includes("locked") || message.includes("busy")) return "lock_conflict";
  if (
    message.includes("malformed") ||
    message.includes("not a database") ||
    message.includes("database disk image") ||
    message.includes("corrupt")
  ) {
    return "quick_check_failed";
  }
  return "database_open_failed";
}

function configureDatabase(database: DatabaseSync): void {
  const journalMode = String(pragmaValue(database, "PRAGMA journal_mode = WAL", "journal_mode"));
  if (journalMode.toLowerCase() !== "wal") {
    throwStoreError("schema_mismatch");
  }
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA busy_timeout = 0");

  if (
    Number(pragmaValue(database, "PRAGMA synchronous", "synchronous")) !== 2 ||
    Number(pragmaValue(database, "PRAGMA foreign_keys", "foreign_keys")) !== 1 ||
    Number(pragmaValue(database, "PRAGMA trusted_schema", "trusted_schema")) !== 0
  ) {
    throwStoreError("schema_mismatch");
  }
}

function initializeDatabase(
  pathValue: string,
  marker: Marker,
  databaseHandle: VerifiedPathHandle,
  stagingDir: string,
  stagingHandle: VerifiedPathHandle,
): void {
  let database: DatabaseSync | undefined;
  let closed = false;
  try {
    verifiedDirectoryEntry(
      stagingDir,
      "initialization_failed",
      stagingHandle.entry,
      DIRECTORY_MODE,
      stagingHandle.owner,
    );
    verifiedRegularFileEntry(
      pathValue,
      "initialization_failed",
      DATABASE_MODE,
      databaseHandle.entry,
      stagingHandle.owner,
    );
    assertVerifiedHandleEntry(databaseHandle, "initialization_failed");
    assertVerifiedHandleEntry(stagingHandle, "initialization_failed");
    database = new DatabaseSync(readWriteDatabaseUrl(pathValue), {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    try {
      verifyOpenedDatabasePath(database, pathValue, databaseHandle.entry);
      verifiedDirectoryEntry(
        stagingDir,
        "initialization_failed",
        stagingHandle.entry,
        DIRECTORY_MODE,
        stagingHandle.owner,
      );
      assertVerifiedHandleEntry(databaseHandle, "initialization_failed");
      assertVerifiedHandleEntry(stagingHandle, "initialization_failed");
    } catch {
      throwStoreError("initialization_failed");
    }
    configureDatabase(database);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of CONTROL_SCHEMA_STATEMENTS) {
        database.exec(statement);
      }
      database
        .prepare(
          `INSERT INTO control_identity
            (singleton_id, marker_format, management_tenant_id, control_db_id, control_db_path, instance_id, schema_version)
           VALUES (1, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          marker.marker_format,
          marker.management_tenant_id,
          marker.control_db_id,
          marker.control_db_path,
          marker.instance_id,
        );
      database.exec("PRAGMA user_version = 1");
      database.exec("COMMIT");
    } catch {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original initialization failure is the only externally visible result.
      }
      throwStoreError("initialization_failed");
    }

    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all() as Array<
      Record<string, unknown>
    >;
    if (
      checkpoint.length !== 1 ||
      Number(checkpoint[0]?.busy) !== 0 ||
      Number(checkpoint[0]?.log) !== 0 ||
      Number(checkpoint[0]?.checkpointed) !== 0
    ) {
      throwStoreError("sidecar_present");
    }
    try {
      verifyOpenedDatabasePath(database, pathValue, databaseHandle.entry);
      verifiedDirectoryEntry(
        stagingDir,
        "initialization_failed",
        stagingHandle.entry,
        DIRECTORY_MODE,
        stagingHandle.owner,
      );
      assertVerifiedHandleEntry(databaseHandle, "initialization_failed");
      assertVerifiedHandleEntry(stagingHandle, "initialization_failed");
    } catch {
      throwStoreError("initialization_failed");
    }
    database.close();
    closed = true;
  } catch (error) {
    if (error instanceof SqliteControlStoreError) {
      throw error;
    }
    throwStoreError("initialization_failed");
  } finally {
    if (database !== undefined && !closed) {
      try {
        database.close();
      } catch {
        // The caller receives the stable initialization error.
      }
    }
  }

  const walPath = `${pathValue}-wal`;
  const shmPath = `${pathValue}-shm`;
  if (existingEntry(walPath) !== null || existingEntry(shmPath) !== null) {
    throwStoreError("sidecar_present");
  }
  verifiedRegularFileEntry(
    pathValue,
    "initialization_failed",
    DATABASE_MODE,
    databaseHandle.entry,
    stagingHandle.owner,
  );
  verifiedDirectoryEntry(
    stagingDir,
    "initialization_failed",
    stagingHandle.entry,
    DIRECTORY_MODE,
    stagingHandle.owner,
  );
  fsyncVerifiedHandle(databaseHandle, pathValue, "initialization_failed");
  assertVerifiedHandleEntry(stagingHandle, "initialization_failed");
}

function compiledSchemaObjectName(statement: string): string {
  const match = /^CREATE (?:TABLE|(?:UNIQUE )?INDEX) ([A-Za-z_][A-Za-z0-9_]*) /iu.exec(
    statement,
  );
  if (match === null) throwStoreError("schema_mismatch");
  return match[1]!;
}

function verifyTables(database: DatabaseSync): void {
  const rows = database
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<Record<string, unknown>>;
  if (
    rows.length !== CONTROL_SCHEMA_STATEMENTS.length ||
    rows.some((row) => row.type !== "table" && row.type !== "index")
  ) {
    throwStoreError("schema_mismatch");
  }

  const actualByName = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.name !== "string" || typeof row.sql !== "string") {
      throwStoreError("schema_mismatch");
    }
    const normalized = normalizeControlSchema(row.sql);
    if (normalized.length !== 1 || actualByName.has(row.name)) {
      throwStoreError("schema_mismatch");
    }
    actualByName.set(row.name, normalized[0]!);
  }

  const actualStatements = CONTROL_SCHEMA_STATEMENTS.map((expectedStatement) => {
    const name = compiledSchemaObjectName(expectedStatement);
    const actualStatement = actualByName.get(name);
    if (actualStatement === undefined || actualStatement !== expectedStatement) {
      throwStoreError("schema_mismatch");
    }
    return actualStatement;
  });
  if (
    actualByName.size !== CONTROL_SCHEMA_STATEMENTS.length ||
    fingerprintControlSchema(actualStatements) !== CONTROL_SCHEMA_FINGERPRINT
  ) {
    throwStoreError("schema_mismatch");
  }

  const tableList = database
    .prepare("PRAGMA table_list")
    .all()
    .filter((row) => !String((row as { name: unknown }).name).startsWith("sqlite_"));
  const expectedTableCount = CONTROL_SCHEMA_STATEMENTS.filter((statement) =>
    statement.startsWith("CREATE TABLE "),
  ).length;
  if (
    tableList.length !== expectedTableCount ||
    tableList.some((row) => Number((row as { strict: unknown }).strict) !== 1)
  ) {
    throwStoreError("schema_mismatch");
  }

  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length !== 0) throwStoreError("schema_mismatch");
}

function verifyDatabase(database: DatabaseSync, marker: Marker): void {
  const journalMode = String(pragmaValue(database, "PRAGMA journal_mode", "journal_mode"));
  if (
    journalMode.toLowerCase() !== "wal" ||
    Number(pragmaValue(database, "PRAGMA synchronous", "synchronous")) !== 2 ||
    Number(pragmaValue(database, "PRAGMA foreign_keys", "foreign_keys")) !== 1 ||
    Number(pragmaValue(database, "PRAGMA trusted_schema", "trusted_schema")) !== 0 ||
    Number(pragmaValue(database, "PRAGMA user_version", "user_version")) !== SCHEMA_VERSION
  ) {
    throwStoreError("schema_mismatch");
  }

  const quickCheck = database.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  if (quickCheck.length !== 1 || String(quickCheck[0]?.quick_check) !== "ok") {
    throwStoreError("quick_check_failed");
  }

  verifyTables(database);

  const identityRows = database
    .prepare(
      "SELECT marker_format, control_db_id, control_db_path, instance_id, management_tenant_id, schema_version FROM control_identity",
    )
    .all() as Array<Record<string, unknown>>;
  if (identityRows.length !== 1) {
    throwStoreError("identity_mismatch");
  }
  const identity = identityRows[0];
  if (
    identity?.marker_format !== marker.marker_format ||
    identity.control_db_id !== marker.control_db_id ||
    identity.control_db_path !== marker.control_db_path ||
    identity.instance_id !== marker.instance_id ||
    identity.management_tenant_id !== marker.management_tenant_id ||
    Number(identity.schema_version) !== SCHEMA_VERSION
  ) {
    throwStoreError("identity_mismatch");
  }
}

function acquireExclusiveLock(database: DatabaseSync): void {
  try {
    const mode = String(pragmaValue(database, "PRAGMA locking_mode = EXCLUSIVE", "locking_mode"));
    if (mode.toLowerCase() !== "exclusive") {
      throwStoreError("lock_conflict");
    }
    database.exec("BEGIN EXCLUSIVE");
    database.exec("COMMIT");
  } catch (error) {
    if (error instanceof SqliteControlStoreError) {
      throw error;
    }
    throwStoreError("lock_conflict");
  }
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type SqlRow = Record<string, unknown>;

function repositoryError(
  code: "closed" | "conflict" | "invalid_state" | "not_found" | "tenant_mismatch",
): never {
  throw new ModuleControlRepositoryError(code);
}

function mapRepositoryFailure(error: unknown): never {
  if (error instanceof ModuleControlRepositoryError) throw error;
  repositoryError("invalid_state");
}

function repositoryPromise<T>(operation: () => T): Promise<T> {
  return Promise.resolve()
    .then(operation)
    .catch((error: unknown) => {
      if (error instanceof ModuleControlRepositoryError) throw error;
      repositoryError("invalid_state");
    });
}

function assertRepositoryIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    repositoryError("invalid_state");
  }
}

function freezePlainValue(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const key of Reflect.ownKeys(value)) {
    freezePlainValue(Reflect.get(value, key));
  }
  Object.freeze(value);
}

function repositoryJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) repositoryError("invalid_state");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => repositoryJson(item)).join(",")}]`;
  }
  if (!isPlainDataObject(value)) repositoryError("invalid_state");
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${repositoryJson(value[key])}`)
    .join(",")}}`;
}

function parseRepositoryJson(value: unknown): unknown {
  if (typeof value !== "string") repositoryError("invalid_state");
  try {
    return JSON.parse(value) as unknown;
  } catch {
    repositoryError("invalid_state");
  }
}

function exactSqlRow(row: unknown, columns: readonly string[]): SqlRow {
  if (!isPlainDataObject(row)) repositoryError("invalid_state");
  const keys = Reflect.ownKeys(row);
  if (
    keys.length !== columns.length ||
    keys.some((key) => typeof key !== "string" || !columns.includes(key))
  ) {
    repositoryError("invalid_state");
  }
  return row;
}

function requiredSqlString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") repositoryError("invalid_state");
  return value;
}

function nullableSqlString(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value !== null && typeof value !== "string") repositoryError("invalid_state");
  return value;
}

function requiredSqlInteger(row: SqlRow, column: string): number {
  const value = row[column];
  if (!Number.isSafeInteger(value)) repositoryError("invalid_state");
  return value as number;
}

function nullableSqlInteger(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (value !== null && !Number.isSafeInteger(value)) repositoryError("invalid_state");
  return value as number | null;
}

function sqlBoolean(value: unknown): boolean {
  if (value !== 0 && value !== 1) repositoryError("invalid_state");
  return value === 1;
}

function requiredJson(row: SqlRow, column: string): unknown {
  return parseRepositoryJson(requiredSqlString(row, column));
}

function rfc3339InstantNanoseconds(value: string): bigint {
  const instant = parseRfc3339Instant(value);
  if (instant === null) repositoryError("invalid_state");
  return instant;
}

function formatUtcRfc3339Nanoseconds(instant: bigint): string {
  const formatted = formatRfc3339InstantUtc(instant);
  if (formatted === null) repositoryError("invalid_state");
  return formatted;
}

function compareRfc3339Instants(left: string, right: string): -1 | 0 | 1 {
  const comparison = compareSharedRfc3339Instants(left, right);
  if (comparison === null) repositoryError("invalid_state");
  return comparison;
}

function latestByInstant<T>(
  rows: Iterable<unknown>,
  decode: (row: unknown) => T,
  timestamp: (record: T) => string,
  tieBreak: (record: T) => string,
): T | null {
  let latest: T | null = null;
  let latestInstant: bigint | null = null;
  for (const row of rows) {
    const record = decode(row);
    const instant = rfc3339InstantNanoseconds(timestamp(record));
    if (
      latest === null ||
      latestInstant === null ||
      instant > latestInstant ||
      (instant === latestInstant && tieBreak(record) > tieBreak(latest))
    ) {
      latest = record;
      latestInstant = instant;
    }
  }
  return latest;
}

function idempotencyExpiry(createdAt: string): string {
  const expiry =
    rfc3339InstantNanoseconds(createdAt) + BigInt(IDEMPOTENCY_TTL_MS) * 1_000_000n;
  return formatUtcRfc3339Nanoseconds(expiry);
}

function isExpiredAt(expiresAt: string, operationAt: string): boolean {
  // This repository is an internal service-only boundary. Domain TTL uses timestamps
  // produced by the service's injected clock and never consults process wall time.
  return compareRfc3339Instants(expiresAt, operationAt) <= 0;
}

function recordTimestamp(record: ControlRecord): string {
  if ("registeredAt" in record) return record.registeredAt;
  if ("createdAt" in record) return record.createdAt;
  if ("decidedAt" in record) return record.decidedAt;
  if ("checkedAt" in record) return record.checkedAt;
  if ("occurredAt" in record) return record.occurredAt;
  repositoryError("invalid_state");
}

function assertTenant(
  metadata: ControlRequestMetadata,
  managementTenantId: string,
): void {
  if (metadata.managementTenantId !== managementTenantId) {
    repositoryError("tenant_mismatch");
  }
}

function assertQuery(
  value: unknown,
  expectedKeys: readonly string[],
  managementTenantId: string,
): Record<string, unknown> {
  if (!isPlainDataObject(value)) repositoryError("invalid_state");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some(
      (key) =>
        typeof key !== "string" || !expectedKeys.includes(key),
    ) ||
    expectedKeys.some(
      (key) => !Object.prototype.hasOwnProperty.call(value, key),
    )
  ) {
    repositoryError("invalid_state");
  }
  const queryTenant = value.managementTenantId;
  assertRepositoryIdentifier(queryTenant);
  if (queryTenant !== managementTenantId) repositoryError("tenant_mismatch");
  return value;
}

function queryIdentifier(
  value: unknown,
  key: string,
  expectedKeys: readonly string[],
  managementTenantId: string,
): string {
  const query = assertQuery(value, expectedKeys, managementTenantId);
  const identifier = query[key];
  assertRepositoryIdentifier(identifier);
  return identifier;
}

function idempotencyQueryValues(
  value: unknown,
  managementTenantId: string,
): { readonly action: ModuleControlAction; readonly idempotencyKey: string } {
  const query = assertQuery(
    value,
    ["managementTenantId", "action", "idempotencyKey"],
    managementTenantId,
  );
  const action = query.action;
  if (
    typeof action !== "string" ||
    !MODULE_CONTROL_ACTIONS.includes(action as ModuleControlAction)
  ) {
    repositoryError("invalid_state");
  }
  assertRepositoryIdentifier(query.idempotencyKey);
  return { action: action as ModuleControlAction, idempotencyKey: query.idempotencyKey };
}

function bindRepositoryRequest(
  metadata: ControlRequestMetadata,
  record: ControlRecord,
  managementTenantId: string,
): {
  readonly metadata: ControlRequestMetadata;
  readonly record: ControlRecord;
} {
  try {
    const bound = assertControlRequestBinding({ metadata, record });
    assertTenant(bound.metadata, managementTenantId);
    return bound as {
      readonly metadata: ControlRequestMetadata;
      readonly record: ControlRecord;
    };
  } catch (error: unknown) {
    if (error instanceof ModuleControlRepositoryError) throw error;
    repositoryError("invalid_state");
  }
}

function validateFinalResult(
  value: ControlFinalResult,
  action: ControlRequestMetadata["action"],
  expectedDomainRecordRef?: string,
  expectedRevision?: number,
): ControlFinalResult {
  if (!isPlainDataObject(value)) repositoryError("invalid_state");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("domainRecordRef") ||
    !keys.includes("envelope")
  ) {
    repositoryError("invalid_state");
  }
  const domainRecordRef = value.domainRecordRef;
  assertRepositoryIdentifier(domainRecordRef);
  if (
    expectedDomainRecordRef !== undefined &&
    domainRecordRef !== expectedDomainRecordRef
  ) {
    repositoryError("conflict");
  }
  const parsed = controlEnvelopeSchema.safeParse(value.envelope);
  if (!parsed.success) repositoryError("invalid_state");
  const data = parsed.data.data;
  switch (action) {
    case "packages.register": {
      if (
        data?.kind !== "registration" ||
        data.module_id === undefined ||
        data.version === undefined ||
        data.descriptor_digest === undefined
      ) {
        repositoryError("conflict");
      }
      const expectedRegistrationRef =
        `registration:${data.module_id}:${data.version}:${data.descriptor_digest}`;
      if (
        domainRecordRef !== expectedRegistrationRef ||
        (expectedDomainRecordRef !== undefined &&
          expectedDomainRecordRef !== expectedRegistrationRef)
      ) {
        repositoryError("conflict");
      }
      break;
    }
    case "deployments.preview":
      if (data?.kind !== "preview" || data.preview_ref !== domainRecordRef) {
        repositoryError("conflict");
      }
      break;
    case "approvals.decide":
      if (data?.kind !== "approval" || data.approval_id !== domainRecordRef) {
        repositoryError("conflict");
      }
      break;
    case "deployments.publish":
      if (data?.kind !== "release" || data.release_id !== domainRecordRef) {
        repositoryError("conflict");
      }
      if (data.revision === undefined) {
        repositoryError("conflict");
      }
      if (
        expectedRevision !== undefined &&
        data.revision !== expectedRevision
      ) {
        repositoryError("conflict");
      }
      if (
        parsed.data.readback.release_id !== domainRecordRef ||
        parsed.data.readback.revision !== data.revision ||
        (parsed.data.status === "success" &&
          parsed.data.readback.status !== "verified") ||
        (parsed.data.status === "manual_review" &&
          parsed.data.readback.status !== "mismatch" &&
          parsed.data.readback.status !== "unknown") ||
        (parsed.data.status !== "success" &&
          parsed.data.status !== "manual_review")
      ) {
        repositoryError("conflict");
      }
      break;
    case "deployments.reconcile":
      if (
        data?.kind !== "reconciliation" ||
        data.release_id !== domainRecordRef ||
        data.revision === undefined ||
        data.status === undefined
      ) {
        repositoryError("conflict");
      }
      if (
        expectedRevision !== undefined &&
        data.revision !== expectedRevision
      ) {
        repositoryError("conflict");
      }
      if (
        parsed.data.readback.release_id !== domainRecordRef ||
        parsed.data.readback.revision !== data.revision ||
        parsed.data.readback.status !== data.status ||
        (parsed.data.status === "success" &&
          parsed.data.readback.status !== "verified") ||
        (parsed.data.status === "manual_review" &&
          parsed.data.readback.status !== "mismatch" &&
          parsed.data.readback.status !== "unknown") ||
        (parsed.data.status !== "success" &&
          parsed.data.status !== "manual_review")
      ) {
        repositoryError("conflict");
      }
      break;
    default:
      repositoryError("invalid_state");
  }
  const result = {
    domainRecordRef,
    envelope: parsed.data,
  } as ControlFinalResult;
  freezePlainValue(result);
  return result;
}

function assertAttemptTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || parseRfc3339Instant(value) === null) {
    repositoryError("invalid_state");
  }
}

function assertAttemptRequestHash(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^mcp-control-hash\/v1\/request\/sha256:[a-f0-9]{64}$/u.test(value)
  ) {
    repositoryError("invalid_state");
  }
}

function assertAttemptObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!isPlainDataObject(value)) repositoryError("invalid_state");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key)) ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    repositoryError("invalid_state");
  }
  return value;
}

function assertAttemptMetadata(
  value: unknown,
): asserts value is ReadbackAttemptRequestMetadata {
  const metadata = assertAttemptObjectKeys(value, [
    "managementTenantId",
    "actorRef",
    "action",
    "idempotencyKey",
    "requestHash",
    "requestId",
    "traceId",
    "auditId",
  ]);
  assertRepositoryIdentifier(metadata.managementTenantId);
  assertRepositoryIdentifier(metadata.actorRef);
  if (
    metadata.action !== "deployments.publish" &&
    metadata.action !== "deployments.reconcile"
  ) {
    repositoryError("invalid_state");
  }
  assertRepositoryIdentifier(metadata.idempotencyKey);
  assertAttemptRequestHash(metadata.requestHash);
  assertRepositoryIdentifier(metadata.requestId);
  assertRepositoryIdentifier(metadata.traceId);
  assertRepositoryIdentifier(metadata.auditId);
}

function assertClaimAttemptRequest(
  value: unknown,
): asserts value is ClaimReadbackAttemptRequest {
  const hasClaimedAt =
    isPlainDataObject(value) && Object.prototype.hasOwnProperty.call(value, "claimedAt");
  const request = assertAttemptObjectKeys(
    value,
    hasClaimedAt
      ? [
          "metadata",
          "attemptId",
          "readbackRef",
          "releaseId",
          "revision",
          "desiredModules",
          "ownerBootId",
          "claimedAt",
        ]
      : [
          "metadata",
          "attemptId",
          "readbackRef",
          "releaseId",
          "revision",
          "desiredModules",
          "ownerBootId",
        ],
  );
  assertAttemptMetadata(request.metadata);
  const attemptId = request.attemptId;
  const readbackRef = request.readbackRef;
  const releaseId = request.releaseId;
  const ownerBootId = request.ownerBootId;
  for (const identifier of [attemptId, readbackRef, releaseId, ownerBootId]) {
    assertRepositoryIdentifier(identifier);
  }
  const revision = request.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    repositoryError("invalid_state");
  }
  const desiredModules = request.desiredModules;
  const claimedAt = hasClaimedAt ? request.claimedAt : undefined;
  const candidate = {
    managementTenantId: request.metadata.managementTenantId,
    attemptId,
    action: request.metadata.action,
    idempotencyKey: request.metadata.idempotencyKey,
    requestHash: request.metadata.requestHash,
    actorRef: request.metadata.actorRef,
    requestId: request.metadata.requestId,
    traceId: request.metadata.traceId,
    auditId: request.metadata.auditId,
    releaseId,
    revision,
    desiredModules,
    readbackRef,
    ownerBootId,
    phase: "claimed" as const,
    claimedAt: claimedAt ?? "1970-01-01T00:00:00.000Z",
    finalizedAt: null,
    terminalStatus: null,
    appliedReleaseId: null,
    appliedRevision: null,
    appliedModules: [],
    reasonCodes: [],
    checkedAt: null,
    finalizedByActorRef: null,
    reconciliationEventSequence: null,
    completionEventSequence: null,
  };
  try {
    deepFreezeReadbackAttempt(candidate as unknown as ReadbackAttemptRecord);
  } catch (error) {
    if (error instanceof ModuleControlRepositoryError) throw error;
    repositoryError("invalid_state");
  }
  if (hasClaimedAt) assertAttemptTimestamp(claimedAt);
}

function assertFinalizeAttemptRequest(value: unknown): asserts value is FinalizeReadbackAndCompleteRequest {
  const hasFinalizedAt =
    isPlainDataObject(value) && Object.prototype.hasOwnProperty.call(value, "finalizedAt");
  const request = assertAttemptObjectKeys(
    value,
    hasFinalizedAt
      ? ["attemptId", "ownerCapability", "observation", "finalResult", "finalizedAt"]
      : ["attemptId", "ownerCapability", "observation", "finalResult"],
  );
  assertRepositoryIdentifier(request.attemptId);
  if (
    typeof request.ownerCapability !== "object" ||
    request.ownerCapability === null ||
    Array.isArray(request.ownerCapability) ||
    nodeUtilTypes.isProxy(request.ownerCapability)
  ) {
    repositoryError("invalid_state");
  }
  try {
    assertReadbackAttemptObservation(request.observation);
  } catch (error) {
    if (error instanceof ModuleControlRepositoryError) throw error;
    repositoryError("invalid_state");
  }
  if (hasFinalizedAt) assertAttemptTimestamp(request.finalizedAt);
}

function assertRecoveryFinalizeAttemptRequest(
  value: unknown,
): asserts value is SqliteRecoveryFinalizeRequest {
  const hasFinalizedAt =
    isPlainDataObject(value) && Object.prototype.hasOwnProperty.call(value, "finalizedAt");
  const request = assertAttemptObjectKeys(
    value,
    hasFinalizedAt
      ? ["attemptId", "observation", "finalResult", "finalizedAt"]
      : ["attemptId", "observation", "finalResult"],
  );
  assertRepositoryIdentifier(request.attemptId);
  try {
    assertReadbackAttemptObservation(request.observation);
  } catch (error) {
    if (error instanceof ModuleControlRepositoryError) throw error;
    repositoryError("invalid_state");
  }
  if (hasFinalizedAt) assertAttemptTimestamp(request.finalizedAt);
}

function createSqliteReadbackRecoverySecret(): SqliteReadbackRecoverySecret {
  const secret = Object.freeze({
    [SQLITE_READBACK_RECOVERY_SECRET]: true,
  } as const);
  SQLITE_READBACK_RECOVERY_SECRETS.add(secret);
  return secret;
}

function assertSqliteReadbackRecoverySecret(
  value: unknown,
): asserts value is SqliteReadbackRecoverySecret {
  if (
    typeof value !== "object" ||
    value === null ||
    !SQLITE_READBACK_RECOVERY_SECRETS.has(value)
  ) {
    repositoryError("invalid_state");
  }
}

function equalCanonical(left: unknown, right: unknown): boolean {
  try {
    return repositoryJson(left) === repositoryJson(right);
  } catch {
    return false;
  }
}

function moduleRefSetKeys(refs: readonly ModuleControlRef[]): readonly string[] | null {
  const keys = refs.map(
    (ref) => `${ref.moduleId}\0${ref.version}\0${ref.descriptorDigest}`,
  );
  const uniqueKeys = new Set(keys);
  if (uniqueKeys.size !== keys.length) return null;
  return [...keys].sort();
}

function sameModuleRefs(
  left: readonly ModuleControlRef[],
  right: readonly ModuleControlRef[],
): boolean {
  const leftKeys = moduleRefSetKeys(left);
  const rightKeys = moduleRefSetKeys(right);
  return (
    leftKeys !== null &&
    rightKeys !== null &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function envelopeModuleRefs(value: unknown): readonly ModuleControlRef[] {
  if (!Array.isArray(value)) repositoryError("conflict");
  return value.map((item) => {
    if (
      !isPlainDataObject(item) ||
      typeof item.module_id !== "string" ||
      typeof item.version !== "string" ||
      typeof item.descriptor_digest !== "string"
    ) {
      repositoryError("conflict");
    }
    return {
      moduleId: item.module_id,
      version: item.version,
      descriptorDigest: item.descriptor_digest as `sha256:${string}`,
    };
  });
}

function sameDigestSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function freezeDecoded<T extends ControlRecord>(record: T): T {
  return deepFreezeControlRecord(record) as T;
}

function decodeRegistrationRow(row: unknown): ModuleRegistrationRecord {
  const value = exactSqlRow(row, [
    "management_tenant_id",
    "module_id",
    "version",
    "descriptor_digest",
    "evidence_level",
    "production_eligible",
    "evidence_refs_json",
    "registered_by_actor_ref",
    "registered_at",
  ]);
  return freezeDecoded({
    managementTenantId: requiredSqlString(value, "management_tenant_id"),
    moduleId: requiredSqlString(value, "module_id"),
    version: requiredSqlString(value, "version"),
    descriptorDigest: requiredSqlString(value, "descriptor_digest") as `sha256:${string}`,
    evidenceLevel: requiredSqlString(value, "evidence_level") as "local_build",
    productionEligible: sqlBoolean(value.production_eligible) as false,
    evidenceRefs: requiredJson(value, "evidence_refs_json") as ModuleRegistrationRecord["evidenceRefs"],
    registeredByActorRef: requiredSqlString(value, "registered_by_actor_ref"),
    registeredAt: requiredSqlString(value, "registered_at"),
  });
}

function decodePreviewRow(row: unknown): ModulePreviewRecord {
  const value = exactSqlRow(row, [
    "management_tenant_id",
    "preview_ref",
    "canonical_hash",
    "intent",
    "base_release_id",
    "base_revision",
    "inventory_refs_json",
    "desired_modules_json",
    "diff_json",
    "validation_json",
    "creator_actor_ref",
    "created_at",
    "expires_at",
    "consumed",
    "target_release_id",
  ]);
  const intent = requiredSqlString(value, "intent");
  const base = {
    managementTenantId: requiredSqlString(value, "management_tenant_id"),
    previewRef: requiredSqlString(value, "preview_ref"),
    canonicalHash: requiredSqlString(value, "canonical_hash") as `mcp-control-hash/v1/preview/sha256:${string}`,
    baseReleaseId: nullableSqlString(value, "base_release_id"),
    baseRevision: requiredSqlInteger(value, "base_revision"),
    inventoryRefs: requiredJson(value, "inventory_refs_json"),
    desiredModules: requiredJson(value, "desired_modules_json"),
    diff: requiredJson(value, "diff_json"),
    validation: requiredJson(value, "validation_json"),
    creatorActorRef: requiredSqlString(value, "creator_actor_ref"),
    createdAt: requiredSqlString(value, "created_at"),
    expiresAt: requiredSqlString(value, "expires_at"),
    consumed: sqlBoolean(value.consumed),
  };
  if (intent === "change") {
    if (value.target_release_id !== null) repositoryError("invalid_state");
    return freezeDecoded({
      ...base,
      intent: "change",
    } as ModuleChangePreviewRecord);
  }
  if (intent === "rollback") {
    return freezeDecoded({
      ...base,
      intent: "rollback",
      targetReleaseId: requiredSqlString(value, "target_release_id"),
    } as ModuleRollbackPreviewRecord);
  }
  repositoryError("invalid_state");
}

function decodeApprovalRow(row: unknown): ModuleApprovalRecord {
  const value = exactSqlRow(row, [
    "management_tenant_id",
    "approval_id",
    "preview_ref",
    "decision",
    "preview_canonical_hash",
    "base_release_id",
    "base_revision",
    "inventory_digest_set_json",
    "expires_at",
    "reason_code",
    "approver_actor_ref",
    "decided_at",
    "consumed",
  ]);
  return freezeDecoded({
    managementTenantId: requiredSqlString(value, "management_tenant_id"),
    approvalId: requiredSqlString(value, "approval_id"),
    previewRef: requiredSqlString(value, "preview_ref"),
    decision: requiredSqlString(value, "decision") as ModuleApprovalRecord["decision"],
    previewCanonicalHash: requiredSqlString(value, "preview_canonical_hash") as `mcp-control-hash/v1/preview/sha256:${string}`,
    baseReleaseId: nullableSqlString(value, "base_release_id"),
    baseRevision: requiredSqlInteger(value, "base_revision"),
    inventoryDigestSet: requiredJson(value, "inventory_digest_set_json") as ModuleApprovalRecord["inventoryDigestSet"],
    expiresAt: requiredSqlString(value, "expires_at"),
    reasonCode: requiredSqlString(value, "reason_code"),
    approverActorRef: requiredSqlString(value, "approver_actor_ref"),
    decidedAt: requiredSqlString(value, "decided_at"),
    consumed: sqlBoolean(value.consumed),
  });
}

function decodeReleaseRow(row: unknown): ModuleReleaseRecord {
  const value = exactSqlRow(row, [
    "management_tenant_id",
    "release_id",
    "revision",
    "desired_modules_json",
    "previous_release_id",
    "preview_ref",
    "approval_id",
    "publisher_actor_ref",
    "status",
    "created_at",
    "published_at",
    "readback_ref",
    "reason_codes_json",
    "superseded_by_release_id",
  ]);
  const record = {
    managementTenantId: requiredSqlString(value, "management_tenant_id"),
    releaseId: requiredSqlString(value, "release_id"),
    revision: requiredSqlInteger(value, "revision"),
    desiredModules: requiredJson(value, "desired_modules_json"),
    previousReleaseId: nullableSqlString(value, "previous_release_id"),
    previewRef: requiredSqlString(value, "preview_ref"),
    approvalId: requiredSqlString(value, "approval_id"),
    publisherActorRef: requiredSqlString(value, "publisher_actor_ref"),
    createdAt: requiredSqlString(value, "created_at"),
    publishedAt: nullableSqlString(value, "published_at"),
    status: requiredSqlString(value, "status"),
    readbackRef: nullableSqlString(value, "readback_ref"),
    reasonCodes: requiredJson(value, "reason_codes_json"),
    supersededByReleaseId: nullableSqlString(value, "superseded_by_release_id"),
  } as ModuleReleaseRecord;
  if (record.publishedAt !== null) {
    const publicationComparison = compareRfc3339Instants(
      record.createdAt,
      record.publishedAt,
    );
    if (publicationComparison === 1) repositoryError("invalid_state");
  }
  return freezeDecoded(record);
}

function decodeReleaseHistoryRow(row: unknown): ModuleReleaseHistoryEntry {
  const value = exactSqlRow(row, [
    "management_tenant_id",
    "release_id",
    "revision",
    "desired_modules_json",
    "previous_release_id",
    "preview_ref",
    "approval_id",
    "publisher_actor_ref",
    "status",
    "created_at",
    "published_at",
    "readback_ref",
    "reason_codes_json",
    "superseded_by_release_id",
    "preview_management_tenant_id",
    "preview_preview_ref",
    "preview_intent",
    "preview_target_release_id",
  ]);
  const release = decodeReleaseRow({
    management_tenant_id: value.management_tenant_id,
    release_id: value.release_id,
    revision: value.revision,
    desired_modules_json: value.desired_modules_json,
    previous_release_id: value.previous_release_id,
    preview_ref: value.preview_ref,
    approval_id: value.approval_id,
    publisher_actor_ref: value.publisher_actor_ref,
    status: value.status,
    created_at: value.created_at,
    published_at: value.published_at,
    readback_ref: value.readback_ref,
    reason_codes_json: value.reason_codes_json,
    superseded_by_release_id: value.superseded_by_release_id,
  });
  if (
    requiredSqlString(value, "preview_management_tenant_id") !==
      release.managementTenantId ||
    requiredSqlString(value, "preview_preview_ref") !== release.previewRef
  ) {
    repositoryError("invalid_state");
  }
  const intent = requiredSqlString(value, "preview_intent");
  if (intent === "change") {
    if (value.preview_target_release_id !== null) repositoryError("invalid_state");
    return {
      release,
      intent: "change",
      rollbackTargetReleaseId: null,
    } satisfies ModuleReleaseHistoryEntry;
  }
  if (intent === "rollback") {
    return {
      release,
      intent: "rollback",
      rollbackTargetReleaseId: requiredSqlString(
        value,
        "preview_target_release_id",
      ),
    } satisfies ModuleReleaseHistoryEntry;
  }
  repositoryError("invalid_state");
}

function decodeReadbackRow(row: unknown): ModuleReadbackRecord {
  const value = exactSqlRow(row, [
    "management_tenant_id",
    "release_id",
    "attempt_id",
    "readback_ref",
    "revision",
    "applied_release_id",
    "applied_revision",
    "applied_modules_json",
    "status",
    "reason_codes_json",
    "checked_at",
  ]);
  const status = requiredSqlString(value, "status") as ModuleReadbackRecord["status"];
  if (status === "pending") repositoryError("invalid_state");
  return freezeDecoded({
    managementTenantId: requiredSqlString(value, "management_tenant_id"),
    readbackRef: requiredSqlString(value, "readback_ref"),
    releaseId: requiredSqlString(value, "release_id"),
    attemptId: requiredSqlString(value, "attempt_id"),
    revision: requiredSqlInteger(value, "revision"),
    appliedReleaseId: nullableSqlString(value, "applied_release_id"),
    appliedRevision: nullableSqlInteger(value, "applied_revision"),
    appliedModules: requiredJson(value, "applied_modules_json") as ModuleReadbackRecord["appliedModules"],
    status,
    reasonCodes: requiredJson(value, "reason_codes_json") as ModuleReadbackRecord["reasonCodes"],
    checkedAt: requiredSqlString(value, "checked_at"),
  } as ModuleReadbackRecord);
}

function decodeReadbackAttemptRow(row: unknown): ReadbackAttemptRecord {
  const value = exactSqlRow(row, [
    "management_tenant_id",
    "attempt_id",
    "action",
    "idempotency_key",
    "request_hash",
    "actor_ref",
    "request_id",
    "trace_id",
    "audit_id",
    "release_id",
    "revision",
    "desired_modules_json",
    "readback_ref",
    "owner_boot_id",
    "phase",
    "claimed_at",
    "finalized_at",
    "terminal_status",
    "applied_release_id",
    "applied_revision",
    "applied_modules_json",
    "reason_codes_json",
    "checked_at",
    "finalized_by_actor_ref",
    "reconciliation_event_sequence",
    "completion_event_sequence",
  ]);
  const record = {
    managementTenantId: requiredSqlString(value, "management_tenant_id"),
    attemptId: requiredSqlString(value, "attempt_id"),
    action: requiredSqlString(value, "action"),
    idempotencyKey: requiredSqlString(value, "idempotency_key"),
    requestHash: requiredSqlString(value, "request_hash"),
    actorRef: requiredSqlString(value, "actor_ref"),
    requestId: requiredSqlString(value, "request_id"),
    traceId: requiredSqlString(value, "trace_id"),
    auditId: requiredSqlString(value, "audit_id"),
    releaseId: requiredSqlString(value, "release_id"),
    revision: requiredSqlInteger(value, "revision"),
    desiredModules: requiredJson(value, "desired_modules_json"),
    readbackRef: requiredSqlString(value, "readback_ref"),
    ownerBootId: requiredSqlString(value, "owner_boot_id"),
    phase: requiredSqlString(value, "phase"),
    claimedAt: requiredSqlString(value, "claimed_at"),
    finalizedAt: nullableSqlString(value, "finalized_at"),
    terminalStatus: nullableSqlString(value, "terminal_status"),
    appliedReleaseId: nullableSqlString(value, "applied_release_id"),
    appliedRevision: nullableSqlInteger(value, "applied_revision"),
    appliedModules: requiredJson(value, "applied_modules_json"),
    reasonCodes: requiredJson(value, "reason_codes_json"),
    checkedAt: nullableSqlString(value, "checked_at"),
    finalizedByActorRef: nullableSqlString(value, "finalized_by_actor_ref"),
    reconciliationEventSequence: nullableSqlInteger(
      value,
      "reconciliation_event_sequence",
    ),
    completionEventSequence: nullableSqlInteger(value, "completion_event_sequence"),
  } as unknown as ReadbackAttemptRecord;
  try {
    assertReadbackAttemptRecord(record);
  } catch (error) {
    if (error instanceof ModuleControlRepositoryError) throw error;
    repositoryError("invalid_state");
  }
  return deepFreezeReadbackAttempt(record) as ReadbackAttemptRecord;
}

function decodeIdempotencyRow(row: unknown): ControlIdempotencyRecord {
  const value = exactSqlRow(row, [
    "management_tenant_id",
    "action",
    "idempotency_key",
    "request_hash",
    "actor_ref",
    "status",
    "domain_record_ref",
    "final_result_json",
    "created_at",
    "expires_at",
  ]);
  const finalResultJson = value.final_result_json;
  if (finalResultJson !== null && typeof finalResultJson !== "string") {
    repositoryError("invalid_state");
  }
  return freezeDecoded({
    managementTenantId: requiredSqlString(value, "management_tenant_id"),
    action: requiredSqlString(value, "action") as ControlIdempotencyRecord["action"],
    idempotencyKey: requiredSqlString(value, "idempotency_key"),
    requestHash: requiredSqlString(value, "request_hash") as `mcp-control-hash/v1/request/sha256:${string}`,
    actorRef: requiredSqlString(value, "actor_ref"),
    status: requiredSqlString(value, "status") as ControlIdempotencyRecord["status"],
    domainRecordRef: nullableSqlString(value, "domain_record_ref"),
    finalResult:
      finalResultJson === null
        ? null
        : (parseRepositoryJson(finalResultJson) as ControlFinalResult),
    createdAt: requiredSqlString(value, "created_at"),
    expiresAt: requiredSqlString(value, "expires_at"),
  } as ControlIdempotencyRecord);
}

function decodeEventRow(row: unknown): ControlEventRecord {
  const value = exactSqlRow(row, [
    "sequence",
    "management_tenant_id",
    "event_id",
    "actor_ref",
    "action",
    "object_ref",
    "status",
    "reason_codes_json",
    "payload_json",
    "occurred_at",
  ]);
  const payload = requiredJson(value, "payload_json");
  if (!isPlainDataObject(payload)) repositoryError("invalid_state");
  const payloadKeys = Reflect.ownKeys(payload);
  if (payloadKeys.length !== 1 || !payloadKeys.includes("detail")) {
    repositoryError("invalid_state");
  }
  const detail = payload.detail;
  if (!isPlainDataObject(detail) || typeof detail.kind !== "string") {
    repositoryError("invalid_state");
  }
  const storedAction = requiredSqlString(value, "action");
  const eventStatus = requiredSqlString(value, "status");
  return freezeDecoded({
    managementTenantId: requiredSqlString(value, "management_tenant_id"),
    eventId: requiredSqlString(value, "event_id"),
    sequence: requiredSqlInteger(value, "sequence"),
    actorRef: requiredSqlString(value, "actor_ref"),
    action: storedAction as ControlEventRecord["action"],
    objectRef: requiredSqlString(value, "object_ref"),
    kind: detail.kind as ControlEventRecord["kind"],
    status: eventStatus as ControlEventRecord["status"],
    reasonCodes: requiredJson(value, "reason_codes_json"),
    detail,
    occurredAt: requiredSqlString(value, "occurred_at"),
  } as unknown as ControlEventRecord);
}

const REGISTRATION_SELECT = `
  SELECT management_tenant_id, module_id, version, descriptor_digest,
         evidence_level, production_eligible, evidence_refs_json,
         registered_by_actor_ref, registered_at
  FROM module_registrations
  WHERE management_tenant_id = ? AND module_id = ? AND version = ? AND descriptor_digest = ?`;
const PREVIEW_SELECT = `
  SELECT management_tenant_id, preview_ref, canonical_hash, intent,
         base_release_id, base_revision, inventory_refs_json,
         desired_modules_json, diff_json, validation_json, creator_actor_ref,
         created_at, expires_at, consumed, target_release_id
  FROM module_previews
  WHERE management_tenant_id = ? AND preview_ref = ?`;
const APPROVAL_SELECT = `
  SELECT management_tenant_id, approval_id, preview_ref, decision,
         preview_canonical_hash, base_release_id, base_revision,
         inventory_digest_set_json, expires_at, reason_code,
         approver_actor_ref, decided_at, consumed
  FROM module_approvals
  WHERE management_tenant_id = ? AND approval_id = ?`;
const RELEASE_SELECT = `
  SELECT management_tenant_id, release_id, revision, desired_modules_json,
         previous_release_id, preview_ref, approval_id, publisher_actor_ref,
         status, created_at, published_at, readback_ref, reason_codes_json,
         superseded_by_release_id
  FROM module_releases
  WHERE management_tenant_id = ? AND release_id = ?`;
const RELEASE_HISTORY_SELECT = `
  SELECT release_window.management_tenant_id, release_window.release_id,
         release_window.revision, release_window.desired_modules_json,
         release_window.previous_release_id, release_window.preview_ref,
         release_window.approval_id, release_window.publisher_actor_ref,
         release_window.status, release_window.created_at,
         release_window.published_at, release_window.readback_ref,
         release_window.reason_codes_json, release_window.superseded_by_release_id,
         preview.management_tenant_id AS preview_management_tenant_id,
         preview.preview_ref AS preview_preview_ref,
         preview.intent AS preview_intent,
         preview.target_release_id AS preview_target_release_id
  FROM (
    SELECT management_tenant_id, release_id, revision, desired_modules_json,
           previous_release_id, preview_ref, approval_id, publisher_actor_ref,
           status, created_at, published_at, readback_ref, reason_codes_json,
           superseded_by_release_id
    FROM module_releases
    WHERE management_tenant_id = ?
    ORDER BY revision DESC, release_id DESC
    LIMIT ?
  ) AS release_window
  LEFT JOIN module_previews AS preview
    ON preview.management_tenant_id = release_window.management_tenant_id
   AND preview.preview_ref = release_window.preview_ref
  ORDER BY release_window.revision DESC, release_window.release_id DESC`;
const READBACK_SELECT = `
  SELECT management_tenant_id, release_id, attempt_id, readback_ref, revision,
         applied_release_id, applied_revision, applied_modules_json, status,
         reason_codes_json, checked_at
  FROM module_readbacks
  WHERE management_tenant_id = ? AND release_id = ?`;
const READBACK_ATTEMPT_SELECT = `
  SELECT management_tenant_id, attempt_id, action, idempotency_key, request_hash,
         actor_ref, request_id, trace_id, audit_id, release_id, revision,
         desired_modules_json, readback_ref, owner_boot_id, phase, claimed_at,
         finalized_at, terminal_status, applied_release_id, applied_revision,
         applied_modules_json, reason_codes_json, checked_at,
         finalized_by_actor_ref, reconciliation_event_sequence,
         completion_event_sequence
  FROM module_readback_attempts`;
const IDEMPOTENCY_SELECT = `
  SELECT management_tenant_id, action, idempotency_key, request_hash, actor_ref, status,
         domain_record_ref, final_result_json, created_at, expires_at
  FROM module_control_idempotency
  WHERE management_tenant_id = ? AND action = ? AND idempotency_key = ?`;
const EVENT_SELECT = `
  SELECT sequence, management_tenant_id, event_id, actor_ref, action,
         object_ref, status, reason_codes_json, payload_json, occurred_at
  FROM module_control_events
  WHERE management_tenant_id = ? AND object_ref = ?
  ORDER BY sequence DESC`;

type PersistedIdempotencyAuthority = {
  readonly record: ControlIdempotencyRecord;
};

type PersistedEventAuthority = {
  readonly event: ControlEventRecord;
  readonly idempotencyKey: string;
  readonly requestHash: string;
};

function decodeIdempotencyAuthorityRow(row: unknown): PersistedIdempotencyAuthority {
  const value = exactSqlRow(row, [
    "management_tenant_id",
    "action",
    "idempotency_key",
    "request_hash",
    "actor_ref",
    "status",
    "domain_record_ref",
    "final_result_json",
    "created_at",
    "expires_at",
  ]);
  return {
    record: decodeIdempotencyRow({
      management_tenant_id: value.management_tenant_id,
      action: value.action,
      idempotency_key: value.idempotency_key,
      request_hash: value.request_hash,
      actor_ref: value.actor_ref,
      status: value.status,
      domain_record_ref: value.domain_record_ref,
      final_result_json: value.final_result_json,
      created_at: value.created_at,
      expires_at: value.expires_at,
    }),
  };
}

function decodeEventAuthorityRow(row: unknown): PersistedEventAuthority {
  const value = exactSqlRow(row, [
    "sequence",
    "management_tenant_id",
    "event_id",
    "actor_ref",
    "action",
    "idempotency_key",
    "request_hash",
    "object_ref",
    "status",
    "reason_codes_json",
    "payload_json",
    "occurred_at",
  ]);
  const idempotencyKey = requiredSqlString(value, "idempotency_key");
  assertRepositoryIdentifier(idempotencyKey);
  return {
    idempotencyKey,
    requestHash: requiredSqlString(value, "request_hash"),
    event: decodeEventRow({
      sequence: value.sequence,
      management_tenant_id: value.management_tenant_id,
      event_id: value.event_id,
      actor_ref: value.actor_ref,
      action: value.action,
      object_ref: value.object_ref,
      status: value.status,
      reason_codes_json: value.reason_codes_json,
      payload_json: value.payload_json,
      occurred_at: value.occurred_at,
    }),
  };
}

function selectOne(
  database: DatabaseSync,
  statement: string,
  parameters: readonly (string | number | null)[],
): unknown {
  return database.prepare(statement).get(...parameters) ?? null;
}

function findRegistration(
  database: DatabaseSync,
  managementTenantId: string,
  moduleId: string,
  version: string,
  descriptorDigest: string,
): ModuleRegistrationRecord | null {
  const row = selectOne(database, REGISTRATION_SELECT, [
    managementTenantId,
    moduleId,
    version,
    descriptorDigest,
  ]);
  return row === null ? null : decodeRegistrationRow(row);
}

function findPreview(
  database: DatabaseSync,
  managementTenantId: string,
  previewRef: string,
): ModulePreviewRecord | null {
  const row = selectOne(database, PREVIEW_SELECT, [managementTenantId, previewRef]);
  return row === null ? null : decodePreviewRow(row);
}

function findApproval(
  database: DatabaseSync,
  managementTenantId: string,
  approvalId: string,
): ModuleApprovalRecord | null {
  const row = selectOne(database, APPROVAL_SELECT, [managementTenantId, approvalId]);
  return row === null ? null : decodeApprovalRow(row);
}

function findRelease(
  database: DatabaseSync,
  managementTenantId: string,
  releaseId: string,
): ModuleReleaseRecord | null {
  const row = selectOne(database, RELEASE_SELECT, [managementTenantId, releaseId]);
  return row === null ? null : decodeReleaseRow(row);
}

function findReadback(
  database: DatabaseSync,
  managementTenantId: string,
  releaseId: string,
): ModuleReadbackRecord | null {
  const row = selectOne(database, READBACK_SELECT, [managementTenantId, releaseId]);
  return row === null ? null : decodeReadbackRow(row);
}

function findEventBySequence(
  database: DatabaseSync,
  managementTenantId: string,
  sequence: number,
): ControlEventRecord | null {
  const row = selectOne(
    database,
    `SELECT sequence, management_tenant_id, event_id, actor_ref, action,
            object_ref, status, reason_codes_json, payload_json, occurred_at
     FROM module_control_events
     WHERE management_tenant_id = ? AND sequence = ?`,
    [managementTenantId, sequence],
  );
  return row === null ? null : decodeEventRow(row);
}

function findReadbackAttempt(
  database: DatabaseSync,
  managementTenantId: string,
  attemptId: string,
): ReadbackAttemptRecord | null {
  const row = database
    .prepare(`${READBACK_ATTEMPT_SELECT} WHERE management_tenant_id = ? AND attempt_id = ?`)
    .get(managementTenantId, attemptId);
  return row === undefined ? null : decodeReadbackAttemptRow(row);
}

function findReadbackAttemptByIdempotency(
  database: DatabaseSync,
  managementTenantId: string,
  action: ReadbackAttemptRecord["action"],
  idempotencyKey: string,
): ReadbackAttemptRecord | null {
  const rows = database
    .prepare(
      `${READBACK_ATTEMPT_SELECT}
       WHERE management_tenant_id = ? AND action = ? AND idempotency_key = ?`,
    )
    .all(managementTenantId, action, idempotencyKey) as unknown[];
  if (rows.length > 1) repositoryError("invalid_state");
  return rows.length === 0 ? null : decodeReadbackAttemptRow(rows[0]);
}

function findReadbackAttempts(
  database: DatabaseSync,
  managementTenantId: string,
  releaseId?: string,
  revision?: number,
): readonly ReadbackAttemptRecord[] {
  const clauses = ["management_tenant_id = ?"];
  const parameters: (string | number)[] = [managementTenantId];
  if (releaseId !== undefined) {
    clauses.push("release_id = ?");
    parameters.push(releaseId);
  }
  if (revision !== undefined) {
    clauses.push("revision = ?");
    parameters.push(revision);
  }
  const rows = database
    .prepare(
      `${READBACK_ATTEMPT_SELECT} WHERE ${clauses.join(" AND ")}
       ORDER BY CASE WHEN reconciliation_event_sequence IS NULL THEN 1 ELSE 0 END,
                reconciliation_event_sequence DESC, attempt_id DESC`,
    )
    .all(...parameters) as unknown[];
  return rows.map((row) => decodeReadbackAttemptRow(row));
}

function findIdempotency(
  database: DatabaseSync,
  managementTenantId: string,
  action: string,
  idempotencyKey: string,
): ControlIdempotencyRecord | null {
  const row = selectOne(database, IDEMPOTENCY_SELECT, [
    managementTenantId,
    action,
    idempotencyKey,
  ]);
  if (row === null) return null;
  const record = decodeIdempotencyRow(row);
  if (
    (record.status === "domain_committed" || record.status === "completed") &&
    !persistedIdempotencyDomainExists(database, managementTenantId, record)
  ) {
    repositoryError("invalid_state");
  }
  if (record.status === "completed") {
    if (record.finalResult === null || record.domainRecordRef === null) {
      repositoryError("invalid_state");
    }
    let expectedRevision: number | undefined;
    if (
      record.action === "deployments.publish" ||
      record.action === "deployments.reconcile"
    ) {
      const release = findRelease(database, managementTenantId, record.domainRecordRef);
      if (release === null) repositoryError("invalid_state");
      expectedRevision = release.revision;
    }
    try {
      validateFinalResult(
        record.finalResult,
        record.action,
        record.domainRecordRef,
        expectedRevision,
      );
    } catch {
      repositoryError("invalid_state");
    }
  }
  return record;
}

function persistedIdempotencyDomainExists(
  database: DatabaseSync,
  managementTenantId: string,
  record: ControlIdempotencyRecord,
): boolean {
  if (record.domainRecordRef === null) return false;
  switch (record.action) {
    case "packages.register":
      return findEventByIdempotencyDomain(
        database,
        managementTenantId,
        record,
        "registration",
      ) !== null;
    case "deployments.preview":
      return findEventByIdempotencyDomain(
        database,
        managementTenantId,
        record,
        "preview",
      ) !== null;
    case "approvals.decide":
      return findEventByIdempotencyDomain(
        database,
        managementTenantId,
        record,
        "approval",
      ) !== null;
    case "deployments.publish":
    case "deployments.reconcile":
      return findRelease(database, managementTenantId, record.domainRecordRef) !== null;
    default:
      return false;
  }
}

function findEventsForObject(
  database: DatabaseSync,
  managementTenantId: string,
  objectRef: string,
): readonly ControlEventRecord[] {
  const rows = database
    .prepare(EVENT_SELECT)
    .all(managementTenantId, objectRef) as unknown[];
  return rows.map((row) => decodeEventRow(row));
}

function findDomainEvent(
  database: DatabaseSync,
  managementTenantId: string,
  objectRef: string,
  kind: ControlEventRecord["kind"],
): ControlEventRecord | null {
  return (
    findEventsForObject(database, managementTenantId, objectRef).find(
      (event) => event.kind === kind,
    ) ?? null
  );
}

function findEventByIdempotencyDomain(
  database: DatabaseSync,
  managementTenantId: string,
  idempotency: ControlIdempotencyRecord,
  kind: ControlEventRecord["kind"],
): ControlEventRecord | null {
  if (idempotency.domainRecordRef === null) return null;
  if (kind === "registration") {
    const events = findEventsForObject(
      database,
      managementTenantId,
      idempotency.domainRecordRef,
    );
    const registrationEvent = events.find((event) => event.kind === kind);
    if (registrationEvent !== undefined) return registrationEvent;
    const allEvents = database
      .prepare(
        `SELECT sequence, management_tenant_id, event_id, actor_ref, action,
                object_ref, status, reason_codes_json, payload_json, occurred_at
         FROM module_control_events
         WHERE management_tenant_id = ? AND action = 'packages.register'
         ORDER BY sequence DESC`,
      )
      .all(managementTenantId) as unknown[];
    return allEvents
      .map((row) => decodeEventRow(row))
      .find(
        (event) =>
          event.kind === kind &&
          event.detail.kind === "registration" &&
          `registration:${event.detail.moduleId}:${event.detail.version}:${event.detail.descriptorDigest}` ===
            idempotency.domainRecordRef,
      ) ?? null;
  }
  return findDomainEvent(
    database,
    managementTenantId,
    idempotency.domainRecordRef,
    kind,
  );
}

function nextEventSequence(database: DatabaseSync): number {
  const row = exactSqlRow(
    database
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM module_control_events")
      .get(),
    ["sequence"],
  );
  return requiredSqlInteger(row, "sequence");
}

function previousPersistedEvent(database: DatabaseSync): ControlEventRecord | null {
  const row = database
    .prepare(
      `SELECT sequence, management_tenant_id, event_id, actor_ref, action,
              object_ref, status, reason_codes_json, payload_json, occurred_at
       FROM module_control_events
       ORDER BY sequence DESC
       LIMIT 1`,
    )
    .get();
  return row === undefined ? null : decodeEventRow(row);
}

function eventOccurredAt(
  database: DatabaseSync,
  record: ControlRecord,
): string {
  const authorityAt = recordTimestamp(record);
  if (!("idempotencyKey" in record) || record.status !== "completed") {
    return authorityAt;
  }
  return resolveMonotonicControlEventOccurredAt(
    authorityAt,
    previousPersistedEvent(database),
  );
}

function insertEvent(
  database: DatabaseSync,
  metadata: ControlRequestMetadata,
  record: ControlRecord,
): ControlEventRecord {
  const sequence = nextEventSequence(database);
  const eventId = `event_${randomUUID()}`;
  const occurredAt = eventOccurredAt(database, record);
  const event = {
    managementTenantId: metadata.managementTenantId,
    eventId,
    sequence,
    actorRef: metadata.actorRef,
    action: metadata.event.action,
    objectRef: metadata.event.objectRef,
    kind: metadata.event.kind,
    status: metadata.event.status,
    reasonCodes: metadata.event.reasonCodes,
    detail: metadata.event.detail,
    occurredAt,
  } as ControlEventRecord;
  database
    .prepare(
      `INSERT INTO module_control_events
        (sequence, management_tenant_id, event_id, actor_ref, action,
         idempotency_key, request_hash, object_ref, status, reason_codes_json,
         payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sequence,
      metadata.managementTenantId,
      eventId,
      metadata.actorRef,
      metadata.event.action,
      metadata.idempotencyKey,
      metadata.requestHash,
      metadata.event.objectRef,
      metadata.event.status,
      repositoryJson(metadata.event.reasonCodes),
      repositoryJson({ detail: metadata.event.detail }),
      occurredAt,
    );
  return freezeDecoded(event);
}

function attemptIdempotencyRecordRef(
  action: ReadbackAttemptRecord["action"],
  idempotencyKey: string,
): string {
  return `idempotency:${action}:${idempotencyKey}`;
}

function insertReadbackAttemptEvent(
  database: DatabaseSync,
  attempt: ReadbackAttemptRecord,
  kind: "reconciliation" | "completion",
  status: "completed" | "verified" | "mismatch" | "unknown",
  reasonCodes: readonly string[],
  occurredAt: string,
  actorRef: string,
): ControlEventRecord {
  const sequence = nextEventSequence(database);
  const eventId = `event_${randomUUID()}`;
  const objectRef =
    kind === "reconciliation"
      ? attempt.releaseId
      : attemptIdempotencyRecordRef(attempt.action, attempt.idempotencyKey);
  const detail =
    kind === "reconciliation"
      ? {
          kind: "reconciliation" as const,
          releaseId: attempt.releaseId,
          revision: attempt.revision,
          readbackRef: attempt.readbackRef,
          status: status as "verified" | "mismatch" | "unknown",
        }
      : {
          kind: "idempotency" as const,
          recordRef: objectRef,
          domainRecordRef: attempt.releaseId,
          status: "completed" as const,
        };
  database
    .prepare(
      `INSERT INTO module_control_events
        (sequence, management_tenant_id, event_id, actor_ref, action,
         idempotency_key, request_hash, object_ref, status, reason_codes_json,
         payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sequence,
      attempt.managementTenantId,
      eventId,
      actorRef,
      attempt.action,
      attempt.idempotencyKey,
      attempt.requestHash,
      objectRef,
      status,
      repositoryJson(reasonCodes),
      repositoryJson({ detail }),
      occurredAt,
    );
  const event = database
    .prepare(
      `SELECT sequence, management_tenant_id, event_id, actor_ref, action,
              object_ref, status, reason_codes_json, payload_json, occurred_at
       FROM module_control_events WHERE sequence = ?`,
    )
    .get(sequence);
  if (event === undefined) repositoryError("invalid_state");
  return decodeEventRow(event);
}

function findActiveRelease(
  database: DatabaseSync,
  managementTenantId: string,
): ModuleReleaseRecord | null {
  const row = database
    .prepare(
      `${RELEASE_SELECT.replace(
        "WHERE management_tenant_id = ? AND release_id = ?",
        "WHERE management_tenant_id = ? AND status = 'active_verified' ORDER BY revision DESC LIMIT 1",
      )}`,
    )
    .get(managementTenantId) as unknown;
  return row === undefined ? null : decodeReleaseRow(row);
}

function findReleaseHistory(
  database: DatabaseSync,
  managementTenantId: string,
): readonly ModuleReleaseHistoryEntry[] {
  const rows = database
    .prepare(RELEASE_HISTORY_SELECT)
    .all(
      managementTenantId,
      CONTROL_STATE_RELEASE_HISTORY_WINDOW,
    ) as unknown[];
  return rows.map((row) => decodeReleaseHistoryRow(row));
}

function findPendingRelease(
  database: DatabaseSync,
  managementTenantId: string,
): ModuleReleaseRecord | null {
  const row = database
    .prepare(
      `${RELEASE_SELECT.replace(
        "WHERE management_tenant_id = ? AND release_id = ?",
        "WHERE management_tenant_id = ? AND status = 'published_pending_readback' ORDER BY revision DESC LIMIT 1",
      )}`,
    )
    .get(managementTenantId) as unknown;
  return row === undefined ? null : decodeReleaseRow(row);
}

function findNewestUnresolvedRelease(
  database: DatabaseSync,
  managementTenantId: string,
): ModuleReleaseRecord | null {
  const row = database
    .prepare(
      `${RELEASE_SELECT.replace(
        "WHERE management_tenant_id = ? AND release_id = ?",
        "WHERE management_tenant_id = ? AND status IN ('published_pending_readback', 'manual_review') ORDER BY revision DESC LIMIT 1",
      )}`,
    )
    .get(managementTenantId) as unknown;
  return row === undefined ? null : decodeReleaseRow(row);
}

function hasDomainCommittedPublish(
  database: DatabaseSync,
  managementTenantId: string,
): boolean {
  const row = database
    .prepare(
      `SELECT 1 AS found
       FROM module_control_idempotency
       WHERE management_tenant_id = ?
         AND action = 'deployments.publish'
         AND status = 'domain_committed'
       LIMIT 1`,
    )
    .get(managementTenantId) as unknown;
  if (row === undefined) return false;
  return requiredSqlInteger(exactSqlRow(row, ["found"]), "found") === 1;
}

function findLatestPreview(
  database: DatabaseSync,
  managementTenantId: string,
): ModulePreviewRecord | null {
  const rows = database
    .prepare(
      `${PREVIEW_SELECT.replace(
        "WHERE management_tenant_id = ? AND preview_ref = ?",
        "WHERE management_tenant_id = ? ORDER BY preview_ref",
      )}`,
    )
    .iterate(managementTenantId) as Iterable<unknown>;
  return latestByInstant(
    rows,
    decodePreviewRow,
    (record) => record.createdAt,
    (record) => record.previewRef,
  );
}

function findLatestApproval(
  database: DatabaseSync,
  managementTenantId: string,
): ModuleApprovalRecord | null {
  const rows = database
    .prepare(
      `${APPROVAL_SELECT.replace(
        "WHERE management_tenant_id = ? AND approval_id = ?",
        "WHERE management_tenant_id = ? ORDER BY approval_id",
      )}`,
    )
    .iterate(managementTenantId) as Iterable<unknown>;
  return latestByInstant(
    rows,
    decodeApprovalRow,
    (record) => record.decidedAt,
    (record) => record.approvalId,
  );
}

function findLatestReadback(
  database: DatabaseSync,
  managementTenantId: string,
): ModuleReadbackRecord | null {
  const rows = database
    .prepare(
      `${READBACK_SELECT.replace(
        "WHERE management_tenant_id = ? AND release_id = ?",
        "WHERE management_tenant_id = ? ORDER BY release_id",
      )}`,
    )
    .iterate(managementTenantId) as Iterable<unknown>;
  return latestByInstant(
    rows,
    decodeReadbackRow,
    (record) => record.checkedAt,
    (record) => record.releaseId,
  );
}

function findRegistrations(
  database: DatabaseSync,
  managementTenantId: string,
): readonly ModuleRegistrationRecord[] {
  const rows = database
    .prepare(
      `SELECT management_tenant_id, module_id, version, descriptor_digest,
              evidence_level, production_eligible, evidence_refs_json,
              registered_by_actor_ref, registered_at
       FROM module_registrations
       WHERE management_tenant_id = ?
       ORDER BY module_id, version, descriptor_digest`,
    )
    .all(managementTenantId) as unknown[];
  return rows.map((row) => decodeRegistrationRow(row));
}

function findEventProjection(
  database: DatabaseSync,
  managementTenantId: string,
): {
  readonly events: readonly ControlEventRecord[];
  readonly eventsTruncated: boolean;
} {
  const rows = database
    .prepare(
      `SELECT sequence, management_tenant_id, event_id, actor_ref, action,
              object_ref, status, reason_codes_json, payload_json, occurred_at
       FROM (
         SELECT sequence, management_tenant_id, event_id, actor_ref, action,
                object_ref, status, reason_codes_json, payload_json, occurred_at
         FROM module_control_events
         WHERE management_tenant_id = ?
         ORDER BY sequence DESC
         LIMIT ?
       ) AS recent_events
       ORDER BY sequence ASC`,
    )
    .all(managementTenantId, CONTROL_STATE_EVENT_QUERY_LIMIT) as unknown[];
  const events = rows.map((row) => decodeEventRow(row));
  return {
    events: events.slice(-CONTROL_STATE_EVENT_WINDOW),
    eventsTruncated: events.length === CONTROL_STATE_EVENT_QUERY_LIMIT,
  };
}

function insertIdempotencyReservation(
  database: DatabaseSync,
  metadata: ControlRequestMetadata,
  record: ControlRecord,
  status: "reserved" | "domain_committed",
  domainRecordRef: string | null,
): void {
  const createdAt = recordTimestamp(record);
  database
    .prepare(
      `INSERT INTO module_control_idempotency
        (management_tenant_id, action, idempotency_key, request_hash, actor_ref,
         status, domain_record_ref, final_result_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      metadata.managementTenantId,
      metadata.action,
      metadata.idempotencyKey,
      metadata.requestHash,
      metadata.actorRef,
      status,
      domainRecordRef,
      createdAt,
      idempotencyExpiry(createdAt),
    );
}

function completeIdempotencyRow(
  database: DatabaseSync,
  metadata: ControlRequestMetadata,
  domainRecordRef: string,
  finalResult: ControlFinalResult,
): ControlIdempotencyRecord {
  database
    .prepare(
      `UPDATE module_control_idempotency
       SET status = 'completed', domain_record_ref = ?, final_result_json = ?
       WHERE management_tenant_id = ? AND action = ? AND idempotency_key = ?
         AND request_hash = ? AND status IN ('reserved', 'domain_committed')`,
    )
    .run(
      domainRecordRef,
      repositoryJson(finalResult),
      metadata.managementTenantId,
      metadata.action,
      metadata.idempotencyKey,
      metadata.requestHash,
    );
  const result = findIdempotency(
    database,
    metadata.managementTenantId,
    metadata.action,
    metadata.idempotencyKey,
  );
  if (result === null || result.status !== "completed") repositoryError("invalid_state");
  return result;
}

function insertRegistration(
  database: DatabaseSync,
  record: ModuleRegistrationRecord,
): void {
  database
    .prepare(
      `INSERT INTO module_registrations
        (management_tenant_id, module_id, version, descriptor_digest,
         evidence_level, production_eligible, evidence_refs_json,
         registered_by_actor_ref, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.managementTenantId,
      record.moduleId,
      record.version,
      record.descriptorDigest,
      record.evidenceLevel,
      record.productionEligible ? 1 : 0,
      repositoryJson(record.evidenceRefs),
      record.registeredByActorRef,
      record.registeredAt,
    );
}

function insertPreview(database: DatabaseSync, record: ModulePreviewRecord): void {
  database
    .prepare(
      `INSERT INTO module_previews
        (management_tenant_id, preview_ref, canonical_hash, intent,
         base_release_id, base_revision, inventory_refs_json,
         desired_modules_json, diff_json, validation_json, creator_actor_ref,
         created_at, expires_at, consumed, target_release_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.managementTenantId,
      record.previewRef,
      record.canonicalHash,
      record.intent,
      record.baseReleaseId,
      record.baseRevision,
      repositoryJson(record.inventoryRefs),
      repositoryJson(record.desiredModules),
      repositoryJson(record.diff),
      repositoryJson(record.validation),
      record.creatorActorRef,
      record.createdAt,
      record.expiresAt,
      record.consumed ? 1 : 0,
      record.intent === "rollback" ? record.targetReleaseId : null,
    );
}

function insertApproval(
  database: DatabaseSync,
  record: ModuleApprovalRecord,
): void {
  const preview = findPreview(database, record.managementTenantId, record.previewRef);
  if (preview === null) repositoryError("not_found");
  if (
    preview.canonicalHash !== record.previewCanonicalHash ||
    preview.baseReleaseId !== record.baseReleaseId ||
    preview.baseRevision !== record.baseRevision ||
    preview.expiresAt !== record.expiresAt ||
    !sameDigestSet(
      preview.inventoryRefs.map((ref) => ref.descriptorDigest),
      record.inventoryDigestSet,
    ) ||
    preview.consumed ||
    isExpiredAt(preview.expiresAt, record.decidedAt)
  ) {
    repositoryError("conflict");
  }
  database
    .prepare(
      `INSERT INTO module_approvals
        (management_tenant_id, approval_id, preview_ref, decision,
         preview_canonical_hash, base_release_id, base_revision,
         inventory_digest_set_json, expires_at, reason_code,
         approver_actor_ref, decided_at, consumed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.managementTenantId,
      record.approvalId,
      record.previewRef,
      record.decision,
      record.previewCanonicalHash,
      record.baseReleaseId,
      record.baseRevision,
      repositoryJson(record.inventoryDigestSet),
      record.expiresAt,
      record.reasonCode,
      record.approverActorRef,
      record.decidedAt,
      record.consumed ? 1 : 0,
    );
}

function insertRelease(
  database: DatabaseSync,
  record: ModuleReleaseRecord,
): void {
  database
    .prepare(
      `INSERT INTO module_releases
        (management_tenant_id, release_id, revision, desired_modules_json,
         previous_release_id, preview_ref, approval_id, publisher_actor_ref,
         status, created_at, published_at, readback_ref, reason_codes_json,
         superseded_by_release_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.managementTenantId,
      record.releaseId,
      record.revision,
      repositoryJson(record.desiredModules),
      record.previousReleaseId,
      record.previewRef,
      record.approvalId,
      record.publisherActorRef,
      record.status,
      record.createdAt,
      record.publishedAt,
      record.readbackRef,
      repositoryJson(record.reasonCodes),
      record.supersededByReleaseId,
    );
}

function insertReadback(
  database: DatabaseSync,
  record: ModuleReadbackRecord,
): void {
  if (record.status === "pending" || typeof record.attemptId !== "string") {
    repositoryError("invalid_state");
  }
  database
    .prepare(
      `INSERT INTO module_readbacks
        (management_tenant_id, release_id, attempt_id, readback_ref, revision,
         applied_release_id, applied_revision, applied_modules_json, status,
         reason_codes_json, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.managementTenantId,
      record.releaseId,
      record.attemptId,
      record.readbackRef,
      record.revision,
      record.appliedReleaseId,
      record.appliedRevision,
      repositoryJson(record.appliedModules),
      record.status,
      repositoryJson(record.reasonCodes),
      record.checkedAt,
    );
}

function updateReadback(
  database: DatabaseSync,
  record: ModuleReadbackRecord,
): void {
  if (record.status === "pending" || typeof record.attemptId !== "string") {
    repositoryError("invalid_state");
  }
  database
    .prepare(
      `UPDATE module_readbacks
       SET attempt_id = ?, readback_ref = ?, revision = ?, applied_release_id = ?,
           applied_revision = ?, applied_modules_json = ?, status = ?,
           reason_codes_json = ?, checked_at = ?
       WHERE management_tenant_id = ? AND release_id = ? AND revision = ?`,
    )
    .run(
      record.attemptId,
      record.readbackRef,
      record.revision,
      record.appliedReleaseId,
      record.appliedRevision,
      repositoryJson(record.appliedModules),
      record.status,
      repositoryJson(record.reasonCodes),
      record.checkedAt,
      record.managementTenantId,
      record.releaseId,
      record.revision,
    );
}

function insertClaimedReadbackAttempt(
  database: DatabaseSync,
  attempt: ReadbackAttemptRecord,
): void {
  if (attempt.phase !== "claimed") repositoryError("invalid_state");
  database
    .prepare(
      `INSERT INTO module_readback_attempts
        (management_tenant_id, attempt_id, action, idempotency_key,
         request_hash, actor_ref, request_id, trace_id, audit_id, release_id,
         revision, desired_modules_json, readback_ref, owner_boot_id, phase,
         claimed_at, finalized_at, terminal_status, applied_release_id,
         applied_revision, applied_modules_json, reason_codes_json, checked_at,
         finalized_by_actor_ref, reconciliation_event_sequence,
         completion_event_sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
               NULL, NULL, '[]', '[]', NULL, NULL, NULL, NULL)`,
    )
    .run(
      attempt.managementTenantId,
      attempt.attemptId,
      attempt.action,
      attempt.idempotencyKey,
      attempt.requestHash,
      attempt.actorRef,
      attempt.requestId,
      attempt.traceId,
      attempt.auditId,
      attempt.releaseId,
      attempt.revision,
      repositoryJson(attempt.desiredModules),
      attempt.readbackRef,
      attempt.ownerBootId,
      attempt.phase,
      attempt.claimedAt,
    );
}

function updateFinalizedReadbackAttempt(
  database: DatabaseSync,
  attempt: ReadbackAttemptRecord,
): void {
  if (
    attempt.phase !== "finalized" ||
    attempt.finalizedAt === null ||
    attempt.terminalStatus === null ||
    attempt.checkedAt === null ||
    attempt.finalizedByActorRef === null ||
    attempt.reconciliationEventSequence === null ||
    attempt.completionEventSequence === null
  ) {
    repositoryError("invalid_state");
  }
  database
    .prepare(
      `UPDATE module_readback_attempts
       SET phase = 'finalized', finalized_at = ?, terminal_status = ?,
           applied_release_id = ?, applied_revision = ?, applied_modules_json = ?,
           reason_codes_json = ?, checked_at = ?, finalized_by_actor_ref = ?,
           reconciliation_event_sequence = ?, completion_event_sequence = ?
       WHERE management_tenant_id = ? AND attempt_id = ? AND phase = 'claimed'`,
    )
    .run(
      attempt.finalizedAt,
      attempt.terminalStatus,
      attempt.appliedReleaseId,
      attempt.appliedRevision,
      repositoryJson(attempt.appliedModules),
      repositoryJson(attempt.reasonCodes),
      attempt.checkedAt,
      attempt.finalizedByActorRef,
      attempt.reconciliationEventSequence,
      attempt.completionEventSequence,
      attempt.managementTenantId,
      attempt.attemptId,
    );
}

function insertReadbackAttemptIdempotency(
  database: DatabaseSync,
  metadata: ReadbackAttemptRequestMetadata,
  releaseId: string,
  createdAt: string,
): void {
  database
    .prepare(
      `INSERT INTO module_control_idempotency
        (management_tenant_id, action, idempotency_key, request_hash, actor_ref,
         status, domain_record_ref, final_result_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'domain_committed', ?, NULL, ?, ?)`,
    )
    .run(
      metadata.managementTenantId,
      metadata.action,
      metadata.idempotencyKey,
      metadata.requestHash,
      metadata.actorRef,
      releaseId,
      createdAt,
      idempotencyExpiry(createdAt),
    );
}

function completeReadbackAttemptIdempotency(
  database: DatabaseSync,
  attempt: ReadbackAttemptRecord,
  finalResult: ControlFinalResult,
): CompletedModuleControlIdempotencyRecord {
  database
    .prepare(
      `UPDATE module_control_idempotency
       SET status = 'completed', final_result_json = ?
       WHERE management_tenant_id = ? AND action = ? AND idempotency_key = ?
         AND request_hash = ? AND actor_ref = ? AND domain_record_ref = ?
         AND status = 'domain_committed'`,
    )
    .run(
      repositoryJson(finalResult),
      attempt.managementTenantId,
      attempt.action,
      attempt.idempotencyKey,
      attempt.requestHash,
      attempt.actorRef,
      attempt.releaseId,
    );
  const idempotency = findIdempotency(
    database,
    attempt.managementTenantId,
    attempt.action,
    attempt.idempotencyKey,
  );
  if (idempotency === null || idempotency.status !== "completed") {
    repositoryError("invalid_state");
  }
  return idempotency;
}

function terminalReadbackFromAttempt(
  attempt: ReadbackAttemptRecord,
): ModuleTerminalReadbackRecord {
  if (
    attempt.phase !== "finalized" ||
    attempt.terminalStatus === null ||
    attempt.checkedAt === null
  ) {
    repositoryError("invalid_state");
  }
  if (attempt.terminalStatus === "verified") {
    if (attempt.appliedReleaseId === null || attempt.appliedRevision === null) {
      repositoryError("invalid_state");
    }
    const readback = {
      managementTenantId: attempt.managementTenantId,
      readbackRef: attempt.readbackRef,
      releaseId: attempt.releaseId,
      attemptId: attempt.attemptId,
      revision: attempt.revision,
      appliedReleaseId: attempt.appliedReleaseId,
      appliedRevision: attempt.appliedRevision,
      appliedModules: attempt.appliedModules,
      status: "verified" as const,
      reasonCodes: [] as readonly [],
      checkedAt: attempt.checkedAt,
    } as ModuleTerminalReadbackRecord;
    return deepFreezeControlRecord(readback) as ModuleTerminalReadbackRecord;
  }
  const firstReasonCode = attempt.reasonCodes[0];
  if (firstReasonCode === undefined) repositoryError("invalid_state");
  if (attempt.terminalStatus === "mismatch") {
    const readback = {
      managementTenantId: attempt.managementTenantId,
      readbackRef: attempt.readbackRef,
      releaseId: attempt.releaseId,
      attemptId: attempt.attemptId,
      revision: attempt.revision,
      appliedReleaseId: attempt.appliedReleaseId,
      appliedRevision: attempt.appliedRevision,
      appliedModules: attempt.appliedModules,
      status: "mismatch" as const,
      reasonCodes: [firstReasonCode, ...attempt.reasonCodes.slice(1)] as readonly [
        string,
        ...string[],
      ],
      checkedAt: attempt.checkedAt,
    } as ModuleTerminalReadbackRecord;
    return deepFreezeControlRecord(readback) as ModuleTerminalReadbackRecord;
  }
  const readback = {
    managementTenantId: attempt.managementTenantId,
    readbackRef: attempt.readbackRef,
    releaseId: attempt.releaseId,
    attemptId: attempt.attemptId,
    revision: attempt.revision,
    appliedReleaseId: attempt.appliedReleaseId,
    appliedRevision: attempt.appliedRevision,
    appliedModules: attempt.appliedModules,
    status: "unknown" as const,
    reasonCodes: [firstReasonCode, ...attempt.reasonCodes.slice(1)] as readonly [
      string,
      ...string[],
    ],
    checkedAt: attempt.checkedAt,
  } as ModuleTerminalReadbackRecord;
  return deepFreezeControlRecord(readback) as ModuleTerminalReadbackRecord;
}

function readbackFinalizationResultFromExisting(
  database: DatabaseSync,
  managementTenantId: string,
  attempt: ReadbackAttemptRecord,
  idempotency: ControlIdempotencyRecord,
): ReadbackFinalizationResult {
  if (
    attempt.phase !== "finalized" ||
    idempotency.status !== "completed" ||
    idempotency.finalResult === null ||
    attempt.reconciliationEventSequence === null ||
    attempt.completionEventSequence === null
  ) {
    repositoryError("invalid_state");
  }
  const release = findRelease(database, managementTenantId, attempt.releaseId);
  const readback = findReadback(database, managementTenantId, attempt.releaseId);
  const reconciliationEvent = findEventBySequence(
    database,
    managementTenantId,
    attempt.reconciliationEventSequence,
  );
  const completionEvent = findEventBySequence(
    database,
    managementTenantId,
    attempt.completionEventSequence,
  );
  if (
    release === null ||
    readback === null ||
    readback.status === "pending" ||
    readback.attemptId !== attempt.attemptId ||
    reconciliationEvent === null ||
    completionEvent === null
  ) {
    repositoryError("invalid_state");
  }
  const observation = {
    status: attempt.terminalStatus,
    appliedReleaseId: attempt.appliedReleaseId,
    appliedRevision: attempt.appliedRevision,
    appliedModules: attempt.appliedModules,
    reasonCodes: attempt.reasonCodes,
    checkedAt: attempt.checkedAt,
  } as ReadbackAttemptObservation;
  const finalResult = validateFinalResult(
    idempotency.finalResult,
    attempt.action,
    attempt.releaseId,
    attempt.revision,
  );
  assertAttemptFinalResultSemantics(finalResult, attempt, observation, release);
  return Object.freeze({
    disposition: "replayed" as const,
    replayed: true,
    attempt: deepFreezeReadbackAttempt(attempt),
    readback: readback as ModuleTerminalReadbackRecord,
    release,
    idempotency,
    reconciliationEvent,
    completionEvent,
    finalResult,
  });
}

function assertAttemptFinalResultSemantics(
  finalResult: ControlFinalResult,
  attempt: ReadbackAttemptRecord,
  observation: ReadbackAttemptObservation,
  release: ModuleReleaseRecord,
): void {
  const parsed = controlEnvelopeSchema.safeParse(finalResult.envelope);
  if (!parsed.success) repositoryError("invalid_state");
  const data = parsed.data.data;
  if (
    finalResult.domainRecordRef !== attempt.releaseId ||
    parsed.data.request_id !== attempt.requestId ||
    parsed.data.trace_id !== attempt.traceId ||
    parsed.data.audit_id !== attempt.auditId ||
    parsed.data.readback.release_id !== attempt.releaseId ||
    parsed.data.readback.revision !== attempt.revision ||
    parsed.data.readback.status !== observation.status ||
    !equalCanonical(parsed.data.reason_codes, observation.reasonCodes)
  ) {
    repositoryError("conflict");
  }
  if (observation.status === "verified") {
    const correctData =
      attempt.action === "deployments.reconcile"
        ? data?.kind === "reconciliation" &&
          data.release_id === release.releaseId &&
          data.revision === release.revision &&
          data.status === "verified"
        : data?.kind === "release" &&
          data.release_id === release.releaseId &&
          data.revision === release.revision &&
          sameModuleRefs(envelopeModuleRefs(data.active_modules), release.desiredModules);
    if (
      parsed.data.status !== "success" ||
      observation.appliedReleaseId !== release.releaseId ||
      observation.appliedRevision !== release.revision ||
      !sameModuleRefs(observation.appliedModules, release.desiredModules) ||
      parsed.data.reason_codes.length !== 0 ||
      !correctData
    ) {
      repositoryError("conflict");
    }
    return;
  }
  if (
    parsed.data.status !== "manual_review" ||
    parsed.data.reason_codes.length === 0 ||
    parsed.data.reason_codes.join("\0") !== observation.reasonCodes.join("\0") ||
    (attempt.action === "deployments.reconcile"
      ? data?.kind !== "reconciliation" || data.status !== observation.status
      : data?.kind !== "release")
  ) {
    repositoryError("conflict");
  }
  if (attempt.action === "deployments.reconcile") {
    if (
      data?.kind !== "reconciliation" ||
      data.release_id !== release.releaseId ||
      data.revision !== release.revision ||
      data.status !== observation.status
    ) {
      repositoryError("conflict");
    }
  } else if (
    data?.kind !== "release" ||
    data.release_id !== release.releaseId ||
    data.revision !== release.revision
  ) {
    repositoryError("conflict");
  }
}

function updatePreviewConsumed(
  database: DatabaseSync,
  managementTenantId: string,
  previewRef: string,
): void {
  database
    .prepare(
      `UPDATE module_previews SET consumed = 1
       WHERE management_tenant_id = ? AND preview_ref = ? AND consumed = 0`,
    )
    .run(managementTenantId, previewRef);
}

function updateApprovalConsumed(
  database: DatabaseSync,
  managementTenantId: string,
  approvalId: string,
): void {
  database
    .prepare(
      `UPDATE module_approvals SET consumed = 1
       WHERE management_tenant_id = ? AND approval_id = ? AND consumed = 0`,
    )
    .run(managementTenantId, approvalId);
}

function updateReleaseStatus(
  database: DatabaseSync,
  release: ModuleReleaseRecord,
  status: ModuleReleaseRecord["status"],
  readbackRef: string | null,
  reasonCodes: readonly string[],
  supersededByReleaseId: string | null,
): void {
  database
    .prepare(
      `UPDATE module_releases
       SET status = ?, readback_ref = ?, reason_codes_json = ?,
           superseded_by_release_id = ?,
           published_at = COALESCE(published_at, created_at)
       WHERE management_tenant_id = ? AND release_id = ? AND revision = ?`,
    )
    .run(
      status,
      readbackRef,
      repositoryJson(reasonCodes),
      supersededByReleaseId,
      release.managementTenantId,
      release.releaseId,
      release.revision,
  );
}

function withRepositoryTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
  guard: RepositoryTransactionGuard,
): T {
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    guard.verifyLiveIdentity();
    const result = operation();
    guard.verifyLiveIdentity();
    database.exec("COMMIT");
    transactionStarted = false;
    guard.verifyLiveIdentity();
    return result;
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the stable repository error below.
      }
    }
    if (
      error instanceof ModuleControlRepositoryError ||
      error instanceof LiveControlStoreMismatch
    ) {
      throw error;
    }
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message).toLowerCase()
        : "";
    if (
      message.includes("constraint") ||
      message.includes("unique") ||
      message.includes("foreign key") ||
      message.includes("locked") ||
      message.includes("busy")
    ) {
      repositoryError("conflict");
    }
    mapRepositoryFailure(error);
  }
}

interface RepositoryTransactionGuard {
  verifyLiveIdentity(): void;
}

class LiveControlStoreMismatch extends Error {}

class SqliteReadbackOwnerCapabilityRegistry {
  #ownerCapabilities = new WeakMap<object, string>();
  #consumedOwnerCapabilities = new WeakSet<object>();

  create(attemptId: string): ReadbackAttemptOwnerCapability {
    const capability = Object.create(null) as object;
    Object.freeze(capability);
    this.#ownerCapabilities.set(capability, attemptId);
    return capability as ReadbackAttemptOwnerCapability;
  }

  assertOwner(
    capability: ReadbackAttemptOwnerCapability,
    attemptId: string,
  ): void {
    if (
      typeof capability !== "object" ||
      capability === null ||
      Array.isArray(capability) ||
      nodeUtilTypes.isProxy(capability) ||
      this.#consumedOwnerCapabilities.has(capability) ||
      this.#ownerCapabilities.get(capability) !== attemptId
    ) {
      repositoryError("conflict");
    }
  }

  consume(capability: ReadbackAttemptOwnerCapability, attemptId: string): void {
    this.assertOwner(capability, attemptId);
    this.#consumedOwnerCapabilities.add(capability);
  }
}

function domainRecordRefForRecord(record: ControlRecord): string {
  if ("moduleId" in record && "registeredAt" in record) {
    return `registration:${record.moduleId}:${record.version}:${record.descriptorDigest}`;
  }
  if ("previewRef" in record && "intent" in record) return record.previewRef;
  if ("approvalId" in record && "decision" in record) return record.approvalId;
  if ("releaseId" in record && "publisherActorRef" in record) return record.releaseId;
  if ("readbackRef" in record && "checkedAt" in record) return record.releaseId;
  if ("idempotencyKey" in record) {
    return record.domainRecordRef ?? "";
  }
  repositoryError("invalid_state");
}

function existingIdempotencyConflict(
  existing: ControlIdempotencyRecord,
  metadata: ControlRequestMetadata,
): void {
  if (
    existing.requestHash !== metadata.requestHash ||
    existing.actorRef !== metadata.actorRef
  ) {
    repositoryError("conflict");
  }
  if (
    existing.managementTenantId !== metadata.managementTenantId ||
    existing.action !== metadata.action ||
    existing.idempotencyKey !== metadata.idempotencyKey
  ) {
    repositoryError("tenant_mismatch");
  }
}

function replaySimpleResult<T extends ControlRecord>(
  database: DatabaseSync,
  metadata: ControlRequestMetadata,
  idempotency: ControlIdempotencyRecord,
  kind: "registration" | "preview" | "approval",
): { readonly record: T; readonly event: ControlEventRecord; readonly replayed: true } {
  if (idempotency.status !== "completed" || idempotency.finalResult === null) {
    repositoryError("invalid_state");
  }
  const event = findEventByIdempotencyDomain(
    database,
    metadata.managementTenantId,
    idempotency,
    kind,
  );
  if (event === null) repositoryError("invalid_state");
  let record: ControlRecord | null;
  if (kind === "registration") {
    if (event.detail.kind !== "registration") repositoryError("invalid_state");
    record = findRegistration(
      database,
      metadata.managementTenantId,
      event.detail.moduleId,
      event.detail.version,
      event.detail.descriptorDigest,
    );
  } else if (kind === "preview") {
    if (event.detail.kind !== "preview") repositoryError("invalid_state");
    record = findPreview(database, metadata.managementTenantId, event.detail.previewRef);
  } else {
    if (event.detail.kind !== "approval") repositoryError("invalid_state");
    record = findApproval(database, metadata.managementTenantId, event.detail.approvalId);
  }
  if (record === null) repositoryError("not_found");
  return {
    record: record as T,
    event,
    replayed: true,
  };
}

function checkFinalDomainBinding(
  finalResult: ControlFinalResult,
  metadata: ControlRequestMetadata,
  record: ControlRecord,
): ControlFinalResult {
  const domainRef = domainRecordRefForRecord(record);
  return validateFinalResult(finalResult, metadata.action, domainRef);
}

function requireRepositoryDatabase(database: DatabaseSync | null): DatabaseSync {
  if (database === null) repositoryError("closed");
  return database;
}

function registerModuleInDatabase(
  database: DatabaseSync,
  managementTenantId: string,
  request: RegisterModuleRecordRequest,
  guard: RepositoryTransactionGuard,
): RegistrationWriteResult {
  const bound = bindRepositoryRequest(
    request.metadata,
    request.record,
    managementTenantId,
  );
  const metadata = bound.metadata;
  const record = bound.record as ModuleRegistrationRecord;
  const existing = findIdempotency(
    database,
    managementTenantId,
    metadata.action,
    metadata.idempotencyKey,
  );
  if (existing !== null) {
    existingIdempotencyConflict(existing, metadata);
    return replaySimpleResult<ModuleRegistrationRecord>(
      database,
      metadata,
      existing,
      "registration",
    );
  }
  const finalResult = checkFinalDomainBinding(
    request.finalResult,
    metadata,
    record,
  );
  return withRepositoryTransaction(database, () => {
    insertIdempotencyReservation(database, metadata, record, "reserved", null);
    insertRegistration(database, record);
    const event = insertEvent(database, metadata, record);
    completeIdempotencyRow(
      database,
      metadata,
      finalResult.domainRecordRef,
      finalResult,
    );
    const persisted = findRegistration(
      database,
      managementTenantId,
      record.moduleId,
      record.version,
      record.descriptorDigest,
    );
    if (persisted === null) repositoryError("invalid_state");
    return { record: persisted, event, replayed: false };
  }, guard);
}

function createPreviewInDatabase(
  database: DatabaseSync,
  managementTenantId: string,
  request: CreatePreviewRecordRequest,
  guard: RepositoryTransactionGuard,
): PreviewWriteResult {
  const bound = bindRepositoryRequest(
    request.metadata,
    request.record,
    managementTenantId,
  );
  const metadata = bound.metadata;
  const record = bound.record as ModulePreviewRecord;
  const existing = findIdempotency(
    database,
    managementTenantId,
    metadata.action,
    metadata.idempotencyKey,
  );
  if (existing !== null) {
    existingIdempotencyConflict(existing, metadata);
    return replaySimpleResult<ModulePreviewRecord>(
      database,
      metadata,
      existing,
      "preview",
    );
  }
  const finalResult = checkFinalDomainBinding(
    request.finalResult,
    metadata,
    record,
  );
  return withRepositoryTransaction(database, () => {
    insertIdempotencyReservation(database, metadata, record, "reserved", null);
    insertPreview(database, record);
    const event = insertEvent(database, metadata, record);
    completeIdempotencyRow(
      database,
      metadata,
      finalResult.domainRecordRef,
      finalResult,
    );
    const persisted = findPreview(database, managementTenantId, record.previewRef);
    if (persisted === null) repositoryError("invalid_state");
    return { record: persisted, event, replayed: false };
  }, guard);
}

function decideApprovalInDatabase(
  database: DatabaseSync,
  managementTenantId: string,
  request: DecideApprovalRecordRequest,
  guard: RepositoryTransactionGuard,
): ApprovalWriteResult {
  const bound = bindRepositoryRequest(
    request.metadata,
    request.record,
    managementTenantId,
  );
  const metadata = bound.metadata;
  const record = bound.record as ModuleApprovalRecord;
  const existing = findIdempotency(
    database,
    managementTenantId,
    metadata.action,
    metadata.idempotencyKey,
  );
  if (existing !== null) {
    existingIdempotencyConflict(existing, metadata);
    return replaySimpleResult<ModuleApprovalRecord>(
      database,
      metadata,
      existing,
      "approval",
    );
  }
  const finalResult = checkFinalDomainBinding(
    request.finalResult,
    metadata,
    record,
  );
  return withRepositoryTransaction(database, () => {
    insertIdempotencyReservation(database, metadata, record, "reserved", null);
    insertApproval(database, record);
    const event = insertEvent(database, metadata, record);
    completeIdempotencyRow(
      database,
      metadata,
      finalResult.domainRecordRef,
      finalResult,
    );
    const persisted = findApproval(database, managementTenantId, record.approvalId);
    if (persisted === null) repositoryError("invalid_state");
    return { record: persisted, event, replayed: false };
  }, guard);
}

function publishReplay(
  database: DatabaseSync,
  managementTenantId: string,
  metadata: ControlRequestMetadata,
  existing: ControlIdempotencyRecord,
): ReleaseWriteResult {
  if (existing.status === "reserved" || existing.domainRecordRef === null) {
    repositoryError("invalid_state");
  }
  const release = findRelease(
    database,
    managementTenantId,
    existing.domainRecordRef,
  );
  if (release === null) repositoryError("not_found");
  if (release.status !== "published_pending_readback" && existing.status !== "completed") {
    if (
      existing.status !== "domain_committed" ||
      (release.status !== "active_verified" && release.status !== "manual_review")
    ) {
      repositoryError("conflict");
    }
    // A crash after durable readback but before completion is recoverable: replay
    // exposes the fixed release without activating or observing it a second time.
    verifyReleaseRecoverySemantics(database, managementTenantId, release);
  }
  const event = findDomainEvent(
    database,
    managementTenantId,
    release.releaseId,
    "release",
  );
  if (event === null) repositoryError("invalid_state");
  return { record: release, event, replayed: true };
}

function publishReleaseInDatabase(
  database: DatabaseSync,
  managementTenantId: string,
  request: PublishReleaseRecordRequest,
  guard: RepositoryTransactionGuard,
): ReleaseWriteResult {
  const bound = bindRepositoryRequest(
    request.metadata,
    request.record,
    managementTenantId,
  );
  const metadata = bound.metadata;
  const record = bound.record as ModuleReleaseRecord;
  const existing = findIdempotency(
    database,
    managementTenantId,
    metadata.action,
    metadata.idempotencyKey,
  );
  if (existing !== null) {
    existingIdempotencyConflict(existing, metadata);
    return publishReplay(database, managementTenantId, metadata, existing);
  }
  if (record.status !== "published_pending_readback") {
    repositoryError("invalid_state");
  }
  const releaseGateAt = record.publishedAt ?? record.createdAt;

  const unresolved = findNewestUnresolvedRelease(database, managementTenantId);
  if (unresolved !== null) repositoryError("conflict");

  const currentActive = findActiveRelease(database, managementTenantId);
  const expectedBaseRevision = currentActive?.revision ?? 0;
  const expectedBaseReleaseId = currentActive?.releaseId ?? null;
  if (
    record.revision !== expectedBaseRevision + 1 ||
    record.previousReleaseId !== expectedBaseReleaseId
  ) {
    repositoryError("conflict");
  }

  const preview = findPreview(database, managementTenantId, record.previewRef);
  if (preview === null) repositoryError("not_found");
  if (
    preview.consumed ||
    isExpiredAt(preview.expiresAt, releaseGateAt) ||
    preview.baseRevision !== expectedBaseRevision ||
    preview.baseReleaseId !== expectedBaseReleaseId ||
    preview.baseRevision !== record.revision - 1 ||
    !sameModuleRefs(preview.desiredModules, record.desiredModules)
  ) {
    repositoryError("conflict");
  }

  const approval = findApproval(database, managementTenantId, record.approvalId);
  if (approval === null) repositoryError("not_found");
  if (
    approval.decision !== "approve" ||
    approval.consumed ||
    isExpiredAt(approval.expiresAt, releaseGateAt) ||
    approval.previewRef !== preview.previewRef ||
    approval.previewCanonicalHash !== preview.canonicalHash ||
    approval.baseReleaseId !== preview.baseReleaseId ||
    approval.baseRevision !== preview.baseRevision ||
    approval.expiresAt !== preview.expiresAt ||
    !sameDigestSet(
      approval.inventoryDigestSet,
      preview.inventoryRefs.map((ref) => ref.descriptorDigest),
    )
  ) {
    repositoryError("conflict");
  }

  return withRepositoryTransaction(database, () => {
    if (hasDomainCommittedPublish(database, managementTenantId)) {
      repositoryError("conflict");
    }
    insertIdempotencyReservation(
      database,
      metadata,
      record,
      "domain_committed",
      record.releaseId,
    );
    updatePreviewConsumed(database, managementTenantId, preview.previewRef);
    updateApprovalConsumed(database, managementTenantId, approval.approvalId);
    insertRelease(database, record);
    const event = insertEvent(database, metadata, record);
    const persisted = findRelease(database, managementTenantId, record.releaseId);
    if (persisted === null) repositoryError("invalid_state");
    return { record: persisted, event, replayed: false };
  }, guard);
}

function claimReadbackAttemptInDatabase(
  database: DatabaseSync,
  managementTenantId: string,
  ownerBootId: string,
  request: ClaimReadbackAttemptRequest,
  guard: RepositoryTransactionGuard,
): { readonly disposition: "created" | "existing"; readonly attempt: ReadbackAttemptRecord } {
  assertClaimAttemptRequest(request);
  const metadata = request.metadata;
  if (metadata.actorRef === "system_startup_recovery") repositoryError("conflict");
  if (metadata.managementTenantId !== managementTenantId) {
    repositoryError("tenant_mismatch");
  }

  const result = withRepositoryTransaction(database, () => {
    const existingIdempotency = findIdempotency(
      database,
      managementTenantId,
      metadata.action,
      metadata.idempotencyKey,
    );
    const existingAttempt = findReadbackAttemptByIdempotency(
      database,
      managementTenantId,
      metadata.action,
      metadata.idempotencyKey,
    );
    if (existingIdempotency !== null) {
      if (
        existingIdempotency.requestHash !== metadata.requestHash ||
        existingIdempotency.actorRef !== metadata.actorRef
      ) {
        repositoryError("conflict");
      }
      if (existingIdempotency.domainRecordRef === null) repositoryError("invalid_state");
      if (existingAttempt !== null) {
        if (
          existingAttempt.attemptId !== request.attemptId ||
          existingAttempt.readbackRef !== request.readbackRef ||
          existingAttempt.releaseId !== request.releaseId ||
          existingAttempt.revision !== request.revision ||
          !sameModuleRefs(existingAttempt.desiredModules, request.desiredModules) ||
          existingAttempt.action !== metadata.action ||
          existingAttempt.idempotencyKey !== metadata.idempotencyKey ||
          existingAttempt.requestHash !== metadata.requestHash ||
          existingAttempt.actorRef !== metadata.actorRef ||
          existingAttempt.requestId !== metadata.requestId ||
          existingAttempt.traceId !== metadata.traceId ||
          existingAttempt.auditId !== metadata.auditId
        ) {
          repositoryError("conflict");
        }
        return { disposition: "existing" as const, attempt: existingAttempt };
      }
      if (
        metadata.action !== "deployments.publish" ||
        existingIdempotency.status !== "domain_committed"
      ) {
        repositoryError("invalid_state");
      }
    }

    const release = findRelease(database, managementTenantId, request.releaseId);
    if (release === null) repositoryError("not_found");
    if (
      release.revision !== request.revision ||
      !sameModuleRefs(release.desiredModules, request.desiredModules)
    ) {
      repositoryError("conflict");
    }
    if (metadata.action === "deployments.publish") {
      if (
        existingIdempotency === null ||
        existingIdempotency.domainRecordRef !== release.releaseId ||
        release.status !== "published_pending_readback"
      ) {
        repositoryError("conflict");
      }
    } else {
      const newest = findNewestUnresolvedRelease(database, managementTenantId);
      if (
        newest === null ||
        newest.releaseId !== release.releaseId ||
        newest.revision !== release.revision ||
        (release.status !== "published_pending_readback" && release.status !== "manual_review")
      ) {
        repositoryError("conflict");
      }
    }
    const claimedRelease = database
      .prepare(
        `SELECT 1 AS found FROM module_readback_attempts
         WHERE management_tenant_id = ? AND release_id = ? AND revision = ?
           AND phase = 'claimed' LIMIT 1`,
      )
      .get(managementTenantId, release.releaseId, release.revision);
    if (claimedRelease !== undefined) repositoryError("conflict");
    const duplicateAttempt = database
      .prepare(
        `SELECT 1 AS found FROM module_readback_attempts
         WHERE management_tenant_id = ? AND (attempt_id = ? OR readback_ref = ?)
         LIMIT 1`,
      )
      .get(managementTenantId, request.attemptId, request.readbackRef);
    if (duplicateAttempt !== undefined) repositoryError("conflict");
    const duplicateReadback = database
      .prepare(
        `SELECT 1 AS found FROM module_readbacks
         WHERE management_tenant_id = ? AND readback_ref = ? LIMIT 1`,
      )
      .get(managementTenantId, request.readbackRef);
    if (duplicateReadback !== undefined) repositoryError("conflict");

    const claimedAt = request.claimedAt ?? new Date().toISOString();
    assertAttemptTimestamp(claimedAt);
    if (
      existingIdempotency !== null &&
      compareRfc3339Instants(existingIdempotency.createdAt, claimedAt) > 0
    ) {
      repositoryError("conflict");
    }
    if (existingIdempotency === null) {
      insertReadbackAttemptIdempotency(
        database,
        metadata,
        release.releaseId,
        claimedAt,
      );
    }
    const attempt = {
      managementTenantId,
      attemptId: request.attemptId,
      action: metadata.action,
      idempotencyKey: metadata.idempotencyKey,
      requestHash: metadata.requestHash,
      actorRef: metadata.actorRef,
      requestId: metadata.requestId,
      traceId: metadata.traceId,
      auditId: metadata.auditId,
      releaseId: request.releaseId,
      revision: request.revision,
      desiredModules: request.desiredModules,
      readbackRef: request.readbackRef,
      ownerBootId,
      phase: "claimed" as const,
      claimedAt,
      finalizedAt: null,
      terminalStatus: null,
      appliedReleaseId: null,
      appliedRevision: null,
      appliedModules: [],
      reasonCodes: [],
      checkedAt: null,
      finalizedByActorRef: null,
      reconciliationEventSequence: null,
      completionEventSequence: null,
    } as unknown as ReadbackAttemptRecord;
    const validatedAttempt = deepFreezeReadbackAttempt(attempt) as ReadbackAttemptRecord;
    insertClaimedReadbackAttempt(database, validatedAttempt);
    const persisted = findReadbackAttempt(database, managementTenantId, request.attemptId);
    if (persisted === null) repositoryError("invalid_state");
    return { disposition: "created" as const, attempt: persisted };
  }, guard);
  return result;
}

interface ReadbackFinalizeRuntime {
  readonly clock: () => string;
  readonly failpoint: SqliteReadbackFinalizeFailpoint | null;
}

function triggerReadbackFinalizeFailpoint(
  runtime: ReadbackFinalizeRuntime,
  phase: SqliteReadbackFinalizeFailpoint,
): void {
  if (runtime.failpoint === phase) repositoryError("conflict");
}

function finalizeReadbackAndCompleteInDatabase(
  database: DatabaseSync,
  managementTenantId: string,
  request: FinalizeReadbackAndCompleteRequest | SqliteRecoveryFinalizeRequest,
  guard: RepositoryTransactionGuard,
  capabilities: SqliteReadbackOwnerCapabilityRegistry,
  runtime: ReadbackFinalizeRuntime,
  ownerBootId: string,
  mode: "owner" | "recovery",
  recoverySecret: SqliteReadbackRecoverySecret | null,
): ReadbackFinalizationResult {
  if (mode === "owner") {
    assertFinalizeAttemptRequest(request);
  } else {
    assertSqliteReadbackRecoverySecret(recoverySecret);
    assertRecoveryFinalizeAttemptRequest(request);
  }
  const result = withRepositoryTransaction(database, () => {
    const attempt = findReadbackAttempt(database, managementTenantId, request.attemptId);
    if (attempt === null) repositoryError("not_found");
    if (mode === "owner") {
      capabilities.assertOwner(
        (request as FinalizeReadbackAndCompleteRequest).ownerCapability,
        attempt.attemptId,
      );
      if (attempt.ownerBootId !== ownerBootId) repositoryError("conflict");
    } else if (attempt.ownerBootId === ownerBootId) {
      repositoryError("conflict");
    }
    const idempotency = findIdempotency(
      database,
      managementTenantId,
      attempt.action,
      attempt.idempotencyKey,
    );
    if (
      idempotency === null ||
      idempotency.requestHash !== attempt.requestHash ||
      idempotency.actorRef !== attempt.actorRef ||
      idempotency.domainRecordRef !== attempt.releaseId
    ) {
      repositoryError("conflict");
    }
    if (mode === "recovery" && attempt.phase === "finalized") {
      if (
        attempt.finalizedByActorRef !== SQLITE_RECOVERY_ACTOR_REF ||
        idempotency.status !== "completed" ||
        idempotency.finalResult === null
      ) {
        repositoryError("conflict");
      }
      const release = findRelease(database, managementTenantId, attempt.releaseId);
      if (release === null) repositoryError("not_found");
      const finalResult = validateFinalResult(
        request.finalResult,
        attempt.action,
        attempt.releaseId,
        attempt.revision,
      );
      const persistedObservation = {
        status: attempt.terminalStatus,
        appliedReleaseId: attempt.appliedReleaseId,
        appliedRevision: attempt.appliedRevision,
        appliedModules: attempt.appliedModules,
        reasonCodes: attempt.reasonCodes,
        checkedAt: attempt.checkedAt,
      } as ReadbackAttemptObservation;
      assertAttemptFinalResultSemantics(
        finalResult,
        attempt,
        persistedObservation,
        release,
      );
      if (
        !equalCanonical(finalResult, idempotency.finalResult) ||
        !equalCanonical(request.observation, persistedObservation)
      ) {
        repositoryError("conflict");
      }
      return readbackFinalizationResultFromExisting(
        database,
        managementTenantId,
        attempt,
        idempotency,
      );
    }
    if (attempt.phase !== "claimed") repositoryError("conflict");
    if (idempotency.status !== "domain_committed") {
      repositoryError("conflict");
    }
    const release = findRelease(database, managementTenantId, attempt.releaseId);
    if (release === null) repositoryError("not_found");
    if (
      release.revision !== attempt.revision ||
      !sameModuleRefs(release.desiredModules, attempt.desiredModules) ||
      (release.status !== "published_pending_readback" && release.status !== "manual_review")
    ) {
      repositoryError("conflict");
    }
    const existingReadback = findReadback(database, managementTenantId, attempt.releaseId);
    if (existingReadback !== null && attempt.action !== "deployments.reconcile") {
      repositoryError("conflict");
    }
    let observation: ReadbackAttemptObservation;
    try {
      assertReadbackAttemptObservation(request.observation);
      observation = request.observation;
    } catch (error) {
      if (error instanceof ModuleControlRepositoryError) throw error;
      repositoryError("invalid_state");
    }
    const finalResult = validateFinalResult(
      request.finalResult,
      attempt.action,
      attempt.releaseId,
      attempt.revision,
    );
    assertAttemptFinalResultSemantics(finalResult, attempt, observation, release);
    if (
      mode === "recovery" &&
      (observation.status !== "unknown" ||
        observation.appliedReleaseId !== null ||
        observation.appliedRevision !== null ||
        observation.appliedModules.length !== 0 ||
        !equalCanonical(observation.reasonCodes, ["readback.interrupted"]) ||
        finalResult.envelope.status !== "manual_review" ||
        finalResult.envelope.readback.status !== "unknown" ||
        !equalCanonical(finalResult.envelope.reason_codes, ["readback.interrupted"]))
    ) {
      repositoryError("conflict");
    }
    const finalizedAt = request.finalizedAt ?? runtime.clock();
    assertAttemptTimestamp(finalizedAt);
    if (
      compareRfc3339Instants(attempt.claimedAt, finalizedAt) > 0 ||
      compareRfc3339Instants(attempt.claimedAt, observation.checkedAt) > 0 ||
      compareRfc3339Instants(observation.checkedAt, finalizedAt) > 0
    ) {
      repositoryError("conflict");
    }
    const previousEvent = previousPersistedEvent(database);
    if (
      previousEvent !== null &&
      compareRfc3339Instants(previousEvent.occurredAt, finalizedAt) > 0
    ) {
      repositoryError("conflict");
    }
    const finalizerActorRef =
      mode === "recovery" ? SQLITE_RECOVERY_ACTOR_REF : attempt.actorRef;

    // The two terminal events are deliberately inserted before any projection
    // or attempt finalization writes. Their immediate FKs are then checked again
    // by the finalized attempt update below, all inside this transaction.
    const reconciliationEvent = insertReadbackAttemptEvent(
      database,
      attempt,
      "reconciliation",
      observation.status,
      observation.reasonCodes,
      finalizedAt,
      finalizerActorRef,
    );
    triggerReadbackFinalizeFailpoint(runtime, "after_reconciliation_event");
    const completionEvent = insertReadbackAttemptEvent(
      database,
      attempt,
      "completion",
      "completed",
      [],
      finalizedAt,
      finalizerActorRef,
    );
    triggerReadbackFinalizeFailpoint(runtime, "after_completion_event");
    if (completionEvent.sequence !== reconciliationEvent.sequence + 1) {
      repositoryError("invalid_state");
    }
    const finalizedAttemptCandidate = {
      ...attempt,
      phase: "finalized" as const,
      finalizedAt,
      terminalStatus: observation.status,
      appliedReleaseId: observation.appliedReleaseId,
      appliedRevision: observation.appliedRevision,
      appliedModules: observation.appliedModules,
      reasonCodes: observation.reasonCodes,
      checkedAt: observation.checkedAt,
      finalizedByActorRef: finalizerActorRef,
      reconciliationEventSequence: reconciliationEvent.sequence,
      completionEventSequence: completionEvent.sequence,
    };
    assertReadbackAttemptRecord(finalizedAttemptCandidate);
    const finalizedAttempt = deepFreezeReadbackAttempt(
      finalizedAttemptCandidate,
    ) as ReadbackAttemptRecord;
    const readback = terminalReadbackFromAttempt(finalizedAttempt);
    if (existingReadback === null) insertReadback(database, readback);
    else updateReadback(database, readback);
    triggerReadbackFinalizeFailpoint(runtime, "after_current_readback");

    if (observation.status === "verified") {
      const previousActive = findActiveRelease(database, managementTenantId);
      if (previousActive !== null && previousActive.releaseId !== release.releaseId) {
        updateReleaseStatus(
          database,
          previousActive,
          "superseded",
          previousActive.readbackRef,
          [],
          release.releaseId,
        );
      }
      updateReleaseStatus(
        database,
        release,
        "active_verified",
        readback.readbackRef,
        [],
        null,
      );
    } else {
      updateReleaseStatus(
        database,
        release,
        "manual_review",
        readback.readbackRef,
        observation.reasonCodes,
        null,
      );
    }
    triggerReadbackFinalizeFailpoint(runtime, "after_release");
    updateFinalizedReadbackAttempt(database, finalizedAttempt);
    triggerReadbackFinalizeFailpoint(runtime, "after_attempt_finalized");
    const completedIdempotency = completeReadbackAttemptIdempotency(
      database,
      attempt,
      finalResult,
    );
    triggerReadbackFinalizeFailpoint(runtime, "after_idempotency_completed");
    triggerReadbackFinalizeFailpoint(runtime, "before_health_check");
    verifyReadbackAttemptGraph(database, managementTenantId);
    triggerReadbackFinalizeFailpoint(runtime, "after_health_check");
    const updatedRelease = findRelease(database, managementTenantId, release.releaseId);
    if (updatedRelease === null) repositoryError("invalid_state");
    return {
      disposition: "finalized" as const,
      replayed: false,
      attempt: finalizedAttempt,
      readback,
      release: updatedRelease,
      idempotency: completedIdempotency,
      reconciliationEvent,
      completionEvent,
      finalResult,
    };
  }, guard);
  if (mode === "owner") {
    capabilities.consume(
      (request as FinalizeReadbackAndCompleteRequest).ownerCapability,
      request.attemptId,
    );
  }
  return result;
}

function controlStateInDatabase(
  database: DatabaseSync,
  managementTenantId: string,
): ModuleControlState {
  const activeRelease = findActiveRelease(database, managementTenantId);
  const eventProjection = findEventProjection(database, managementTenantId);
  const state = {
    managementTenantId,
    activeRelease,
    activeRevision: activeRelease?.revision ?? 0,
    activeModules: activeRelease?.desiredModules ?? [],
    registrations: findRegistrations(database, managementTenantId),
    latestPreview: findLatestPreview(database, managementTenantId),
    latestApproval: findLatestApproval(database, managementTenantId),
    latestReadback: findLatestReadback(database, managementTenantId),
    releaseHistory: findReleaseHistory(database, managementTenantId),
    events: eventProjection.events,
    eventsTruncated: eventProjection.eventsTruncated,
  } as ModuleControlState;
  return freezeDecoded(state);
}

function verifyReleaseRecoverySemantics(
  database: DatabaseSync,
  managementTenantId: string,
  release: ModuleReleaseRecord,
): void {
  const readback = findReadback(database, managementTenantId, release.releaseId);
  const idempotencyRows = database
    .prepare(
      `SELECT management_tenant_id, action, idempotency_key, request_hash, actor_ref, status,
              domain_record_ref, final_result_json, created_at, expires_at
       FROM module_control_idempotency
       WHERE management_tenant_id = ? AND domain_record_ref = ?
         AND action IN ('deployments.publish', 'deployments.reconcile')
         AND status IN ('domain_committed', 'completed')
       ORDER BY created_at, action, idempotency_key`,
    )
    .iterate(managementTenantId, release.releaseId) as Iterable<unknown>;
  let hasPublishRecovery = false;
  for (const row of idempotencyRows) {
    const record = decodeIdempotencyRow(row);
    if (record.domainRecordRef !== release.releaseId) repositoryError("invalid_state");
    if (record.action === "deployments.publish") hasPublishRecovery = true;
    if (record.status === "completed") {
      if (record.finalResult === null) repositoryError("invalid_state");
      try {
        validateFinalResult(
          record.finalResult,
          record.action,
          release.releaseId,
          release.revision,
        );
      } catch {
        repositoryError("invalid_state");
      }
    }
  }
  if (!hasPublishRecovery) repositoryError("invalid_state");

  if (release.status === "published_pending_readback") {
    if (
      release.readbackRef !== null ||
      (readback !== null && readback.status !== "pending")
    ) {
      repositoryError("invalid_state");
    }
    if (
      readback !== null &&
      (readback.releaseId !== release.releaseId ||
        readback.revision !== release.revision ||
        readback.appliedReleaseId !== null ||
        readback.appliedRevision !== null ||
        readback.reasonCodes.length !== 0)
    ) {
      repositoryError("invalid_state");
    }
    return;
  }
  if (release.status === "active_verified" || release.status === "superseded") {
    if (
      readback === null ||
      readback.status !== "verified" ||
      release.readbackRef !== readback.readbackRef ||
      release.revision !== readback.revision ||
      readback.appliedReleaseId !== release.releaseId ||
      readback.appliedRevision !== release.revision ||
      !sameModuleRefs(readback.appliedModules, release.desiredModules) ||
      release.reasonCodes.length !== 0 ||
      readback.reasonCodes.length !== 0
    ) {
      repositoryError("invalid_state");
    }
    return;
  }
  if (release.status === "manual_review") {
    if (
      readback === null ||
      (readback.status !== "mismatch" && readback.status !== "unknown") ||
      release.readbackRef !== readback.readbackRef ||
      release.revision !== readback.revision ||
      !equalCanonical(release.reasonCodes, readback.reasonCodes)
    ) {
      repositoryError("invalid_state");
    }
    return;
  }
  repositoryError("invalid_state");
}

function verifyRecordTenant(
  recordTenant: string,
  managementTenantId: string,
): void {
  if (recordTenant !== managementTenantId) repositoryError("invalid_state");
}

function verifyPreviewSemantics(
  database: DatabaseSync,
  managementTenantId: string,
  preview: ModulePreviewRecord,
): void {
  verifyRecordTenant(preview.managementTenantId, managementTenantId);
  const baseRelease = preview.baseReleaseId === null
    ? null
    : findRelease(database, managementTenantId, preview.baseReleaseId);
  const releaseHistory = findReleaseHistory(database, managementTenantId);
  const rollbackTargetRelease = preview.intent === "rollback"
    ? releaseHistory.find(
      (entry) => entry.release.releaseId === preview.targetReleaseId,
    )?.release ?? null
    : null;
  assertModulePreviewAuthoritySemantics(
    preview,
    baseRelease,
    rollbackTargetRelease,
    releaseHistory,
  );
}

function countReleasesForGate(
  database: DatabaseSync,
  managementTenantId: string,
  previewRef: string,
  approvalId?: string,
): number {
  const row = exactSqlRow(
    approvalId === undefined
      ? database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM module_releases
             WHERE management_tenant_id = ? AND preview_ref = ?`,
          )
          .get(managementTenantId, previewRef)
      : database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM module_releases
             WHERE management_tenant_id = ? AND preview_ref = ? AND approval_id = ?`,
          )
          .get(managementTenantId, previewRef, approvalId),
    ["count"],
  );
  return requiredSqlInteger(row, "count");
}

function verifyApprovalSemantics(
  database: DatabaseSync,
  managementTenantId: string,
  approval: ModuleApprovalRecord,
): void {
  verifyRecordTenant(approval.managementTenantId, managementTenantId);
  const preview = findPreview(database, managementTenantId, approval.previewRef);
  if (
    preview === null ||
    approval.previewCanonicalHash !== preview.canonicalHash ||
    approval.baseReleaseId !== preview.baseReleaseId ||
    approval.baseRevision !== preview.baseRevision ||
    approval.expiresAt !== preview.expiresAt ||
    !sameDigestSet(
      approval.inventoryDigestSet,
      preview.inventoryRefs.map((ref) => ref.descriptorDigest),
    ) ||
    approval.consumed !== preview.consumed ||
    compareRfc3339Instants(approval.decidedAt, approval.expiresAt) >= 0
  ) {
    repositoryError("invalid_state");
  }
  const releaseCount = countReleasesForGate(
    database,
    managementTenantId,
    approval.previewRef,
    approval.approvalId,
  );
  if (
    approval.decision === "reject" ||
    !preview.validation.baseMatches ||
    !preview.validation.desiredModulesValid ||
    !preview.validation.inventoryMatches ||
    !preview.validation.minimumActiveModules
  ) {
    if (approval.consumed || releaseCount !== 0) repositoryError("invalid_state");
  } else if (
    (approval.consumed && releaseCount !== 1) ||
    (!approval.consumed && releaseCount !== 0)
  ) {
    repositoryError("invalid_state");
  }
}

function verifyReleaseGateSemantics(
  database: DatabaseSync,
  managementTenantId: string,
  release: ModuleReleaseRecord,
): void {
  verifyRecordTenant(release.managementTenantId, managementTenantId);
  const preview = findPreview(database, managementTenantId, release.previewRef);
  const approval = findApproval(database, managementTenantId, release.approvalId);
  const releaseGateAt = release.publishedAt ?? release.createdAt;
  if (
    preview === null ||
    approval === null ||
    approval.previewRef !== preview.previewRef ||
    approval.decision !== "approve" ||
    !preview.consumed ||
    !approval.consumed ||
    compareRfc3339Instants(releaseGateAt, preview.expiresAt) >= 0 ||
    release.previousReleaseId !== preview.baseReleaseId ||
    release.revision !== preview.baseRevision + 1 ||
    !sameModuleRefs(release.desiredModules, preview.desiredModules) ||
    !preview.validation.baseMatches ||
    !preview.validation.desiredModulesValid ||
    !preview.validation.inventoryMatches ||
    !preview.validation.minimumActiveModules ||
    preview.validation.reasonCodes.length !== 0
  ) {
    repositoryError("invalid_state");
  }
  verifyReleaseRecoverySemantics(database, managementTenantId, release);
}

function verifyReadbackSemantics(
  database: DatabaseSync,
  managementTenantId: string,
  readback: ModuleReadbackRecord,
): void {
  verifyRecordTenant(readback.managementTenantId, managementTenantId);
  const release = findRelease(database, managementTenantId, readback.releaseId);
  if (release === null || release.revision !== readback.revision) {
    repositoryError("invalid_state");
  }
  if (
    (readback.status === "verified" &&
      release.status !== "active_verified" &&
      release.status !== "superseded") ||
    ((readback.status === "mismatch" || readback.status === "unknown") &&
      release.status !== "manual_review")
  ) {
    repositoryError("invalid_state");
  }
  if (readback.status === "pending" || readback.attemptId === undefined) {
    repositoryError("invalid_state");
  }
  const attempt = findReadbackAttempt(database, managementTenantId, readback.attemptId);
  if (
    attempt === null ||
    attempt.phase !== "finalized" ||
    attempt.releaseId !== readback.releaseId ||
    attempt.revision !== readback.revision ||
    attempt.readbackRef !== readback.readbackRef ||
    attempt.terminalStatus !== readback.status
  ) {
    repositoryError("invalid_state");
  }
}

function idempotencyDomainTimestamp(
  database: DatabaseSync,
  managementTenantId: string,
  record: ControlIdempotencyRecord,
): string | null {
  if (record.domainRecordRef === null) return null;
  switch (record.action) {
    case "packages.register": {
      const event = findDomainEvent(
        database,
        managementTenantId,
        record.domainRecordRef,
        "registration",
      );
      if (event === null || event.detail.kind !== "registration") return null;
      return findRegistration(
        database,
        managementTenantId,
        event.detail.moduleId,
        event.detail.version,
        event.detail.descriptorDigest,
      )?.registeredAt ?? null;
    }
    case "deployments.preview":
      return findPreview(database, managementTenantId, record.domainRecordRef)?.createdAt ?? null;
    case "approvals.decide":
      return findApproval(database, managementTenantId, record.domainRecordRef)?.decidedAt ?? null;
    case "deployments.publish":
      return findRelease(database, managementTenantId, record.domainRecordRef)?.createdAt ?? null;
    case "deployments.reconcile": {
      const attempt = findReadbackAttemptByIdempotency(
        database,
        managementTenantId,
        "deployments.reconcile",
        record.idempotencyKey,
      );
      if (attempt !== null) return attempt.claimedAt;
      const rows = database
        .prepare(EVENT_SELECT)
        .iterate(managementTenantId, record.domainRecordRef) as Iterable<unknown>;
      for (const row of rows) {
        const event = decodeEventRow(row);
        if (
          event.action === "deployments.reconcile" &&
          event.kind === "reconciliation" &&
          event.occurredAt === record.createdAt
        ) {
          return event.occurredAt;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function verifySimpleFinalResultBinding(
  database: DatabaseSync,
  managementTenantId: string,
  record: ControlIdempotencyRecord,
  finalResult: ControlFinalResult,
): void {
  const parsed = controlEnvelopeSchema.safeParse(finalResult.envelope);
  if (!parsed.success || record.domainRecordRef === null) repositoryError("invalid_state");
  const data = parsed.data.data;
  if (record.action === "packages.register") {
    if (
      data?.kind !== "registration" ||
      data.module_id === undefined ||
      data.version === undefined ||
      data.descriptor_digest === undefined
    ) {
      repositoryError("invalid_state");
    }
    const registration = findRegistration(
      database,
      managementTenantId,
      data.module_id,
      data.version,
      data.descriptor_digest,
    );
    if (registration === null) repositoryError("invalid_state");
    return;
  }
  if (record.action === "deployments.preview") {
    if (
      data?.kind !== "preview" ||
      data.preview_ref === undefined ||
      data.intent === undefined ||
      data.base_revision === undefined ||
      data.desired_modules === undefined ||
      data.expires_at === undefined
    ) {
      repositoryError("invalid_state");
    }
    const preview = findPreview(database, managementTenantId, data.preview_ref);
    if (
      preview === null ||
      preview.intent !== data.intent ||
      preview.baseReleaseId !== data.base_release_id ||
      preview.baseRevision !== data.base_revision ||
      preview.expiresAt !== data.expires_at ||
      !sameModuleRefs(preview.desiredModules, envelopeModuleRefs(data.desired_modules)) ||
      (preview.intent === "rollback" && preview.targetReleaseId !== data.target_release_id)
    ) {
      repositoryError("invalid_state");
    }
    return;
  }
  if (record.action === "approvals.decide") {
    if (
      data?.kind !== "approval" ||
      data.approval_id === undefined ||
      data.preview_ref === undefined ||
      data.decision === undefined
    ) {
      repositoryError("invalid_state");
    }
    const approval = findApproval(database, managementTenantId, data.approval_id);
    if (
      approval === null ||
      approval.previewRef !== data.preview_ref ||
      approval.decision !== data.decision
    ) {
      repositoryError("invalid_state");
    }
  }
}

function hasHistoricalReadbackEvent(
  database: DatabaseSync,
  managementTenantId: string,
  releaseId: string,
  revision: number,
  action: "deployments.publish" | "deployments.reconcile",
  status: "pending" | "verified" | "mismatch" | "unknown",
  reasonCodes?: readonly string[],
): boolean {
  const rows = database
    .prepare(EVENT_SELECT)
    .iterate(managementTenantId, releaseId) as Iterable<unknown>;
  for (const row of rows) {
    const event = decodeEventRow(row);
    if (
      event.kind === "reconciliation" &&
      event.action === action &&
      event.status === status &&
      event.detail.releaseId === releaseId &&
      event.detail.revision === revision &&
      (reasonCodes === undefined || equalCanonical(event.reasonCodes, reasonCodes))
    ) {
      return true;
    }
  }
  return false;
}

function verifyHistoricalReleaseCompletion(
  database: DatabaseSync,
  managementTenantId: string,
  record: ControlIdempotencyRecord,
  finalResult: ControlFinalResult,
): void {
  if (
    record.domainRecordRef === null ||
    (record.action !== "deployments.publish" &&
      record.action !== "deployments.reconcile")
  ) {
    repositoryError("invalid_state");
  }
  const parsed = controlEnvelopeSchema.safeParse(finalResult.envelope);
  const release = findRelease(database, managementTenantId, record.domainRecordRef);
  const readback = findReadback(database, managementTenantId, record.domainRecordRef);
  if (!parsed.success || release === null || readback === null) {
    repositoryError("invalid_state");
  }
  const envelope = parsed.data;
  const data = envelope.data;
  const historicalAttempt = findReadbackAttemptByIdempotency(
    database,
    managementTenantId,
    record.action,
    record.idempotencyKey,
  );
  if (
    historicalAttempt !== null &&
    (historicalAttempt.phase !== "finalized" ||
      historicalAttempt.terminalStatus !== envelope.readback.status ||
      !equalCanonical(historicalAttempt.reasonCodes, envelope.reason_codes))
  ) {
    repositoryError("invalid_state");
  }
  if (
    envelope.readback.release_id !== release.releaseId ||
    envelope.readback.revision !== release.revision ||
    (record.action === "deployments.publish" &&
      (data?.kind !== "release" ||
        data.release_id !== release.releaseId ||
        data.revision !== release.revision ||
        !sameModuleRefs(envelopeModuleRefs(data.active_modules), release.desiredModules))) ||
    (record.action === "deployments.reconcile" &&
      (data?.kind !== "reconciliation" ||
        data.release_id !== release.releaseId ||
        data.revision !== release.revision ||
        data.status !== envelope.readback.status))
  ) {
    repositoryError("invalid_state");
  }

  if (envelope.status === "success") {
    if (
      envelope.readback.status !== "verified" ||
      (release.status !== "active_verified" && release.status !== "superseded") ||
      readback.status !== "verified" ||
      readback.appliedReleaseId !== release.releaseId ||
      readback.appliedRevision !== release.revision ||
      !sameModuleRefs(readback.appliedModules, release.desiredModules) ||
      envelope.reason_codes.length !== 0 ||
      !hasHistoricalReadbackEvent(
        database,
        managementTenantId,
        release.releaseId,
        release.revision,
        record.action,
        "verified",
      )
    ) {
      repositoryError("invalid_state");
    }
    return;
  }

  const historicalStatus = envelope.readback.status;
  if (
    envelope.status !== "manual_review" ||
    (historicalStatus !== "mismatch" && historicalStatus !== "unknown") ||
    envelope.reason_codes.length === 0 ||
    !hasHistoricalReadbackEvent(
      database,
      managementTenantId,
      release.releaseId,
      release.revision,
      record.action,
      historicalStatus,
      envelope.reason_codes,
    )
  ) {
    repositoryError("invalid_state");
  }
  if (historicalAttempt !== null) return;
  if (release.status === "manual_review") {
    if (
      readback.status !== historicalStatus ||
      !equalCanonical(readback.reasonCodes, envelope.reason_codes)
    ) {
      repositoryError("invalid_state");
    }
    return;
  }
  if (
    (release.status !== "active_verified" && release.status !== "superseded") ||
    readback.status !== "verified" ||
    !hasHistoricalReadbackEvent(
      database,
      managementTenantId,
      release.releaseId,
      release.revision,
      "deployments.reconcile",
      "verified",
    )
  ) {
    repositoryError("invalid_state");
  }
}

function verifyIdempotencySemantics(
  database: DatabaseSync,
  managementTenantId: string,
  record: ControlIdempotencyRecord,
): void {
  verifyRecordTenant(record.managementTenantId, managementTenantId);
  if (record.status === "reserved") return;
  const domainTimestamp = idempotencyDomainTimestamp(
    database,
    managementTenantId,
    record,
  );
  if (domainTimestamp === null || domainTimestamp !== record.createdAt) {
    repositoryError("invalid_state");
  }
  if (
    record.action === "deployments.publish" &&
    record.status === "domain_committed"
  ) {
    const release = findRelease(database, managementTenantId, record.domainRecordRef);
    if (release === null || release.status === "superseded") {
      repositoryError("invalid_state");
    }
  }
  if (record.status !== "completed") return;
  if (record.finalResult === null || record.domainRecordRef === null) {
    repositoryError("invalid_state");
  }
  let expectedRevision: number | undefined;
  if (record.action === "deployments.publish" || record.action === "deployments.reconcile") {
    const release = findRelease(database, managementTenantId, record.domainRecordRef);
    if (release === null) repositoryError("invalid_state");
    expectedRevision = release.revision;
  }
  let finalResult: ControlFinalResult;
  try {
    finalResult = validateFinalResult(
      record.finalResult,
      record.action,
      record.domainRecordRef,
      expectedRevision,
    );
  } catch {
    repositoryError("invalid_state");
  }
  if (record.action === "deployments.publish" || record.action === "deployments.reconcile") {
    verifyHistoricalReleaseCompletion(
      database,
      managementTenantId,
      record,
      finalResult,
    );
  } else {
    verifySimpleFinalResultBinding(
      database,
      managementTenantId,
      record,
      finalResult,
    );
  }
}

function idempotencyAuthorityKey(
  action: ModuleControlAction,
  idempotencyKey: string,
): string {
  return `${action}\0${idempotencyKey}`;
}

function domainEventAuthorityKey(kind: string, objectRef: string): string {
  return `${kind}\0${objectRef}`;
}

function currentReadbackEventKey(readback: ModuleReadbackRecord): string {
  return repositoryJson({
    checkedAt: readback.checkedAt,
    readbackRef: readback.readbackRef,
    reasonCodes: readback.reasonCodes,
    releaseId: readback.releaseId,
    revision: readback.revision,
    status: readback.status,
  });
}

function reconciliationEventKey(event: ControlEventRecord): string {
  if (event.kind !== "reconciliation") repositoryError("invalid_state");
  return repositoryJson({
    checkedAt: event.occurredAt,
    readbackRef: event.detail.readbackRef,
    reasonCodes: event.reasonCodes,
    releaseId: event.detail.releaseId,
    revision: event.detail.revision,
    status: event.status,
  });
}

function incrementAuthorityCount(
  counts: Map<string, number>,
  key: string,
): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function completedEnvelope(
  record: ControlIdempotencyRecord,
): ControlFinalResult["envelope"] | null {
  if (record.status !== "completed" || record.finalResult === null) return null;
  const parsed = controlEnvelopeSchema.safeParse(record.finalResult.envelope);
  if (!parsed.success) repositoryError("invalid_state");
  return parsed.data;
}

function verifyCompletionEvent(
  database: DatabaseSync,
  authority: PersistedIdempotencyAuthority,
  event: ControlEventRecord,
  previousEvent: ControlEventRecord | null,
): void {
  const record = authority.record;
  const expectedRef = `idempotency:${record.action}:${record.idempotencyKey}`;
  const attempt = database
    .prepare(
      `SELECT attempt_id FROM module_readback_attempts
       WHERE completion_event_sequence = ?`,
    )
    .get(event.sequence);
  const expectedOccurredAt =
    attempt === undefined
      ? resolveMonotonicControlEventOccurredAt(record.createdAt, previousEvent)
      : event.occurredAt;
  if (
    record.status !== "completed" ||
    event.kind !== "idempotency" ||
    event.objectRef !== expectedRef ||
    event.status !== "completed" ||
    event.detail.recordRef !== expectedRef ||
    event.detail.domainRecordRef !== record.domainRecordRef ||
    event.detail.status !== "completed" ||
    event.occurredAt !== expectedOccurredAt ||
    event.reasonCodes.length !== 0
  ) {
    repositoryError("invalid_state");
  }
}

function verifyRegistrationEvent(
  database: DatabaseSync,
  managementTenantId: string,
  authority: PersistedIdempotencyAuthority,
  event: ControlEventRecord,
): void {
  const record = authority.record;
  if (
    record.action !== "packages.register" ||
    record.domainRecordRef === null ||
    event.kind !== "registration"
  ) {
    repositoryError("invalid_state");
  }
  const registration = findRegistration(
    database,
    managementTenantId,
    event.detail.moduleId,
    event.detail.version,
    event.detail.descriptorDigest,
  );
  const expectedRef =
    `registration:${event.detail.moduleId}:${event.detail.version}:${event.detail.descriptorDigest}`;
  const envelope = completedEnvelope(record);
  if (
    registration === null ||
    record.domainRecordRef !== expectedRef ||
    event.objectRef !== expectedRef ||
    event.detail.recordRef !== expectedRef ||
    event.status !== "registered" ||
    event.detail.status !== "registered" ||
    event.actorRef !== registration.registeredByActorRef ||
    event.occurredAt !== registration.registeredAt ||
    (envelope === null
      ? event.reasonCodes.length !== 0
      : !equalCanonical(event.reasonCodes, envelope.reason_codes))
  ) {
    repositoryError("invalid_state");
  }
}

function verifyPreviewEvent(
  database: DatabaseSync,
  managementTenantId: string,
  authority: PersistedIdempotencyAuthority,
  event: ControlEventRecord,
): void {
  const record = authority.record;
  if (
    record.action !== "deployments.preview" ||
    record.domainRecordRef === null ||
    event.kind !== "preview"
  ) {
    repositoryError("invalid_state");
  }
  const preview = findPreview(database, managementTenantId, record.domainRecordRef);
  const envelope = completedEnvelope(record);
  if (
    preview === null ||
    event.objectRef !== preview.previewRef ||
    event.detail.previewRef !== preview.previewRef ||
    event.detail.baseRevision !== preview.baseRevision ||
    event.status !== "previewed" ||
    event.detail.status !== "previewed" ||
    event.actorRef !== preview.creatorActorRef ||
    event.occurredAt !== preview.createdAt ||
    (envelope === null
      ? event.reasonCodes.length !== 0
      : !equalCanonical(event.reasonCodes, envelope.reason_codes))
  ) {
    repositoryError("invalid_state");
  }
}

function verifyApprovalEvent(
  database: DatabaseSync,
  managementTenantId: string,
  authority: PersistedIdempotencyAuthority,
  event: ControlEventRecord,
): void {
  const record = authority.record;
  if (
    record.action !== "approvals.decide" ||
    record.domainRecordRef === null ||
    event.kind !== "approval"
  ) {
    repositoryError("invalid_state");
  }
  const approval = findApproval(database, managementTenantId, record.domainRecordRef);
  const expectedStatus = approval?.decision === "approve" ? "approved" : "rejected";
  const envelope = completedEnvelope(record);
  if (
    approval === null ||
    event.objectRef !== approval.approvalId ||
    event.detail.approvalId !== approval.approvalId ||
    event.detail.previewRef !== approval.previewRef ||
    event.status !== expectedStatus ||
    event.detail.status !== expectedStatus ||
    event.actorRef !== approval.approverActorRef ||
    event.occurredAt !== approval.decidedAt ||
    (envelope === null
      ? event.reasonCodes.length !== 0
      : !equalCanonical(event.reasonCodes, envelope.reason_codes))
  ) {
    repositoryError("invalid_state");
  }
}

function verifyReleaseEvent(
  database: DatabaseSync,
  managementTenantId: string,
  authority: PersistedIdempotencyAuthority,
  event: ControlEventRecord,
): void {
  const record = authority.record;
  if (
    record.action !== "deployments.publish" ||
    record.domainRecordRef === null ||
    event.kind !== "release"
  ) {
    repositoryError("invalid_state");
  }
  const release = findRelease(database, managementTenantId, record.domainRecordRef);
  if (
    release === null ||
    event.objectRef !== release.releaseId ||
    event.detail.releaseId !== release.releaseId ||
    event.detail.revision !== release.revision ||
    event.status !== "published_pending_readback" ||
    event.detail.status !== "published_pending_readback" ||
    event.actorRef !== release.publisherActorRef ||
    event.occurredAt !== release.createdAt ||
    event.reasonCodes.length !== 0
  ) {
    repositoryError("invalid_state");
  }
}

function verifyReconciliationEvent(
  database: DatabaseSync,
  managementTenantId: string,
  authority: PersistedIdempotencyAuthority,
  event: ControlEventRecord,
): void {
  const record = authority.record;
  if (
    (record.action !== "deployments.publish" &&
      record.action !== "deployments.reconcile") ||
    record.domainRecordRef === null ||
    event.kind !== "reconciliation"
  ) {
    repositoryError("invalid_state");
  }
  const release = findRelease(database, managementTenantId, record.domainRecordRef);
  const currentReadback = findReadback(database, managementTenantId, record.domainRecordRef);
  const attempt = database
    .prepare(
      `SELECT attempt_id FROM module_readback_attempts
       WHERE reconciliation_event_sequence = ?`,
    )
    .get(event.sequence);
  if (
    release === null ||
    event.objectRef !== release.releaseId ||
    event.detail.releaseId !== release.releaseId ||
    event.detail.revision !== release.revision ||
    compareRfc3339Instants(event.occurredAt, release.createdAt) < 0 ||
    ((event.status === "pending" || event.status === "verified") &&
      event.reasonCodes.length !== 0) ||
    ((event.status === "mismatch" || event.status === "unknown") &&
      event.reasonCodes.length === 0)
  ) {
    repositoryError("invalid_state");
  }
  if (
    attempt === undefined &&
    record.action === "deployments.reconcile" &&
    event.occurredAt !== record.createdAt
  ) {
    repositoryError("invalid_state");
  }
  if (
    attempt === undefined &&
    currentReadback !== null &&
    currentReadback.readbackRef === event.detail.readbackRef &&
    reconciliationEventKey(event) !== currentReadbackEventKey(currentReadback)
  ) {
    repositoryError("invalid_state");
  }
  const envelope = completedEnvelope(record);
  if (
    envelope !== null &&
    (envelope.readback.status !== event.status ||
      !equalCanonical(envelope.reason_codes, event.reasonCodes))
  ) {
    repositoryError("invalid_state");
  }
}

function verifyReadbackAttemptGraph(
  database: DatabaseSync,
  managementTenantId: string,
): void {
  const eventRows = database
    .prepare(
      `SELECT sequence, management_tenant_id, event_id, actor_ref, action,
              idempotency_key, request_hash, object_ref, status,
              reason_codes_json, payload_json, occurred_at
       FROM module_control_events ORDER BY sequence`,
    )
    .all() as unknown[];
  const events = new Map<number, PersistedEventAuthority>();
  let expectedSequence = 1;
  for (const row of eventRows) {
    const persisted = decodeEventAuthorityRow(row);
    if (persisted.event.sequence !== expectedSequence) repositoryError("invalid_state");
    expectedSequence += 1;
    if (persisted.event.managementTenantId !== managementTenantId) {
      repositoryError("invalid_state");
    }
    events.set(persisted.event.sequence, persisted);
  }

  const attempts = findReadbackAttempts(database, managementTenantId);
  const reconciliationSequences = new Set<number>();
  const completionSequences = new Set<number>();
  const finalizedAttemptsByRelease = new Map<string, ReadbackAttemptRecord[]>();
  for (const attempt of attempts) {
    if (attempt.managementTenantId !== managementTenantId) repositoryError("invalid_state");
    const idempotency = findIdempotency(
      database,
      managementTenantId,
      attempt.action,
      attempt.idempotencyKey,
    );
    const release = findRelease(database, managementTenantId, attempt.releaseId);
    if (
      idempotency === null ||
      release === null ||
      idempotency.requestHash !== attempt.requestHash ||
      idempotency.actorRef !== attempt.actorRef ||
      idempotency.domainRecordRef !== attempt.releaseId ||
      release.revision !== attempt.revision ||
      !sameModuleRefs(release.desiredModules, attempt.desiredModules)
    ) {
      repositoryError("invalid_state");
    }
    if (attempt.actorRef === SQLITE_RECOVERY_ACTOR_REF) {
      repositoryError("invalid_state");
    }
    if (attempt.phase === "claimed") {
      if (
        idempotency.status !== "domain_committed" ||
        (attempt.action === "deployments.publish" &&
          findReadback(database, managementTenantId, attempt.releaseId) !== null) ||
        (release.status !== "published_pending_readback" && release.status !== "manual_review")
      ) {
        repositoryError("invalid_state");
      }
      continue;
    }
    if (
      idempotency.status !== "completed" ||
      idempotency.finalResult === null ||
      attempt.reconciliationEventSequence === null ||
      attempt.completionEventSequence === null ||
      reconciliationSequences.has(attempt.reconciliationEventSequence) ||
      completionSequences.has(attempt.completionEventSequence) ||
      attempt.reconciliationEventSequence === attempt.completionEventSequence
    ) {
      repositoryError("invalid_state");
    }
    if (
      attempt.finalizedByActorRef !== attempt.actorRef &&
      attempt.finalizedByActorRef !== SQLITE_RECOVERY_ACTOR_REF
    ) {
      repositoryError("invalid_state");
    }
    if (
      attempt.finalizedByActorRef === SQLITE_RECOVERY_ACTOR_REF &&
      (attempt.terminalStatus !== "unknown" ||
        attempt.appliedReleaseId !== null ||
        attempt.appliedRevision !== null ||
        attempt.appliedModules.length !== 0 ||
        !equalCanonical(attempt.reasonCodes, ["readback.interrupted"]) ||
        idempotency.finalResult?.envelope.status !== "manual_review")
    ) {
      repositoryError("invalid_state");
    }
    const reconciliation = events.get(attempt.reconciliationEventSequence);
    const completion = events.get(attempt.completionEventSequence);
    if (reconciliation === undefined || completion === undefined) {
      repositoryError("invalid_state");
    }
    const reconciliationEvent = reconciliation.event;
    const completionEvent = completion.event;
    if (
      reconciliationEvent.kind !== "reconciliation" ||
      reconciliationEvent.action !== attempt.action ||
      reconciliation.idempotencyKey !== attempt.idempotencyKey ||
      reconciliation.requestHash !== attempt.requestHash ||
      reconciliationEvent.objectRef !== attempt.releaseId ||
      reconciliationEvent.status !== attempt.terminalStatus ||
      reconciliationEvent.detail.releaseId !== attempt.releaseId ||
      reconciliationEvent.detail.revision !== attempt.revision ||
      reconciliationEvent.detail.readbackRef !== attempt.readbackRef ||
      reconciliationEvent.detail.status !== attempt.terminalStatus ||
      !equalCanonical(reconciliationEvent.reasonCodes, attempt.reasonCodes) ||
      reconciliationEvent.actorRef !== attempt.finalizedByActorRef ||
      reconciliationEvent.occurredAt !== attempt.finalizedAt
    ) {
      repositoryError("invalid_state");
    }
    const completionRef = attemptIdempotencyRecordRef(attempt.action, attempt.idempotencyKey);
    if (
      completionEvent.kind !== "idempotency" ||
      completionEvent.action !== attempt.action ||
      completion.idempotencyKey !== attempt.idempotencyKey ||
      completion.requestHash !== attempt.requestHash ||
      completionEvent.objectRef !== completionRef ||
      completionEvent.status !== "completed" ||
      completionEvent.detail.recordRef !== completionRef ||
      completionEvent.detail.domainRecordRef !== attempt.releaseId ||
      completionEvent.detail.status !== "completed" ||
      completionEvent.reasonCodes.length !== 0 ||
      completionEvent.actorRef !== attempt.finalizedByActorRef ||
      completionEvent.occurredAt !== attempt.finalizedAt
    ) {
      repositoryError("invalid_state");
    }
    const finalResult = validateFinalResult(
      idempotency.finalResult,
      attempt.action,
      attempt.releaseId,
      attempt.revision,
    );
    const observation = {
      status: attempt.terminalStatus,
      appliedReleaseId: attempt.appliedReleaseId,
      appliedRevision: attempt.appliedRevision,
      appliedModules: attempt.appliedModules,
      reasonCodes: attempt.reasonCodes,
      checkedAt: attempt.checkedAt,
    } as ReadbackAttemptObservation;
    assertAttemptFinalResultSemantics(finalResult, attempt, observation, release);
    reconciliationSequences.add(attempt.reconciliationEventSequence);
    completionSequences.add(attempt.completionEventSequence);
    const releaseAttempts = finalizedAttemptsByRelease.get(attempt.releaseId) ?? [];
    releaseAttempts.push(attempt);
    finalizedAttemptsByRelease.set(attempt.releaseId, releaseAttempts);
  }

  for (const readbackRow of database
    .prepare(
      `SELECT management_tenant_id, release_id, attempt_id, readback_ref, revision,
              applied_release_id, applied_revision, applied_modules_json, status,
              reason_codes_json, checked_at
       FROM module_readbacks ORDER BY management_tenant_id, release_id`,
    )
    .all() as unknown[]) {
    const readback = decodeReadbackRow(readbackRow);
    const attempt = findReadbackAttempt(database, managementTenantId, readback.attemptId!);
    if (attempt === null || attempt.phase !== "finalized") repositoryError("invalid_state");
  }
  for (const [releaseId, releaseAttempts] of finalizedAttemptsByRelease) {
    const ordered = [...releaseAttempts].sort(
      (left, right) =>
        right.reconciliationEventSequence! - left.reconciliationEventSequence! ||
        (right.attemptId > left.attemptId ? 1 : right.attemptId < left.attemptId ? -1 : 0),
    );
    const current = findReadback(database, managementTenantId, releaseId);
    const currentRelease = findRelease(database, managementTenantId, releaseId);
    if (currentRelease === null) repositoryError("invalid_state");
    const latestAttempt = ordered[0]!;
    if (
      current === null ||
      current.attemptId !== latestAttempt.attemptId ||
      current.readbackRef !== latestAttempt.readbackRef ||
      current.revision !== latestAttempt.revision ||
      current.status !== latestAttempt.terminalStatus ||
      current.appliedReleaseId !== latestAttempt.appliedReleaseId ||
      current.appliedRevision !== latestAttempt.appliedRevision ||
      !sameModuleRefs(current.appliedModules, latestAttempt.appliedModules) ||
      !equalCanonical(current.reasonCodes, latestAttempt.reasonCodes) ||
      current.checkedAt !== latestAttempt.checkedAt ||
      (latestAttempt.terminalStatus === "verified" &&
        (currentRelease.status !== "active_verified" && currentRelease.status !== "superseded")) ||
      ((latestAttempt.terminalStatus === "mismatch" || latestAttempt.terminalStatus === "unknown") &&
        (currentRelease.status !== "manual_review" ||
          !equalCanonical(
            currentRelease.reasonCodes,
            latestAttempt.reasonCodes,
          )))
    ) {
      repositoryError("invalid_state");
    }
  }
  for (const event of events.values()) {
    const sequence = event.event.sequence;
    if (
      event.event.kind === "reconciliation" &&
      (event.event.action === "deployments.publish" ||
        event.event.action === "deployments.reconcile") &&
      !reconciliationSequences.has(sequence)
    ) {
      repositoryError("invalid_state");
    }
    if (
      event.event.kind === "idempotency" &&
      (event.event.action === "deployments.publish" ||
        event.event.action === "deployments.reconcile") &&
      event.event.status === "completed" &&
      !completionSequences.has(sequence)
    ) {
      repositoryError("invalid_state");
    }
  }
  for (const sequence of reconciliationSequences) {
    if (completionSequences.has(sequence)) repositoryError("invalid_state");
  }
}

function verifyEventAgainstAuthority(
  database: DatabaseSync,
  managementTenantId: string,
  authority: PersistedIdempotencyAuthority,
  event: ControlEventRecord,
  counts: ControlEventLifecycleCounts,
  previousEvent: ControlEventRecord | null,
): void {
  if (authority.record.status === "reserved") repositoryError("invalid_state");
  switch (event.kind) {
    case "registration":
      verifyRegistrationEvent(database, managementTenantId, authority, event);
      counts.registration += 1;
      return;
    case "preview":
      verifyPreviewEvent(database, managementTenantId, authority, event);
      counts.preview += 1;
      return;
    case "approval":
      verifyApprovalEvent(database, managementTenantId, authority, event);
      counts.approval += 1;
      return;
    case "release":
      verifyReleaseEvent(database, managementTenantId, authority, event);
      counts.release += 1;
      return;
    case "reconciliation":
      verifyReconciliationEvent(database, managementTenantId, authority, event);
      counts.reconciliation += 1;
      return;
    case "idempotency":
      verifyCompletionEvent(database, authority, event, previousEvent);
      counts.completion += 1;
      return;
    default:
      repositoryError("invalid_state");
  }
}

function verifyEventGraph(
  database: DatabaseSync,
  managementTenantId: string,
): void {
  const authorities = new Map<string, PersistedIdempotencyAuthority>();
  const lifecycleCounts = new Map<string, ControlEventLifecycleCounts>();
  const idempotencyRows = database
    .prepare(
      `SELECT management_tenant_id, action, idempotency_key, request_hash,
              actor_ref, status, domain_record_ref, final_result_json,
              created_at, expires_at
       FROM module_control_idempotency
       ORDER BY management_tenant_id, action, idempotency_key`,
    )
    .iterate() as Iterable<unknown>;
  for (const row of idempotencyRows) {
    const authority = decodeIdempotencyAuthorityRow(row);
    verifyRecordTenant(authority.record.managementTenantId, managementTenantId);
    const key = idempotencyAuthorityKey(
      authority.record.action,
      authority.record.idempotencyKey,
    );
    if (authorities.has(key)) repositoryError("invalid_state");
    authorities.set(key, authority);
    lifecycleCounts.set(key, createControlEventLifecycleCounts());
  }

  const authoritativeDomainEvents = new Map<string, number>();
  const readbackEvents = new Map<string, number>();
  const attemptTerminalActors = new Map<number, string>();
  for (const attempt of findReadbackAttempts(database, managementTenantId)) {
    if (attempt.phase !== "finalized") continue;
    if (
      attempt.finalizedByActorRef !== attempt.actorRef &&
      attempt.finalizedByActorRef !== SQLITE_RECOVERY_ACTOR_REF
    ) {
      repositoryError("invalid_state");
    }
    for (const sequence of [
      attempt.reconciliationEventSequence,
      attempt.completionEventSequence,
    ]) {
      if (sequence === null || attemptTerminalActors.has(sequence)) {
        repositoryError("invalid_state");
      }
      attemptTerminalActors.set(sequence, attempt.finalizedByActorRef);
    }
  }
  const eventRows = database
    .prepare(
      `SELECT sequence, management_tenant_id, event_id, actor_ref, action,
              idempotency_key, request_hash, object_ref, status,
              reason_codes_json, payload_json, occurred_at
       FROM module_control_events
       ORDER BY sequence`,
    )
    .iterate() as Iterable<unknown>;
  let expectedSequence = 1;
  let previousEvent: ControlEventRecord | null = null;
  for (const row of eventRows) {
    const persisted = decodeEventAuthorityRow(row);
    const event = persisted.event;
    verifyRecordTenant(event.managementTenantId, managementTenantId);
    if (event.sequence !== expectedSequence) repositoryError("invalid_state");
    assertControlEventInstantOrder(previousEvent, event);
    expectedSequence += 1;
    const key = idempotencyAuthorityKey(event.action, persisted.idempotencyKey);
    const authority = authorities.get(key);
    const counts = lifecycleCounts.get(key);
    const attemptFinalizerActor = attemptTerminalActors.get(event.sequence);
    const actorMatchesAuthority =
      authority !== undefined && event.actorRef === authority.record.actorRef;
    const actorMatchesAttemptFinalizer =
      attemptFinalizerActor !== undefined &&
      (event.kind === "reconciliation" || event.kind === "idempotency") &&
      event.actorRef === attemptFinalizerActor;
    if (
      authority === undefined ||
      counts === undefined ||
      persisted.requestHash !== authority.record.requestHash ||
      (!actorMatchesAuthority && !actorMatchesAttemptFinalizer)
    ) {
      repositoryError("invalid_state");
    }
    verifyEventAgainstAuthority(
      database,
      managementTenantId,
      authority,
      event,
      counts,
      previousEvent,
    );
    if (event.kind === "reconciliation") {
      incrementAuthorityCount(readbackEvents, reconciliationEventKey(event));
    } else if (event.kind !== "idempotency") {
      incrementAuthorityCount(
        authoritativeDomainEvents,
        domainEventAuthorityKey(event.kind, event.objectRef),
      );
    }
    previousEvent = event;
  }

  for (const [key, authority] of authorities) {
    const counts = lifecycleCounts.get(key);
    if (counts === undefined) repositoryError("invalid_state");
    const claimedReadbackAttempt =
      authority.record.action === "deployments.reconcile" &&
      authority.record.status === "domain_committed"
        ? findReadbackAttemptByIdempotency(
            database,
            managementTenantId,
            authority.record.action,
            authority.record.idempotencyKey,
          )
        : null;
    if (
      claimedReadbackAttempt?.phase === "claimed" &&
      counts.approval === 0 &&
      counts.completion === 0 &&
      counts.preview === 0 &&
      counts.reconciliation === 0 &&
      counts.registration === 0 &&
      counts.release === 0
    ) {
      continue;
    }
    assertControlEventLifecycleCardinality(authority.record, counts);
  }

  const requireOneDomainEvent = (kind: string, objectRef: string): void => {
    if (authoritativeDomainEvents.get(domainEventAuthorityKey(kind, objectRef)) !== 1) {
      repositoryError("invalid_state");
    }
  };
  const registrationRows = database
    .prepare(
      `SELECT management_tenant_id, module_id, version, descriptor_digest,
              evidence_level, production_eligible, evidence_refs_json,
              registered_by_actor_ref, registered_at
       FROM module_registrations`,
    )
    .iterate() as Iterable<unknown>;
  for (const row of registrationRows) {
    const registration = decodeRegistrationRow(row);
    requireOneDomainEvent(
      "registration",
      `registration:${registration.moduleId}:${registration.version}:${registration.descriptorDigest}`,
    );
  }
  const previewRows = database
    .prepare(PREVIEW_SELECT.replace(
      "WHERE management_tenant_id = ? AND preview_ref = ?",
      "",
    ))
    .iterate() as Iterable<unknown>;
  for (const row of previewRows) {
    const preview = decodePreviewRow(row);
    requireOneDomainEvent("preview", preview.previewRef);
  }
  const approvalRows = database
    .prepare(APPROVAL_SELECT.replace(
      "WHERE management_tenant_id = ? AND approval_id = ?",
      "",
    ))
    .iterate() as Iterable<unknown>;
  for (const row of approvalRows) {
    const approval = decodeApprovalRow(row);
    requireOneDomainEvent("approval", approval.approvalId);
  }
  const releaseRows = database
    .prepare(RELEASE_SELECT.replace(
      "WHERE management_tenant_id = ? AND release_id = ?",
      "",
    ))
    .iterate() as Iterable<unknown>;
  for (const row of releaseRows) {
    const release = decodeReleaseRow(row);
    requireOneDomainEvent("release", release.releaseId);
  }
  const readbackRows = database
    .prepare(READBACK_SELECT.replace(
      "WHERE management_tenant_id = ? AND release_id = ?",
      "",
    ))
    .iterate() as Iterable<unknown>;
  for (const row of readbackRows) {
    const readback = decodeReadbackRow(row);
    const attempt =
      readback.attemptId === undefined
        ? null
        : findReadbackAttempt(database, managementTenantId, readback.attemptId);
    if (
      (attempt === null && (readbackEvents.get(currentReadbackEventKey(readback)) ?? 0) < 1) ||
      (attempt !== null && attempt.phase !== "finalized")
    ) {
      repositoryError("invalid_state");
    }
  }
}

function verifyRepositorySemantics(
  database: DatabaseSync,
  managementTenantId: string,
): void {
  const registrationRows = database
    .prepare(
      `SELECT management_tenant_id, module_id, version, descriptor_digest,
              evidence_level, production_eligible, evidence_refs_json,
              registered_by_actor_ref, registered_at
       FROM module_registrations
       ORDER BY management_tenant_id, module_id, version, descriptor_digest`,
    )
    .iterate() as Iterable<unknown>;
  for (const row of registrationRows) {
    verifyRecordTenant(
      decodeRegistrationRow(row).managementTenantId,
      managementTenantId,
    );
  }

  const eventRows = database
    .prepare(
      `SELECT sequence, management_tenant_id, event_id, actor_ref, action,
              object_ref, status, reason_codes_json, payload_json, occurred_at
       FROM module_control_events
       ORDER BY sequence`,
    )
    .iterate() as Iterable<unknown>;
  let expectedSequence = 1;
  for (const row of eventRows) {
    const event = decodeEventRow(row);
    verifyRecordTenant(event.managementTenantId, managementTenantId);
    if (event.sequence !== expectedSequence) repositoryError("invalid_state");
    expectedSequence += 1;
  }

  const previewRows = database
    .prepare(
      `SELECT management_tenant_id, preview_ref, canonical_hash, intent,
              base_release_id, base_revision, inventory_refs_json,
              desired_modules_json, diff_json, validation_json, creator_actor_ref,
              created_at, expires_at, consumed, target_release_id
       FROM module_previews
       ORDER BY management_tenant_id, created_at, preview_ref`,
    )
    .iterate() as Iterable<unknown>;
  for (const row of previewRows) {
    verifyPreviewSemantics(database, managementTenantId, decodePreviewRow(row));
  }

  const approvalRows = database
    .prepare(
      `SELECT management_tenant_id, approval_id, preview_ref, decision,
              preview_canonical_hash, base_release_id, base_revision,
              inventory_digest_set_json, expires_at, reason_code,
              approver_actor_ref, decided_at, consumed
       FROM module_approvals
       ORDER BY management_tenant_id, decided_at, approval_id`,
    )
    .iterate() as Iterable<unknown>;
  for (const row of approvalRows) {
    verifyApprovalSemantics(database, managementTenantId, decodeApprovalRow(row));
  }

  const releaseRows = database
    .prepare(
      `SELECT management_tenant_id, release_id, revision, desired_modules_json,
              previous_release_id, preview_ref, approval_id, publisher_actor_ref,
              status, created_at, published_at, readback_ref, reason_codes_json,
              superseded_by_release_id
       FROM module_releases
       ORDER BY management_tenant_id, revision`,
    )
    .iterate() as Iterable<unknown>;
  let previousRelease: ModuleReleaseRecord | null = null;
  let unresolvedCount = 0;
  let activeCount = 0;
  for (const row of releaseRows) {
    const release = decodeReleaseRow(row);
    verifyReleaseGateSemantics(database, managementTenantId, release);
    if (
      release.revision !== (previousRelease?.revision ?? 0) + 1 ||
      release.previousReleaseId !== (previousRelease?.releaseId ?? null)
    ) {
      repositoryError("invalid_state");
    }
    if (release.status === "published_pending_readback" || release.status === "manual_review") {
      unresolvedCount += 1;
    }
    if (release.status === "active_verified") activeCount += 1;
    if (previousRelease !== null) {
      if (release.status === "published_pending_readback" || release.status === "manual_review") {
        if (previousRelease.status !== "active_verified") repositoryError("invalid_state");
      } else if (
        previousRelease.status !== "superseded" ||
        previousRelease.supersededByReleaseId !== release.releaseId
      ) {
        repositoryError("invalid_state");
      }
    }
    previousRelease = release;
  }
  if (unresolvedCount > 1 || activeCount > 1) repositoryError("invalid_state");
  if (previousRelease?.status === "superseded") repositoryError("invalid_state");

  const readbackRows = database
    .prepare(
      `SELECT management_tenant_id, release_id, attempt_id, readback_ref, revision,
              applied_release_id, applied_revision, applied_modules_json, status,
              reason_codes_json, checked_at
       FROM module_readbacks
       ORDER BY management_tenant_id, checked_at, release_id`,
    )
    .iterate() as Iterable<unknown>;
  for (const row of readbackRows) {
    verifyReadbackSemantics(database, managementTenantId, decodeReadbackRow(row));
  }

  const idempotencyRows = database
    .prepare(
      `SELECT management_tenant_id, action, idempotency_key, request_hash, actor_ref, status,
              domain_record_ref, final_result_json, created_at, expires_at
       FROM module_control_idempotency
       ORDER BY management_tenant_id, created_at, action, idempotency_key`,
    )
    .iterate() as Iterable<unknown>;
  for (const row of idempotencyRows) {
    verifyIdempotencySemantics(database, managementTenantId, decodeIdempotencyRow(row));
  }

  verifyEventGraph(database, managementTenantId);
  verifyReadbackAttemptGraph(database, managementTenantId);

  controlStateInDatabase(database, managementTenantId);
}

function validateInitializeOptions(options: unknown): InitializeSqliteControlStateOptions {
  try {
    assertClosedOptions(options, ["applicationRoot", "instanceId", "managementTenantId"]);
    const applicationRoot = options.applicationRoot;
    const instanceId = options.instanceId;
    const managementTenantId = options.managementTenantId;
    assertIdentityValue(instanceId);
    assertIdentityValue(managementTenantId);
    if (typeof applicationRoot !== "string") throwStoreError("invalid_options");
    return { applicationRoot, instanceId, managementTenantId };
  } catch (error) {
    if (error instanceof SqliteControlStoreError) throw error;
    throwStoreError("invalid_options");
  }
}

function validateOpenOptions(options: unknown): OpenSqliteControlStoreOptions {
  try {
    const hasTestOnly =
      isPlainDataObject(options) &&
      Object.prototype.hasOwnProperty.call(options, "testOnly");
    assertClosedOptions(
      options,
      hasTestOnly
        ? [
            "applicationRoot",
            "instanceId",
            "managementTenantId",
            "adminControlEnabled",
            "testOnly",
          ]
        : [
            "applicationRoot",
            "instanceId",
            "managementTenantId",
            "adminControlEnabled",
          ],
    );
    const applicationRoot = options.applicationRoot;
    const instanceId = options.instanceId;
    const managementTenantId = options.managementTenantId;
    const adminControlEnabled = options.adminControlEnabled;
    assertIdentityValue(instanceId);
    assertIdentityValue(managementTenantId);
    if (typeof applicationRoot !== "string" || typeof adminControlEnabled !== "boolean") {
      throwStoreError("invalid_options");
    }
    if (!hasTestOnly) {
      return { applicationRoot, instanceId, managementTenantId, adminControlEnabled };
    }
    const rawTestOnly: unknown = options.testOnly;
    assertClosedOptions(rawTestOnly, ["finalizeClock", "finalizeFailpoint"]);
    const finalizeClock = rawTestOnly.finalizeClock;
    const finalizeFailpoint = rawTestOnly.finalizeFailpoint;
    if (!isSqliteFinalizeClock(finalizeClock)) {
      throwStoreError("invalid_options");
    }
    let typedFinalizeFailpoint: SqliteReadbackFinalizeFailpoint | null;
    if (finalizeFailpoint === null) {
      typedFinalizeFailpoint = null;
    } else if (!isSqliteReadbackFinalizeFailpoint(finalizeFailpoint)) {
      throwStoreError("invalid_options");
    } else {
      typedFinalizeFailpoint = finalizeFailpoint;
    }
    return {
      applicationRoot,
      instanceId,
      managementTenantId,
      adminControlEnabled,
      testOnly: Object.freeze({
        finalizeClock,
        finalizeFailpoint: typedFinalizeFailpoint,
      }),
    };
  } catch (error) {
    if (error instanceof SqliteControlStoreError) throw error;
    throwStoreError("invalid_options");
  }
}

function closeInitializerHandles(
  handles: readonly (VerifiedPathHandle | undefined)[],
  code: "initialization_failed" | "cleanup_failed",
): void {
  let failed = false;
  for (const handle of handles) {
    if (handle === undefined) continue;
    try {
      closeVerifiedHandle(handle, code);
    } catch {
      failed = true;
    }
  }
  if (failed) throwStoreError(code);
}

function cleanupStagingDirectory(
  stagingDir: string,
  stagingEntry: Stats,
  runtimeDir: string,
  runtimeHandle: VerifiedPathHandle,
): void {
  try {
    assertVerifiedHandleEntry(runtimeHandle, "cleanup_failed");
    verifyHandlePath(runtimeHandle, runtimeDir, "cleanup_failed");
    verifiedDirectoryEntry(
      stagingDir,
      "cleanup_failed",
      stagingEntry,
      DIRECTORY_MODE,
      runtimeHandle.owner,
    );
    const entries = readdirSync(stagingDir).sort();
    for (const entryName of entries) {
      const entryPath = join(stagingDir, entryName);
      let entry: Stats;
      let resolvedPath: string;
      try {
        entry = lstatSync(entryPath);
        resolvedPath = realpathSync(entryPath);
      } catch {
        throwStoreError("cleanup_failed");
      }
      if (
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        entry.nlink !== 1 ||
        entry.uid !== runtimeHandle.owner ||
        (entry.mode & 0o077) !== 0 ||
        resolvedPath !== entryPath
      ) {
        throwStoreError("cleanup_failed");
      }
      let fileDescriptor: number | undefined;
      try {
        fileDescriptor = openSync(entryPath, openFlags(fsConstants.O_RDONLY));
        const openedEntry = fstatSync(fileDescriptor);
        if (!sameEntryIdentity(openedEntry, entry)) throwStoreError("cleanup_failed");
      } finally {
        if (fileDescriptor !== undefined) closeSync(fileDescriptor);
      }
      const currentEntry = lstatSync(entryPath);
      if (!sameEntryIdentity(currentEntry, entry)) throwStoreError("cleanup_failed");
      unlinkSync(entryPath);
    }
    verifiedDirectoryEntry(
      stagingDir,
      "cleanup_failed",
      stagingEntry,
      DIRECTORY_MODE,
      runtimeHandle.owner,
    );
    rmdirSync(stagingDir);
    fsyncVerifiedHandle(runtimeHandle, runtimeDir, "cleanup_failed");
  } catch (error) {
    if (error instanceof SqliteControlStoreError) throw error;
    throwStoreError("cleanup_failed");
  }
}

function quarantineUnexpectedFinalState(
  stateDir: string,
  runtimeDir: string,
  runtimeHandle: VerifiedPathHandle,
  observedEntry: Stats,
): void {
  const quarantinePath = join(
    runtimeDir,
    `.mcp-instance-state-quarantine-${randomBytes(16).toString("hex")}`,
  );
  try {
    assertVerifiedHandleEntry(runtimeHandle, "initialization_failed");
    verifyHandlePath(runtimeHandle, runtimeDir, "initialization_failed");
    const currentEntry = lstatSync(stateDir);
    if (!sameEntryIdentity(currentEntry, observedEntry)) {
      throwStoreError("initialization_failed");
    }
    renameSync(stateDir, quarantinePath);
    verifiedDirectoryEntry(
      quarantinePath,
      "initialization_failed",
      observedEntry,
      DIRECTORY_MODE,
      runtimeHandle.owner,
    );
    fsyncVerifiedHandle(runtimeHandle, runtimeDir, "initialization_failed");
  } catch (error) {
    if (error instanceof SqliteControlStoreError) throw error;
    throwStoreError("initialization_failed");
  }
}

export function initializeSqliteControlState(options: InitializeSqliteControlStateOptions): Promise<void> {
  const validated = validateInitializeOptions(options);
  const applicationRoot = normalizedApplicationRoot(validated.applicationRoot);
  const paths = deriveStorePaths(applicationRoot);
  const applicationRootEntry = verifiedDirectoryEntry(
    applicationRoot,
    "invalid_application_root",
  );
  const runtimeEntry = ensureRuntimeDirectory(
    applicationRoot,
    paths.runtimeDir,
    applicationRootEntry,
  );
  const initializerLock = acquireInitializerLock(paths.runtimeDir, runtimeEntry);
  let runtimeHandle: VerifiedPathHandle | undefined;

  try {
    runtimeHandle = openVerifiedDirectoryHandle(
      paths.runtimeDir,
      "invalid_application_root",
      runtimeEntry,
      applicationRootEntry.uid,
    );
    verifiedDirectoryEntry(
      applicationRoot,
      "invalid_application_root",
      applicationRootEntry,
    );
    verifiedDirectoryEntry(
      paths.runtimeDir,
      "invalid_application_root",
      runtimeEntry,
      DIRECTORY_MODE,
      applicationRootEntry.uid,
    );
    if (existingEntry(paths.stateDir) !== null) {
      throwStoreError("state_exists");
    }

    let stagingDir: string | undefined;
    let stagingEntry: Stats | undefined;
    let stagingHandle: VerifiedPathHandle | undefined;
    let databaseHandle: VerifiedPathHandle | undefined;
    let markerHandle: VerifiedPathHandle | undefined;
    let renamed = false;
    let finalStateVerified = false;
    try {
      stagingDir = mkdtempSync(join(paths.runtimeDir, ".mcp-instance-state-staging-"));
      chmodSync(stagingDir, DIRECTORY_MODE);
      try {
        stagingEntry = lstatSync(stagingDir);
      } catch {
        throwStoreError("initialization_failed");
      }
      if (
        stagingEntry.isSymbolicLink() ||
        !stagingEntry.isDirectory() ||
        (stagingEntry.mode & 0o777) !== DIRECTORY_MODE ||
        stagingEntry.uid !== runtimeEntry.uid
      ) {
        throwStoreError("initialization_failed");
      }
      stagingEntry = verifiedDirectoryEntry(
        stagingDir,
        "initialization_failed",
        stagingEntry,
        DIRECTORY_MODE,
        runtimeEntry.uid,
      );
      if (stagingEntry.dev !== runtimeEntry.dev) {
        throwStoreError("initialization_failed");
      }
      stagingHandle = openVerifiedDirectoryHandle(
        stagingDir,
        "initialization_failed",
        stagingEntry,
        runtimeEntry.uid,
      );
      verifiedDirectoryEntry(
        paths.runtimeDir,
        "invalid_application_root",
        runtimeEntry,
        DIRECTORY_MODE,
        applicationRootEntry.uid,
      );

      const stagingDbPath = join(stagingDir, "control.sqlite");
      const stagingMarkerPath = join(stagingDir, "control-identity.json");
      databaseHandle = createDatabaseFile(
        stagingDbPath,
        stagingEntry.uid,
      );
      verifiedDirectoryEntry(
        paths.runtimeDir,
        "invalid_application_root",
        runtimeEntry,
        DIRECTORY_MODE,
        applicationRootEntry.uid,
      );
      verifiedDirectoryEntry(
        stagingDir,
        "initialization_failed",
        stagingEntry,
        DIRECTORY_MODE,
        runtimeEntry.uid,
      );
      const marker = markerFor(
        paths.controlDbPath,
        validated.instanceId,
        validated.managementTenantId,
        `db_${randomBytes(16).toString("hex")}`,
      );
      initializeDatabase(
        stagingDbPath,
        marker,
        databaseHandle,
        stagingDir,
        stagingHandle,
      );
      markerHandle = writeExclusiveFile(
        stagingMarkerPath,
        markerBytes(marker),
        MARKER_MODE,
        stagingEntry.uid,
      );
      verifiedRegularFileEntry(
        stagingMarkerPath,
        "initialization_failed",
        MARKER_MODE,
        markerHandle.entry,
        stagingEntry.uid,
      );
      verifiedDirectoryEntry(
        paths.runtimeDir,
        "invalid_application_root",
        runtimeEntry,
        DIRECTORY_MODE,
        applicationRootEntry.uid,
      );
      verifiedDirectoryEntry(
        stagingDir,
        "initialization_failed",
        stagingEntry,
        DIRECTORY_MODE,
        runtimeEntry.uid,
      );
      fsyncVerifiedHandle(stagingHandle, stagingDir, "initialization_failed");
      assertVerifiedHandleEntry(databaseHandle, "initialization_failed");
      assertVerifiedHandleEntry(markerHandle, "initialization_failed");

      if (existingEntry(paths.stateDir) !== null) {
        throwStoreError("state_exists");
      }
      verifiedDirectoryEntry(
        applicationRoot,
        "invalid_application_root",
        applicationRootEntry,
      );
      verifiedDirectoryEntry(
        paths.runtimeDir,
        "invalid_application_root",
        runtimeEntry,
        DIRECTORY_MODE,
        applicationRootEntry.uid,
      );
      assertVerifiedHandleEntry(runtimeHandle, "initialization_failed");
      verifyHandlePath(runtimeHandle, paths.runtimeDir, "initialization_failed");
      assertVerifiedHandleEntry(stagingHandle, "initialization_failed");
      verifyHandlePath(stagingHandle, stagingDir, "initialization_failed");
      verifyHandlePath(databaseHandle, stagingDbPath, "initialization_failed");
      verifyHandlePath(markerHandle, stagingMarkerPath, "initialization_failed");
      renameSync(stagingDir, paths.stateDir);
      renamed = true;
      let finalEntry: Stats;
      try {
        finalEntry = lstatSync(paths.stateDir);
      } catch {
        throwStoreError("initialization_failed");
      }
      if (
        finalEntry.isSymbolicLink() ||
        !finalEntry.isDirectory() ||
        !sameEntryIdentity(finalEntry, stagingEntry) ||
        (finalEntry.mode & 0o777) !== DIRECTORY_MODE ||
        finalEntry.uid !== runtimeEntry.uid
      ) {
        quarantineUnexpectedFinalState(
          paths.stateDir,
          paths.runtimeDir,
          runtimeHandle,
          finalEntry,
        );
        stagingDir = undefined;
        throwStoreError("initialization_failed");
      }
      stagingDir = undefined;
      verifyHandlePath(stagingHandle, paths.stateDir, "initialization_failed");
      verifyHandlePath(databaseHandle, paths.controlDbPath, "initialization_failed");
      verifyHandlePath(markerHandle, paths.markerPath, "initialization_failed");
      finalStateVerified = true;
      verifiedDirectoryEntry(
        paths.runtimeDir,
        "invalid_application_root",
        runtimeEntry,
        DIRECTORY_MODE,
        applicationRootEntry.uid,
      );
      fsyncVerifiedHandle(runtimeHandle, paths.runtimeDir, "initialization_failed");
      verifiedDirectoryEntry(
        paths.runtimeDir,
        "invalid_application_root",
        runtimeEntry,
        DIRECTORY_MODE,
        applicationRootEntry.uid,
      );
      verifyHandlePath(stagingHandle, paths.stateDir, "initialization_failed");
      verifyHandlePath(databaseHandle, paths.controlDbPath, "initialization_failed");
      verifyHandlePath(markerHandle, paths.markerPath, "initialization_failed");
      closeInitializerHandles(
        [markerHandle, databaseHandle, stagingHandle],
        "initialization_failed",
      );
      markerHandle = undefined;
      databaseHandle = undefined;
      stagingHandle = undefined;
    } catch (error) {
      closeInitializerHandles(
        [markerHandle, databaseHandle, stagingHandle],
        "cleanup_failed",
      );
      markerHandle = undefined;
      databaseHandle = undefined;
      stagingHandle = undefined;
      if (!renamed && stagingDir !== undefined) {
        if (stagingEntry === undefined || runtimeHandle === undefined) {
          throwStoreError("cleanup_failed");
        }
        cleanupStagingDirectory(
          stagingDir,
          stagingEntry,
          paths.runtimeDir,
          runtimeHandle,
        );
      } else if (renamed && !finalStateVerified && existingEntry(paths.stateDir) !== null) {
        throwStoreError("initialization_failed");
      }
      if (error instanceof SqliteControlStoreError) {
        throw error;
      }
      throwStoreError("initialization_failed");
    }
  } finally {
    let cleanupFailed = false;
    try {
      releaseInitializerLock(initializerLock, paths.runtimeDir);
    } catch {
      cleanupFailed = true;
    }
    try {
      closeVerifiedHandle(runtimeHandle, "cleanup_failed");
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) throwStoreError("cleanup_failed");
  }
  return Promise.resolve();
}

function verifyLiveControlStore(
  database: DatabaseSync,
  applicationRoot: string,
  paths: StorePaths,
  expectedIdentity: OpenStoreIdentity,
  expectedMarker: Omit<Marker, "control_db_id">,
  marker: Marker,
  managementTenantId: string,
): void {
  captureOpenStoreIdentity(applicationRoot, paths, expectedIdentity);
  const currentMarker = readAndValidateMarker(
    paths.markerPath,
    expectedMarker,
    expectedIdentity.marker,
  );
  if (currentMarker.control_db_id !== marker.control_db_id) {
    throwStoreError("identity_mismatch");
  }
  verifyOpenedDatabasePath(database, paths.controlDbPath, expectedIdentity.database);
  verifyDatabase(database, marker);
  verifyRepositorySemantics(database, managementTenantId);
}

interface OpenedSqliteControlStore {
  readonly repository: SqliteControlStore;
  readonly recoveryDriver: SqliteReadbackRecoveryDriver | null;
}

function openSqliteControlStoreInternal(
  options: OpenSqliteControlStoreOptions,
  withRecoveryDriver: boolean,
): OpenedSqliteControlStore {
  const validated = validateOpenOptions(options);
  if (validated.adminControlEnabled !== true) {
    throwStoreError("admin_control_disabled");
  }

  const applicationRoot = normalizedApplicationRoot(validated.applicationRoot);
  const paths = deriveStorePaths(applicationRoot);
  assertStateDirectory(paths);
  const expectedIdentity = captureOpenStoreIdentity(applicationRoot, paths);

  const expectedMarker = {
    control_db_path: paths.controlDbPath,
    instance_id: validated.instanceId,
    management_tenant_id: validated.managementTenantId,
    marker_format: MARKER_FORMAT,
    schema_version: SCHEMA_VERSION,
  } as const;
  const marker = readAndValidateMarker(
    paths.markerPath,
    expectedMarker,
    expectedIdentity.marker,
  );

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(readWriteDatabaseUrl(paths.controlDbPath), {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    verifyOpenedDatabasePath(database, paths.controlDbPath, expectedIdentity.database);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec("PRAGMA busy_timeout = 0");
    verifyDatabase(database, marker);
    acquireExclusiveLock(database);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Do not replace the stable store error with a native SQLite message.
    }
    if (error instanceof SqliteControlStoreError) {
      throw error;
    }
    throwStoreError(nativeSqliteFailureCode(error));
  }

  if (database === undefined) {
    throwStoreError("database_open_failed");
  }
  let openDatabase: DatabaseSync | null = database;
  let quarantined = false;
  const quarantine = (): void => {
    quarantined = true;
    const handle = openDatabase;
    if (handle === null) return;
    try {
      handle.close();
      openDatabase = null;
    } catch {
      // Keep the handle for an explicit close retry, but never permit further use.
    }
  };
  const verifyLiveIdentity = (activeDatabase: DatabaseSync): void => {
    try {
      verifyLiveControlStore(
        activeDatabase,
        applicationRoot,
        paths,
        expectedIdentity,
        expectedMarker,
        marker,
        validated.managementTenantId,
      );
    } catch {
      throw new LiveControlStoreMismatch();
    }
  };
  const transactionGuard: RepositoryTransactionGuard = {
    verifyLiveIdentity(): void {
      verifyLiveIdentity(database);
    },
  };
  const readbackOwnerBootId = `boot_${randomUUID()}`;
  const readbackOwnerCapabilities = new SqliteReadbackOwnerCapabilityRegistry();
  const recoverySecret = withRecoveryDriver
    ? createSqliteReadbackRecoverySecret()
    : null;
  const readbackFinalizeRuntime: ReadbackFinalizeRuntime = Object.freeze({
    clock: validated.testOnly?.finalizeClock ?? (() => new Date().toISOString()),
    failpoint: validated.testOnly?.finalizeFailpoint ?? null,
  });
  const liveRepositoryDatabase = (): DatabaseSync => {
    if (quarantined) repositoryError("invalid_state");
    const activeDatabase = requireRepositoryDatabase(openDatabase);
    try {
      verifyLiveIdentity(activeDatabase);
    } catch {
      quarantine();
      repositoryError("invalid_state");
    }
    return activeDatabase;
  };
  const runMutation = <T>(operation: (activeDatabase: DatabaseSync) => T): T => {
    const activeDatabase = liveRepositoryDatabase();
    try {
      return operation(activeDatabase);
    } catch (error: unknown) {
      if (error instanceof LiveControlStoreMismatch) {
        quarantine();
        repositoryError("invalid_state");
      }
      throw error;
    }
  };
  const repository: SqliteControlStore = {
    health(): Promise<{ readonly ready: boolean }> {
      if (openDatabase === null || quarantined) return Promise.resolve({ ready: false });
      try {
        verifyLiveControlStore(
          openDatabase,
          applicationRoot,
          paths,
          expectedIdentity,
          expectedMarker,
          marker,
          validated.managementTenantId,
        );
        return Promise.resolve({ ready: true });
      } catch {
        return Promise.resolve({ ready: false });
      }
    },
    registerModule(request: RegisterModuleRecordRequest): Promise<RegistrationWriteResult> {
      return repositoryPromise(() => {
        return runMutation((activeDatabase) =>
          registerModuleInDatabase(
            activeDatabase,
            validated.managementTenantId,
            request,
            transactionGuard,
          ));
      });
    },
    createPreview(request: CreatePreviewRecordRequest): Promise<PreviewWriteResult> {
      return repositoryPromise(() => {
        return runMutation((activeDatabase) =>
          createPreviewInDatabase(
            activeDatabase,
            validated.managementTenantId,
            request,
            transactionGuard,
          ));
      });
    },
    decideApproval(request: DecideApprovalRecordRequest): Promise<ApprovalWriteResult> {
      return repositoryPromise(() => {
        return runMutation((activeDatabase) =>
          decideApprovalInDatabase(
            activeDatabase,
            validated.managementTenantId,
            request,
            transactionGuard,
          ));
      });
    },
    publishRelease(request: PublishReleaseRecordRequest): Promise<ReleaseWriteResult> {
      return repositoryPromise(() => {
        return runMutation((activeDatabase) =>
          publishReleaseInDatabase(
            activeDatabase,
            validated.managementTenantId,
            request,
            transactionGuard,
          ));
      });
    },
    claimReadbackAttempt(request: ClaimReadbackAttemptRequest): Promise<ReadbackAttemptClaimResult> {
      return repositoryPromise(() => {
        const outcome = runMutation((activeDatabase) =>
          claimReadbackAttemptInDatabase(
            activeDatabase,
            validated.managementTenantId,
            readbackOwnerBootId,
            request,
            transactionGuard,
          ));
        if (outcome.disposition === "existing") {
          return Object.freeze({
            disposition: "existing" as const,
            attempt: deepFreezeReadbackAttempt(outcome.attempt),
          });
        }
        return Object.freeze({
          disposition: "created" as const,
          attempt: deepFreezeReadbackAttempt(outcome.attempt),
          ownerCapability: readbackOwnerCapabilities.create(outcome.attempt.attemptId),
        });
      });
    },
    finalizeReadbackAndComplete(
      request: FinalizeReadbackAndCompleteRequest,
    ): Promise<ReadbackFinalizationResult> {
      return repositoryPromise(() => {
        return runMutation((activeDatabase) =>
          finalizeReadbackAndCompleteInDatabase(
            activeDatabase,
            validated.managementTenantId,
            request,
            transactionGuard,
            readbackOwnerCapabilities,
            readbackFinalizeRuntime,
            readbackOwnerBootId,
            "owner",
            null,
          ));
      });
    },
    getUnfinishedReadbackAttempt(
      query: GetUnfinishedReadbackAttemptQuery,
    ): Promise<DeepReadonly<ReadbackAttemptRecord> | null> {
      return repositoryPromise(() => {
        const values = assertAttemptObjectKeys(query, ["managementTenantId", "attemptId"]);
        if (values.managementTenantId !== validated.managementTenantId) {
          repositoryError("tenant_mismatch");
        }
        assertRepositoryIdentifier(values.attemptId);
        const activeDatabase = liveRepositoryDatabase();
        const attempt = findReadbackAttempt(
          activeDatabase,
          validated.managementTenantId,
          values.attemptId,
        );
        return attempt?.phase === "claimed"
          ? deepFreezeReadbackAttempt(attempt)
          : null;
      });
    },
    listUnfinishedReadbackAttempts(): Promise<readonly DeepReadonly<ReadbackAttemptRecord>[]> {
      return repositoryPromise(() => {
        const activeDatabase = liveRepositoryDatabase();
        const rows = activeDatabase
          .prepare(
            `${READBACK_ATTEMPT_SELECT}
             WHERE management_tenant_id = ? AND phase = 'claimed'
             ORDER BY claimed_at, release_id, revision, attempt_id`,
          )
          .all(validated.managementTenantId) as unknown[];
        return Object.freeze(
          rows.map((row) => deepFreezeReadbackAttempt(decodeReadbackAttemptRow(row))),
        );
      });
    },
    getReadbackAttemptHistory(
      query: GetReadbackAttemptHistoryQuery,
    ): Promise<readonly DeepReadonly<ReadbackAttemptRecord>[]> {
      return repositoryPromise(() => {
        const hasRevision =
          isPlainDataObject(query) && Object.prototype.hasOwnProperty.call(query, "revision");
        const values = assertAttemptObjectKeys(
          query,
          hasRevision
            ? ["managementTenantId", "releaseId", "revision"]
            : ["managementTenantId", "releaseId"],
        );
        if (values.managementTenantId !== validated.managementTenantId) {
          repositoryError("tenant_mismatch");
        }
        assertRepositoryIdentifier(values.releaseId);
        let revision: number | undefined;
        if (hasRevision) {
          if (!Number.isSafeInteger(values.revision) || Number(values.revision) < 1) {
            repositoryError("invalid_state");
          }
          revision = Number(values.revision);
        }
        const activeDatabase = liveRepositoryDatabase();
        return Object.freeze(
          findReadbackAttempts(
            activeDatabase,
            validated.managementTenantId,
            values.releaseId,
            revision,
          ).map((attempt) => deepFreezeReadbackAttempt(attempt)),
        );
      });
    },
    getControlState(): Promise<ModuleControlState> {
      return repositoryPromise(() => {
        const activeDatabase = liveRepositoryDatabase();
        return controlStateInDatabase(activeDatabase, validated.managementTenantId);
      });
    },
    getActiveRelease(): Promise<ModuleReleaseRecord | null> {
      return repositoryPromise(() => {
        const activeDatabase = liveRepositoryDatabase();
        return findActiveRelease(activeDatabase, validated.managementTenantId);
      });
    },
    getPendingRelease(): Promise<ModuleReleaseRecord | null> {
      return repositoryPromise(() => {
        const activeDatabase = liveRepositoryDatabase();
        return findPendingRelease(activeDatabase, validated.managementTenantId);
      });
    },
    getNewestUnresolvedRelease(): Promise<ModuleReleaseRecord | null> {
      return repositoryPromise(() => {
        const activeDatabase = liveRepositoryDatabase();
        return findNewestUnresolvedRelease(activeDatabase, validated.managementTenantId);
      });
    },
    getPreview(query: GetModulePreviewQuery): Promise<ModulePreviewRecord | null> {
      return repositoryPromise(() => {
        const activeDatabase = liveRepositoryDatabase();
        const previewRef = queryIdentifier(
          query,
          "previewRef",
          ["managementTenantId", "previewRef"],
          validated.managementTenantId,
        );
        return findPreview(activeDatabase, validated.managementTenantId, previewRef);
      });
    },
    getApproval(query: GetModuleApprovalQuery): Promise<ModuleApprovalRecord | null> {
      return repositoryPromise(() => {
        const activeDatabase = liveRepositoryDatabase();
        const approvalId = queryIdentifier(
          query,
          "approvalId",
          ["managementTenantId", "approvalId"],
          validated.managementTenantId,
        );
        return findApproval(activeDatabase, validated.managementTenantId, approvalId);
      });
    },
    getRelease(query: GetModuleReleaseQuery): Promise<ModuleReleaseRecord | null> {
      return repositoryPromise(() => {
        const activeDatabase = liveRepositoryDatabase();
        const releaseId = queryIdentifier(
          query,
          "releaseId",
          ["managementTenantId", "releaseId"],
          validated.managementTenantId,
        );
        return findRelease(activeDatabase, validated.managementTenantId, releaseId);
      });
    },
    getReadback(query: GetModuleReadbackQuery): Promise<ModuleReadbackRecord | null> {
      return repositoryPromise(() => {
        const activeDatabase = liveRepositoryDatabase();
        const releaseId = queryIdentifier(
          query,
          "releaseId",
          ["managementTenantId", "releaseId"],
          validated.managementTenantId,
        );
        return findReadback(activeDatabase, validated.managementTenantId, releaseId);
      });
    },
    getIdempotency(query: GetControlIdempotencyQuery): Promise<ControlIdempotencyRecord | null> {
      return repositoryPromise(() => {
        const activeDatabase = liveRepositoryDatabase();
        const { action, idempotencyKey } = idempotencyQueryValues(
          query,
          validated.managementTenantId,
        );
        return findIdempotency(
          activeDatabase,
          validated.managementTenantId,
          action,
          idempotencyKey,
        );
      });
    },
    close(): Promise<void> {
      if (openDatabase === null) {
        return Promise.resolve();
      }
      const handle = openDatabase;
      try {
        handle.close();
      } catch {
        throw new SqliteControlStoreError("close_failed");
      }
      openDatabase = null;
      return Promise.resolve();
    },
  };

  const recoveryInvoker = withRecoveryDriver
    ? Object.freeze({
        [SQLITE_READBACK_RECOVERY_FINALIZE]: (
          request: SqliteRecoveryFinalizeRequest,
          secret: SqliteReadbackRecoverySecret,
        ): Promise<ReadbackFinalizationResult> =>
          repositoryPromise(() => {
            assertSqliteReadbackRecoverySecret(secret);
            assertRecoveryFinalizeAttemptRequest(request);
            return runMutation((activeDatabase) =>
              finalizeReadbackAndCompleteInDatabase(
                activeDatabase,
                validated.managementTenantId,
                request,
                transactionGuard,
                readbackOwnerCapabilities,
                readbackFinalizeRuntime,
                readbackOwnerBootId,
                "recovery",
                secret,
              ));
          }),
      })
    : null;
  const recoveryDriver = withRecoveryDriver
    ? Object.freeze({
        finalizePriorBootAttempt(
          request: SqliteRecoveryFinalizeRequest,
        ): Promise<ReadbackFinalizationResult> {
          if (recoveryInvoker === null || recoverySecret === null) {
            repositoryError("invalid_state");
          }
          return recoveryInvoker[SQLITE_READBACK_RECOVERY_FINALIZE](
            request,
            recoverySecret,
          );
        },
      })
    : null;
  return { repository, recoveryDriver };
}

export function openSqliteControlStore(
  options: OpenSqliteControlStoreOptions,
): SqliteControlStore {
  return openSqliteControlStoreInternal(options, false).repository;
}

export function createSqliteControlStoreWithRecovery(
  options: OpenSqliteControlStoreOptions,
): SqliteControlStoreWithRecovery {
  const opened = openSqliteControlStoreInternal(options, true);
  if (opened.recoveryDriver === null) {
    throw new SqliteControlStoreError("initialization_failed");
  }
  return Object.freeze({
    repository: opened.repository,
    recoveryDriver: opened.recoveryDriver,
  });
}
