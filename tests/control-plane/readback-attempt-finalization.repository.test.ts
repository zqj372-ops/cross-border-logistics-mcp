import { describe, expect, it } from "vitest";

import {
  assertReadbackAttemptRecord,
  deepFreezeReadbackAttempt,
} from "../../src/logistics_mcp/control-plane/repository";
import type {
  CanonicalRequestHash,
  FinalizedReadbackAttemptRecord,
  ModuleControlReadbackAttemptRepository,
  ModuleControlRef,
  ReadbackAttemptClaimResult,
  ReadbackAttemptRecord,
} from "../../src/logistics_mcp/control-plane/repository";
import { FakeModuleControlRepository } from "./fake-control-repository";

const requestHash = ("mcp-control-hash/v1/request/sha256:" + "a".repeat(64)) as CanonicalRequestHash;
const descriptorDigest = ("sha256:" + "b".repeat(64)) as ModuleControlRef["descriptorDigest"];

const claimedAttempt = {
  managementTenantId: "tenant_attempt_contract",
  attemptId: "attempt_contract_001",
  action: "deployments.reconcile",
  idempotencyKey: "idem_attempt_contract_001",
  requestHash,
  actorRef: "actor_reconciler",
  requestId: "request_attempt_contract_001",
  traceId: "trace_attempt_contract_001",
  auditId: "audit_attempt_contract_001",
  releaseId: "release_attempt_contract_001",
  revision: 1,
  desiredModules: [
    {
      moduleId: "cargo",
      version: "1.0.0",
      descriptorDigest,
    },
  ],
  readbackRef: "readback_attempt_contract_001",
  ownerBootId: "boot_attempt_contract_001",
  phase: "claimed",
  claimedAt: "2026-08-23T00:00:00.000000000Z",
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
} as const satisfies ReadbackAttemptRecord;

const finalizedAttempt = {
  ...claimedAttempt,
  phase: "finalized",
  finalizedAt: "2026-08-23T00:00:00.000000001Z",
  terminalStatus: "verified",
  appliedReleaseId: claimedAttempt.releaseId,
  appliedRevision: claimedAttempt.revision,
  appliedModules: claimedAttempt.desiredModules,
  checkedAt: "2026-08-23T00:00:00.000000000Z",
  finalizedByActorRef: claimedAttempt.actorRef,
  reconciliationEventSequence: 1,
  completionEventSequence: 2,
} as const satisfies FinalizedReadbackAttemptRecord;

describe("readback attempt repository contract", () => {
  it("keeps the accepted five-method companion separate from the legacy repository", () => {
    const repository: ModuleControlReadbackAttemptRepository =
      new FakeModuleControlRepository({
        managementTenantId: "tenant_attempt_contract",
      });

    expect(typeof repository.claimReadbackAttempt).toBe("function");
    expect(typeof repository.finalizeReadbackAndComplete).toBe("function");
    expect(typeof repository.getUnfinishedReadbackAttempt).toBe("function");
    expect(typeof repository.listUnfinishedReadbackAttempts).toBe("function");
    expect(typeof repository.getReadbackAttemptHistory).toBe("function");
    expect("recoveryDriver" in repository).toBe(false);
  });

  it("deep-freezes the closed claimed attempt shape", () => {
    const frozen = deepFreezeReadbackAttempt(claimedAttempt);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.desiredModules)).toBe(true);
    expect(Object.isFrozen(frozen.appliedModules)).toBe(true);

    const claim: ReadbackAttemptClaimResult = {
      disposition: "existing",
      attempt: frozen,
    };
    expect(claim.disposition).toBe("existing");
  });

  it("narrows finalized attempts to terminal observations and enforces time order", () => {
    const frozen = deepFreezeReadbackAttempt(finalizedAttempt);
    expect(frozen.phase).toBe("finalized");
    expect(frozen.terminalStatus).toBe("verified");
    expect(frozen.finalizedAt).toBe("2026-08-23T00:00:00.000000001Z");

    const invalid = {
      ...finalizedAttempt,
      finalizedAt: "2026-08-22T23:59:59.999999999Z",
    };
    expect(() => assertReadbackAttemptRecord(invalid)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
  });
});
