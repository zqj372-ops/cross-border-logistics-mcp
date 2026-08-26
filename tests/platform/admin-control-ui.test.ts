import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  actionAvailability,
  CONTROL_SCHEMA_VERSION,
  createControlPlaneClient,
  deriveDesiredDraftDiff,
  derivePreviewPresentation,
  deriveReleaseStages,
  isFixtureIdentityVisible,
  isPreviewUsable,
  redactReference,
  selectReconcileReleaseId,
  selectRollbackReleaseId,
  validateControlState,
} from "../../apps/admin/control-plane.js";

const descriptorDigest = `sha256:${"a".repeat(64)}`;
const PREVIEW_ACTIVE_NOW_MS = Date.parse("2026-08-26T00:02:00Z");

function availabilityAtPreviewTime(
  input: Omit<Parameters<typeof actionAvailability>[0], "nowMs">,
) {
  return actionAvailability({ ...input, nowMs: PREVIEW_ACTIVE_NOW_MS });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const validControlState = {
  kind: "control_state",
  activation: {
    state: "active",
    release_id: "release-1",
    revision: 3,
    active_modules: [
      {
        module_id: "cargo",
        version: "1.0.0",
        descriptor_digest: descriptorDigest,
      },
    ],
  },
  inventory_modules: [
    {
      module_id: "cargo",
      version: "1.0.0",
      risk_level: "T0",
      descriptor_digest: descriptorDigest,
      evidence_level: "local_build",
      production_eligible: false,
      tool_names: ["cargo.calculate"],
      standard_ids: ["cargo.contract.v1"],
      registration: {
        registered_by_actor_ref: "actor-1",
        registered_at: "2026-08-26T00:00:00.000Z",
      },
    },
  ],
  latest_preview: null,
  latest_approval: null,
  latest_readback: null,
  release_history: [],
  events: [],
  events_truncated: false,
} as const;

type TestModuleRef = Readonly<{
  module_id: string;
  version: string;
  descriptor_digest: string;
}>;

function previewSnapshot({
  previewRef = "preview-1",
  desiredModules = validControlState.activation.active_modules,
  creatorActorRef = "actor-1",
  consumed = false,
}: Readonly<{
  previewRef?: string;
  desiredModules?: readonly TestModuleRef[];
  creatorActorRef?: string;
  consumed?: boolean;
}> = {}) {
  return {
    preview_ref: previewRef,
    canonical_hash: `mcp-control-hash/v1/preview/sha256:${"b".repeat(64)}`,
    base_release_id: "release-1",
    base_revision: 3,
    desired_modules: desiredModules,
    diff: {
      added: [],
      removed: [],
      retained: desiredModules,
    },
    validation: {
      base_matches: true,
      desired_modules_valid: true,
      inventory_matches: true,
      minimum_active_modules: true,
      reason_codes: [],
    },
    creator_actor_ref: creatorActorRef,
    created_at: "2026-08-26T00:00:00Z",
    expires_at: "2026-08-26T00:05:00Z",
    consumed,
    intent: "change",
  } as const;
}

function approvalSnapshot(decision: "approve" | "reject") {
  return {
    approval_id: "approval-1",
    preview_ref: "preview-1",
    decision,
    reason_code: "admin_ui_approval",
    approver_actor_ref: "actor-2",
    decided_at: "2026-08-26T00:01:00Z",
    consumed: false,
  } as const;
}

function readbackSnapshot(status: "pending" | "verified" | "mismatch" | "unknown") {
  const base = {
    release_id: "release-1",
    revision: 3,
    readback_ref: "readback-1",
    applied_modules: validControlState.activation.active_modules,
    checked_at: "2026-08-26T00:02:00Z",
  } as const;
  if (status === "pending") {
    return { ...base, status, observed_activation: null, reason_codes: [] } as const;
  }
  if (status === "verified") {
    return { ...base, status, reason_codes: [] } as const;
  }
  return {
    ...base,
    status,
    observed_activation: {
      release_id: "release-1",
      revision: 3,
    },
    reason_codes: ["readback_not_verified"],
  } as const;
}

type ReleaseStatus =
  | "published_pending_readback"
  | "manual_review"
  | "active_verified"
  | "superseded";

function releaseSummary({
  releaseId,
  revision,
  status,
  desiredModules = validControlState.activation.active_modules,
}: Readonly<{
  releaseId: string;
  revision: number;
  status: ReleaseStatus;
  desiredModules?: readonly TestModuleRef[];
}>) {
  const base = {
    release_id: releaseId,
    revision,
    desired_modules: desiredModules,
    previous_release_id: revision > 1 ? `release-${revision - 1}` : null,
    preview_ref: `preview-${revision}`,
    approval_id: `approval-${revision}`,
    publisher_actor_ref: "actor-1",
    created_at: "2026-08-26T00:00:00Z",
    intent: "change",
  } as const;
  if (status === "published_pending_readback") {
    return {
      ...base,
      status,
      published_at: null,
      readback_ref: null,
      reason_codes: [],
      superseded_by_release_id: null,
    } as const;
  }
  if (status === "manual_review") {
    return {
      ...base,
      status,
      published_at: "2026-08-26T00:01:00Z",
      readback_ref: `readback-${revision}`,
      reason_codes: ["manual_review_required"],
      superseded_by_release_id: null,
    } as const;
  }
  if (status === "active_verified") {
    return {
      ...base,
      status,
      published_at: "2026-08-26T00:01:00Z",
      readback_ref: `readback-${revision}`,
      reason_codes: [],
      superseded_by_release_id: null,
    } as const;
  }
  return {
    ...base,
    status,
    published_at: "2026-08-26T00:01:00Z",
    readback_ref: `readback-${revision}`,
    reason_codes: [],
    superseded_by_release_id: `release-${revision + 1}`,
  } as const;
}

describe("admin control-plane model boundary", () => {
  it("validates the closed control-state snapshot and rejects production claims", () => {
    expect(validateControlState(validControlState)).toEqual(validControlState);
    expect(() => validateControlState({ ...validControlState, events: {} })).toThrow();
    expect(() => validateControlState({
      ...validControlState,
      inventory_modules: [{
        ...validControlState.inventory_modules[0],
        evidence_level: "verified_release",
      }],
    })).toThrow();
    expect(() => validateControlState({
      ...validControlState,
      inventory_modules: [{
        ...validControlState.inventory_modules[0],
        production_eligible: true,
      }],
    })).toThrow();
  });

  it("accepts authoritative RFC 3339 offsets and rejects invalid calendar instants", () => {
    const offsetState = {
      ...validControlState,
      inventory_modules: [{
        ...validControlState.inventory_modules[0],
        registration: {
          ...validControlState.inventory_modules[0].registration,
          registered_at: "2026-08-22T08:00:00+08:00",
        },
      }],
    };
    expect(validateControlState(offsetState)).toEqual(offsetState);
    expect(() => validateControlState({
      ...offsetState,
      inventory_modules: [{
        ...offsetState.inventory_modules[0],
        registration: {
          ...offsetState.inventory_modules[0]!.registration,
          registered_at: "2026-02-31T08:00:00+08:00",
        },
      }],
    })).toThrow();
  });

  it("rejects incomplete closed control-state branches before action gating", () => {
    for (const malformedState of [
      { ...validControlState, latest_preview: {} },
      { ...validControlState, latest_approval: { decision: "approve", consumed: false } },
      { ...validControlState, latest_readback: { status: "verified" } },
      { ...validControlState, release_history: [{}] },
      { ...validControlState, events: [{}] },
    ]) {
      expect(() => validateControlState(malformedState)).toThrow();
    }
  });

  it("accepts every structurally valid discriminated control-state branch", () => {
    const rollbackPreview = {
      ...previewSnapshot(),
      intent: "rollback",
      target_release_id: "release-2",
    } as const;
    for (const latestPreview of [previewSnapshot(), rollbackPreview]) {
      expect(() => validateControlState({
        ...validControlState,
        latest_preview: latestPreview,
      })).not.toThrow();
    }

    for (const latestApproval of [approvalSnapshot("approve"), approvalSnapshot("reject")]) {
      expect(() => validateControlState({
        ...validControlState,
        latest_approval: latestApproval,
      })).not.toThrow();
    }

    for (const status of ["pending", "verified", "mismatch", "unknown"] as const) {
      expect(() => validateControlState({
        ...validControlState,
        latest_readback: readbackSnapshot(status),
      })).not.toThrow();
    }

    const releases = ([
      "published_pending_readback",
      "manual_review",
      "active_verified",
      "superseded",
    ] as const).map((status, index) => releaseSummary({
      releaseId: `release-${index + 1}`,
      revision: index + 1,
      status,
    }));
    const rollbackRelease = {
      ...releaseSummary({
        releaseId: "release-5",
        revision: 5,
        status: "active_verified",
      }),
      intent: "rollback",
      rollback_target_release_id: "release-2",
    } as const;
    expect(() => validateControlState({
      ...validControlState,
      release_history: [...releases, rollbackRelease],
    })).not.toThrow();

    const eventBase = (sequence: number) => ({
      sequence,
      event_id: `event-${sequence}`,
      actor_ref: "actor-1",
      object_ref: `object-${sequence}`,
      reason_codes: sequence === 1 ? ["recorded", "recorded"] : [],
      occurred_at: "2026-08-26T08:00:00+08:00",
    });
    const events = [
      { ...eventBase(1), action: "packages.register", kind: "registration", status: "registered" },
      { ...eventBase(2), action: "deployments.preview", kind: "preview", status: "previewed" },
      { ...eventBase(3), action: "approvals.decide", kind: "approval", status: "approved" },
      { ...eventBase(4), action: "deployments.publish", kind: "release", status: "active_verified" },
      { ...eventBase(5), action: "deployments.publish", kind: "reconciliation", status: "verified" },
      { ...eventBase(6), action: "deployments.reconcile", kind: "reconciliation", status: "unknown" },
      { ...eventBase(7), action: "packages.register", kind: "idempotency", status: "completed" },
    ];
    expect(() => validateControlState({
      ...validControlState,
      events,
    })).not.toThrow();
  });

  it("accepts the authoritative version grammar and full release-history window", () => {
    const maximumLengthVersion = `v${"1".repeat(127)}`;
    const extendedVersionState = {
      ...validControlState,
      activation: {
        ...validControlState.activation,
        active_modules: [{
          ...validControlState.activation.active_modules[0],
          version: "pkg@1",
        }],
      },
      inventory_modules: [
        {
          ...validControlState.inventory_modules[0],
          version: "pkg@1",
        },
        {
          ...validControlState.inventory_modules[0],
          module_id: "release-module",
          version: "release/2026",
        },
        {
          ...validControlState.inventory_modules[0],
          module_id: "max-version-module",
          version: maximumLengthVersion,
        },
      ],
    };
    expect(validateControlState(extendedVersionState)).toEqual(extendedVersionState);
    expect(() => validateControlState({
      ...extendedVersionState,
      inventory_modules: extendedVersionState.inventory_modules.map((module) => (
        module.module_id === "max-version-module"
          ? { ...module, version: `v${"1".repeat(128)}` }
          : module
      )),
    })).toThrow();

    const releaseHistory = Array.from({ length: 128 }, (_, index) => releaseSummary({
      releaseId: `release-${index + 1}`,
      revision: index + 1,
      status: "superseded",
    }));
    expect(() => validateControlState({
      ...validControlState,
      release_history: releaseHistory,
    })).not.toThrow();
    expect(() => validateControlState({
      ...validControlState,
      release_history: [...releaseHistory, releaseSummary({
        releaseId: "release-129",
        revision: 129,
        status: "superseded",
      })],
    })).toThrow();
  });

  it("keeps the module token out of storage, DOM, URL, console, and error visibility", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const client = createControlPlaneClient({
      fetchImpl: (url: RequestInfo | URL, init?: RequestInit) => {
        request = { url: requestUrl(url), init: init ?? {} };
        return new Response(JSON.stringify({
          status: "success",
          data: validControlState,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    client.setToken("module-scoped-fixture-token");
    await expect(client.getControlState()).resolves.toEqual(validControlState);
    expect(request?.url).toBe("/admin/api/v1/control/state");
    expect(new Headers(request?.init.headers).get("authorization")).toBe(
      "Bearer module-scoped-fixture-token",
    );
    expect(request?.init.credentials).toBe("omit");

    const source = await readFile(new URL("../../apps/admin/control-plane.js", import.meta.url), "utf8");
    const appSource = await readFile(new URL("../../apps/admin/app.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(?:localStorage|sessionStorage)\b/);
    expect(source).not.toMatch(/\bdocument\b|\bwindow\.location\b|\blocation\.(?:href|search|hash)\b/);
    expect(source).not.toMatch(/\bconsole\.(?:log|error|warn|info|debug)\b/);
    expect(source).not.toMatch(/(?:throw new Error|Promise\.reject)\([^)]*module-scoped-fixture-token/);
    expect(appSource).not.toMatch(/bindControlIdentity\(\{\s*actor:\s*["']session["']/);
  });

  it("keeps release gating deterministic and requires a distinct approver", async () => {
    const previewState = {
      ...validControlState,
      latest_preview: previewSnapshot(),
      release_history: [releaseSummary({
        releaseId: "release-2",
        revision: 2,
        status: "manual_review",
      })],
    };
    const diff = deriveDesiredDraftDiff(
      validControlState.activation.active_modules,
      [],
    );
    expect(diff.added).toEqual([]);
    expect(diff.removed).toHaveLength(1);
    expect(diff.retained).toEqual([]);
    expect(deriveReleaseStages(previewState).map((stage: { status: string }) => stage.status)).toEqual([
      "complete",
      "pending",
      "empty",
      "empty",
    ]);

    const consumedPublishedState = {
      ...previewState,
      latest_preview: { ...previewState.latest_preview, consumed: true },
      latest_readback: readbackSnapshot("verified"),
    };
    expect(derivePreviewPresentation(consumedPublishedState)).toEqual({
      status: "complete",
      label: "已用于发布",
    });
    expect(deriveReleaseStages(consumedPublishedState).find((stage: { key: string }) => stage.key === "preview")?.status).toBe("complete");

    const consumedWithoutReadbackState = {
      ...consumedPublishedState,
      latest_readback: null,
    };
    expect(derivePreviewPresentation(consumedWithoutReadbackState)).toEqual({
      status: "blocked",
      label: "预览已消费",
    });
    expect(deriveReleaseStages(consumedWithoutReadbackState).find((stage: { key: string }) => stage.key === "preview")?.status).toBe("blocked");

    const sameActor = availabilityAtPreviewTime({
      state: previewState,
      draftModules: [],
      actorRole: "admin",
      actorRef: "actor-1",
      creatorActorRef: "actor-1",
      environment: "fixture",
    });
    expect(sameActor.submitApproval).toBe(false);
    expect(sameActor.generatePreview).toBe(false);
    expect(sameActor.reconcile).toBe(true);

    expect(availabilityAtPreviewTime({
      state: previewState,
      draftModules: validControlState.activation.active_modules,
      actorRole: "admin",
      actorRef: "actor-1",
      creatorActorRef: "actor-1",
      environment: "fixture",
    }).generatePreview).toBe(true);

    expect(availabilityAtPreviewTime({
      state: {
        ...previewState,
        inventory_modules: previewState.inventory_modules.map((module) => ({
          ...module,
          registration: null,
        })),
      },
      draftModules: validControlState.activation.active_modules,
      actorRole: "admin",
      actorRef: "actor-1",
      creatorActorRef: "actor-1",
      environment: "fixture",
    }).generatePreview).toBe(false);

    expect(availabilityAtPreviewTime({
      state: previewState,
      draftModules: [{
        module_id: "unknown-module",
        version: "1.0.0",
        descriptor_digest: descriptorDigest,
      }],
      actorRole: "admin",
      actorRef: "actor-1",
      creatorActorRef: "actor-1",
      environment: "fixture",
    }).generatePreview).toBe(false);

    expect(availabilityAtPreviewTime({
      state: previewState,
      draftModules: [],
      actorRole: "admin",
      creatorActorRef: "actor-1",
      environment: "local",
    }).submitApproval).toBe(false);

    expect(availabilityAtPreviewTime({
      state: previewState,
      draftModules: [],
      actorRole: "admin",
      actorRef: "actor-2",
      environment: "local",
    }).submitApproval).toBe(false);

    const distinctActor = availabilityAtPreviewTime({
      state: previewState,
      draftModules: [],
      actorRole: "admin",
      actorRef: "actor-2",
      creatorActorRef: "actor-1",
      environment: "fixture",
    });
    expect(distinctActor.submitApproval).toBe(true);
    expect(distinctActor.publish).toBe(false);

    const rejectedState = {
      ...previewState,
      latest_approval: approvalSnapshot("reject"),
    };
    expect(deriveReleaseStages(rejectedState).find((stage: { key: string }) => stage.key === "approval")?.status).toBe("blocked");
    expect(availabilityAtPreviewTime({
      state: rejectedState,
      draftModules: [],
      actorRole: "admin",
      actorRef: "actor-2",
      creatorActorRef: "actor-1",
      environment: "fixture",
    })).toMatchObject({
      submitApproval: false,
      publish: false,
    });

    const approvedState = {
      ...previewState,
      latest_approval: approvalSnapshot("approve"),
    };
    expect(availabilityAtPreviewTime({
      state: approvedState,
      draftModules: [],
      actorRole: "admin",
      actorRef: "actor-2",
      creatorActorRef: "actor-1",
      environment: "fixture",
    }).submitApproval).toBe(false);

    const crossLinkedApprovalState = {
      ...previewState,
      latest_preview: previewSnapshot({ previewRef: "preview-2" }),
      latest_approval: approvalSnapshot("approve"),
    };
    expect(derivePreviewPresentation(crossLinkedApprovalState)).toEqual({
      status: "pending",
      label: "待审批",
    });
    expect(deriveReleaseStages(crossLinkedApprovalState).find((stage: { key: string }) => stage.key === "approval")?.status).toBe("manual_review");
    expect(availabilityAtPreviewTime({
      state: crossLinkedApprovalState,
      draftModules: [],
      actorRole: "admin",
      actorRef: "actor-2",
      creatorActorRef: "actor-1",
      environment: "fixture",
    }).publish).toBe(false);

    const expiredApprovedState = {
      ...previewState,
      latest_approval: approvalSnapshot("approve"),
    };
    const expiryMs = Date.parse(expiredApprovedState.latest_preview.expires_at);
    expect(isPreviewUsable(expiredApprovedState.latest_preview, expiryMs - 1)).toBe(true);
    expect(isPreviewUsable(expiredApprovedState.latest_preview, expiryMs)).toBe(false);
    const expiredActions = actionAvailability({
      state: expiredApprovedState,
      draftModules: [],
      actorRole: "admin",
      actorRef: "actor-2",
      creatorActorRef: "actor-1",
      environment: "fixture",
      nowMs: expiryMs,
    });
    expect(expiredActions.submitApproval).toBe(false);
    expect(expiredActions.publish).toBe(false);

    const appSource = await readFile(new URL("../../apps/admin/app.js", import.meta.url), "utf8");
    expect(appSource).toMatch(/case "submit-approval":[\s\S]*?!isPreviewUsable\(preview\)/u);
    expect(appSource).toMatch(/case "publish":[\s\S]*?!isPreviewUsable\(preview\)/u);

    const pendingReadbackState = {
      ...validControlState,
      latest_readback: readbackSnapshot("pending"),
    };
    expect(deriveReleaseStages(pendingReadbackState).find((stage: { key: string }) => stage.key === "publish_readback")?.status).toBe("pending");
    expect(deriveReleaseStages({
      ...validControlState,
      inventory_modules: [{ ...validControlState.inventory_modules[0], registration: null }],
    }).find((stage: { key: string }) => stage.key === "registration")?.status).toBe("pending");
  });

  it.each([
    [
      "a failed validation flag",
      {
        base_matches: false,
        desired_modules_valid: true,
        inventory_matches: true,
        minimum_active_modules: true,
        reason_codes: ["preview_base_stale"],
      },
    ],
    [
      "a validation reason",
      {
        base_matches: true,
        desired_modules_valid: true,
        inventory_matches: true,
        minimum_active_modules: true,
        reason_codes: ["preview_validation_failed"],
      },
    ],
  ] as const)("disables approval and publish for a preview with %s", (_label, validation) => {
    const failedPreview = {
      ...previewSnapshot(),
      validation,
    };
    const failedState = {
      ...validControlState,
      latest_preview: failedPreview,
    };

    expect(isPreviewUsable(failedPreview, PREVIEW_ACTIVE_NOW_MS)).toBe(false);
    expect(availabilityAtPreviewTime({
      state: failedState,
      draftModules: [],
      actorRole: "admin",
      actorRef: "actor-2",
      creatorActorRef: "actor-1",
      environment: "fixture",
    }).submitApproval).toBe(false);
    expect(availabilityAtPreviewTime({
      state: {
        ...failedState,
        latest_approval: approvalSnapshot("approve"),
      },
      draftModules: [],
      actorRole: "admin",
      actorRef: "actor-2",
      creatorActorRef: "actor-1",
      environment: "fixture",
    }).publish).toBe(false);
  });

  it("compares preview expiry without truncating sub-millisecond precision", () => {
    const precisePreview = {
      ...previewSnapshot(),
      expires_at: "2026-08-26T00:02:00.123000001Z",
    };
    const truncatedExpiryMs = Date.parse("2026-08-26T00:02:00.123Z");

    expect(isPreviewUsable(precisePreview, truncatedExpiryMs)).toBe(true);
    expect(isPreviewUsable(precisePreview, truncatedExpiryMs + 1)).toBe(false);
  });

  it("selects the unresolved published release for reconciliation", () => {
    const initialPublishedState = {
      ...validControlState,
      activation: {
        state: "inactive",
        release_id: null,
        revision: 0,
        active_modules: [],
      },
      release_history: [releaseSummary({
        status: "published_pending_readback",
        releaseId: "release-pending-readback",
        revision: 1,
      })],
    } as const;

    expect(selectReconcileReleaseId(initialPublishedState)).toBe("release-pending-readback");
  });

  it("enables rollback only when the handler has an older eligible target", () => {
    const singleReleaseState = {
      ...validControlState,
      release_history: [releaseSummary({
        status: "active_verified",
        releaseId: "release-3",
        revision: 3,
      })],
    };
    expect(selectRollbackReleaseId(singleReleaseState)).toBeNull();
    expect(availabilityAtPreviewTime({
      state: singleReleaseState,
      draftModules: [],
      actorRole: "admin",
      environment: "local",
    }).rollback).toBe(false);

    const rollbackReadyState = {
      ...singleReleaseState,
      release_history: [
        singleReleaseState.release_history[0]!,
        releaseSummary({
          status: "superseded",
          releaseId: "release-2",
          revision: 2,
        }),
      ],
    };
    expect(selectRollbackReleaseId(rollbackReadyState)).toBe("release-2");
    expect(availabilityAtPreviewTime({
      state: rollbackReadyState,
      draftModules: [],
      actorRole: "admin",
      environment: "local",
    }).rollback).toBe(true);
  });

  it("derives registration from exact release targets instead of unrelated inventory", () => {
    const targetModule = {
      module_id: "freightcom-ltl",
      version: "1.0.0",
      descriptor_digest: descriptorDigest,
    } as const;
    const inventoryModules = [
      targetModule,
      { module_id: "riskcustoms", version: "1.0.0", descriptor_digest: `sha256:${"b".repeat(64)}` },
      { module_id: "canada-final-mile", version: "1.0.0", descriptor_digest: `sha256:${"c".repeat(64)}` },
      { module_id: "knowledge", version: "1.0.0", descriptor_digest: `sha256:${"d".repeat(64)}` },
    ].map((module, index) => ({
      ...validControlState.inventory_modules[0],
      ...module,
      registration: index === 0 ? validControlState.inventory_modules[0].registration : null,
    }));
    const publishedState = {
      ...validControlState,
      activation: {
        ...validControlState.activation,
        active_modules: [targetModule],
      },
      inventory_modules: inventoryModules,
      latest_preview: previewSnapshot({
        previewRef: "preview-freightcom-ltl",
        consumed: true,
        desiredModules: [targetModule],
      }),
      latest_readback: readbackSnapshot("verified"),
    };

    expect(deriveReleaseStages(publishedState).find((stage: { key: string }) => stage.key === "registration")?.status).toBe("complete");

    const descriptorDriftState = {
      ...publishedState,
      latest_preview: {
        ...publishedState.latest_preview,
        desired_modules: [{
          ...targetModule,
          descriptor_digest: `sha256:${"e".repeat(64)}`,
        }],
      },
    };
    expect(deriveReleaseStages(descriptorDriftState).find((stage: { key: string }) => stage.key === "registration")?.status).toBe("pending");

    const unregisteredTargetState = {
      ...publishedState,
      inventory_modules: publishedState.inventory_modules.map((module) => ({
        ...module,
        registration: module.module_id === targetModule.module_id ? null : module.registration,
      })),
    };
    expect(deriveReleaseStages(unregisteredTargetState).find((stage: { key: string }) => stage.key === "registration")?.status).toBe("pending");
  });

  it("uses the control API client for each write path without persisting credentials", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = createControlPlaneClient({
      fetchImpl: (url: RequestInfo | URL, init?: RequestInit) => {
        const path = requestUrl(url);
        requests.push({ url: path, init: init ?? {} });
        const data = path.endsWith("/state") ? validControlState : {};
        return new Response(JSON.stringify({ status: "success", data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    client.setToken("request-scoped-token");
    await client.getControlState();
    await client.registerPackage({
      schema_version: CONTROL_SCHEMA_VERSION,
      module_id: "cargo",
      version: "1.0.0",
      descriptor_digest: descriptorDigest,
    }, "key-register");
    await client.createPreview({
      schema_version: CONTROL_SCHEMA_VERSION,
      intent: "change",
      desired_modules: [{
        module_id: "cargo",
        version: "1.0.0",
        descriptor_digest: descriptorDigest,
      }],
    }, "key-preview");
    await client.decideApproval({
      schema_version: CONTROL_SCHEMA_VERSION,
      preview_ref: "preview-1",
      decision: "approve",
      reason_code: "admin_ui_approval",
    }, "key-approval");
    await client.publish({
      schema_version: CONTROL_SCHEMA_VERSION,
      preview_ref: "preview-1",
      approval_id: "approval-1",
    }, "key-publish");
    await client.reconcile({
      schema_version: CONTROL_SCHEMA_VERSION,
      release_id: "release-1",
    }, "key-reconcile");

    expect(requests.map((request) => request.url)).toEqual([
      "/admin/api/v1/control/state",
      "/admin/api/v1/control/packages/register",
      "/admin/api/v1/control/deployments/preview",
      "/admin/api/v1/control/approvals",
      "/admin/api/v1/control/deployments/publish",
      "/admin/api/v1/control/deployments/reconcile",
    ]);
    for (const [index, request] of requests.entries()) {
      const headers = new Headers(request.init.headers);
      expect(headers.get("authorization")).toBe("Bearer request-scoped-token");
      expect(request.init.credentials).toBe("omit");
      if (index > 0) expect(headers.get("idempotency-key")).toBeTruthy();
    }
    expect(redactReference("opaque-ref")).toBe("已记录（具体内容隐藏）");
    expect(isFixtureIdentityVisible("fixture=1")).toBe(true);
    expect(isFixtureIdentityVisible("fixture=0")).toBe(false);
  });

  it("does not accept a success envelope from a non-2xx response", async () => {
    let request: { init: RequestInit } | undefined;
    const client = createControlPlaneClient({
      fetchImpl: (_url: RequestInfo | URL, init?: RequestInit) => {
        request = { init: init ?? {} };
        return new Response(JSON.stringify({ status: "success", data: validControlState }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(client.getControlState()).rejects.toMatchObject({
      name: "ControlPlaneError",
      status: "blocked",
    });
    expect(request?.init.credentials).toBe("omit");
  });

  it.each([
    [409, "manual_review"],
    [503, "unavailable"],
  ] as const)("preserves a non-success envelope from HTTP %s as %s", async (httpStatus, envelopeStatus) => {
    const client = createControlPlaneClient({
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
        status: envelopeStatus,
        reason_codes: [`control.${envelopeStatus}`],
        data: validControlState,
      }), {
        status: httpStatus,
        headers: { "content-type": "application/json" },
      })),
    });

    await expect(client.getControlState()).rejects.toMatchObject({
      name: "ControlPlaneError",
      status: envelopeStatus,
      reasonCodes: [`control.${envelopeStatus}`],
      data: validControlState,
    });
  });

  it("wires the module-center shell, identity dialog, and fail-closed interactions", async () => {
    const [html, app, css] = await Promise.all([
      readFile(new URL("../../apps/admin/index.html", import.meta.url), "utf8"),
      readFile(new URL("../../apps/admin/app.js", import.meta.url), "utf8"),
      readFile(new URL("../../apps/admin/styles.css", import.meta.url), "utf8"),
    ]);

    expect(html).toContain('data-view="modules"');
    expect(html).toContain("模块中心");
    expect(html).toContain("Agent 接入");
    expect(html).toContain("适配器状态");
    expect(html).toContain("审批与发布");
    expect(html).toContain("审计日志");
    expect(html).toContain('id="identity-dialog"');
    expect(html).toMatch(/id="identity-token"[^>]+type="password"/);
    expect(html).not.toMatch(/local-fixture-(?:token|approver-token)/);
    expect(app).toContain('from "./control-plane.js"');
    expect(app).toContain("renderModuleCenter");
    expect(app).toContain("data-control-action");
    expect(app).toContain("已登记");
    expect(app).toContain("待审批");
    expect(app).toContain("当前激活");
    expect(app).toContain("本地演示申请人");
    expect(app).toContain("本地演示审批人");
    expect(app).toContain("报价、关务与客户数据仍由外部权威系统管理");
    expect(app).toContain("登记制品");
    expect(app).toContain("发布轨迹与回滚目标");
    expect(app).toContain("运行时已读回");
    expect(app).toContain("未获生产资格");
    expect(app).toContain("只有生成预览后才进入服务端审批链");
    expect(app).toContain("回滚到上一已读回版本（本地受控环境）");
    expect(app).toContain("manual_review");
    expect(app).toContain("publish");
    expect(app).toContain("reconcile");
    expect(app).toContain("rollback");
    expect(app).toContain("isFixtureIdentityVisible");
    expect(app).toContain("草稿只保留在当前浏览器内存");
    expect(app).not.toMatch(/active_verified.{0,80}(签名|生产资格)/s);
    expect(app).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("overflow-x: auto");
    expect(css).not.toMatch(/linear-gradient|radial-gradient|backdrop-filter/);
  });
});
