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
import { isAbsolute, join, normalize, parse, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Stats } from "node:fs";
import { controlEnvelopeSchema } from "./contracts";
import {
  assertControlEventInstantOrder,
  assertControlEventLifecycleCardinality,
  assertControlRequestBinding,
  assertModulePreviewAuthoritySemantics,
  createControlEventLifecycleCounts,
  deepFreezeControlRecord,
  MODULE_CONTROL_ACTIONS,
  ModuleControlRepositoryError,
  resolveMonotonicControlEventOccurredAt,
} from "./repository";
import {
  compareRfc3339Instants as compareSharedRfc3339Instants,
  formatRfc3339InstantUtc,
  parseRfc3339Instant,
} from "./rfc3339-instant";
import type {
  ApprovalWriteResult,
  CompleteControlIdempotencyRequest,
  ControlEventLifecycleCounts,
  ControlEventRecord,
  ControlFinalResult,
  ControlIdempotencyRecord,
  ControlRecord,
  ControlRequestMetadata,
  CreatePreviewRecordRequest,
  DecideApprovalRecordRequest,
  GetControlIdempotencyQuery,
  GetModuleApprovalQuery,
  GetModulePreviewQuery,
  GetModuleReadbackQuery,
  GetModuleReleaseQuery,
  ModuleControlAction,
  ModuleControlRef,
  ModuleApprovalRecord,
  ModuleChangePreviewRecord,
  ModuleControlRepository,
  ModuleControlState,
  ModuleReleaseHistoryEntry,
  ModuleRollbackPreviewRecord,
  ModulePreviewRecord,
  ModuleReadbackRecord,
  ModuleRegistrationRecord,
  ModuleReleaseRecord,
  PublishReleaseRecordRequest,
  ReadbackWriteResult,
  RecordReadbackRequest,
  RegistrationWriteResult,
  RegisterModuleRecordRequest,
  PreviewWriteResult,
  ReleaseWriteResult,
} from "./repository";
import { IDENTIFIER_PATTERN } from "./lexical-contracts";

const DIRECTORY_MODE = 0o700;
const DATABASE_MODE = 0o600;
const MARKER_MODE = 0o400;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = fsConstants.O_DIRECTORY ?? 0;

const TABLE_NAMES = [
  "control_identity",
  "module_approvals",
  "module_control_events",
  "module_control_idempotency",
  "module_previews",
  "module_readbacks",
  "module_registrations",
  "module_releases",
] as const;

type TableName = (typeof TABLE_NAMES)[number];

