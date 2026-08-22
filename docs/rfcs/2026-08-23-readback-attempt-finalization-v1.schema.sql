-- Readback attempt finalization v1: the standalone nine-table SQLite DDL artifact.
-- This file intentionally contains no business tables, generic key/value table,
-- secret column, trigger, or sequence allocator.
--
-- Fingerprint input algorithm (there is deliberately no precomputed hash here):
-- 1. Read this file as UTF-8 and lexically scan it using SQLite quoting rules.
-- 2. Replace each line comment beginning with -- and each block comment
--    beginning with /* and ending with */ with exactly one ASCII space, only
--    when outside string literals and quoted identifiers. A line comment also
--    consumes its terminating CR, LF, or CRLF before that one replacement
--    space is emitted. This replacement is required even when the comment is
--    adjacent to tokens, so a/*comment*/TEXT cannot collide with aTEXT.
--    Discard PRAGMA statements, empty statements, and whitespace-only
--    statements; preserve other whitespace inside retained SQL for the
--    normalization in step 3.
-- 3. Keep every CREATE TABLE, CREATE INDEX, and CREATE UNIQUE INDEX statement
--    in this file's order. Remove only its final semicolon, trim it, and replace
--    each maximal run of ASCII whitespace with one ASCII space. Preserve all
--    remaining token bytes, including quoted values and token case.
-- 4. Join the normalized statements with one LF byte, UTF-8 encode that joined
--    string, and SHA-256 the bytes. The fingerprint representation is
--    sha256:<64 lowercase hexadecimal characters>. The PRAGMA statements and
--    all comments are never input to the digest. Implementations must compute
--    this value from the artifact; this comment does not assert a hash.
--
-- The current TypeScript store also sets foreign_keys during connection setup
-- and user_version during initialization. These executable PRAGMAs are kept
-- here so the artifact can initialize an empty database directly; foreign_keys
-- must be enabled before a caller starts a transaction.

PRAGMA foreign_keys = ON;

CREATE TABLE control_identity (
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
) STRICT;

CREATE TABLE module_registrations (
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
) STRICT;

CREATE TABLE module_previews (
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
) STRICT;

CREATE TABLE module_approvals (
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
) STRICT;

CREATE TABLE module_releases (
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
) STRICT;

CREATE TABLE module_readbacks (
  management_tenant_id TEXT NOT NULL CHECK (length(management_tenant_id) > 0),
  release_id TEXT NOT NULL CHECK (length(release_id) > 0),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) > 0),
  readback_ref TEXT NOT NULL CHECK (length(readback_ref) > 0),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  applied_release_id TEXT,
  applied_revision INTEGER,
  applied_modules_json TEXT NOT NULL CHECK (
    json_valid(applied_modules_json) AND json_type(applied_modules_json) = 'array'
  ),
  status TEXT NOT NULL CHECK (status IN ('verified', 'mismatch', 'unknown')),
  reason_codes_json TEXT NOT NULL CHECK (
    json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'
  ),
  checked_at TEXT NOT NULL CHECK (length(checked_at) > 0),
  PRIMARY KEY (management_tenant_id, release_id),
  UNIQUE (management_tenant_id, readback_ref),
  CHECK (
    (status = 'verified' AND applied_release_id = release_id AND applied_revision = revision AND reason_codes_json = '[]') OR
    (status IN ('mismatch', 'unknown') AND reason_codes_json <> '[]' AND
      ((applied_release_id IS NULL AND applied_revision IS NULL) OR
       (applied_release_id IS NOT NULL AND applied_revision IS NOT NULL)))
  ),
  FOREIGN KEY (management_tenant_id, release_id, revision)
    REFERENCES module_releases (management_tenant_id, release_id, revision),
  FOREIGN KEY (
    management_tenant_id,
    attempt_id,
    release_id,
    revision,
    readback_ref
  ) REFERENCES module_readback_attempts (
    management_tenant_id,
    attempt_id,
    release_id,
    revision,
    readback_ref
  )
) STRICT;

