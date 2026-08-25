import { describe, expect, it } from "vitest";

import {
  ActivationAuthorityError,
  createActivationGate,
} from "../../src/logistics_mcp/control-plane/activation-authority-internal";
import {
  createModuleInventory,
} from "../../src/logistics_mcp/control-plane/inventory";
import type {
  ActiveModuleRef,
  ModuleActivationSnapshot,
  ModuleInventoryInput,
  TrustedModuleInventory,
} from "../../src/logistics_mcp/control-plane/types";

const inventoryInput: ModuleInventoryInput = {
  mountedModules: [
    {
      moduleId: "cargo",
      version: "2026-08-21.v0",
      riskLevel: "T0",
      lifecycle: "static",
      requiredCapabilities: ["audit"],
      optionalCapabilities: [],
      standardRefs: ["module-runtime.v0"],
    },
    {
      moduleId: "container",
      version: "2026-08-21.v0",
      riskLevel: "T0",
      lifecycle: "static",
      requiredCapabilities: ["audit"],
      optionalCapabilities: [],
      standardRefs: ["module-runtime.v0"],
    },
  ],
  catalog: [
    {
      owner: "cargo",
      name: "cargo.calculate",
      permission: "quote:calculate",
      kind: "read",
      riskLevel: "T0",
      inputSchemaId: "urn:input:cargo",
      outputSchemaId: "urn:output:cargo",
      standardRefs: ["module-runtime.v0"],
    },
    {
      owner: "container",
      name: "container.plan_summary",
      permission: "container:calculate",
      kind: "read",
      riskLevel: "T0",
      inputSchemaId: "urn:input:container",
      outputSchemaId: "urn:output:container",
      standardRefs: ["module-runtime.v0"],
    },
  ],
  localEvidence: [
    {
      moduleId: "cargo",
      version: "2026-08-21.v0",
      evidenceRefs: {
        sourceShaRef: null,
        artifactDigestRef: null,
        signatureRef: null,
        sbomRef: null,
        attestationRef: null,
      },
    },
    {
      moduleId: "container",
      version: "2026-08-21.v0",
      evidenceRefs: {
        sourceShaRef: null,
        artifactDigestRef: null,
        signatureRef: null,
        sbomRef: null,
        attestationRef: null,
      },
    },
  ],
};

function inventory(): TrustedModuleInventory {
  return createModuleInventory(inventoryInput);
}

function refsFor(value: TrustedModuleInventory): readonly ActiveModuleRef[] {
  return value.map((entry) => ({
    moduleId: entry.moduleId,
    version: entry.version,
    descriptorDigest: entry.descriptorDigest,
  }));
}

function candidate(
  refs: readonly ActiveModuleRef[],
  revision = 1,
  releaseId = "release_one",
): ModuleActivationSnapshot {
  return {
    releaseId,
    revision,
    activeModules: refs.map((ref) => ({ ...ref })),
  };
}

function expectAuthorityCode(
  action: () => unknown,
  code: ActivationAuthorityError["code"],
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ActivationAuthorityError);
  expect((thrown as ActivationAuthorityError | undefined)?.code).toBe(code);
}

function restoreEvidence(refs: readonly ActiveModuleRef[]) {
  const desiredModules = refs.map((ref) => ({ ...ref }));
  const release = {
    managementTenantId: "tenant_control",
    releaseId: "release_restored",
    revision: 7,
    desiredModules,
    previousReleaseId: "release_previous",
    previewRef: "preview_restored",
    approvalId: "approval_restored",
    publisherActorRef: "actor_publisher",
    createdAt: "2026-08-25T00:00:00.000000000Z",
    publishedAt: "2026-08-25T00:00:01.000000000Z",
    status: "active_verified" as const,
    readbackRef: "readback_restored",
    reasonCodes: [] as const,
    supersededByReleaseId: null,
  };
  const attempt = {
    managementTenantId: "tenant_control",
    attemptId: "attempt_restored",
    action: "deployments.publish" as const,
    idempotencyKey: "idempotency_restored",
    requestHash: `mcp-control-hash/v1/request/sha256:${"a".repeat(64)}`,
    actorRef: "actor_publisher",
    requestId: "request_restored",
    traceId: "trace_restored",
    auditId: "audit_restored",
    releaseId: "release_restored",
    revision: 7,
    desiredModules,
    readbackRef: "readback_restored",
    ownerBootId: "boot_restored",
    phase: "finalized" as const,
    claimedAt: "2026-08-25T00:00:01.000000000Z",
    finalizedAt: "2026-08-25T00:00:03.000000000Z",
    terminalStatus: "verified" as const,
    appliedReleaseId: "release_restored",
    appliedRevision: 7,
    appliedModules: desiredModules,
    reasonCodes: [] as const,
    checkedAt: "2026-08-25T00:00:02.000000000Z",
    finalizedByActorRef: "actor_publisher",
    reconciliationEventSequence: 10,
    completionEventSequence: 11,
  };
  const readback = {
    managementTenantId: "tenant_control",
    readbackRef: "readback_restored",
    releaseId: "release_restored",
    attemptId: "attempt_restored",
    revision: 7,
    appliedReleaseId: "release_restored",
    appliedRevision: 7,
    appliedModules: desiredModules,
    status: "verified" as const,
    reasonCodes: [] as const,
    checkedAt: "2026-08-25T00:00:02.000000000Z",
  };
  return { release, readback, attempt };
}