const TABLE_COLUMNS: Readonly<Record<TableName, readonly { name: string; type: string }[]>> = {
  control_identity: [
    { name: "singleton_id", type: "INTEGER" },
    { name: "marker_format", type: "TEXT" },
    { name: "management_tenant_id", type: "TEXT" },
    { name: "control_db_id", type: "TEXT" },
    { name: "control_db_path", type: "TEXT" },
    { name: "instance_id", type: "TEXT" },
    { name: "schema_version", type: "INTEGER" },
  ],
  module_registrations: [
    { name: "management_tenant_id", type: "TEXT" },
    { name: "module_id", type: "TEXT" },
    { name: "version", type: "TEXT" },
    { name: "descriptor_digest", type: "TEXT" },
    { name: "evidence_level", type: "TEXT" },
    { name: "production_eligible", type: "INTEGER" },
    { name: "evidence_refs_json", type: "TEXT" },
    { name: "registered_by_actor_ref", type: "TEXT" },
    { name: "registered_at", type: "TEXT" },
  ],
  module_previews: [
    { name: "management_tenant_id", type: "TEXT" },
    { name: "preview_ref", type: "TEXT" },
    { name: "canonical_hash", type: "TEXT" },
    { name: "intent", type: "TEXT" },
    { name: "base_release_id", type: "TEXT" },
    { name: "base_revision", type: "INTEGER" },
    { name: "inventory_refs_json", type: "TEXT" },
    { name: "desired_modules_json", type: "TEXT" },
    { name: "diff_json", type: "TEXT" },
    { name: "validation_json", type: "TEXT" },
    { name: "creator_actor_ref", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
    { name: "expires_at", type: "TEXT" },
    { name: "consumed", type: "INTEGER" },
    { name: "target_release_id", type: "TEXT" },
  ],
  module_approvals: [
    { name: "management_tenant_id", type: "TEXT" },
    { name: "approval_id", type: "TEXT" },
    { name: "preview_ref", type: "TEXT" },
    { name: "decision", type: "TEXT" },
    { name: "preview_canonical_hash", type: "TEXT" },
    { name: "base_release_id", type: "TEXT" },
    { name: "base_revision", type: "INTEGER" },
    { name: "inventory_digest_set_json", type: "TEXT" },
    { name: "expires_at", type: "TEXT" },
    { name: "reason_code", type: "TEXT" },
    { name: "approver_actor_ref", type: "TEXT" },
    { name: "decided_at", type: "TEXT" },
    { name: "consumed", type: "INTEGER" },
  ],
  module_releases: [
    { name: "management_tenant_id", type: "TEXT" },
    { name: "release_id", type: "TEXT" },
    { name: "revision", type: "INTEGER" },
    { name: "desired_modules_json", type: "TEXT" },
    { name: "previous_release_id", type: "TEXT" },
    { name: "preview_ref", type: "TEXT" },
    { name: "approval_id", type: "TEXT" },
    { name: "publisher_actor_ref", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
    { name: "published_at", type: "TEXT" },
    { name: "readback_ref", type: "TEXT" },
    { name: "reason_codes_json", type: "TEXT" },
    { name: "superseded_by_release_id", type: "TEXT" },
  ],
  module_readbacks: [
    { name: "management_tenant_id", type: "TEXT" },
    { name: "release_id", type: "TEXT" },
    { name: "readback_ref", type: "TEXT" },
    { name: "revision", type: "INTEGER" },
    { name: "applied_release_id", type: "TEXT" },
    { name: "applied_revision", type: "INTEGER" },
    { name: "applied_modules_json", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "reason_codes_json", type: "TEXT" },
    { name: "checked_at", type: "TEXT" },
  ],
  module_control_idempotency: [
    { name: "management_tenant_id", type: "TEXT" },
    { name: "action", type: "TEXT" },
    { name: "idempotency_key", type: "TEXT" },
    { name: "request_hash", type: "TEXT" },
    { name: "actor_ref", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "domain_record_ref", type: "TEXT" },
    { name: "final_result_json", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
    { name: "expires_at", type: "TEXT" },
  ],
  module_control_events: [
    { name: "sequence", type: "INTEGER" },
    { name: "management_tenant_id", type: "TEXT" },
    { name: "event_id", type: "TEXT" },
    { name: "actor_ref", type: "TEXT" },
    { name: "action", type: "TEXT" },
    { name: "idempotency_key", type: "TEXT" },
    { name: "request_hash", type: "TEXT" },
    { name: "object_ref", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "reason_codes_json", type: "TEXT" },
    { name: "payload_json", type: "TEXT" },
    { name: "occurred_at", type: "TEXT" },
  ],
};

const JSON_COLUMNS: Readonly<Record<TableName, readonly string[]>> = {
  control_identity: [],
  module_registrations: ["evidence_refs_json"],
  module_previews: [
    "inventory_refs_json",
    "desired_modules_json",
    "diff_json",
    "validation_json",
  ],
  module_approvals: ["inventory_digest_set_json"],
  module_releases: ["desired_modules_json", "reason_codes_json"],
  module_readbacks: ["applied_modules_json", "reason_codes_json"],
  module_control_idempotency: ["final_result_json"],
  module_control_events: ["reason_codes_json", "payload_json"],
};

const CONTROL_SCHEMA = [
  `CREATE TABLE control_identity (
    singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
    marker_format TEXT NOT NULL CHECK (marker_format = 'mcp-control-identity/v1'),
    management_tenant_id TEXT NOT NULL CHECK (length(management_tenant_id) > 0),
    control_db_id TEXT NOT NULL CHECK (
      length(control_db_id) = 35 AND
      substr(control_db_id, 1, 3) = 'db_' AND
      substr(control_db_id, 4) NOT GLOB '*[^0-9a-f]*'
    ),
    control_db_path TEXT NOT NULL CHECK (length(control_db_path) > 0),
    instance_id TEXT NOT NULL CHECK (length(instance_id) > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    UNIQUE (management_tenant_id, control_db_id)
  ) STRICT`,
  `CREATE TABLE module_registrations (
    management_tenant_id TEXT NOT NULL CHECK (length(management_tenant_id) > 0),
    module_id TEXT NOT NULL CHECK (length(module_id) > 0),
    version TEXT NOT NULL CHECK (length(version) > 0),
    descriptor_digest TEXT NOT NULL CHECK (
      length(descriptor_digest) = 71 AND
      substr(descriptor_digest, 1, 7) = 'sha256:' AND
      substr(descriptor_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    evidence_level TEXT NOT NULL CHECK (evidence_level = 'local_build'),
    production_eligible INTEGER NOT NULL CHECK (production_eligible = 0),
    evidence_refs_json TEXT NOT NULL CHECK (
      json_valid(evidence_refs_json) AND json_type(evidence_refs_json) = 'object'
    ),
    registered_by_actor_ref TEXT NOT NULL CHECK (length(registered_by_actor_ref) > 0),
    registered_at TEXT NOT NULL CHECK (length(registered_at) > 0),
    PRIMARY KEY (management_tenant_id, module_id, version, descriptor_digest)
  ) STRICT`,
  `CREATE TABLE module_previews (
    management_tenant_id TEXT NOT NULL CHECK (length(management_tenant_id) > 0),
    preview_ref TEXT NOT NULL CHECK (length(preview_ref) > 0),
    canonical_hash TEXT NOT NULL CHECK (
      length(canonical_hash) = length('mcp-control-hash/v1/preview/sha256:') + 64 AND
      substr(canonical_hash, 1, length('mcp-control-hash/v1/preview/sha256:')) =
        'mcp-control-hash/v1/preview/sha256:' AND
      substr(canonical_hash, length('mcp-control-hash/v1/preview/sha256:') + 1)
        NOT GLOB '*[^0-9a-f]*'
    ),
    intent TEXT NOT NULL CHECK (intent IN ('change', 'rollback')),
    base_release_id TEXT,
    base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
    inventory_refs_json TEXT NOT NULL CHECK (
      json_valid(inventory_refs_json) AND json_type(inventory_refs_json) = 'array'
    ),
    desired_modules_json TEXT NOT NULL CHECK (
      json_valid(desired_modules_json) AND json_type(desired_modules_json) = 'array'
    ),
    diff_json TEXT NOT NULL CHECK (json_valid(diff_json) AND json_type(diff_json) = 'object'),
    validation_json TEXT NOT NULL CHECK (
      json_valid(validation_json) AND json_type(validation_json) = 'object'
    ),
    creator_actor_ref TEXT NOT NULL CHECK (length(creator_actor_ref) > 0),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
    consumed INTEGER NOT NULL CHECK (consumed IN (0, 1)),
    target_release_id TEXT,
    PRIMARY KEY (management_tenant_id, preview_ref),
    UNIQUE (management_tenant_id, preview_ref, canonical_hash, base_revision, expires_at),
    CHECK (
      (intent = 'change' AND target_release_id IS NULL) OR
      (intent = 'rollback' AND target_release_id IS NOT NULL AND length(target_release_id) > 0)
    )
  ) STRICT`,
  `CREATE TABLE module_approvals (
    management_tenant_id TEXT NOT NULL CHECK (length(management_tenant_id) > 0),
    approval_id TEXT NOT NULL CHECK (length(approval_id) > 0),
    preview_ref TEXT NOT NULL CHECK (length(preview_ref) > 0),
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
    preview_canonical_hash TEXT NOT NULL CHECK (length(preview_canonical_hash) > 0),
    base_release_id TEXT,
    base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
    inventory_digest_set_json TEXT NOT NULL CHECK (
      json_valid(inventory_digest_set_json) AND json_type(inventory_digest_set_json) = 'array'
    ),
    expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
    reason_code TEXT NOT NULL CHECK (length(reason_code) > 0),
    approver_actor_ref TEXT NOT NULL CHECK (length(approver_actor_ref) > 0),
    decided_at TEXT NOT NULL CHECK (length(decided_at) > 0),
    consumed INTEGER NOT NULL CHECK (consumed IN (0, 1)),
    PRIMARY KEY (management_tenant_id, approval_id),
    UNIQUE (management_tenant_id, preview_ref),
    UNIQUE (management_tenant_id, preview_ref, approval_id),
    CHECK (decision = 'approve' OR consumed = 0),
    FOREIGN KEY (
      management_tenant_id,
      preview_ref,
      preview_canonical_hash,
      base_revision,
      expires_at
    ) REFERENCES module_previews (
      management_tenant_id,
      preview_ref,
      canonical_hash,
      base_revision,
      expires_at
    )
  ) STRICT`,
  `CREATE TABLE module_releases (
    management_tenant_id TEXT NOT NULL CHECK (length(management_tenant_id) > 0),
    release_id TEXT NOT NULL CHECK (length(release_id) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    desired_modules_json TEXT NOT NULL CHECK (
      json_valid(desired_modules_json) AND json_type(desired_modules_json) = 'array'
    ),
    previous_release_id TEXT,
    preview_ref TEXT NOT NULL CHECK (length(preview_ref) > 0),
    approval_id TEXT NOT NULL CHECK (length(approval_id) > 0),
    publisher_actor_ref TEXT NOT NULL CHECK (length(publisher_actor_ref) > 0),
    status TEXT NOT NULL CHECK (status IN ('published_pending_readback', 'manual_review', 'active_verified', 'superseded')),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    published_at TEXT CHECK (published_at IS NULL OR length(published_at) > 0),
    readback_ref TEXT,
    reason_codes_json TEXT NOT NULL CHECK (
      json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'
    ),
    superseded_by_release_id TEXT,
    PRIMARY KEY (management_tenant_id, release_id),
    UNIQUE (management_tenant_id, revision),
    UNIQUE (management_tenant_id, release_id, revision),
    CHECK (
      (status = 'published_pending_readback' AND readback_ref IS NULL AND reason_codes_json = '[]' AND superseded_by_release_id IS NULL) OR
      (status = 'manual_review' AND readback_ref IS NOT NULL AND reason_codes_json <> '[]' AND superseded_by_release_id IS NULL) OR
      (status = 'active_verified' AND readback_ref IS NOT NULL AND reason_codes_json = '[]' AND superseded_by_release_id IS NULL) OR
      (status = 'superseded' AND readback_ref IS NOT NULL AND reason_codes_json = '[]' AND superseded_by_release_id IS NOT NULL)
    ),
    CHECK (
      status = 'published_pending_readback' OR published_at IS NOT NULL
    ),
    FOREIGN KEY (management_tenant_id, preview_ref, approval_id)
      REFERENCES module_approvals (management_tenant_id, preview_ref, approval_id),
    FOREIGN KEY (management_tenant_id, previous_release_id)
      REFERENCES module_releases (management_tenant_id, release_id)
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (management_tenant_id, superseded_by_release_id)
      REFERENCES module_releases (management_tenant_id, release_id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE TABLE module_readbacks (
    management_tenant_id TEXT NOT NULL CHECK (length(management_tenant_id) > 0),
    release_id TEXT NOT NULL CHECK (length(release_id) > 0),
    readback_ref TEXT NOT NULL CHECK (length(readback_ref) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    applied_release_id TEXT,
    applied_revision INTEGER,
    applied_modules_json TEXT NOT NULL CHECK (
      json_valid(applied_modules_json) AND json_type(applied_modules_json) = 'array'
    ),
    status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'mismatch', 'unknown')),
    reason_codes_json TEXT NOT NULL CHECK (
      json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'
    ),
    checked_at TEXT NOT NULL CHECK (length(checked_at) > 0),
    PRIMARY KEY (management_tenant_id, release_id),
    UNIQUE (management_tenant_id, readback_ref),
    CHECK (
      (status = 'pending' AND applied_release_id IS NULL AND applied_revision IS NULL AND reason_codes_json = '[]') OR
      (status = 'verified' AND applied_release_id = release_id AND applied_revision = revision AND reason_codes_json = '[]') OR
      (status IN ('mismatch', 'unknown') AND reason_codes_json <> '[]' AND
        ((applied_release_id IS NULL AND applied_revision IS NULL) OR
         (applied_release_id IS NOT NULL AND applied_revision IS NOT NULL)))
    ),
    FOREIGN KEY (management_tenant_id, release_id, revision)
      REFERENCES module_releases (management_tenant_id, release_id, revision)
  ) STRICT`,
  `CREATE TABLE module_control_idempotency (
    management_tenant_id TEXT NOT NULL CHECK (length(management_tenant_id) > 0),
    action TEXT NOT NULL CHECK (action IN ('packages.register', 'deployments.preview', 'approvals.decide', 'deployments.publish', 'deployments.reconcile')),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
    request_hash TEXT NOT NULL CHECK (
      length(request_hash) = length('mcp-control-hash/v1/request/sha256:') + 64 AND
      substr(request_hash, 1, length('mcp-control-hash/v1/request/sha256:')) =
        'mcp-control-hash/v1/request/sha256:' AND
      substr(request_hash, length('mcp-control-hash/v1/request/sha256:') + 1)
        NOT GLOB '*[^0-9a-f]*'
    ),
    actor_ref TEXT NOT NULL CHECK (length(actor_ref) > 0),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'domain_committed', 'completed')),
    domain_record_ref TEXT,
    final_result_json TEXT CHECK (
      final_result_json IS NULL OR
      (json_valid(final_result_json) AND json_type(final_result_json) = 'object')
    ),
    created_at TEXT NOT NULL CHECK (length(created_at) > 0),
    expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
    PRIMARY KEY (management_tenant_id, action, idempotency_key),
    CHECK (
      (status = 'reserved' AND domain_record_ref IS NULL AND final_result_json IS NULL) OR
      (status = 'domain_committed' AND domain_record_ref IS NOT NULL AND final_result_json IS NULL) OR
      (status = 'completed' AND domain_record_ref IS NOT NULL AND final_result_json IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE module_control_events (
    sequence INTEGER PRIMARY KEY NOT NULL,
    management_tenant_id TEXT NOT NULL CHECK (length(management_tenant_id) > 0),
    event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) > 0),
    actor_ref TEXT NOT NULL CHECK (length(actor_ref) > 0),
    action TEXT NOT NULL CHECK (action IN ('packages.register', 'deployments.preview', 'approvals.decide', 'deployments.publish', 'deployments.reconcile')),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
    request_hash TEXT NOT NULL CHECK (
      length(request_hash) = length('mcp-control-hash/v1/request/sha256:') + 64 AND
      substr(request_hash, 1, length('mcp-control-hash/v1/request/sha256:')) =
        'mcp-control-hash/v1/request/sha256:' AND
      substr(request_hash, length('mcp-control-hash/v1/request/sha256:') + 1)
        NOT GLOB '*[^0-9a-f]*'
    ),
    object_ref TEXT NOT NULL CHECK (length(object_ref) > 0),
    status TEXT NOT NULL,
    reason_codes_json TEXT NOT NULL CHECK (
      json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'
    ),
    payload_json TEXT NOT NULL CHECK (
      json_valid(payload_json) AND json_type(payload_json) = 'object'
    ),
    occurred_at TEXT NOT NULL CHECK (length(occurred_at) > 0),
    CHECK (
      (action = 'packages.register' AND status = 'registered') OR
      (action = 'deployments.preview' AND status = 'previewed') OR
      (action = 'approvals.decide' AND status IN ('approved', 'rejected')) OR
      (action = 'deployments.publish' AND status IN ('published_pending_readback', 'manual_review', 'active_verified', 'superseded')) OR
      (action = 'deployments.reconcile' AND status IN ('pending', 'verified', 'mismatch', 'unknown')) OR
      (
        action = 'deployments.publish' AND
        status IN ('pending', 'verified', 'mismatch', 'unknown') AND
        json_type(payload_json, '$.detail') = 'object' AND
        json_extract(payload_json, '$.detail.kind') = 'reconciliation' AND
        json_extract(payload_json, '$.detail.status') = status
      ) OR
      (
        status IN ('reserved', 'domain_committed', 'completed') AND
        json_type(payload_json, '$.detail') = 'object' AND
        json_extract(payload_json, '$.detail.kind') = 'idempotency' AND
        json_extract(payload_json, '$.detail.status') = status
      )
    )
  ) STRICT`,
] as const;

const CONTROL_INDEXES = [
  `CREATE INDEX idx_module_control_events_tenant_sequence
    ON module_control_events (management_tenant_id, sequence)`,
  `CREATE INDEX idx_module_control_idempotency_tenant_expires_at
    ON module_control_idempotency (management_tenant_id, expires_at)`,
  `CREATE INDEX idx_module_previews_tenant_expires_at
    ON module_previews (management_tenant_id, expires_at)`,
  `CREATE INDEX idx_module_releases_tenant_status_revision
    ON module_releases (management_tenant_id, status, revision DESC)`,
] as const;

const INDEX_NAMES = [
  "idx_module_control_events_tenant_sequence",
  "idx_module_control_idempotency_tenant_expires_at",
  "idx_module_previews_tenant_expires_at",
  "idx_module_releases_tenant_status_revision",
] as const;

const SCHEMA_BY_TABLE: Readonly<Record<TableName, string>> = {
  control_identity: CONTROL_SCHEMA[0],
  module_registrations: CONTROL_SCHEMA[1],
  module_previews: CONTROL_SCHEMA[2],
  module_approvals: CONTROL_SCHEMA[3],
  module_releases: CONTROL_SCHEMA[4],
  module_readbacks: CONTROL_SCHEMA[5],
  module_control_idempotency: CONTROL_SCHEMA[6],
  module_control_events: CONTROL_SCHEMA[7],
};

const SCHEMA_BY_INDEX: Readonly<Record<(typeof INDEX_NAMES)[number], string>> = {
  idx_module_control_events_tenant_sequence: CONTROL_INDEXES[0],
  idx_module_control_idempotency_tenant_expires_at: CONTROL_INDEXES[1],
  idx_module_previews_tenant_expires_at: CONTROL_INDEXES[2],
  idx_module_releases_tenant_status_revision: CONTROL_INDEXES[3],
};

const MARKER_FORMAT = "mcp-control-identity/v1" as const;
const SCHEMA_VERSION = 1 as const;
const CONTROL_STATE_RELEASE_HISTORY_WINDOW = 128 as const;
const CONTROL_STATE_EVENT_WINDOW = 256 as const;
const CONTROL_STATE_EVENT_QUERY_LIMIT = CONTROL_STATE_EVENT_WINDOW + 1;

export interface InitializeSqliteControlStateOptions {
  readonly applicationRoot: string;
  readonly instanceId: string;
  readonly managementTenantId: string;
}

export interface OpenSqliteControlStoreOptions {
  readonly applicationRoot: string;
  readonly instanceId: string;
  readonly managementTenantId: string;
  readonly adminControlEnabled: boolean;
}

export interface SqliteControlStore extends ModuleControlRepository {
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
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
      for (const statement of CONTROL_SCHEMA) {
        database.exec(statement);
      }
      for (const statement of CONTROL_INDEXES) {
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

function normalizeSchemaSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function verifyTables(database: DatabaseSync): void {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String((row as { name: unknown }).name));
  if (tables.length !== TABLE_NAMES.length || tables.some((name, index) => name !== TABLE_NAMES[index])) {
    throwStoreError("schema_mismatch");
  }

  const tableList = database
    .prepare("PRAGMA table_list")
    .all()
    .filter((row) => !String((row as { name: unknown }).name).startsWith("sqlite_"));
  if (
    tableList.length !== TABLE_NAMES.length ||
    tableList.some((row) => Number((row as { strict: unknown }).strict) !== 1)
  ) {
    throwStoreError("schema_mismatch");
  }

  const indexes = database
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<Record<string, unknown>>;
  if (
    indexes.length !== INDEX_NAMES.length ||
    indexes.some((row, index) => row.name !== INDEX_NAMES[index])
  ) {
    throwStoreError("schema_mismatch");
  }

  for (const row of indexes) {
    const name = row.name;
    if (typeof name !== "string" || !INDEX_NAMES.includes(name as (typeof INDEX_NAMES)[number])) {
      throwStoreError("schema_mismatch");
    }
    if (
      typeof row.sql !== "string" ||
      normalizeSchemaSql(row.sql) !==
        normalizeSchemaSql(SCHEMA_BY_INDEX[name as (typeof INDEX_NAMES)[number]])
    ) {
      throwStoreError("schema_mismatch");
    }
  }

  const unexpectedObjects = database
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type NOT IN ('table', 'index')",
    )
    .all();
  if (unexpectedObjects.length !== 0) throwStoreError("schema_mismatch");

  for (const tableName of TABLE_NAMES) {
    const columns = database
      .prepare(`PRAGMA table_info("${tableName}")`)
      .all()
      .map((row) => ({
        name: String((row as { name: unknown }).name),
        type: String((row as { type: unknown }).type),
        notnull: Number((row as { notnull: unknown }).notnull),
      }));
    const expectedColumns = TABLE_COLUMNS[tableName];
    if (
      columns.length !== expectedColumns.length ||
      columns.some(
        (column, index) =>
          column.name !== expectedColumns[index]?.name ||
          column.type !== expectedColumns[index]?.type ||
          (column.name === "management_tenant_id" && column.notnull !== 1),
      )
    ) {
      throwStoreError("schema_mismatch");
    }

    const tableSqlRow = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { sql?: unknown } | undefined;
    const tableSql = typeof tableSqlRow?.sql === "string" ? tableSqlRow.sql : "";
    if (normalizeSchemaSql(tableSql) !== normalizeSchemaSql(SCHEMA_BY_TABLE[tableName])) {
      throwStoreError("schema_mismatch");
    }
    for (const jsonColumn of JSON_COLUMNS[tableName]) {
      const jsonCheck = new RegExp(`json_valid\\s*\\(\\s*${jsonColumn}\\s*\\)`, "i");
      if (!jsonCheck.test(tableSql)) {
        throwStoreError("schema_mismatch");
      }
    }
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

function persistedCompletionError(
  code: "conflict" | "invalid_state",
): never {
  repositoryError(code);
}

function validatePersistedReleaseCompletion(
  database: DatabaseSync,
  managementTenantId: string,
  action: "deployments.publish" | "deployments.reconcile",
  finalResult: ControlFinalResult,
  failureCode: "conflict" | "invalid_state",
): void {
  const parsed = controlEnvelopeSchema.safeParse(finalResult.envelope);
  if (!parsed.success) persistedCompletionError(failureCode);
  const release = findRelease(
    database,
    managementTenantId,
    finalResult.domainRecordRef,
  );
  const readback = findReadback(
    database,
    managementTenantId,
    finalResult.domainRecordRef,
  );
  if (release === null || readback === null) {
    persistedCompletionError(failureCode);
  }
  const envelope = parsed.data;
  const data = envelope.data;
  if (
    release.releaseId !== readback.releaseId ||
    release.revision !== readback.revision ||
    release.readbackRef !== readback.readbackRef ||
    envelope.readback.release_id !== release.releaseId ||
    envelope.readback.revision !== release.revision
  ) {
    persistedCompletionError(failureCode);
  }
  if (action === "deployments.publish") {
    if (
      data?.kind !== "release" ||
      data.release_id !== release.releaseId ||
      data.revision !== release.revision ||
      !sameModuleRefs(envelopeModuleRefs(data.active_modules), release.desiredModules)
    ) {
      persistedCompletionError(failureCode);
    }
  } else if (
    data?.kind !== "reconciliation" ||
    data.release_id !== release.releaseId ||
    data.revision !== release.revision ||
    data.status !== readback.status
  ) {
    persistedCompletionError(failureCode);
  }

  if (envelope.status === "success") {
    if (
      release.status !== "active_verified" ||
      readback.status !== "verified" ||
      envelope.readback.status !== "verified" ||
      readback.appliedReleaseId !== release.releaseId ||
      readback.appliedRevision !== release.revision ||
      !sameModuleRefs(readback.appliedModules, release.desiredModules) ||
      envelope.reason_codes.length !== 0 ||
      readback.reasonCodes.length !== 0 ||
      release.reasonCodes.length !== 0
    ) {
      persistedCompletionError(failureCode);
    }
    return;
  }

  if (
    envelope.status !== "manual_review" ||
    release.status !== "manual_review" ||
    (readback.status !== "mismatch" && readback.status !== "unknown") ||
    envelope.readback.status !== readback.status ||
    !equalCanonical(envelope.reason_codes, readback.reasonCodes) ||
    !equalCanonical(release.reasonCodes, readback.reasonCodes)
  ) {
    persistedCompletionError(failureCode);
  }
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
    "readback_ref",
    "revision",
    "applied_release_id",
    "applied_revision",
    "applied_modules_json",
    "status",
    "reason_codes_json",
    "checked_at",
  ]);
  return freezeDecoded({
    managementTenantId: requiredSqlString(value, "management_tenant_id"),
    readbackRef: requiredSqlString(value, "readback_ref"),
    releaseId: requiredSqlString(value, "release_id"),
    revision: requiredSqlInteger(value, "revision"),
    appliedReleaseId: nullableSqlString(value, "applied_release_id"),
    appliedRevision: nullableSqlInteger(value, "applied_revision"),
    appliedModules: requiredJson(value, "applied_modules_json") as ModuleReadbackRecord["appliedModules"],
    status: requiredSqlString(value, "status") as ModuleReadbackRecord["status"],
    reasonCodes: requiredJson(value, "reason_codes_json") as ModuleReadbackRecord["reasonCodes"],
    checkedAt: requiredSqlString(value, "checked_at"),
  } as ModuleReadbackRecord);
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
  SELECT management_tenant_id, release_id, readback_ref, revision,
         applied_release_id, applied_revision, applied_modules_json, status,
         reason_codes_json, checked_at
  FROM module_readbacks
  WHERE management_tenant_id = ? AND release_id = ?`;
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
  database
    .prepare(
      `INSERT INTO module_readbacks
        (management_tenant_id, release_id, readback_ref, revision,
         applied_release_id, applied_revision, applied_modules_json, status,
         reason_codes_json, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.managementTenantId,
      record.releaseId,
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
  database
    .prepare(
      `UPDATE module_readbacks
       SET readback_ref = ?, revision = ?, applied_release_id = ?,
           applied_revision = ?, applied_modules_json = ?, status = ?,
           reason_codes_json = ?, checked_at = ?
       WHERE management_tenant_id = ? AND release_id = ? AND revision = ?`,
    )
    .run(
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

function readbackReplay(
  database: DatabaseSync,
  managementTenantId: string,
  metadata: ControlRequestMetadata,
  record: ModuleReadbackRecord,
): ReadbackWriteResult {
  const event = findEventsForObject(database, managementTenantId, record.releaseId).find(
    (candidate) =>
      candidate.kind === "reconciliation" &&
      candidate.action === metadata.action &&
      candidate.status === record.status &&
      candidate.detail.releaseId === record.releaseId &&
      candidate.detail.revision === record.revision &&
      candidate.detail.readbackRef === record.readbackRef,
  ) ?? null;
  if (event === null) repositoryError("invalid_state");
  const persisted = findReadback(database, managementTenantId, record.releaseId);
  if (persisted === null) repositoryError("invalid_state");
  return { record: persisted, event, replayed: true };
}

function recordReadbackInDatabase(
  database: DatabaseSync,
  managementTenantId: string,
  request: RecordReadbackRequest,
  guard: RepositoryTransactionGuard,
): ReadbackWriteResult {
  const bound = bindRepositoryRequest(
    request.metadata,
    request.record,
    managementTenantId,
  );
  const metadata = bound.metadata;
  const record = bound.record as ModuleReadbackRecord;
  const existingIdempotency = findIdempotency(
    database,
    managementTenantId,
    metadata.action,
    metadata.idempotencyKey,
  );
  if (existingIdempotency !== null) {
    existingIdempotencyConflict(existingIdempotency, metadata);
    if (existingIdempotency.status === "reserved") {
      repositoryError("invalid_state");
    }
    if (
      existingIdempotency.domainRecordRef !== null &&
      existingIdempotency.domainRecordRef !== record.releaseId
    ) {
      repositoryError("conflict");
    }
  }
  if (metadata.action === "deployments.publish") {
    if (existingIdempotency === null) repositoryError("not_found");
    if (
      existingIdempotency.status !== "domain_committed" &&
      existingIdempotency.status !== "completed"
    ) {
      repositoryError("invalid_state");
    }
    if (
      existingIdempotency.domainRecordRef === null ||
      existingIdempotency.domainRecordRef !== record.releaseId
    ) {
      repositoryError("conflict");
    }
  }

  const release = findRelease(database, managementTenantId, record.releaseId);
  if (release === null) repositoryError("not_found");
  if (release.revision !== record.revision) repositoryError("conflict");

  if (metadata.action === "deployments.reconcile") {
    const newest = findNewestUnresolvedRelease(database, managementTenantId);
    if (newest === null || newest.releaseId !== release.releaseId || newest.revision !== release.revision) {
      repositoryError("conflict");
    }
  }

  const existing = findReadback(database, managementTenantId, record.releaseId);
  const exactExistingReadback = existing !== null && equalCanonical(existing, record);
  if (
    existing !== null &&
    existingIdempotency !== null &&
    !exactExistingReadback
  ) {
    repositoryError("conflict");
  }
  if (exactExistingReadback && existingIdempotency !== null) {
    return readbackReplay(database, managementTenantId, metadata, record);
  }
  if (
    metadata.action === "deployments.publish" &&
    release.status !== "published_pending_readback"
  ) {
    repositoryError("conflict");
  }
  if (existingIdempotency?.status === "completed") {
    repositoryError("conflict");
  }
  if (
    existing !== null &&
    (existing.status === "verified" || release.status === "active_verified" || release.status === "superseded")
  ) {
    repositoryError("conflict");
  }
  if (
    record.status === "verified" &&
    (!sameModuleRefs(record.appliedModules, release.desiredModules) ||
      record.appliedReleaseId !== release.releaseId ||
      record.appliedRevision !== release.revision)
  ) {
    repositoryError("conflict");
  }
  if (
    record.status === "pending" &&
    release.status !== "published_pending_readback"
  ) {
    repositoryError("conflict");
  }

  return withRepositoryTransaction(database, () => {
    if (
      metadata.action === "deployments.reconcile" &&
      existingIdempotency === null
    ) {
      insertIdempotencyReservation(
        database,
        metadata,
        record,
        "domain_committed",
        record.releaseId,
      );
    }
    if (existing === null) insertReadback(database, record);
    else if (!exactExistingReadback) updateReadback(database, record);

    if (!exactExistingReadback && record.status === "verified") {
      const previousActive = findActiveRelease(database, managementTenantId);
      if (
        previousActive !== null &&
        previousActive.releaseId !== release.releaseId
      ) {
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
        record.readbackRef,
        [],
        null,
      );
    } else if (
      !exactExistingReadback &&
      (record.status === "mismatch" || record.status === "unknown")
    ) {
      updateReleaseStatus(
        database,
        release,
        "manual_review",
        record.readbackRef,
        record.reasonCodes,
        null,
      );
    }

    const event = insertEvent(database, metadata, record);
    const persisted = findReadback(database, managementTenantId, record.releaseId);
    if (persisted === null) repositoryError("invalid_state");
    return { record: persisted, event, replayed: false };
  }, guard);
}

function completeIdempotencyInDatabase(
  database: DatabaseSync,
  managementTenantId: string,
  request: CompleteControlIdempotencyRequest,
  guard: RepositoryTransactionGuard,
): ControlIdempotencyRecord {
  const bound = bindRepositoryRequest(
    request.metadata,
    request.record,
    managementTenantId,
  );
  const metadata = bound.metadata;
  const record = bound.record as ControlIdempotencyRecord;
  if (record.status !== "completed" || record.finalResult === null) {
    repositoryError("invalid_state");
  }
  const existing = findIdempotency(
    database,
    managementTenantId,
    metadata.action,
    metadata.idempotencyKey,
  );
  if (existing === null) repositoryError("not_found");
  existingIdempotencyConflict(existing, metadata);
  if (
    existing.createdAt !== record.createdAt ||
    existing.expiresAt !== record.expiresAt
  ) {
    repositoryError("conflict");
  }
  if (existing.status === "completed") {
    if (!equalCanonical(existing, record)) repositoryError("conflict");
    return existing;
  }
  if (
    existing.status !== "reserved" &&
    existing.status !== "domain_committed"
  ) {
    repositoryError("invalid_state");
  }
  if (existing.domainRecordRef !== record.domainRecordRef) {
    repositoryError("conflict");
  }
  let expectedRevision: number | undefined;
  if (
    metadata.action === "deployments.publish" ||
    metadata.action === "deployments.reconcile"
  ) {
    const release = findRelease(
      database,
      managementTenantId,
      record.domainRecordRef,
    );
    if (release === null) repositoryError("not_found");
    expectedRevision = release.revision;
  }
  const finalResult = validateFinalResult(
    record.finalResult,
    metadata.action,
    record.domainRecordRef,
    expectedRevision,
  );
  if (
    metadata.action === "deployments.publish" ||
    metadata.action === "deployments.reconcile"
  ) {
    validatePersistedReleaseCompletion(
      database,
      managementTenantId,
      metadata.action,
      finalResult,
      "conflict",
    );
  }
  return withRepositoryTransaction(database, () => {
    const completed = completeIdempotencyRow(
      database,
      metadata,
      record.domainRecordRef,
      finalResult,
    );
    insertEvent(database, metadata, record);
    return completed;
  }, guard);
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
    (readback.status === "pending" && release.status !== "published_pending_readback") ||
    (readback.status === "verified" &&
      release.status !== "active_verified" &&
      release.status !== "superseded") ||
    ((readback.status === "mismatch" || readback.status === "unknown") &&
      release.status !== "manual_review")
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
  authority: PersistedIdempotencyAuthority,
  event: ControlEventRecord,
  previousEvent: ControlEventRecord | null,
): void {
  const record = authority.record;
  const expectedRef = `idempotency:${record.action}:${record.idempotencyKey}`;
  const expectedOccurredAt = resolveMonotonicControlEventOccurredAt(
    record.createdAt,
    previousEvent,
  );
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
  if (record.action === "deployments.reconcile" && event.occurredAt !== record.createdAt) {
    repositoryError("invalid_state");
  }
  if (
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
      verifyCompletionEvent(authority, event, previousEvent);
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
    if (
      authority === undefined ||
      counts === undefined ||
      persisted.requestHash !== authority.record.requestHash ||
      event.actorRef !== authority.record.actorRef
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
    if ((readbackEvents.get(currentReadbackEventKey(readback)) ?? 0) < 1) {
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
      `SELECT management_tenant_id, release_id, readback_ref, revision,
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
    assertClosedOptions(options, [
      "applicationRoot",
      "instanceId",
      "managementTenantId",
      "adminControlEnabled",
    ]);
    const applicationRoot = options.applicationRoot;
    const instanceId = options.instanceId;
    const managementTenantId = options.managementTenantId;
    const adminControlEnabled = options.adminControlEnabled;
    assertIdentityValue(instanceId);
    assertIdentityValue(managementTenantId);
    if (typeof applicationRoot !== "string" || typeof adminControlEnabled !== "boolean") {
      throwStoreError("invalid_options");
    }
    return { applicationRoot, instanceId, managementTenantId, adminControlEnabled };
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

export function openSqliteControlStore(options: OpenSqliteControlStoreOptions): SqliteControlStore {
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
  return {
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
    recordReadback(request: RecordReadbackRequest): Promise<ReadbackWriteResult> {
      return repositoryPromise(() => {
        return runMutation((activeDatabase) =>
          recordReadbackInDatabase(
            activeDatabase,
            validated.managementTenantId,
            request,
            transactionGuard,
          ));
      });
    },
    completeIdempotency(
      request: CompleteControlIdempotencyRequest,
    ): Promise<ControlIdempotencyRecord> {
      return repositoryPromise(() => {
        return runMutation((activeDatabase) =>
          completeIdempotencyInDatabase(
            activeDatabase,
            validated.managementTenantId,
            request,
            transactionGuard,
          ));
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
}