CREATE TABLE module_control_idempotency (
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
  UNIQUE (
    management_tenant_id,
    action,
    idempotency_key,
    request_hash,
    domain_record_ref
  ),
  CHECK (
    (status = 'reserved' AND domain_record_ref IS NULL AND final_result_json IS NULL) OR
    (status = 'domain_committed' AND domain_record_ref IS NOT NULL AND final_result_json IS NULL) OR
    (status = 'completed' AND domain_record_ref IS NOT NULL AND final_result_json IS NOT NULL)
  )
) STRICT;

CREATE TABLE module_control_events (
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
) STRICT;

CREATE TABLE module_readback_attempts (
  management_tenant_id TEXT NOT NULL CHECK (length(management_tenant_id) > 0),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) > 0),
  action TEXT NOT NULL CHECK (action IN ('deployments.publish', 'deployments.reconcile')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = length('mcp-control-hash/v1/request/sha256:') + 64 AND
    substr(request_hash, 1, length('mcp-control-hash/v1/request/sha256:')) =
      'mcp-control-hash/v1/request/sha256:' AND
    substr(request_hash, length('mcp-control-hash/v1/request/sha256:') + 1)
      NOT GLOB '*[^0-9a-f]*'
  ),
  actor_ref TEXT NOT NULL CHECK (length(actor_ref) > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) > 0),
  trace_id TEXT NOT NULL CHECK (length(trace_id) > 0),
  audit_id TEXT NOT NULL CHECK (length(audit_id) > 0),
  release_id TEXT NOT NULL CHECK (length(release_id) > 0),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  desired_modules_json TEXT NOT NULL CHECK (
    json_valid(desired_modules_json) AND json_type(desired_modules_json) = 'array'
  ),
  readback_ref TEXT NOT NULL CHECK (length(readback_ref) > 0),
  owner_boot_id TEXT NOT NULL CHECK (length(owner_boot_id) > 0),
  phase TEXT NOT NULL CHECK (phase IN ('claimed', 'finalized')),
  claimed_at TEXT NOT NULL CHECK (length(claimed_at) > 0),
  finalized_at TEXT CHECK (finalized_at IS NULL OR length(finalized_at) > 0),
  terminal_status TEXT CHECK (
    terminal_status IS NULL OR terminal_status IN ('verified', 'mismatch', 'unknown')
  ),
  applied_release_id TEXT,
  applied_revision INTEGER CHECK (applied_revision IS NULL OR applied_revision >= 1),
  applied_modules_json TEXT NOT NULL CHECK (
    json_valid(applied_modules_json) AND json_type(applied_modules_json) = 'array'
  ),
  reason_codes_json TEXT NOT NULL CHECK (
    json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'
  ),
  checked_at TEXT CHECK (checked_at IS NULL OR length(checked_at) > 0),
  finalized_by_actor_ref TEXT CHECK (
    finalized_by_actor_ref IS NULL OR length(finalized_by_actor_ref) > 0
  ),
  reconciliation_event_sequence INTEGER CHECK (
    reconciliation_event_sequence IS NULL OR reconciliation_event_sequence > 0
  ),
  completion_event_sequence INTEGER CHECK (
    completion_event_sequence IS NULL OR completion_event_sequence > 0
  ),
  PRIMARY KEY (management_tenant_id, attempt_id),
  UNIQUE (management_tenant_id, action, idempotency_key),
  UNIQUE (management_tenant_id, readback_ref),
  UNIQUE (reconciliation_event_sequence),
  UNIQUE (completion_event_sequence),
  UNIQUE (
    management_tenant_id,
    attempt_id,
    release_id,
    revision,
    readback_ref
  ),
  CHECK (
    (phase = 'claimed' AND
      terminal_status IS NULL AND
      finalized_at IS NULL AND
      applied_release_id IS NULL AND
      applied_revision IS NULL AND
      applied_modules_json = '[]' AND
      reason_codes_json = '[]' AND
      checked_at IS NULL AND
      finalized_by_actor_ref IS NULL AND
      reconciliation_event_sequence IS NULL AND
      completion_event_sequence IS NULL) OR
    (phase = 'finalized' AND
      terminal_status IN ('verified', 'mismatch', 'unknown') AND
      finalized_at IS NOT NULL AND
      checked_at IS NOT NULL AND
      finalized_by_actor_ref IS NOT NULL AND
      reconciliation_event_sequence IS NOT NULL AND
      completion_event_sequence IS NOT NULL AND
      reconciliation_event_sequence > 0 AND
      completion_event_sequence > 0 AND
      reconciliation_event_sequence <> completion_event_sequence AND
      ((terminal_status = 'verified' AND
        applied_release_id = release_id AND
        applied_revision = revision AND
        applied_modules_json = desired_modules_json AND
        reason_codes_json = '[]') OR
       (terminal_status IN ('mismatch', 'unknown') AND
        reason_codes_json <> '[]' AND
        ((applied_release_id IS NULL AND applied_revision IS NULL) OR
         (applied_release_id IS NOT NULL AND applied_revision IS NOT NULL)))))
  ),
  FOREIGN KEY (
    management_tenant_id,
    action,
    idempotency_key,
    request_hash,
    release_id
  ) REFERENCES module_control_idempotency (
    management_tenant_id,
    action,
    idempotency_key,
    request_hash,
    domain_record_ref
  ),
  FOREIGN KEY (management_tenant_id, release_id, revision)
    REFERENCES module_releases (management_tenant_id, release_id, revision),
  FOREIGN KEY (reconciliation_event_sequence)
    REFERENCES module_control_events (sequence)
    NOT DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (completion_event_sequence)
    REFERENCES module_control_events (sequence)
    NOT DEFERRABLE INITIALLY IMMEDIATE
) STRICT;

