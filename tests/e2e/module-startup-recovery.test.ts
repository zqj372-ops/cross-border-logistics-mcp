import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalControlHash,
  type ControlHashPayload,
} from "../../src/logistics_mcp/control-plane/canonical-control-hash";
import type {
  ApprovalRequest,
  DeploymentPreviewRequest,
  PublishRequest,
  RegisterPackageRequest,
} from "../../src/logistics_mcp/control-plane/contracts";
import { createModuleInventory } from "../../src/logistics_mcp/control-plane/inventory";
import {
  initializeSqliteControlState,
  openSqliteControlStore,
} from "../../src/logistics_mcp/control-plane/sqlite-control-store";
import {
  createModuleControlRuntimeAssembly,
  type WriteMeta,
} from "../../src/logistics_mcp/control-plane/service";
import { ADMIN_CONTROL_SCHEMA_VERSION } from "../../src/logistics_mcp/control-plane/types";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import { startRuntime } from "../../src/logistics_mcp/server/start";

const MANAGEMENT_TENANT_ID = "tenant_fixture";
const INSTANCE_ID = "instance_fixture_001";
const FIXED_TIME = "2026-01-01T00:00:00Z";
const RUNTIME_ENV_NAMES = [
  "MCP_DATA_MODE",
  "MCP_ADMIN_CONTROL_ENABLED",
  "MCP_INSTANCE_ID",
  "MCP_ADMIN_TENANT_ID",
  "MCP_FIXTURE_TOKEN",
  "MCP_FIXTURE_APPROVER_TOKEN",
  "MCP_APPLICATION_ROOT",
  "MCP_RUNTIME_DIR",
  "MCP_STATE_DIR",
  "MCP_STATE_DB_PATH",
  "MCP_CONTROL_DB_PATH",
  "MCP_CONTROL_MARKER_PATH",
  "MCP_CONTROL_STATE_PATH",
] as const;

const inventory = createModuleInventory({
  mountedModules: [
    {
      moduleId: "cargo",
      version: "1.0.0",
      riskLevel: "T0",
      lifecycle: "static",
      requiredCapabilities: [],
      optionalCapabilities: [],
      standardRefs: ["standard"],
    },
  ],
  catalog: [
    {
      owner: "cargo",
      name: "cargo.calculate",
      permission: "quote:calculate",
      kind: "read",
      riskLevel: "T0",
      inputSchemaId: "cargo.input",
      outputSchemaId: "cargo.output",
      standardRefs: ["standard"],
    },
  ],
  localEvidence: [
    {
      moduleId: "cargo",
      version: "1.0.0",
      evidenceRefs: {
        sourceShaRef: null,
        artifactDigestRef: null,
        signatureRef: null,
        sbomRef: null,
        attestationRef: null,
      },
    },
  ],
});

function adminContext(actorId: string) {
  return parseExecutionContext({
    tenant_id: MANAGEMENT_TENANT_ID,
    actor_id: actorId,
    actor_role: "admin",
    roles: ["admin"],
    scopes: ["platform:admin"],
    client_id: `client_${actorId}`,
    session_id: `session_${actorId}`,
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });
}

function writeMeta(payload: ControlHashPayload, suffix: string): WriteMeta {
  return {
    idempotencyKey: `idem_${suffix}`,
    requestHash: canonicalControlHash({
      domain: "request",
      schemaVersion: ADMIN_CONTROL_SCHEMA_VERSION,
      payload,
    }).hash as WriteMeta["requestHash"],
    requestId: `request_${suffix}`,
    traceId: `trace_${suffix}`,
    auditId: `audit_${suffix}`,
  };
}

function configureManagedFixtureEnvironment(): void {
  for (const name of RUNTIME_ENV_NAMES) delete process.env[name];
  process.env.MCP_DATA_MODE = "fixtures";
  process.env.MCP_ADMIN_CONTROL_ENABLED = "true";
  process.env.MCP_INSTANCE_ID = INSTANCE_ID;
  process.env.MCP_ADMIN_TENANT_ID = MANAGEMENT_TENANT_ID;
  process.env.MCP_FIXTURE_TOKEN = "fixture-applicant-token";
  process.env.MCP_FIXTURE_APPROVER_TOKEN = "fixture-approver-token";
}

