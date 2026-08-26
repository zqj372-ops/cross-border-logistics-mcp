import { describe, expect, it, vi } from "vitest";

import { createModuleInventory } from "../../src/logistics_mcp/control-plane/inventory";
import {
  createModuleControlRuntimeAssembly,
  type ModuleControlRuntimeAssembly,
  type ModuleControlRuntimeAssemblyOptions,
} from "../../src/logistics_mcp/control-plane/service";
import type {
  ActiveModuleRef,
  ModuleInventoryInput,
} from "../../src/logistics_mcp/control-plane/types";
import { FakeModuleControlRepository } from "./fake-control-repository";

const MANAGEMENT_TENANT_ID = "tenant_control";

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

const inventory = createModuleInventory(inventoryInput);
const inventoryRefs = inventory.map((entry) => ({
  moduleId: entry.moduleId,
  version: entry.version,
  descriptorDigest: entry.descriptorDigest,
}));

function restoreEvidence(desiredModules: readonly ActiveModuleRef[]) {
  const modules = desiredModules.map((module) => ({ ...module }));
  const release = {
    managementTenantId: MANAGEMENT_TENANT_ID,
    releaseId: "release_restored",
    revision: 7,
    desiredModules: modules,
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
  const readback = {
    managementTenantId: MANAGEMENT_TENANT_ID,
    readbackRef: "readback_restored",
    releaseId: "release_restored",
    attemptId: "attempt_restored",
    revision: 7,
    appliedReleaseId: "release_restored",
    appliedRevision: 7,
    appliedModules: modules,
    status: "verified" as const,
    reasonCodes: [] as const,
    checkedAt: "2026-08-25T00:00:02.000000000Z",
  };
  const attempt = {
    managementTenantId: MANAGEMENT_TENANT_ID,
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
    desiredModules: modules,
    readbackRef: "readback_restored",
    ownerBootId: "boot_restored",
    phase: "finalized" as const,
    claimedAt: "2026-08-25T00:00:01.000000000Z",
    finalizedAt: "2026-08-25T00:00:03.000000000Z",
    terminalStatus: "verified" as const,
    appliedReleaseId: "release_restored",
    appliedRevision: 7,
    appliedModules: modules,
    reasonCodes: [] as const,
    checkedAt: "2026-08-25T00:00:02.000000000Z",
    finalizedByActorRef: "actor_publisher",
    reconciliationEventSequence: 10,
    completionEventSequence: 11,
  };
  return { release, readback, attempt };
}

function assemblyOptions(
  activationRestoreEvidence?: unknown,
): ModuleControlRuntimeAssemblyOptions {
  return {
    inventory,
    repository: new FakeModuleControlRepository({
      managementTenantId: MANAGEMENT_TENANT_ID,
    }),
    managementTenantId: MANAGEMENT_TENANT_ID,
    previewTtlSeconds: 900,
    clock: vi.fn(() => "2026-08-25T01:00:00.000000000Z"),
    idGenerator: vi.fn(() => "unused_generated_id"),
    ...(activationRestoreEvidence === undefined
      ? {}
      : { activationRestoreEvidence }),
  };
}

function createAssembly(
  activationRestoreEvidence?: unknown,
): ModuleControlRuntimeAssembly {
  return createModuleControlRuntimeAssembly(
    assemblyOptions(activationRestoreEvidence),
  );
}

function captureAssemblyFailure(evidence: unknown): unknown {
  let assembly: ModuleControlRuntimeAssembly | undefined;
  let thrown: unknown;
  try {
    assembly = createAssembly(evidence);
  } catch (error: unknown) {
    thrown = error;
  }
  expect(assembly).toBeUndefined();
  return thrown;
}

describe("module control runtime activation restore", () => {
  it("restores an active_verified release from exact terminal readback and finalized attempt evidence", () => {
    const restoredRef = inventoryRefs[0]!;
    const assembly = createAssembly(restoreEvidence([restoredRef]));

    expect(assembly.activation.snapshot()).toEqual({
      releaseId: "release_restored",
      revision: 7,
      activeModules: [restoredRef],
    });
  });

  it("fails assembly closed for malformed, contradictory, drifted, proxied, and forged evidence", () => {
    const valid = restoreEvidence([inventoryRefs[0]!]);
    const missingAttempt = {
      release: valid.release,
      readback: valid.readback,
    };
    const contradictory = {
      ...valid,
      readback: { ...valid.readback, releaseId: "release_other" },
    };
    const driftedRef = {
      ...inventoryRefs[0]!,
      descriptorDigest: `sha256:${"f".repeat(64)}` as const,
    };
    const drifted = restoreEvidence([driftedRef]);

    for (const [evidence, code] of [
      [missingAttempt, "restore_invalid"],
      [contradictory, "restore_invalid"],
      [drifted, "inventory_mismatch"],
      [Object.freeze({}), "restore_invalid"],
    ] as const) {
      expect(captureAssemblyFailure(evidence)).toMatchObject({ code });
    }

    let trapCount = 0;
    const proxy = new Proxy(valid, {
      get() {
        trapCount += 1;
        throw new Error("restore evidence getter must not run");
      },
      getPrototypeOf() {
        trapCount += 1;
        throw new Error("restore evidence prototype trap must not run");
      },
      ownKeys() {
        trapCount += 1;
        throw new Error("restore evidence ownKeys trap must not run");
      },
    });
    expect(captureAssemblyFailure(proxy)).toMatchObject({
      code: "restore_invalid",
    });
    expect(trapCount).toBe(0);
  });

  it("keeps the public assembly capability-minimal and preserves the empty default", () => {
    const assembly = createAssembly();

    expect(assembly.activation.snapshot()).toEqual({
      releaseId: null,
      revision: 0,
      activeModules: [],
    });
    expect(Reflect.ownKeys(assembly).sort()).toEqual([
      "activation",
      "dispatch",
      "service",
    ]);
    for (const surface of [
      assembly,
      assembly.activation,
      assembly.dispatch,
      assembly.service,
    ]) {
      expect("recoveryDriver" in surface).toBe(false);
      expect("privateDriver" in surface).toBe(false);
    }
  });

  it("allows controlled dispatch only for the restored exact module ref", async () => {
    const restoredRef = inventoryRefs[0]!;
    const inactiveRef = inventoryRefs[1]!;
    const assembly = createAssembly(restoreEvidence([restoredRef]));
    const restoredHandler = vi.fn(() => "restored");
    const inactiveHandler = vi.fn(() => "must-not-run");

    await expect(
      assembly.dispatch.dispatch(restoredRef, restoredHandler),
    ).resolves.toBe("restored");
    await expect(
      assembly.dispatch.dispatch(inactiveRef, inactiveHandler),
    ).rejects.toMatchObject({ code: "module_not_active" });
    expect(restoredHandler).toHaveBeenCalledOnce();
    expect(inactiveHandler).not.toHaveBeenCalled();
  });
});
