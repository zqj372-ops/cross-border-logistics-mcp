import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ClaimReadbackAttemptRequest,
  ControlEnvelope,
  ControlFinalResult,
  ModuleControlRef,
  ReadbackAttemptOwnerCapability,
  ReadbackAttemptObservation,
} from "../../src/logistics_mcp/control-plane/repository";
import {
  createSqliteControlStoreWithRecovery,
  initializeSqliteControlState,
  openSqliteControlStore,
} from "../../src/logistics_mcp/control-plane/sqlite-control-store";

const tenant = "tenant_control";
const actor = "actor_publisher";
const descriptorDigest = `sha256:${"1".repeat(64)}` as const;
const requestHash = `mcp-control-hash/v1/request/sha256:${"2".repeat(64)}` as const;
const previewHash = `mcp-control-hash/v1/preview/sha256:${"3".repeat(64)}` as const;
const moduleRef = {
  moduleId: "cargo",
  version: "1.0.0",
  descriptorDigest,
} as const satisfies ModuleControlRef;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sqlite-attempt-")));
  roots.push(root);
  return root;
}

const FINALIZE_FAILPOINTS = [
  "after_reconciliation_event",
  "after_completion_event",
  "after_current_readback",
  "after_release",
  "after_attempt_finalized",
  "after_idempotency_completed",
  "before_health_check",
  "after_health_check",
] as const;

const RECOVERY_FAILPOINTS = [
  "after_reconciliation_event",
  "after_release",
  "after_idempotency_completed",
  "before_health_check",
  "after_health_check",
] as const;

type FinalizeFailpoint = (typeof FINALIZE_FAILPOINTS)[number];

interface TestOnlyStoreOptions {
  readonly finalizeClock: () => string;
  readonly finalizeFailpoint: FinalizeFailpoint | null;
}

function storeOptions(
  applicationRoot: string,
  testOnly?: TestOnlyStoreOptions,
) {
  return {
    applicationRoot,
    instanceId: "instance_fixture_001",
    managementTenantId: tenant,
    adminControlEnabled: true,
    ...(testOnly === undefined ? {} : { testOnly }),
  } as const;
}

function databasePath(applicationRoot: string): string {
  return join(applicationRoot, ".runtime/mcp-instance-state/control.sqlite");
}

async function seedPublishedStore(
  applicationRoot: string,
  testOnly?: TestOnlyStoreOptions,
) {
  await initializeSqliteControlState({
    applicationRoot,
    instanceId: "instance_fixture_001",
    managementTenantId: tenant,
  });
  const store = openSqliteControlStore(storeOptions(applicationRoot, testOnly));
  const registration = await store.registerModule({
    metadata: {
      managementTenantId: tenant,
      actorRef: "actor_operator",
      action: "packages.register",
      idempotencyKey: "idem_register_attempt",
      requestHash: `mcp-control-hash/v1/request/sha256:${"4".repeat(64)}`,
      event: {
        action: "packages.register",
        objectRef: `registration:cargo:1.0.0:${descriptorDigest}`,
        kind: "registration",
        status: "registered",
        reasonCodes: [],
        detail: {
          kind: "registration",
          recordRef: `registration:cargo:1.0.0:${descriptorDigest}`,
          moduleId: "cargo",
          version: "1.0.0",
          descriptorDigest,
          status: "registered",
        },
      },
    },
    record: {
      managementTenantId: tenant,
      moduleId: "cargo",
      version: "1.0.0",
      descriptorDigest,
      evidenceLevel: "local_build",
      productionEligible: false,
      evidenceRefs: {
        sourceShaRef: null,
        artifactDigestRef: null,
        signatureRef: null,
        sbomRef: null,
        attestationRef: null,
      },
      registeredByActorRef: "actor_operator",
      registeredAt: "2099-08-23T00:00:00Z",
    },
    finalResult: {
      domainRecordRef: `registration:cargo:1.0.0:${descriptorDigest}`,
      envelope: {
        schema_version: "2026-08-22.v1",
        request_id: "request_register_attempt",
        trace_id: "trace_register_attempt",
        audit_id: "audit_register_attempt",
        status: "success",
        data: {
          kind: "registration",
          module_id: "cargo",
          version: "1.0.0",
          descriptor_digest: descriptorDigest,
          evidence_level: "local_build",
          production_eligible: false,
        },
        reason_codes: [],
        readback: { status: "not_applicable", release_id: null, revision: null },
      },
    },
  });
  expect(registration.replayed).toBe(false);
  await store.createPreview({
    metadata: {
      managementTenantId: tenant,
      actorRef: "actor_operator",
      action: "deployments.preview",
      idempotencyKey: "idem_preview_attempt",
      requestHash: `mcp-control-hash/v1/request/sha256:${"5".repeat(64)}`,
      event: {
        action: "deployments.preview",
        objectRef: "preview_attempt",
        kind: "preview",
        status: "previewed",
        reasonCodes: [],
        detail: {
          kind: "preview",
          previewRef: "preview_attempt",
          baseRevision: 0,
          status: "previewed",
        },
      },
    },
    record: {
      managementTenantId: tenant,
      previewRef: "preview_attempt",
      canonicalHash: previewHash,
      intent: "change",
      baseReleaseId: null,
      baseRevision: 0,
      inventoryRefs: [moduleRef],
      desiredModules: [moduleRef],
      diff: { added: [moduleRef], removed: [], retained: [] },
      validation: {
        baseMatches: true,
        desiredModulesValid: true,
        inventoryMatches: true,
        minimumActiveModules: true,
        reasonCodes: [],
      },
      creatorActorRef: "actor_operator",
      createdAt: "2099-08-23T00:01:00Z",
      expiresAt: "2099-08-24T00:01:00Z",
      consumed: false,
    },
    finalResult: {
      domainRecordRef: "preview_attempt",
      envelope: {
        schema_version: "2026-08-22.v1",
        request_id: "request_preview_attempt",
        trace_id: "trace_preview_attempt",
        audit_id: "audit_preview_attempt",
        status: "success",
        data: {
          kind: "preview",
          preview_ref: "preview_attempt",
          intent: "change",
          base_release_id: null,
          base_revision: 0,
          desired_modules: [
            { module_id: "cargo", version: "1.0.0", descriptor_digest: descriptorDigest },
          ],
          target_release_id: null,
          expires_at: "2099-08-24T00:01:00Z",
        },
        reason_codes: [],
        readback: { status: "not_applicable", release_id: null, revision: null },
      },
    },
  });
  await store.decideApproval({
    metadata: {
      managementTenantId: tenant,
      actorRef: "actor_approver",
      action: "approvals.decide",
      idempotencyKey: "idem_approval_attempt",
      requestHash: `mcp-control-hash/v1/request/sha256:${"6".repeat(64)}`,
      event: {
        action: "approvals.decide",
        objectRef: "approval_attempt",
        kind: "approval",
        status: "approved",
        reasonCodes: [],
        detail: {
          kind: "approval",
          approvalId: "approval_attempt",
          previewRef: "preview_attempt",
          status: "approved",
        },
      },
    },
    record: {
      managementTenantId: tenant,
      approvalId: "approval_attempt",
      previewRef: "preview_attempt",
      decision: "approve",
      previewCanonicalHash: previewHash,
      baseReleaseId: null,
      baseRevision: 0,
      inventoryDigestSet: [descriptorDigest],
      expiresAt: "2099-08-24T00:01:00Z",
      reasonCode: "approved",
      approverActorRef: "actor_approver",
      decidedAt: "2099-08-23T00:02:00Z",
      consumed: false,
    },
    finalResult: {
      domainRecordRef: "approval_attempt",
      envelope: {
        schema_version: "2026-08-22.v1",
        request_id: "request_approval_attempt",
        trace_id: "trace_approval_attempt",
        audit_id: "audit_approval_attempt",
        status: "success",
        data: {
          kind: "approval",
          approval_id: "approval_attempt",
          preview_ref: "preview_attempt",
          decision: "approve",
        },
        reason_codes: [],
        readback: { status: "not_applicable", release_id: null, revision: null },
      },
    },
  });
  await store.publishRelease({
    metadata: {
      managementTenantId: tenant,
      actorRef: actor,
      action: "deployments.publish",
      idempotencyKey: "idem_publish_attempt",
      requestHash,
      event: {
        action: "deployments.publish",
        objectRef: "release_attempt",
        kind: "release",
        status: "published_pending_readback",
        reasonCodes: [],
        detail: {
          kind: "release",
          releaseId: "release_attempt",
          revision: 1,
          status: "published_pending_readback",
        },
      },
    },
    record: {
      managementTenantId: tenant,
      releaseId: "release_attempt",
      revision: 1,
      desiredModules: [moduleRef],
      previousReleaseId: null,
      previewRef: "preview_attempt",
      approvalId: "approval_attempt",
      publisherActorRef: actor,
      status: "published_pending_readback",
      createdAt: "2099-08-23T00:03:00Z",
      publishedAt: "2099-08-23T00:03:00Z",
      readbackRef: null,
      reasonCodes: [],
      supersededByReleaseId: null,
    },
  });
  return store;
}