describe("module startup recovery", () => {
  it("finalizes an interrupted attempt and keeps later startups open for operator reconciliation", async () => {
    const applicationRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "logistics-mcp-prior-claim-")),
    );
    const previousEnvironment = new Map(
      RUNTIME_ENV_NAMES.map((name) => [name, process.env[name]]),
    );
    let ownerStore: ReturnType<typeof openSqliteControlStore> | undefined;
    let inspectedStore: ReturnType<typeof openSqliteControlStore> | undefined;
    let firstRuntime: Awaited<ReturnType<typeof startRuntime>> | undefined;
    let secondRuntime: Awaited<ReturnType<typeof startRuntime>> | undefined;

    try {
      configureManagedFixtureEnvironment();
      await initializeSqliteControlState({
        applicationRoot,
        instanceId: INSTANCE_ID,
        managementTenantId: MANAGEMENT_TENANT_ID,
      });
      ownerStore = openSqliteControlStore({
        applicationRoot,
        instanceId: INSTANCE_ID,
        managementTenantId: MANAGEMENT_TENANT_ID,
        adminControlEnabled: true,
      });

      const interruptedOwnerFinalize = vi.fn(() =>
        Promise.reject(new Error("simulated owner interruption")),
      );
      const repository = {
        ...ownerStore,
        finalizeReadbackAndComplete: interruptedOwnerFinalize,
      };
      const generatedIds = [
        "preview_prior_boot",
        "approval_prior_boot",
        "release_prior_boot",
        "attempt_prior_boot",
        "readback_prior_boot",
      ];
      let generatedIndex = 0;
      const assembly = createModuleControlRuntimeAssembly({
        inventory,
        repository,
        managementTenantId: MANAGEMENT_TENANT_ID,
        previewTtlSeconds: 900,
        clock: () => FIXED_TIME,
        idGenerator: () => generatedIds[generatedIndex++] ?? `extra_${generatedIndex}`,
        ownerBootId: "service_boot_prior",
      });

      const operator = "actor_operator";
      const approver = "actor_approver";
      const publisher = "actor_publisher";
      const moduleRef = inventory[0]!;
      const descriptorDigest = moduleRef.descriptorDigest;
      const registerRequest: RegisterPackageRequest = {
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        module_id: moduleRef.moduleId,
        version: moduleRef.version,
        descriptor_digest: descriptorDigest,
      };
      await assembly.service.registerPackage(
        adminContext(operator),
        registerRequest,
        writeMeta({
          action: "packages.register",
          management_tenant_id: MANAGEMENT_TENANT_ID,
          actor_ref: operator,
          request: {
            schema_version: registerRequest.schema_version,
            module_id: registerRequest.module_id,
            version: registerRequest.version,
            descriptor_digest: descriptorDigest,
          },
        }, "register_prior_boot"),
      );

      const previewRequest: DeploymentPreviewRequest = {
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        intent: "change",
        desired_modules: [{
          module_id: moduleRef.moduleId,
          version: moduleRef.version,
          descriptor_digest: descriptorDigest,
        }],
      };
      const preview = await assembly.service.createDeploymentPreview(
        adminContext(operator),
        previewRequest,
        writeMeta({
          action: "deployments.preview",
          management_tenant_id: MANAGEMENT_TENANT_ID,
          actor_ref: operator,
          request: {
            schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
            intent: "change",
            desired_modules: [{
              module_id: moduleRef.moduleId,
              version: moduleRef.version,
              descriptor_digest: descriptorDigest,
            }],
          },
        }, "preview_prior_boot"),
      );
      if (
        preview.data?.kind !== "preview" ||
        typeof preview.data.preview_ref !== "string"
      ) {
        throw new Error("preview fixture failed");
      }
      const previewRef = preview.data.preview_ref;

      const approvalRequest: ApprovalRequest = {
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        preview_ref: previewRef,
        decision: "approve",
        reason_code: "approved",
      };
      const approval = await assembly.service.decideApproval(
        adminContext(approver),
        approvalRequest,
        writeMeta({
          action: "approvals.decide",
          management_tenant_id: MANAGEMENT_TENANT_ID,
          actor_ref: approver,
          request: {
            schema_version: approvalRequest.schema_version,
            preview_ref: previewRef,
            decision: "approve",
            reason_code: "approved",
          },
        }, "approval_prior_boot"),
      );
      if (
        approval.data?.kind !== "approval" ||
        typeof approval.data.approval_id !== "string"
      ) {
        throw new Error("approval fixture failed");
      }
      const approvalId = approval.data.approval_id;

      const publishRequest: PublishRequest = {
        schema_version: ADMIN_CONTROL_SCHEMA_VERSION,
        preview_ref: previewRef,
        approval_id: approvalId,
      };
      await expect(assembly.service.publish(
        adminContext(publisher),
        publishRequest,
        writeMeta({
          action: "deployments.publish",
          management_tenant_id: MANAGEMENT_TENANT_ID,
          actor_ref: publisher,
          request: {
            schema_version: publishRequest.schema_version,
            preview_ref: previewRef,
            approval_id: approvalId,
          },
        }, "publish_prior_boot"),
      )).rejects.toThrow("The runtime mutation coordinator is in a fatal state.");
      expect(interruptedOwnerFinalize).toHaveBeenCalledTimes(1);

      const claimed = await ownerStore.listUnfinishedReadbackAttempts();
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        phase: "claimed",
        attemptId: "attempt_prior_boot",
        action: "deployments.publish",
      });
      const releaseId = claimed[0]!.releaseId;
      await ownerStore.close();
      ownerStore = undefined;

      const listen = vi.fn(() => Promise.resolve());
      firstRuntime = await startRuntime({ applicationRoot, listen });
      expect(listen).toHaveBeenCalledTimes(1);
      await firstRuntime.close();
      firstRuntime = undefined;

      secondRuntime = await startRuntime({ applicationRoot, listen });
      expect(listen).toHaveBeenCalledTimes(2);
      await secondRuntime.close();
      secondRuntime = undefined;

      inspectedStore = openSqliteControlStore({
        applicationRoot,
        instanceId: INSTANCE_ID,
        managementTenantId: MANAGEMENT_TENANT_ID,
        adminControlEnabled: true,
      });
      await expect(inspectedStore.listUnfinishedReadbackAttempts()).resolves.toEqual([]);
      const history = await inspectedStore.getReadbackAttemptHistory({
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId,
      });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        phase: "finalized",
        attemptId: "attempt_prior_boot",
        terminalStatus: "unknown",
        appliedReleaseId: null,
        appliedRevision: null,
        appliedModules: [],
        reasonCodes: ["readback.interrupted"],
        finalizedByActorRef: "system_startup_recovery",
      });
      await expect(inspectedStore.getRelease({
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId,
      })).resolves.toMatchObject({
        status: "manual_review",
        reasonCodes: ["readback.interrupted"],
      });
      await expect(inspectedStore.getReadback({
        managementTenantId: MANAGEMENT_TENANT_ID,
        releaseId,
      })).resolves.toMatchObject({
        status: "unknown",
        appliedReleaseId: null,
        appliedRevision: null,
        appliedModules: [],
        reasonCodes: ["readback.interrupted"],
      });
    } finally {
      await secondRuntime?.close().catch(() => undefined);
      await firstRuntime?.close().catch(() => undefined);
      await inspectedStore?.close().catch(() => undefined);
      await ownerStore?.close().catch(() => undefined);
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(applicationRoot, { recursive: true, force: true });
    }
  });
});