describe("service-private activation authority", () => {
  it("creates an empty read facade and keeps the mutation driver off the registry", () => {
    const gate = createActivationGate(inventory());

    expect(gate.readFacade.snapshot()).toEqual({
      releaseId: null,
      revision: 0,
      activeModules: [],
    });
    expect(Reflect.ownKeys(gate.readFacade).sort()).toEqual([
      "isActive",
      "snapshot",
    ]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(gate.readFacade)).sort()).toEqual([
      "constructor",
      "isActive",
      "snapshot",
    ]);
    expect(Object.isFrozen(gate.readFacade)).toBe(true);
    expect(Object.isFrozen(gate.privateDriver)).toBe(true);
    expect(Object.isFrozen(gate.recoveryDriver)).toBe(true);
    expect(Object.isFrozen(gate)).toBe(true);
    expect("restoreVerified" in gate.privateDriver).toBe(false);
    expect(Reflect.ownKeys(gate.recoveryDriver).sort()).toEqual([
      "restoreVerified",
      "verifyRestoreEvidence",
    ]);
  });

  it("rejects invalid or parallel stages without changing the served snapshot", () => {
    const gate = createActivationGate(inventory());
    const refs = refsFor(inventory());
    const before = gate.readFacade.snapshot();

    expectAuthorityCode(
      () => gate.privateDriver.stageCandidate(candidate([])),
      "candidate_invalid",
    );
    expectAuthorityCode(
      () => gate.privateDriver.stageCandidate({
        releaseId: "release_one",
        revision: 0,
        activeModules: [refs[0]],
      }),
      "revision_invalid",
    );
    expectAuthorityCode(
      () => gate.privateDriver.stageCandidate({
        releaseId: null,
        revision: 1,
        activeModules: [refs[0]],
      }),
      "release_id_invalid",
    );
    expectAuthorityCode(
      () => gate.privateDriver.stageCandidate({
        releaseId: "release_one",
        revision: 1,
        activeModules: [refs[0], refs[0]],
      }),
      "candidate_invalid",
    );
    expectAuthorityCode(
      () => gate.privateDriver.stageCandidate({
        releaseId: "release_one",
        revision: 1,
        activeModules: [{ ...refs[0], descriptorDigest: `sha256:${"f".repeat(64)}` }],
      }),
      "inventory_mismatch",
    );

    const handle = gate.privateDriver.stageCandidate(candidate([refs[0]!], 1));
    expect(gate.readFacade.snapshot()).toBe(before);
    expectAuthorityCode(
      () => gate.privateDriver.stageCandidate(candidate([refs[1]!], 2)),
      "stage_in_progress",
    );
    gate.privateDriver.abortCandidate(handle);
    expect(gate.readFacade.snapshot()).toBe(before);
  });

  it("hands the trusted adapter a detached frozen candidate and commits only exact verified readback", () => {
    const gate = createActivationGate(inventory());
    const refs = refsFor(inventory());
    const input = candidate([refs[0]!], 1);
    const handle = gate.privateDriver.stageCandidate(input);

    (input.activeModules[0] as { moduleId: string }).moduleId = "forged";
    const staged = gate.privateDriver.candidateSnapshot(handle);
    expect(staged).toEqual(candidate([refs[0]!], 1));
    expect(Object.isFrozen(staged)).toBe(true);
    expect(Object.isFrozen(staged.activeModules)).toBe(true);
    expect(Object.isFrozen(staged.activeModules[0])).toBe(true);
    expect(gate.readFacade.snapshot().revision).toBe(0);

    const observed = {
      status: "verified" as const,
      releaseId: staged.releaseId,
      revision: staged.revision,
      activeModules: staged.activeModules.map((ref) => ({ ...ref })),
    };
    const proof = gate.privateDriver.verifyCandidate(handle, observed);
    observed.activeModules[0]!.moduleId = "forged_after_verify";
    gate.privateDriver.commitCandidate(proof);

    expect(gate.readFacade.snapshot()).toEqual(candidate([refs[0]!], 1));
    expect(gate.readFacade.isActive(refs[0]!)).toBe(true);
    expect(Object.isFrozen(gate.readFacade.snapshot().activeModules[0])).toBe(true);
    expectAuthorityCode(
      () => gate.privateDriver.commitCandidate(proof),
      "proof_invalid",
    );
    expectAuthorityCode(
      () => gate.privateDriver.candidateSnapshot(handle),
      "stage_invalid",
    );
  });

  it("does not issue a proof for mismatch, unknown, malformed, or borrowed observations", () => {
    const gate = createActivationGate(inventory());
    const refs = refsFor(inventory());
    const handle = gate.privateDriver.stageCandidate(candidate([refs[0]!], 1));

    for (const observed of [
      {
        status: "mismatch",
        releaseId: "release_one",
        revision: 1,
        activeModules: [refs[0]],
      },
      {
        status: "unknown",
        releaseId: null,
        revision: null,
        activeModules: [],
      },
      {
        status: "verified",
        releaseId: "release_other",
        revision: 1,
        activeModules: [refs[0]],
      },
      {
        status: "verified",
        releaseId: "release_one",
        revision: 1,
        activeModules: [refs[1]],
      },
    ]) {
      expectAuthorityCode(
        () => gate.privateDriver.verifyCandidate(handle, observed),
        "readback_invalid",
      );
    }
    expect(gate.readFacade.snapshot().revision).toBe(0);
    gate.privateDriver.abortCandidate(handle);

    const borrowed = gate.privateDriver.verifyCandidate;
    expectAuthorityCode(
      () => Reflect.apply(borrowed, {}, [handle, candidate([refs[0]!], 1)]),
      "driver_invalid",
    );
  });

  it("binds handles and proofs to the driver instance and rejects clones, proxies, and fake proofs", () => {
    const first = createActivationGate(inventory());
    const second = createActivationGate(inventory());
    const ref = refsFor(inventory())[0]!;
    const handle = first.privateDriver.stageCandidate(candidate([ref]));
    const proof = first.privateDriver.verifyCandidate(handle, candidate([ref]));

    expectAuthorityCode(
      () => second.privateDriver.commitCandidate(proof),
      "proof_invalid",
    );
    expectAuthorityCode(
      () => first.privateDriver.commitCandidate({ ...proof }),
      "proof_invalid",
    );
    expectAuthorityCode(
      () => first.privateDriver.commitCandidate(new Proxy(proof, {})),
      "proof_invalid",
    );
    expectAuthorityCode(
      () => first.privateDriver.commitCandidate(
        Object.freeze({}) as never,
      ),
      "proof_invalid",
    );
    expectAuthorityCode(
      () => second.privateDriver.candidateSnapshot(handle),
      "stage_invalid",
    );
    expectAuthorityCode(
      () => first.privateDriver.candidateSnapshot(new Proxy(handle, {})),
      "stage_invalid",
    );

    const borrowedCommit = first.privateDriver.commitCandidate;
    expectAuthorityCode(
      () => Reflect.apply(borrowedCommit, {}, [proof]),
      "driver_invalid",
    );
    expect(first.readFacade.snapshot().revision).toBe(0);
    first.privateDriver.commitCandidate(proof);
    expect(first.readFacade.snapshot().revision).toBe(1);
    expect(second.readFacade.snapshot().revision).toBe(0);
  });

  it("aborting an old handle cannot cancel a later stage", () => {
    const gate = createActivationGate(inventory());
    const refs = refsFor(inventory());
    const first = gate.privateDriver.stageCandidate(candidate([refs[0]!], 1));
    gate.privateDriver.abortCandidate(first);
    const second = gate.privateDriver.stageCandidate(candidate([refs[1]!], 1));

    expectAuthorityCode(
      () => gate.privateDriver.abortCandidate(first),
      "stage_invalid",
    );
    expect(gate.privateDriver.candidateSnapshot(second).activeModules).toEqual([refs[1]]);
    gate.privateDriver.abortCandidate(second);
    expect(gate.readFacade.snapshot()).toEqual({
      releaseId: null,
      revision: 0,
      activeModules: [],
    });
  });

  it("restores a nonempty exact-ref inventory subset and leaves other modules inactive", () => {
    const sourceInventory = inventory();
    const gate = createActivationGate(sourceInventory);
    const refs = refsFor(sourceInventory);
    const evidence = restoreEvidence([refs[0]!]);
    const before = gate.readFacade.snapshot();

    const proof = gate.recoveryDriver.verifyRestoreEvidence(evidence);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(gate.readFacade.snapshot()).toBe(before);
    gate.recoveryDriver.restoreVerified(proof);
    expect(gate.readFacade.snapshot()).toEqual({
      releaseId: "release_restored",
      revision: 7,
      activeModules: [refs[0]],
    });
    expect(gate.readFacade.isActive(refs[0]!)).toBe(true);
    expect(gate.readFacade.isActive(refs[1]!)).toBe(false);
    expect(Object.isFrozen(gate.readFacade.snapshot())).toBe(true);
    expect(Object.isFrozen(gate.readFacade.snapshot().activeModules)).toBe(true);
  });

  it("rejects inconsistent restore graphs, event gaps, and inventory drift without changing the snapshot", () => {
    const sourceInventory = inventory();
    const refs = refsFor(sourceInventory);
    const evidence = restoreEvidence([refs[0]!]);

    for (const invalid of [
      { ...evidence, release: { ...evidence.release, status: "manual_review" } },
      { ...evidence, readback: { ...evidence.readback, status: "mismatch" } },
      { ...evidence, readback: { ...evidence.readback, status: "unknown" } },
      { ...evidence, readback: { ...evidence.readback, attemptId: "attempt_other" } },
      { ...evidence, readback: { ...evidence.readback, releaseId: "release_other" } },
      { ...evidence, readback: { ...evidence.readback, checkedAt: "2026-08-25T00:00:03.000000000Z" } },
      { ...evidence, attempt: { ...evidence.attempt, revision: 8 } },
      { ...evidence, attempt: { ...evidence.attempt, desiredModules: [refs[1]] } },
      { ...evidence, attempt: { ...evidence.attempt, checkedAt: "2026-08-25T00:00:04.000000000Z" } },
      {
        ...evidence,
        readback: {
          ...evidence.readback,
          checkedAt: "2026-08-25T00:00:04.000000000Z",
        },
        attempt: {
          ...evidence.attempt,
          checkedAt: "2026-08-25T00:00:04.000000000Z",
          finalizedAt: "2026-08-25T00:00:03.000000000Z",
        },
      },
      {
        ...evidence,
        attempt: {
          ...evidence.attempt,
          completionEventSequence: 12,
        },
      },
      {
        ...evidence,
        readback: {
          ...evidence.readback,
          checkedAt: "2026-08-25T00:00:00.500000000Z",
        },
        attempt: {
          ...evidence.attempt,
          checkedAt: "2026-08-25T00:00:00.500000000Z",
        },
      },
      {
        ...evidence,
        attempt: {
          ...evidence.attempt,
          claimedAt: "2026-08-25T00:00:00.500000000Z",
        },
      },
      {
        ...evidence,
        release: { ...evidence.release, managementTenantId: " " },
        readback: { ...evidence.readback, managementTenantId: " " },
        attempt: { ...evidence.attempt, managementTenantId: " " },
      },
    ]) {
      const fresh = createActivationGate(sourceInventory);
      const before = fresh.readFacade.snapshot();
      expectAuthorityCode(
        () => fresh.recoveryDriver.verifyRestoreEvidence(invalid),
        "restore_invalid",
      );
      expect(fresh.readFacade.snapshot()).toBe(before);
    }

    const unknownRef = {
      ...refs[0]!,
      descriptorDigest: `sha256:${"f".repeat(64)}` as const,
    };
    const unknownGate = createActivationGate(sourceInventory);
    const unknownBefore = unknownGate.readFacade.snapshot();
    expectAuthorityCode(
      () => unknownGate.recoveryDriver.verifyRestoreEvidence(
        restoreEvidence([unknownRef]),
      ),
      "inventory_mismatch",
    );
    expect(unknownGate.readFacade.snapshot()).toBe(unknownBefore);

    const driftedInventory = createModuleInventory({
      ...inventoryInput,
      mountedModules: inventoryInput.mountedModules.map((module) =>
        module.moduleId === "cargo"
          ? { ...module, version: "2026-08-21.v1" }
          : module,
      ),
      localEvidence: inventoryInput.localEvidence.map((evidenceEntry) =>
        evidenceEntry.moduleId === "cargo"
          ? { ...evidenceEntry, version: "2026-08-21.v1" }
          : evidenceEntry,
      ),
    });
    const driftedGate = createActivationGate(driftedInventory);
    const driftedBefore = driftedGate.readFacade.snapshot();
    expectAuthorityCode(
      () => driftedGate.recoveryDriver.verifyRestoreEvidence(evidence),
      "inventory_mismatch",
    );
    expect(driftedGate.readFacade.snapshot()).toBe(driftedBefore);
  });

  it("requires an instance-bound one-use restore proof and rejects plain, cloned, proxied, cross-gate, and borrowed authority", () => {
    const sourceInventory = inventory();
    const refs = refsFor(sourceInventory);
    const evidence = restoreEvidence([refs[0]!]);
    const gate = createActivationGate(sourceInventory);
    const otherGate = createActivationGate(sourceInventory);
    const before = gate.readFacade.snapshot();
    const proof = gate.recoveryDriver.verifyRestoreEvidence(evidence);

    expectAuthorityCode(
      () => gate.recoveryDriver.restoreVerified(evidence as never),
      "restore_proof_invalid",
    );
    expectAuthorityCode(
      () => gate.recoveryDriver.restoreVerified({ ...proof }),
      "restore_proof_invalid",
    );
    expectAuthorityCode(
      () => otherGate.recoveryDriver.restoreVerified(proof),
      "restore_proof_invalid",
    );

    let proofTrapCount = 0;
    const proxiedProof = new Proxy(proof, {
      get() {
        proofTrapCount += 1;
        throw new Error("restore proof trap must not run");
      },
    });
    expectAuthorityCode(
      () => gate.recoveryDriver.restoreVerified(proxiedProof),
      "restore_proof_invalid",
    );
    expect(proofTrapCount).toBe(0);

    const borrowedRestore = gate.recoveryDriver.restoreVerified;
    expectAuthorityCode(
      () => Reflect.apply(borrowedRestore, {}, [proof]),
      "driver_invalid",
    );
    expect(gate.readFacade.snapshot()).toBe(before);
    expect(otherGate.readFacade.snapshot().revision).toBe(0);

    gate.recoveryDriver.restoreVerified(proof);
    expect(gate.readFacade.snapshot().revision).toBe(7);
    expectAuthorityCode(
      () => gate.recoveryDriver.restoreVerified(proof),
      "restore_proof_invalid",
    );
  });

  it("rejects recovery after live staging or prior restore and refuses evidence proxies without traps", () => {
    const sourceInventory = inventory();
    const refs = refsFor(sourceInventory);
    const evidence = restoreEvidence([refs[0]!]);
    const stagedGate = createActivationGate(sourceInventory);
    const handle = stagedGate.privateDriver.stageCandidate(candidate([refs[0]!], 1));
    expectAuthorityCode(
      () => stagedGate.recoveryDriver.verifyRestoreEvidence(evidence),
      "restore_invalid",
    );
    stagedGate.privateDriver.abortCandidate(handle);

    const restoredGate = createActivationGate(sourceInventory);
    const proof = restoredGate.recoveryDriver.verifyRestoreEvidence(evidence);
    restoredGate.recoveryDriver.restoreVerified(proof);
    expectAuthorityCode(
      () => restoredGate.recoveryDriver.verifyRestoreEvidence(evidence),
      "restore_invalid",
    );

    let trapCount = 0;
    const proxiedEvidence = new Proxy(evidence, {
      get() {
        trapCount += 1;
        throw new Error("restore input trap must not run");
      },
      getPrototypeOf() {
        trapCount += 1;
        throw new Error("restore input trap must not run");
      },
      ownKeys() {
        trapCount += 1;
        throw new Error("restore input trap must not run");
      },
    });
    const fresh = createActivationGate(sourceInventory);
    expectAuthorityCode(
      () => fresh.recoveryDriver.verifyRestoreEvidence(proxiedEvidence),
      "restore_invalid",
    );
    expect(trapCount).toBe(0);
    expect(fresh.readFacade.snapshot().revision).toBe(0);
  });
});