function claimRequest(): ClaimReadbackAttemptRequest {
  return {
    metadata: {
      managementTenantId: tenant,
      actorRef: actor,
      action: "deployments.publish",
      idempotencyKey: "idem_publish_attempt",
      requestHash,
      requestId: "request_publish_attempt",
      traceId: "trace_publish_attempt",
      auditId: "audit_publish_attempt",
    },
    attemptId: "attempt_release_001",
    readbackRef: "readback_attempt_001",
    releaseId: "release_attempt",
    revision: 1,
    desiredModules: [moduleRef],
    ownerBootId: "boot_placeholder",
    claimedAt: "2099-08-23T00:04:00Z",
  };
}

function verifiedObservation(): ReadbackAttemptObservation {
  return {
    status: "verified",
    appliedReleaseId: "release_attempt",
    appliedRevision: 1,
    appliedModules: [moduleRef],
    reasonCodes: [],
    checkedAt: "2099-08-23T00:05:00Z",
  };
}

function verifiedFinalResult(): ControlFinalResult {
  return {
    domainRecordRef: "release_attempt",
    envelope: {
      schema_version: "2026-08-22.v1",
      request_id: "request_publish_attempt",
      trace_id: "trace_publish_attempt",
      audit_id: "audit_publish_attempt",
      status: "success",
      data: {
        kind: "release",
        release_id: "release_attempt",
        revision: 1,
        active_modules: [
          { module_id: "cargo", version: "1.0.0", descriptor_digest: descriptorDigest },
        ],
      },
      reason_codes: [],
      readback: { status: "verified", release_id: "release_attempt", revision: 1 },
    } satisfies ControlEnvelope,
  };
}

type AttemptStore = Awaited<ReturnType<typeof seedPublishedStore>>;

async function claimCreated(
  store: AttemptStore,
  request: ClaimReadbackAttemptRequest = claimRequest(),
) {
  const claim = await store.claimReadbackAttempt(request);
  if (claim.disposition !== "created") throw new Error("claim did not create");
  return claim;
}

function terminalObservation(
  status: "verified" | "mismatch" | "unknown",
  checkedAt: string,
): ReadbackAttemptObservation {
  if (status === "verified") {
    return {
      ...verifiedObservation(),
      checkedAt,
    };
  }
  return {
    status,
    appliedReleaseId: null,
    appliedRevision: null,
    appliedModules: [],
    reasonCodes: [`readback.${status}`],
    checkedAt,
  };
}

function terminalFinalResult(input: {
  readonly action: "deployments.publish" | "deployments.reconcile";
  readonly status: "verified" | "mismatch" | "unknown";
  readonly requestId: string;
  readonly traceId: string;
  readonly auditId: string;
}): ControlFinalResult {
  const reasonCodes =
    input.status === "verified" ? [] : [`readback.${input.status}`];
  return {
    domainRecordRef: "release_attempt",
    envelope: {
      schema_version: "2026-08-22.v1",
      request_id: input.requestId,
      trace_id: input.traceId,
      audit_id: input.auditId,
      status: input.status === "verified" ? "success" : "manual_review",
      data:
        input.action === "deployments.publish"
          ? {
              kind: "release",
              release_id: "release_attempt",
              revision: 1,
              active_modules: [
                {
                  module_id: moduleRef.moduleId,
                  version: moduleRef.version,
                  descriptor_digest: moduleRef.descriptorDigest,
                },
              ],
            }
          : {
              kind: "reconciliation",
              release_id: "release_attempt",
              revision: 1,
              status: input.status,
            },
      reason_codes: reasonCodes,
      readback: {
        status: input.status,
        release_id: "release_attempt",
        revision: 1,
      },
    },
  };
}

function interruptedObservation(checkedAt: string): ReadbackAttemptObservation {
  return {
    status: "unknown",
    appliedReleaseId: null,
    appliedRevision: null,
    appliedModules: [],
    reasonCodes: ["readback.interrupted"],
    checkedAt,
  };
}

function interruptedFinalResult(input: {
  readonly action: "deployments.publish" | "deployments.reconcile";
  readonly requestId: string;
  readonly traceId: string;
  readonly auditId: string;
}): ControlFinalResult {
  return {
    domainRecordRef: "release_attempt",
    envelope: {
      schema_version: "2026-08-22.v1",
      request_id: input.requestId,
      trace_id: input.traceId,
      audit_id: input.auditId,
      status: "manual_review",
      data:
        input.action === "deployments.publish"
          ? {
              kind: "release",
              release_id: "release_attempt",
              revision: 1,
              active_modules: [
                {
                  module_id: moduleRef.moduleId,
                  version: moduleRef.version,
                  descriptor_digest: moduleRef.descriptorDigest,
                },
              ],
            }
          : {
              kind: "reconciliation",
              release_id: "release_attempt",
              revision: 1,
              status: "unknown",
            },
      reason_codes: ["readback.interrupted"],
      readback: {
        status: "unknown",
        release_id: "release_attempt",
        revision: 1,
      },
    } satisfies ControlEnvelope,
  };
}

function interruptedRecoveryRequest(
  attempt: {
    readonly attemptId: string;
    readonly action: "deployments.publish" | "deployments.reconcile";
    readonly requestId: string;
    readonly traceId: string;
    readonly auditId: string;
  },
) {
  return {
    attemptId: attempt.attemptId,
    observation: interruptedObservation("2099-08-23T00:05:00Z"),
    finalResult: interruptedFinalResult(attempt),
    finalizedAt: "2099-08-23T00:06:00Z",
  } as const;
}

function reconcileClaimRequest(input: {
  readonly suffix: string;
  readonly hashCharacter: string;
  readonly claimedAt: string;
}): ClaimReadbackAttemptRequest {
  const requestId = `request_reconcile_${input.suffix}`;
  return {
    metadata: {
      managementTenantId: tenant,
      actorRef: "actor_reconciler",
      action: "deployments.reconcile",
      idempotencyKey: `idem_reconcile_${input.suffix}`,
      requestHash:
        `mcp-control-hash/v1/request/sha256:${input.hashCharacter.repeat(64)}`,
      requestId,
      traceId: `trace_reconcile_${input.suffix}`,
      auditId: `audit_reconcile_${input.suffix}`,
    },
    attemptId: `attempt_reconcile_${input.suffix}`,
    readbackRef: `readback_reconcile_${input.suffix}`,
    releaseId: "release_attempt",
    revision: 1,
    desiredModules: [moduleRef],
    ownerBootId: `caller_boot_${input.suffix}`,
    claimedAt: input.claimedAt,
  };
}