-- The existing store indexes remain part of v1. The following indexes cover
-- unfinished attempts, release-history/current projection ordering, exact
-- idempotency lookup, and readback-reference lookup. Authority selection uses
-- reconciliation_event_sequence DESC then attempt_id DESC, never finalized_at.
CREATE INDEX idx_module_control_events_tenant_sequence
  ON module_control_events (management_tenant_id, sequence);

CREATE INDEX idx_module_control_idempotency_tenant_expires_at
  ON module_control_idempotency (management_tenant_id, expires_at);

CREATE INDEX idx_module_previews_tenant_expires_at
  ON module_previews (management_tenant_id, expires_at);

CREATE INDEX idx_module_releases_tenant_status_revision
  ON module_releases (management_tenant_id, status, revision DESC);

CREATE INDEX idx_module_readback_attempts_unfinished
  ON module_readback_attempts (
    management_tenant_id,
    claimed_at,
    release_id,
    revision
  )
  WHERE phase = 'claimed';

CREATE INDEX idx_module_readback_attempts_release_history
  ON module_readback_attempts (
    management_tenant_id,
    release_id,
    revision,
    reconciliation_event_sequence DESC,
    attempt_id DESC
  );

CREATE INDEX idx_module_control_idempotency_tenant_action_key_hash
  ON module_control_idempotency (
    management_tenant_id,
    action,
    idempotency_key,
    request_hash
  );

CREATE INDEX idx_module_readbacks_tenant_readback_ref
  ON module_readbacks (management_tenant_id, readback_ref);

CREATE UNIQUE INDEX uq_module_readback_attempts_claimed_release
  ON module_readback_attempts (
    management_tenant_id,
    release_id,
    revision
  )
  WHERE phase = 'claimed';

-- Both event sequences are allocated by the repository inside BEGIN IMMEDIATE:
-- SELECT COALESCE(MAX(sequence), 0) + 1 yields the reconciliation sequence and
-- the immediately following integer yields the completion sequence. Both event
-- rows are inserted before the attempt is finalized. This artifact defines the
-- constraints only; it intentionally does not emulate allocation with a trigger.

PRAGMA user_version = 1;