function durableAttemptState(applicationRoot: string, attemptId: string) {
  const database = new DatabaseSync(databasePath(applicationRoot));
  try {
    return {
      attempt: database
        .prepare(
          `SELECT phase, finalized_at, terminal_status, checked_at,
                  finalized_by_actor_ref, reconciliation_event_sequence,
                  completion_event_sequence
           FROM module_readback_attempts WHERE attempt_id = ?`,
        )
        .get(attemptId),
      idempotency: database
        .prepare(
          `SELECT status, final_result_json FROM module_control_idempotency
           WHERE action = 'deployments.publish' AND idempotency_key = 'idem_publish_attempt'`,
        )
        .get(),
      release: database
        .prepare(
          `SELECT status, readback_ref, reason_codes_json FROM module_releases
           WHERE release_id = 'release_attempt'`,
        )
        .get(),
      readbackCount: database
        .prepare("SELECT COUNT(*) AS count FROM module_readbacks")
        .get(),
      terminalEventCount: database
        .prepare(
          `SELECT COUNT(*) AS count FROM module_control_events
           WHERE idempotency_key = 'idem_publish_attempt'
             AND json_extract(payload_json, '$.detail.kind') IN ('reconciliation', 'idempotency')`,
        )
        .get(),
    };
  } finally {
    database.close();
  }
}

function expectClaimedRollbackState(
  applicationRoot: string,
  attemptId: string,
): void {
  expect(durableAttemptState(applicationRoot, attemptId)).toEqual({
    attempt: {
      phase: "claimed",
      finalized_at: null,
      terminal_status: null,
      checked_at: null,
      finalized_by_actor_ref: null,
      reconciliation_event_sequence: null,
      completion_event_sequence: null,
    },
    idempotency: { status: "domain_committed", final_result_json: null },
    release: {
      status: "published_pending_readback",
      readback_ref: null,
      reason_codes_json: "[]",
    },
    readbackCount: { count: 0 },
    terminalEventCount: { count: 0 },
  });
}

async function seedFinalizedVerifiedRoot(applicationRoot: string) {
  const store = await seedPublishedStore(applicationRoot);
  const claim = await claimCreated(store);
  const finalized = await store.finalizeReadbackAndComplete({
    attemptId: claim.attempt.attemptId,
    ownerCapability: claim.ownerCapability,
    observation: verifiedObservation(),
    finalResult: verifiedFinalResult(),
    finalizedAt: "2099-08-23T00:06:00Z",
  });
  await store.close();
  return finalized;
}

type FinalizedFixture = Awaited<ReturnType<typeof seedFinalizedVerifiedRoot>>;

const GRAPH_TAMPER_CASES: readonly {
  readonly name: string;
  readonly mutate: (database: DatabaseSync, finalized: FinalizedFixture) => void;
}[] = [
  {
    name: "attempt actor",
    mutate: (database, finalized) => {
      database.prepare(
        "UPDATE module_readback_attempts SET actor_ref = 'actor_tampered' WHERE attempt_id = ?",
      ).run(finalized.attempt.attemptId);
    },
  },
  {
    name: "terminal event actor",
    mutate: (database, finalized) => {
      database.prepare(
        "UPDATE module_control_events SET actor_ref = 'actor_tampered' WHERE sequence = ?",
      ).run(finalized.reconciliationEvent.sequence);
    },
  },
  {
    name: "current attempt ref",
    mutate: (database) => {
      database.exec("PRAGMA foreign_keys = OFF");
      database.prepare(
        "UPDATE module_readbacks SET attempt_id = 'attempt_missing' WHERE release_id = 'release_attempt'",
      ).run();
    },
  },
  {
    name: "idempotency actor",
    mutate: (database) => {
      database.prepare(
        `UPDATE module_control_idempotency SET actor_ref = 'actor_tampered'
         WHERE action = 'deployments.publish' AND idempotency_key = 'idem_publish_attempt'`,
      ).run();
    },
  },
  {
    name: "event sequence",
    mutate: (database, finalized) => {
      database.exec("PRAGMA foreign_keys = OFF");
      database.prepare(
        "UPDATE module_control_events SET sequence = sequence + 100 WHERE sequence = ?",
      ).run(finalized.reconciliationEvent.sequence);
    },
  },
  {
    name: "terminal event time",
    mutate: (database, finalized) => {
      database.prepare(
        "UPDATE module_control_events SET occurred_at = '2099-08-23T00:06:01Z' WHERE sequence = ?",
      ).run(finalized.completionEvent.sequence);
    },
  },
  {
    name: "idempotency terminal relation",
    mutate: (database) => {
      database.prepare(
        `UPDATE module_control_idempotency
         SET status = 'domain_committed', final_result_json = NULL
         WHERE action = 'deployments.publish' AND idempotency_key = 'idem_publish_attempt'`,
      ).run();
    },
  },
  {
    name: "current terminal status relation",
    mutate: (database) => {
      database.prepare(
        `UPDATE module_readbacks
         SET status = 'unknown', applied_release_id = NULL, applied_revision = NULL,
             applied_modules_json = '[]', reason_codes_json = '["readback.tampered"]'
         WHERE release_id = 'release_attempt'`,
      ).run();
      database.prepare(
        `UPDATE module_releases
         SET status = 'manual_review', reason_codes_json = '["readback.tampered"]'
         WHERE release_id = 'release_attempt'`,
      ).run();
    },
  },
];

async function expectTamperedGraphFailsClosed(applicationRoot: string): Promise<void> {
  const databaseBeforeOpen = readFileSync(databasePath(applicationRoot));
  let reopened: AttemptStore | null = null;
  try {
    reopened = openSqliteControlStore(storeOptions(applicationRoot));
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
  }
  if (reopened !== null) {
    await expect(reopened.health()).resolves.toEqual({ ready: false });
    await expect(reopened.getControlState()).rejects.toMatchObject({ code: "invalid_state" });
    await expect(reopened.health()).resolves.toEqual({ ready: false });
    await reopened.close();
  }
  expect(readFileSync(databasePath(applicationRoot))).toEqual(databaseBeforeOpen);
}

describe("SQLite readback-attempt finalization", () => {
  describe("startup recovery assembly boundary", () => {
    it("does not expose legacy readback or idempotency write entries after claim", async () => {
      const root = makeRoot();
      const repository = await seedPublishedStore(root);
      const claim = await claimCreated(repository);
      expect(claim.disposition).toBe("created");

      const legacyNames = ["recordReadback", "completeIdempotency"] as const;
      const reflectedKeys = new Set<PropertyKey>();
      let cursor: object | null = repository;
      while (cursor !== null) {
        for (const key of Reflect.ownKeys(cursor)) reflectedKeys.add(key);
        cursor = Reflect.getPrototypeOf(cursor);
      }
      const escaped = repository as unknown as Record<string, unknown>;
      for (const legacyName of legacyNames) {
        expect(legacyName in repository).toBe(false);
        expect(reflectedKeys.has(legacyName)).toBe(false);
        expect(escaped[legacyName]).toBeUndefined();
      }

      await repository.close();
    });

    it("separates the recovery driver from the plain repository", async () => {
      const root = makeRoot();
      const initialized = await seedPublishedStore(root);
      await initialized.close();
      const assembled = createSqliteControlStoreWithRecovery(storeOptions(root));

      expect(Object.isFrozen(assembled)).toBe(true);
      expect(Object.isFrozen(assembled.recoveryDriver)).toBe(true);
      expect("recoveryDriver" in assembled.repository).toBe(false);
      expect(Reflect.ownKeys(assembled.repository)).not.toContain("recoveryDriver");

      await assembled.repository.close();
    });

    it("rejects same-boot recovery without changing durable state", async () => {
      const root = makeRoot();
      const initialized = await seedPublishedStore(root);
      await initialized.close();
      const assembled = createSqliteControlStoreWithRecovery(storeOptions(root));
      const claim = await claimCreated(assembled.repository);
      const before = await assembled.repository.getControlState();

      await expect(
        assembled.recoveryDriver.finalizePriorBootAttempt(
          interruptedRecoveryRequest(claim.attempt),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(assembled.repository.getControlState()).resolves.toEqual(before);
      await expect(
        assembled.repository.getUnfinishedReadbackAttempt({
          managementTenantId: tenant,
          attemptId: claim.attempt.attemptId,
        }),
      ).resolves.toEqual(claim.attempt);

      await assembled.repository.close();
    });

    it("finalizes a prior-boot claim as interrupted manual review with recovery terminal actors", async () => {
      const root = makeRoot();
      const owner = await seedPublishedStore(root);
      const claim = await claimCreated(owner);
      await owner.close();

      const assembled = createSqliteControlStoreWithRecovery(storeOptions(root));
      await expect(assembled.repository.health()).resolves.toEqual({ ready: true });
      const finalized = await assembled.recoveryDriver.finalizePriorBootAttempt(
        interruptedRecoveryRequest(claim.attempt),
      );

      expect(finalized.disposition).toBe("finalized");
      expect(finalized.attempt.finalizedByActorRef).toBe("system_startup_recovery");
      expect(finalized.reconciliationEvent.actorRef).toBe("system_startup_recovery");
      expect(finalized.completionEvent.actorRef).toBe("system_startup_recovery");
      expect(finalized.idempotency.actorRef).toBe(claim.attempt.actorRef);
      expect(finalized.readback).toMatchObject({
        status: "unknown",
        appliedReleaseId: null,
        appliedRevision: null,
        appliedModules: [],
        reasonCodes: ["readback.interrupted"],
      });
      expect(finalized.release).toMatchObject({
        status: "manual_review",
        reasonCodes: ["readback.interrupted"],
      });
      expect(finalized.finalResult.envelope).toMatchObject({
        status: "manual_review",
        reason_codes: ["readback.interrupted"],
        readback: {
          status: "unknown",
          release_id: claim.attempt.releaseId,
          revision: claim.attempt.revision,
        },
      });
      await expect(assembled.repository.health()).resolves.toEqual({ ready: true });
      await assembled.repository.close();
    });

    it.each([
      {
        name: "the observation status",
        mutate: (request: ReturnType<typeof interruptedRecoveryRequest>) => ({
          ...request,
          observation: verifiedObservation(),
        }),
      },
      {
        name: "the observation reasons",
        mutate: (request: ReturnType<typeof interruptedRecoveryRequest>) => ({
          ...request,
          observation: {
            ...request.observation,
            reasonCodes: ["readback.tampered"],
          },
          finalResult: {
            ...request.finalResult,
            envelope: {
              ...request.finalResult.envelope,
              reason_codes: ["readback.tampered"],
            },
          },
        }),
      },
      {
        name: "the final status",
        mutate: (request: ReturnType<typeof interruptedRecoveryRequest>) => ({
          ...request,
          finalResult: {
            ...request.finalResult,
            envelope: {
              ...request.finalResult.envelope,
              status: "success" as const,
            },
          },
        }),
      },
      {
        name: "the final payload",
        mutate: (request: ReturnType<typeof interruptedRecoveryRequest>) => ({
          ...request,
          finalResult: {
            ...request.finalResult,
            envelope: {
              ...request.finalResult.envelope,
              data: {
                ...request.finalResult.envelope.data,
                release_id: "release_forged",
              },
            },
          },
        } as ReturnType<typeof interruptedRecoveryRequest>),
      },
    ])("rejects recovery with forged $name without durable writes", async ({ mutate }) => {
      const root = makeRoot();
      const owner = await seedPublishedStore(root);
      const claim = await claimCreated(owner);
      await owner.close();

      const assembled = createSqliteControlStoreWithRecovery(storeOptions(root));
      const beforeState = await assembled.repository.getControlState();
      const beforeBytes = readFileSync(databasePath(root));
      await expect(
        assembled.recoveryDriver.finalizePriorBootAttempt(
          mutate(interruptedRecoveryRequest(claim.attempt)),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(assembled.repository.getControlState()).resolves.toEqual(beforeState);
      await expect(
        assembled.repository.getUnfinishedReadbackAttempt({
          managementTenantId: tenant,
          attemptId: claim.attempt.attemptId,
        }),
      ).resolves.toEqual(claim.attempt);
      expect(readFileSync(databasePath(root))).toEqual(beforeBytes);
      await assembled.repository.close();
    });

    it("does not accept an owner capability as recovery authority", async () => {
      const root = makeRoot();
      const owner = await seedPublishedStore(root);
      const claim = await claimCreated(owner);
      await owner.close();

      const assembled = createSqliteControlStoreWithRecovery(storeOptions(root));
      const beforeState = await assembled.repository.getControlState();
      const beforeBytes = readFileSync(databasePath(root));
      await expect(
        assembled.recoveryDriver.finalizePriorBootAttempt({
          ...interruptedRecoveryRequest(claim.attempt),
          ownerCapability: claim.ownerCapability,
        } as never),
      ).rejects.toMatchObject({ code: "invalid_state" });
      await expect(assembled.repository.getControlState()).resolves.toEqual(beforeState);
      expect(readFileSync(databasePath(root))).toEqual(beforeBytes);
      await assembled.repository.close();
    });

    it.each(RECOVERY_FAILPOINTS)(
      "rolls back recovery at %s, leaves the claim, and permits a later retry",
      async (finalizeFailpoint) => {
        const root = makeRoot();
        const owner = await seedPublishedStore(root);
        const claim = await claimCreated(owner);
        await owner.close();

        const failed = createSqliteControlStoreWithRecovery(
          storeOptions(root, {
            finalizeClock: () => "2099-08-23T00:06:00Z",
            finalizeFailpoint,
          }),
        );
        const beforeState = await failed.repository.getControlState();
        await expect(
          failed.recoveryDriver.finalizePriorBootAttempt(
            interruptedRecoveryRequest(claim.attempt),
          ),
        ).rejects.toMatchObject({ code: "conflict" });
        await expect(failed.repository.getControlState()).resolves.toEqual(beforeState);
        await expect(
          failed.repository.getUnfinishedReadbackAttempt({
            managementTenantId: tenant,
            attemptId: claim.attempt.attemptId,
          }),
        ).resolves.toEqual(claim.attempt);
        await failed.repository.close();
        expectClaimedRollbackState(root, claim.attempt.attemptId);

        const retried = createSqliteControlStoreWithRecovery(storeOptions(root));
        await expect(retried.repository.health()).resolves.toEqual({ ready: true });
        await expect(
          retried.recoveryDriver.finalizePriorBootAttempt(
            interruptedRecoveryRequest(claim.attempt),
          ),
        ).resolves.toMatchObject({
          disposition: "finalized",
          attempt: { finalizedByActorRef: "system_startup_recovery" },
        });
        await expect(retried.repository.health()).resolves.toEqual({ ready: true });
        await retried.repository.close();
      },
    );

    it("replays a completed recovery exactly and rejects a changed final payload", async () => {
      const root = makeRoot();
      const owner = await seedPublishedStore(root);
      const claim = await claimCreated(owner);
      await owner.close();

      const assembled = createSqliteControlStoreWithRecovery(storeOptions(root));
      const request = interruptedRecoveryRequest(claim.attempt);
      const finalized = await assembled.recoveryDriver.finalizePriorBootAttempt(request);
      const replay = await assembled.recoveryDriver.finalizePriorBootAttempt(request);
      expect(replay).toEqual({
        ...finalized,
        disposition: "replayed",
        replayed: true,
      });
      expect(replay.disposition).toBe("replayed");
      expect(replay.replayed).toBe(true);

      const beforeState = await assembled.repository.getControlState();
      const changedRequest = {
        ...request,
        finalResult: {
          ...request.finalResult,
          envelope: {
            ...request.finalResult.envelope,
            data: {
              ...request.finalResult.envelope.data,
              release_id: "release_changed",
            },
          },
        },
      } as ReturnType<typeof interruptedRecoveryRequest>;
      await expect(
        assembled.recoveryDriver.finalizePriorBootAttempt(changedRequest),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(assembled.repository.getControlState()).resolves.toEqual(beforeState);
      await assembled.repository.close();
    });

    it("keeps recovery drivers scoped to their own store and attempt records", async () => {
      const firstRoot = makeRoot();
      const secondRoot = makeRoot();
      const firstOwner = await seedPublishedStore(firstRoot);
      const firstClaim = await claimCreated(firstOwner);
      await firstOwner.close();
      const secondOwner = await seedPublishedStore(secondRoot);
      const secondClaim = await claimCreated(secondOwner, {
        ...claimRequest(),
        attemptId: "attempt_release_002",
        readbackRef: "readback_attempt_002",
      });
      await secondOwner.close();

      const first = createSqliteControlStoreWithRecovery(storeOptions(firstRoot));
      const second = createSqliteControlStoreWithRecovery(storeOptions(secondRoot));
      const firstBefore = await first.repository.getControlState();
      const secondBefore = await second.repository.getControlState();
      await expect(
        first.recoveryDriver.finalizePriorBootAttempt(
          interruptedRecoveryRequest(secondClaim.attempt),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        first.recoveryDriver.finalizePriorBootAttempt({
          ...interruptedRecoveryRequest(firstClaim.attempt),
          attemptId: "attempt_missing",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(first.repository.getControlState()).resolves.toEqual(firstBefore);
      await expect(second.repository.getControlState()).resolves.toEqual(secondBefore);

      await expect(
        second.recoveryDriver.finalizePriorBootAttempt(
          interruptedRecoveryRequest(secondClaim.attempt),
        ),
      ).resolves.toMatchObject({ disposition: "finalized" });
      await expect(
        first.recoveryDriver.finalizePriorBootAttempt(
          interruptedRecoveryRequest(firstClaim.attempt),
        ),
      ).resolves.toMatchObject({ disposition: "finalized" });
      await first.repository.close();
      await second.repository.close();
    });
  });

  describe("persisted graph tamper fail-closed", () => {
    it.each(GRAPH_TAMPER_CASES)(
      "rejects $name after reopen without automatic repair",
      async ({ mutate }) => {
        const root = makeRoot();
        const finalized = await seedFinalizedVerifiedRoot(root);
        const database = new DatabaseSync(databasePath(root));
        try {
          mutate(database, finalized);
        } finally {
          database.close();
        }
        await expectTamperedGraphFailsClosed(root);
      },
    );
  });

  describe("owner capability", () => {
    it("keeps the capability opaque to reflection, JSON, and spread", async () => {
      const root = makeRoot();
      const store = await seedPublishedStore(root);
      const claim = await claimCreated(store);

      expect(Object.getPrototypeOf(claim.ownerCapability)).toBeNull();
      expect(Object.isFrozen(claim.ownerCapability)).toBe(true);
      expect(Object.keys(claim.ownerCapability)).toEqual([]);
      expect(Reflect.ownKeys(claim.ownerCapability)).toEqual([]);
      expect(JSON.stringify(claim.ownerCapability)).toBe("{}");
      expect({ ...claim.ownerCapability }).toEqual({});
      expect(Reflect.ownKeys(store)).not.toContain("ownerCapabilities");
      expect(Reflect.ownKeys(store)).not.toContain("consumedOwnerCapabilities");

      await store.close();
    });

    it.each([
      {
        name: "a plain object",
        expectedCode: "conflict",
        make: () => Object.freeze({}) as ReadbackAttemptOwnerCapability,
      },
      {
        name: "a symbol",
        expectedCode: "invalid_state",
        make: () => Symbol("forged") as unknown as ReadbackAttemptOwnerCapability,
      },
      {
        name: "a JSON round-trip",
        expectedCode: "conflict",
        make: (capability: ReadbackAttemptOwnerCapability) =>
          JSON.parse(JSON.stringify(capability)) as ReadbackAttemptOwnerCapability,
      },
      {
        name: "an object spread",
        expectedCode: "conflict",
        make: (capability: ReadbackAttemptOwnerCapability) =>
          ({ ...capability }),
      },
      {
        name: "a structured clone",
        expectedCode: "conflict",
        make: (capability: ReadbackAttemptOwnerCapability) =>
          structuredClone(capability),
      },
    ])("rejects $name without durable side effects", async ({ make, expectedCode }) => {
      const root = makeRoot();
      const store = await seedPublishedStore(root);
      const claim = await claimCreated(store);
      const before = await store.getControlState();

      await expect(store.finalizeReadbackAndComplete({
        attemptId: claim.attempt.attemptId,
        ownerCapability: make(claim.ownerCapability),
        observation: verifiedObservation(),
        finalResult: verifiedFinalResult(),
        finalizedAt: "2099-08-23T00:06:00Z",
      })).rejects.toMatchObject({ code: expectedCode });
      await expect(store.getControlState()).resolves.toEqual(before);
      await expect(store.getUnfinishedReadbackAttempt({
        managementTenantId: tenant,
        attemptId: claim.attempt.attemptId,
      })).resolves.toEqual(claim.attempt);

      await expect(store.finalizeReadbackAndComplete({
        attemptId: claim.attempt.attemptId,
        ownerCapability: claim.ownerCapability,
        observation: verifiedObservation(),
        finalResult: verifiedFinalResult(),
        finalizedAt: "2099-08-23T00:06:00Z",
      })).resolves.toMatchObject({ disposition: "finalized" });
      await store.close();
    });

    it("rejects a capability borrowed from another store", async () => {
      const firstRoot = makeRoot();
      const secondRoot = makeRoot();
      const first = await seedPublishedStore(firstRoot);
      const second = await seedPublishedStore(secondRoot);
      const firstClaim = await claimCreated(first);
      const secondClaim = await claimCreated(second);
      const beforeSecond = await second.getControlState();

      await expect(second.finalizeReadbackAndComplete({
        attemptId: secondClaim.attempt.attemptId,
        ownerCapability: firstClaim.ownerCapability,
        observation: verifiedObservation(),
        finalResult: verifiedFinalResult(),
        finalizedAt: "2099-08-23T00:06:00Z",
      })).rejects.toMatchObject({ code: "conflict" });
      await expect(second.getControlState()).resolves.toEqual(beforeSecond);

      await second.finalizeReadbackAndComplete({
        attemptId: secondClaim.attempt.attemptId,
        ownerCapability: secondClaim.ownerCapability,
        observation: verifiedObservation(),
        finalResult: verifiedFinalResult(),
        finalizedAt: "2099-08-23T00:06:00Z",
      });
      await first.finalizeReadbackAndComplete({
        attemptId: firstClaim.attempt.attemptId,
        ownerCapability: firstClaim.ownerCapability,
        observation: verifiedObservation(),
        finalResult: verifiedFinalResult(),
        finalizedAt: "2099-08-23T00:06:00Z",
      });
      await first.close();
      await second.close();
    });

    it("rejects a capability for another attempt and rejects reuse after commit", async () => {
      const root = makeRoot();
      const store = await seedPublishedStore(root);
      const publishClaim = await claimCreated(store);
      await store.finalizeReadbackAndComplete({
        attemptId: publishClaim.attempt.attemptId,
        ownerCapability: publishClaim.ownerCapability,
        observation: terminalObservation("mismatch", "2099-08-23T00:05:00Z"),
        finalResult: terminalFinalResult({
          action: "deployments.publish",
          status: "mismatch",
          requestId: "request_publish_attempt",
          traceId: "trace_publish_attempt",
          auditId: "audit_publish_attempt",
        }),
        finalizedAt: "2099-08-23T00:06:00Z",
      });
      const reconcileRequest = reconcileClaimRequest({
        suffix: "capability_002",
        hashCharacter: "7",
        claimedAt: "2099-08-23T00:07:00Z",
      });
      const reconcileClaim = await claimCreated(store, reconcileRequest);
      const beforeWrongAttempt = await store.getControlState();

      await expect(store.finalizeReadbackAndComplete({
        attemptId: publishClaim.attempt.attemptId,
        ownerCapability: reconcileClaim.ownerCapability,
        observation: terminalObservation("unknown", "2099-08-23T00:08:00Z"),
        finalResult: terminalFinalResult({
          action: "deployments.reconcile",
          status: "unknown",
          requestId: reconcileRequest.metadata.requestId,
          traceId: reconcileRequest.metadata.traceId,
          auditId: reconcileRequest.metadata.auditId,
        }),
        finalizedAt: "2099-08-23T00:09:00Z",
      })).rejects.toMatchObject({ code: "conflict" });
      await expect(store.getControlState()).resolves.toEqual(beforeWrongAttempt);

      const finalizeReconcile = {
        attemptId: reconcileClaim.attempt.attemptId,
        ownerCapability: reconcileClaim.ownerCapability,
        observation: terminalObservation("unknown", "2099-08-23T00:08:00Z"),
        finalResult: terminalFinalResult({
          action: "deployments.reconcile" as const,
          status: "unknown" as const,
          requestId: reconcileRequest.metadata.requestId,
          traceId: reconcileRequest.metadata.traceId,
          auditId: reconcileRequest.metadata.auditId,
        }),
        finalizedAt: "2099-08-23T00:09:00Z",
      };
      await expect(store.finalizeReadbackAndComplete(finalizeReconcile)).resolves.toMatchObject({
        disposition: "finalized",
      });
      const afterCommit = await store.getControlState();
      await expect(store.finalizeReadbackAndComplete(finalizeReconcile)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(store.getControlState()).resolves.toEqual(afterCommit);
      await store.close();
    });
  });

  describe("actor and durable lineage authority", () => {
    it("rejects the reserved startup-recovery actor before any write", async () => {
      const root = makeRoot();
      const store = await seedPublishedStore(root);
      const request = reconcileClaimRequest({
        suffix: "reserved_actor",
        hashCharacter: "8",
        claimedAt: "2099-08-23T00:04:00Z",
      });
      const reservedRequest = {
        ...request,
        metadata: {
          ...request.metadata,
          actorRef: "system_startup_recovery",
        },
      } satisfies ClaimReadbackAttemptRequest;
      const before = await store.getControlState();

      await expect(store.claimReadbackAttempt(reservedRequest)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(store.getControlState()).resolves.toEqual(before);
      await expect(store.listUnfinishedReadbackAttempts()).resolves.toEqual([]);
      await expect(store.getIdempotency({
        managementTenantId: tenant,
        action: reservedRequest.metadata.action,
        idempotencyKey: reservedRequest.metadata.idempotencyKey,
      })).resolves.toBeNull();
      await store.close();
    });

    it("uses a server boot lineage and exposes no ordinary recovery finalizer", async () => {
      const root = makeRoot();
      let store = await seedPublishedStore(root);
      const request = claimRequest();
      const claim = await claimCreated(store, request);
      const exposed = store as unknown as Record<string, unknown>;

      expect(claim.attempt.ownerBootId).toMatch(/^boot_[0-9a-f-]{36}$/);
      expect(claim.attempt.ownerBootId).not.toBe(request.ownerBootId);
      expect("recoveryDriver" in exposed).toBe(false);
      expect("finalizePriorBootAttempt" in exposed).toBe(false);
      await store.close();

      store = openSqliteControlStore(storeOptions(root));
      await expect(store.getUnfinishedReadbackAttempt({
        managementTenantId: tenant,
        attemptId: request.attemptId,
      })).resolves.toEqual(claim.attempt);
      const before = await store.getControlState();
      await expect(store.finalizeReadbackAndComplete({
        attemptId: request.attemptId,
        ownerCapability: Object.freeze(Object.create(null)) as ReadbackAttemptOwnerCapability,
        observation: verifiedObservation(),
        finalResult: verifiedFinalResult(),
        finalizedAt: "2099-08-23T00:06:00Z",
      })).rejects.toMatchObject({ code: "conflict" });
      await expect(store.getControlState()).resolves.toEqual(before);
      await store.close();
    });

    it.each([
      {
        name: "tenant",
        expectedCode: "tenant_mismatch",
        mutate: (request: ClaimReadbackAttemptRequest): ClaimReadbackAttemptRequest => ({
          ...request,
          metadata: { ...request.metadata, managementTenantId: "tenant_other" },
        }),
      },
      {
        name: "release",
        expectedCode: "not_found",
        mutate: (request: ClaimReadbackAttemptRequest): ClaimReadbackAttemptRequest => ({
          ...request,
          releaseId: "release_other",
        }),
      },
      {
        name: "revision",
        expectedCode: "conflict",
        mutate: (request: ClaimReadbackAttemptRequest): ClaimReadbackAttemptRequest => ({
          ...request,
          revision: 2,
        }),
      },
      {
        name: "desired-module",
        expectedCode: "conflict",
        mutate: (request: ClaimReadbackAttemptRequest): ClaimReadbackAttemptRequest => ({
          ...request,
          desiredModules: [{
            moduleId: "quote",
            version: "2.0.0",
            descriptorDigest: `sha256:${"9".repeat(64)}`,
          }],
        }),
      },
    ])("rejects a $name lineage mismatch without an attempt row", async ({ mutate, expectedCode }) => {
      const root = makeRoot();
      const store = await seedPublishedStore(root);
      const request = mutate(claimRequest());
      const before = await store.getControlState();

      await expect(store.claimReadbackAttempt(request)).rejects.toMatchObject({
        code: expectedCode,
      });
      await expect(store.getControlState()).resolves.toEqual(before);
      await expect(store.listUnfinishedReadbackAttempts()).resolves.toEqual([]);
      await store.close();
    });

    it("rejects altered attempt and readback lineage under an existing key", async () => {
      const root = makeRoot();
      const store = await seedPublishedStore(root);
      const claim = await claimCreated(store);
      const before = await store.getControlState();

      await expect(store.claimReadbackAttempt({
        ...claimRequest(),
        attemptId: "attempt_release_changed",
        readbackRef: "readback_attempt_changed",
      })).rejects.toMatchObject({ code: "conflict" });
      await expect(store.getControlState()).resolves.toEqual(before);
      await expect(store.listUnfinishedReadbackAttempts()).resolves.toEqual([claim.attempt]);
      await store.close();
    });
  });

  describe("concurrent claim, finalize, and replay", () => {
    it("returns one created claim and one existing replay for concurrent same-key claims", async () => {
      const root = makeRoot();
      const store = await seedPublishedStore(root);
      const request = claimRequest();
      const claims = await Promise.all([
        store.claimReadbackAttempt(request),
        store.claimReadbackAttempt(request),
      ]);
      expect(claims.map((claim) => claim.disposition).sort()).toEqual([
        "created",
        "existing",
      ]);
      const created = claims.find((claim) => claim.disposition === "created");
      if (created?.disposition !== "created") throw new Error("missing created claim");
      const replay = await store.claimReadbackAttempt(request);
      expect(replay).toEqual({ disposition: "existing", attempt: created.attempt });

      await expect(store.claimReadbackAttempt({
        ...request,
        metadata: {
          ...request.metadata,
          requestHash: `mcp-control-hash/v1/request/sha256:${"a".repeat(64)}`,
        },
      })).rejects.toMatchObject({ code: "conflict" });

      const finalizeRequest = {
        attemptId: created.attempt.attemptId,
        ownerCapability: created.ownerCapability,
        observation: verifiedObservation(),
        finalResult: verifiedFinalResult(),
        finalizedAt: "2099-08-23T00:06:00Z",
      };
      const finalizations = await Promise.allSettled([
        store.finalizeReadbackAndComplete(finalizeRequest),
        store.finalizeReadbackAndComplete(finalizeRequest),
      ]);
      const fulfilled = finalizations.filter((result) => result.status === "fulfilled");
      const rejected = finalizations.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        status: "rejected",
        reason: { code: "conflict" },
      });

      const state = await store.getControlState();
      expect(state.events.filter((event) => event.kind === "reconciliation")).toHaveLength(1);
      expect(state.events.filter(
        (event) => event.kind === "idempotency" && event.action === "deployments.publish",
      )).toHaveLength(1);
      await expect(store.getReadback({
        managementTenantId: tenant,
        releaseId: request.releaseId,
      })).resolves.toMatchObject({
        attemptId: request.attemptId,
        status: "verified",
      });
      await store.close();

      const database = new DatabaseSync(databasePath(root));
      try {
        expect(database.prepare("SELECT COUNT(*) AS count FROM module_readback_attempts").get())
          .toEqual({ count: 1 });
        expect(database.prepare("SELECT COUNT(*) AS count FROM module_readbacks").get())
          .toEqual({ count: 1 });
      } finally {
        database.close();
      }
    });

    it("allows only one lineage when different attempt IDs race for the same release and key", async () => {
      const root = makeRoot();
      const store = await seedPublishedStore(root);
      const firstRequest = claimRequest();
      const secondRequest = {
        ...claimRequest(),
        attemptId: "attempt_release_racing_002",
        readbackRef: "readback_attempt_racing_002",
      } satisfies ClaimReadbackAttemptRequest;
      const results = await Promise.allSettled([
        store.claimReadbackAttempt(firstRequest),
        store.claimReadbackAttempt(secondRequest),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        status: "rejected",
        reason: { code: "conflict" },
      });
      if (fulfilled[0]?.status !== "fulfilled" || fulfilled[0].value.disposition !== "created") {
        throw new Error("race did not leave one created owner");
      }
      await expect(store.listUnfinishedReadbackAttempts()).resolves.toEqual([
        fulfilled[0].value.attempt,
      ]);
      await store.finalizeReadbackAndComplete({
        attemptId: fulfilled[0].value.attempt.attemptId,
        ownerCapability: fulfilled[0].value.ownerCapability,
        observation: verifiedObservation(),
        finalResult: verifiedFinalResult(),
        finalizedAt: "2099-08-23T00:06:00Z",
      });
      await store.close();
    });
  });

  describe("terminal projection, history, reopen, and canonical clock", () => {
    it.each(["verified", "mismatch", "unknown"] as const)(
      "persists an exact terminal-only %s current projection",
      async (status) => {
        const root = makeRoot();
        const store = await seedPublishedStore(root);
        const claim = await claimCreated(store);
        await expect(store.getReadback({
          managementTenantId: tenant,
          releaseId: claim.attempt.releaseId,
        })).resolves.toBeNull();

        const finalized = await store.finalizeReadbackAndComplete({
          attemptId: claim.attempt.attemptId,
          ownerCapability: claim.ownerCapability,
          observation: terminalObservation(status, "2099-08-23T00:05:00Z"),
          finalResult: terminalFinalResult({
            action: "deployments.publish",
            status,
            requestId: "request_publish_attempt",
            traceId: "trace_publish_attempt",
            auditId: "audit_publish_attempt",
          }),
          finalizedAt: "2099-08-23T00:06:00Z",
        });
        expect(finalized.readback).toMatchObject({
          attemptId: claim.attempt.attemptId,
          status,
        });
        expect(finalized.release.status).toBe(
          status === "verified" ? "active_verified" : "manual_review",
        );
        await expect(store.getReadbackAttemptHistory({
          managementTenantId: tenant,
          releaseId: claim.attempt.releaseId,
        })).resolves.toMatchObject([{
          attemptId: claim.attempt.attemptId,
          terminalStatus: status,
        }]);
        await store.close();

        const database = new DatabaseSync(databasePath(root));
        try {
          expect(database.prepare("SELECT status, attempt_id FROM module_readbacks").get())
            .toEqual({ status, attempt_id: claim.attempt.attemptId });
          expect(database.prepare(
            "SELECT COUNT(*) AS count FROM module_readbacks WHERE status = 'pending'",
          ).get()).toEqual({ count: 0 });
        } finally {
          database.close();
        }

        const reopened = openSqliteControlStore(storeOptions(root));
        await expect(reopened.health()).resolves.toEqual({ ready: true });
        await expect(reopened.getReadback({
          managementTenantId: tenant,
          releaseId: claim.attempt.releaseId,
        })).resolves.toMatchObject({
          attemptId: claim.attempt.attemptId,
          status,
        });
        await reopened.close();
      },
    );

    it("orders immutable history by reconciliation sequence and projects only the latest attempt", async () => {
      const root = makeRoot();
      const store = await seedPublishedStore(root);
      const publishClaim = await claimCreated(store);
      const first = await store.finalizeReadbackAndComplete({
        attemptId: publishClaim.attempt.attemptId,
        ownerCapability: publishClaim.ownerCapability,
        observation: terminalObservation("mismatch", "2099-08-23T00:05:00Z"),
        finalResult: terminalFinalResult({
          action: "deployments.publish",
          status: "mismatch",
          requestId: "request_publish_attempt",
          traceId: "trace_publish_attempt",
          auditId: "audit_publish_attempt",
        }),
        finalizedAt: "2099-08-23T00:06:00Z",
      });

      const unknownRequest = reconcileClaimRequest({
        suffix: "history_unknown",
        hashCharacter: "b",
        claimedAt: "2099-08-23T00:07:00Z",
      });
      const unknownClaim = await claimCreated(store, unknownRequest);
      const second = await store.finalizeReadbackAndComplete({
        attemptId: unknownClaim.attempt.attemptId,
        ownerCapability: unknownClaim.ownerCapability,
        observation: terminalObservation("unknown", "2099-08-23T00:08:00Z"),
        finalResult: terminalFinalResult({
          action: "deployments.reconcile",
          status: "unknown",
          requestId: unknownRequest.metadata.requestId,
          traceId: unknownRequest.metadata.traceId,
          auditId: unknownRequest.metadata.auditId,
        }),
        finalizedAt: "2099-08-23T00:09:00Z",
      });

      const verifiedRequest = reconcileClaimRequest({
        suffix: "history_verified",
        hashCharacter: "c",
        claimedAt: "2099-08-23T00:10:00Z",
      });
      const verifiedClaim = await claimCreated(store, verifiedRequest);
      const third = await store.finalizeReadbackAndComplete({
        attemptId: verifiedClaim.attempt.attemptId,
        ownerCapability: verifiedClaim.ownerCapability,
        observation: terminalObservation("verified", "2099-08-23T00:11:00Z"),
        finalResult: terminalFinalResult({
          action: "deployments.reconcile",
          status: "verified",
          requestId: verifiedRequest.metadata.requestId,
          traceId: verifiedRequest.metadata.traceId,
          auditId: verifiedRequest.metadata.auditId,
        }),
        finalizedAt: "2099-08-23T00:12:00Z",
      });

      const expectedAttemptIds = [
        third.attempt.attemptId,
        second.attempt.attemptId,
        first.attempt.attemptId,
      ];
      const history = await store.getReadbackAttemptHistory({
        managementTenantId: tenant,
        releaseId: "release_attempt",
        revision: 1,
      });
      expect(history.map((attempt) => attempt.attemptId)).toEqual(expectedAttemptIds);
      expect(history.map((attempt) => attempt.terminalStatus)).toEqual([
        "verified",
        "unknown",
        "mismatch",
      ]);
      expect(history[0]!.reconciliationEventSequence).toBeGreaterThan(
        history[1]!.reconciliationEventSequence!,
      );
      expect(history[1]!.reconciliationEventSequence).toBeGreaterThan(
        history[2]!.reconciliationEventSequence!,
      );
      await expect(store.getReadback({
        managementTenantId: tenant,
        releaseId: "release_attempt",
      })).resolves.toMatchObject({
        attemptId: third.attempt.attemptId,
        status: "verified",
      });
      await store.close();

      const reopened = openSqliteControlStore(storeOptions(root));
      await expect(reopened.health()).resolves.toEqual({ ready: true });
      await expect(reopened.getReadbackAttemptHistory({
        managementTenantId: tenant,
        releaseId: "release_attempt",
        revision: 1,
      })).resolves.toMatchObject(expectedAttemptIds.map((attemptId) => ({ attemptId })));
      await expect(reopened.getReadback({
        managementTenantId: tenant,
        releaseId: "release_attempt",
      })).resolves.toMatchObject({ attemptId: third.attempt.attemptId });
      await reopened.close();
    });

    it("calls the injected finalize clock once and reuses that canonical instant", async () => {
      const root = makeRoot();
      let finalizeClockCalls = 0;
      const canonicalInstant = "2099-08-23T00:06:00.123Z";
      const store = await seedPublishedStore(root, {
        finalizeClock: () => {
          finalizeClockCalls += 1;
          return canonicalInstant;
        },
        finalizeFailpoint: null,
      });
      const claim = await claimCreated(store);

      const finalized = await store.finalizeReadbackAndComplete({
        attemptId: claim.attempt.attemptId,
        ownerCapability: claim.ownerCapability,
        observation: verifiedObservation(),
        finalResult: verifiedFinalResult(),
      });
      expect(finalizeClockCalls).toBe(1);
      expect(finalized.attempt.finalizedAt).toBe(canonicalInstant);
      expect(finalized.reconciliationEvent.occurredAt).toBe(canonicalInstant);
      expect(finalized.completionEvent.occurredAt).toBe(canonicalInstant);
      await store.close();
    });
  });

  describe("finalize transaction failpoints", () => {
    it.each(FINALIZE_FAILPOINTS)(
      "rolls back the complete graph at %s and remains claimed after reopen",
      async (finalizeFailpoint) => {
        const root = makeRoot();
        const store = await seedPublishedStore(root, {
          finalizeClock: () => "2099-08-23T00:06:00Z",
          finalizeFailpoint,
        });
        const claim = await claimCreated(store);
        const before = await store.getControlState();

        await expect(store.finalizeReadbackAndComplete({
          attemptId: claim.attempt.attemptId,
          ownerCapability: claim.ownerCapability,
          observation: verifiedObservation(),
          finalResult: verifiedFinalResult(),
        })).rejects.toMatchObject({ code: "conflict" });
        await expect(store.getControlState()).resolves.toEqual(before);
        await expect(store.getUnfinishedReadbackAttempt({
          managementTenantId: tenant,
          attemptId: claim.attempt.attemptId,
        })).resolves.toEqual(claim.attempt);
        await store.close();

        expectClaimedRollbackState(root, claim.attempt.attemptId);
        const reopened = openSqliteControlStore(storeOptions(root));
        await expect(reopened.health()).resolves.toEqual({ ready: true });
        await expect(reopened.getUnfinishedReadbackAttempt({
          managementTenantId: tenant,
          attemptId: claim.attempt.attemptId,
        })).resolves.toEqual(claim.attempt);
        await expect(reopened.getReadback({
          managementTenantId: tenant,
          releaseId: claim.attempt.releaseId,
        })).resolves.toBeNull();
        await expect(reopened.getIdempotency({
          managementTenantId: tenant,
          action: claim.attempt.action,
          idempotencyKey: claim.attempt.idempotencyKey,
        })).resolves.toMatchObject({
          status: "domain_committed",
          finalResult: null,
        });
        await reopened.close();
      },
    );

    it("keeps the nested test-only options closed and rejects unknown controls", async () => {
      const root = makeRoot();
      await initializeSqliteControlState({
        applicationRoot: root,
        instanceId: "instance_fixture_001",
        managementTenantId: tenant,
      });

      expect(() => openSqliteControlStore({
        ...storeOptions(root),
        testOnly: {
          finalizeClock: () => "2099-08-23T00:06:00Z",
          finalizeFailpoint: null,
          skipHealthCheck: true,
        },
      } as never)).toThrowError(expect.objectContaining({ code: "invalid_options" }));
      expect(() => openSqliteControlStore({
        ...storeOptions(root),
        testOnly: {
          finalizeClock: () => "2099-08-23T00:06:00Z",
          finalizeFailpoint: "skip_validation",
        },
      } as never)).toThrowError(expect.objectContaining({ code: "invalid_options" }));
    });
  });





  it("claims, finalizes, reopens, and projects terminal current/history state", async () => {
    const root = makeRoot();
    const store = await seedPublishedStore(root);
    const request = claimRequest();
    const claimed = await store.claimReadbackAttempt(request);
    expect(claimed.disposition).toBe("created");
    if (claimed.disposition !== "created") throw new Error("claim did not create");
    expect(claimed.attempt.phase).toBe("claimed");
    expect(await store.getReadback({ managementTenantId: tenant, releaseId: request.releaseId })).toBeNull();
    await expect(
      store.getUnfinishedReadbackAttempt({
        managementTenantId: tenant,
        attemptId: request.attemptId,
      }),
    ).resolves.toMatchObject({ phase: "claimed", attemptId: request.attemptId });

    const finalized = await store.finalizeReadbackAndComplete({
      attemptId: request.attemptId,
      ownerCapability: claimed.ownerCapability,
      observation: verifiedObservation(),
      finalResult: verifiedFinalResult(),
      finalizedAt: "2099-08-23T00:06:00Z",
    });
    expect(finalized.disposition).toBe("finalized");
    expect(finalized.attempt.phase).toBe("finalized");
    expect(finalized.attempt.finalizedAt).toBe("2099-08-23T00:06:00Z");
    expect(finalized.reconciliationEvent.occurredAt).toBe(finalized.attempt.finalizedAt);
    expect(finalized.completionEvent.occurredAt).toBe(finalized.attempt.finalizedAt);
    expect(finalized.reconciliationEvent.sequence + 1).toBe(
      finalized.completionEvent.sequence,
    );
    await expect(store.getUnfinishedReadbackAttempt({
      managementTenantId: tenant,
      attemptId: request.attemptId,
    })).resolves.toBeNull();
    await expect(store.getReadback({
      managementTenantId: tenant,
      releaseId: request.releaseId,
    })).resolves.toMatchObject({
      status: "verified",
      attemptId: request.attemptId,
    });
    await expect(store.getReadbackAttemptHistory({
      managementTenantId: tenant,
      releaseId: request.releaseId,
    })).resolves.toMatchObject([
      { attemptId: request.attemptId, phase: "finalized" },
    ]);
    await store.close();

    const reopened = openSqliteControlStore(storeOptions(root));
    await expect(reopened.health()).resolves.toEqual({ ready: true });
    await expect(reopened.getReadback({
      managementTenantId: tenant,
      releaseId: request.releaseId,
    })).resolves.toMatchObject({ status: "verified", attemptId: request.attemptId });
    await expect(reopened.getReadbackAttemptHistory({
      managementTenantId: tenant,
      releaseId: request.releaseId,
    })).resolves.toMatchObject([
      { attemptId: request.attemptId, phase: "finalized" },
    ]);
    await reopened.close();
  });
});
