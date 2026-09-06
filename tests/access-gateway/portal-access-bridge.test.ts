import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalJWKSet, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAccessGateway } from "../../services/access-gateway/service";
import { TenantAccessGatewayRepository } from "../../services/access-gateway/production-store";
import { createSyntheticAccessGatewayFixture } from "../../services/access-gateway/synthetic";
import { PortalService } from "../../services/access-gateway/portal/service";
import { SqliteSyntheticPortalStore } from "../../services/access-gateway/portal/store";
import { createPortalAccessBridge } from "../../services/access-gateway/portal/access-bridge";
import { createAgentAccessRuntime, agentContextToolContract } from "../../src/logistics_mcp/agent-context/runtime";
import { cargoToolContract, cargoToolHandler } from "../../src/logistics_mcp/domains/cargo/tool";
import {
  containerPlanSummaryHandler,
  containerPlanSummaryToolContract,
} from "../../src/logistics_mcp/domains/container/service";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  initializeSqliteTenantAccessState,
  SqliteTenantAccessStore,
} from "../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import {
  TENANT_ACCESS_SCHEMA_VERSION,
  TenantAccessService,
} from "../../src/logistics_mcp/control-plane/tenant-access-service";
import type { ToolDefinition } from "../../src/logistics_mcp/server/tool-registry";

const roots: string[] = [];
const NOW_SECONDS = Math.floor(Date.now() / 1_000);
const NOW = new Date(NOW_SECONDS * 1_000).toISOString();

function identity(userId: string, platformRole: "reviewer" | "operator" | null = null) {
  return {
    identity: {
      userId,
      displayName: userId,
      email: `${userId}@example.test`,
      emailVerified: true,
      platformRole,
    },
    organizationId: "org_demo",
  } as const;
}

function adminContext() {
  return parseExecutionContext({
    tenant_id: "tenant_management",
    actor_id: "portal_bridge",
    actor_role: "admin",
    roles: ["admin"],
    scopes: ["platform:admin", "tenant:admin"],
    client_id: "portal_bridge",
    session_id: "portal_bridge_session",
    expires_at: 1_900_000_000,
  });
}

function t0Definitions(): readonly ToolDefinition[] {
  const runtime = createAgentAccessRuntime();
  const common = {
    kind: "read" as const,
    statusMapping: ["success", "needs_input", "manual_review", "blocked", "unavailable"] as const,
  };
  return [
    {
      ...common,
      name: "cargo.calculate",
      title: "Cargo",
      description: "Cargo",
      inputSchemaId: "cargo-input",
      outputSchemaId: "cargo-output",
      permission: "quote:calculate",
      handler: cargoToolHandler,
      inputSchema: cargoToolContract.inputSchema,
      validateOutput: cargoToolContract.validateOutput,
    },
    {
      ...common,
      name: "container.plan_summary",
      title: "Container",
      description: "Container",
      inputSchemaId: "container-input",
      outputSchemaId: "container-output",
      permission: "container:calculate",
      handler: containerPlanSummaryHandler,
      inputSchema: containerPlanSummaryToolContract.inputSchema,
      validateOutput: containerPlanSummaryToolContract.validateOutput,
    },
    {
      ...common,
      name: "system.agent_context.get",
      title: "Agent context",
      description: "Agent context",
      inputSchemaId: "agent-context-input",
      outputSchemaId: "agent-context-output",
      permission: "system:agent_context",
      handler: (input, context) => runtime.getContext(input, context),
      inputSchema: agentContextToolContract.inputSchema,
      validateOutput: agentContextToolContract.validateOutput,
    },
  ];
}

function cargoRequest() {
  const sourceRef = (sourceId: string, version: string) => ({
    source_id: sourceId,
    source_type: sourceId.includes("rule") ? "internal_system" : "user_input",
    system: sourceId.includes("rule") ? "quote-rule-registry" : "mcp-gateway",
    locator: sourceId.includes("rule")
      ? "channel/CAQ-HP/dimensional-weight"
      : "opaque://request/demo",
    version,
    retrieved_at: "2026-08-11T09:00:00Z",
    authority: sourceId.includes("rule") ? "authoritative" : "user_provided",
    content_hash: `sha256:${sourceId.replace(/[^A-Za-z0-9]/gu, "")}`,
  });
  return {
    schema_version: "2026-08-11.v1",
    version: "cargo.calculate@2026-08-11.v1",
    cargo_lines: [{
      version: "cargo-line@2026-08-11.v1",
      line_id: "line_1",
      description: "carton",
      quantity: 2,
      quantity_unit: "carton",
      package_type: "carton",
      unit_weight: { value: "12.5", unit: "kg" },
      dimensions: [{
        length: { value: "60", unit: "cm" },
        width: { value: "50", unit: "cm" },
        height: { value: "40", unit: "cm" },
        quantity: 2,
      }],
      stackable: true,
      fragile: false,
      sensitive: false,
      source_ref_ids: ["src_input_1"],
    }],
    dimensional_divisor: null,
    bubble_rule: {
      channel: "CAQ-HP",
      mode: "full",
      ratio: null,
      rule_version: "CAQ-HP@2026-01-01",
      source_ref_ids: ["src_rule_1"],
      density: { value: "1000", unit: "kg_per_cbm" },
      unit: "kg",
      rounding: { mode: "none", decimals: 6 },
    },
    channel_code: "CAQ-HP",
    source_refs: [
      sourceRef("src_input_1", "input@2026-08-11"),
      sourceRef("src_rule_1", "CAQ-HP@2026-01-01"),
    ],
  };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "portal-access-bridge-"));
  roots.push(root);
  mkdirSync(join(root, ".runtime"), { mode: 0o700 });
  await initializeSqliteTenantAccessState({
    applicationRoot: root,
    instanceId: "portal_fixture",
    managementTenantId: "tenant_management",
  });
  const tenantStore = new SqliteTenantAccessStore({
    applicationRoot: root,
    instanceId: "portal_fixture",
    managementTenantId: "tenant_management",
  });
  const crypto = createSyntheticAccessGatewayFixture({ nowSeconds: NOW_SECONDS });
  const tenantService = new TenantAccessService(tenantStore, {
    clock: () => NOW_SECONDS,
    idGenerator: (() => {
      let sequence = 0;
      return (prefix) => `${prefix}_${String(++sequence).padStart(8, "0")}`;
    })(),
    secretGenerator: () => "S".repeat(43),
    saltGenerator: () => new Uint8Array(16).fill(7),
    credentialSecretProvider: {
      pepperVersion: crypto.pepper.version,
      hash: (secret, salt) => crypto.pepper.hashCredentialSecret({
        secret,
        salt,
        pepperVersion: crypto.pepper.version,
      }),
      verify: (secret, salt, expectedHash, pepperVersion) =>
        crypto.pepper.verifyCredentialSecret({
          secret,
          material: { salt, expectedHash, pepperVersion },
        }),
    },
  });
  const repository = new TenantAccessGatewayRepository({
    store: tenantStore,
    nowSeconds: () => NOW_SECONDS,
  });
  const gateway = createAccessGateway({
    ...crypto.providers,
    credentialRepository: repository,
    revocationRepository: repository,
  }, {
    issuer: "https://fixture-access.example.invalid/",
    audience: "logistics-mcp",
  });
  const portalStore = new SqliteSyntheticPortalStore({ databasePath: join(root, "portal.sqlite") });
  const portalService = new PortalService({
    repository: portalStore,
    dataMode: "fixtures",
    now: () => NOW,
    id: (() => {
      let sequence = 0;
      return (prefix) => `${prefix}_${String(++sequence).padStart(8, "0")}`;
    })(),
  });
  const signingJwks = await crypto.signer.getJwks();
  const jwks = createLocalJWKSet({ keys: signingJwks.keys.map((key) => ({ ...key })) });
  const bridgeOptions = {
    dataMode: "fixtures",
    portalService,
    tenantAccessService: tenantService,
    accessGateway: gateway,
    internalAdminContext: adminContext(),
    tokenVerifier: {
      verify: async (token: string) => (await jwtVerify(token, jwks, {
        algorithms: ["RS256"],
        currentDate: new Date(NOW_SECONDS * 1_000),
      })).payload,
    },
    restTokenPolicy: {
      issuer: "https://fixture-access.example.invalid/",
      audience: "logistics-mcp",
      nowSeconds: NOW_SECONDS,
      maxLifetimeSeconds: 900,
    },
    exchangeAudience: "logistics-mcp",
    t0Definitions: t0Definitions(),
    id: (() => {
      let sequence = 0;
      return (prefix: "req" | "audit") => `${prefix}_${String(++sequence).padStart(8, "0")}`;
    })(),
  } as const;
  const bridge = createPortalAccessBridge(bridgeOptions);
  await tenantService.createTenant(adminContext(), {
    schema_version: TENANT_ACCESS_SCHEMA_VERSION,
    tenant_id: "tenant_demo",
    display_name: "Demo",
  }, "tenant-create-00000001");
  portalService.bootstrapOrganization(
    identity("owner", "operator"),
    { idempotencyKey: "org-bootstrap-0000001", input: {
      organizationId: "org_demo",
      tenantId: "tenant_demo",
      displayName: "Demo",
    } },
  );
  return { bridge, bridgeOptions, crypto, portalService, portalStore, tenantService, tenantStore };
}

async function approvedApplication(
  value: Awaited<ReturnType<typeof fixture>>,
  beforeProvision?: (input: Readonly<{ applicationId: string; grantId: string }>) => Promise<void>,
) {
  const owner = identity("owner");
  const created = await value.bridge.createApplication(owner, {
    idempotencyKey: "application-create-001",
    input: {
      name: "Demo App",
      purpose: "T0 integration",
      environment: "test",
      ownerUserId: "owner",
    },
  });
  const applicationId = (created.data as { applicationId: string }).applicationId;
  value.portalService.createRequest(owner, {
    idempotencyKey: "request-create-00001",
    input: {
      requestId: "request_demo",
      applicationId,
      capabilities: ["cargo.calculate"],
      justification: "Fixture verification",
    },
  });
  value.portalService.submitRequest(owner, "request_demo", 1, "request-submit-00001");
  const decision = value.portalService.decideRequest(
    identity("reviewer", "reviewer"),
    "request_demo",
    {
      idempotencyKey: "request-decide-00001",
      expectedVersion: 2,
      input: { decision: "approve", reason: "Approved for fixture verification" },
    },
  );
  const grantId = (decision.data as { grant: { grantId: string } }).grant.grantId;
  await beforeProvision?.({ applicationId, grantId });
  await value.bridge.provisionGrant(identity("operator", "operator"), grantId, {
    idempotencyKey: "grant-provision-00001",
    expectedVersion: 1,
    input: {},
  });
  return { owner, grantId, applicationId };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("portal access bridge", () => {
  it("creates and reads back the existing client before storing the application", async () => {
    const value = await fixture();
    const owner = identity("owner");
    const created = await value.bridge.createApplication(owner, {
      idempotencyKey: "application-create-001",
      input: {
        name: "Demo App",
        purpose: "T0 integration",
        environment: "test",
        ownerUserId: "owner",
      },
    });
    const application = created.data as { applicationId: string; clientId: string };
    const replayed = await value.bridge.createApplication(owner, {
      idempotencyKey: "application-create-001",
      input: {
        name: "Demo App",
        purpose: "T0 integration",
        environment: "test",
        ownerUserId: "owner",
      },
    });

    const accessState = await value.tenantService.getState(adminContext());
    expect(accessState.data.clients).toEqual([
      expect.objectContaining({ tenant_id: "tenant_demo", client_id: application.clientId }),
    ]);
    expect(accessState.data.credentials).toEqual([]);
    expect(accessState.data.operations).toContainEqual(expect.objectContaining({
      action: "client.create",
      actor_ref: "owner:portal_bridge",
    }));
    expect(value.portalStore.read().applications).toEqual([
      expect.objectContaining({ applicationId: application.applicationId, clientId: application.clientId }),
    ]);
    expect(replayed.data).toEqual(created.data);
  });

  it("provisions from current tenant and client readback after the operation window rolls over", async () => {
    const value = await fixture();
    const approved = await approvedApplication(value, async ({ applicationId }) => {
      const application = value.portalStore.read().applications.find((item) => (
        item.applicationId === applicationId
      ));
      if (application === undefined) throw new Error("application missing");
      for (let index = 0; index < 260; index += 1) {
        const status = index % 2 === 0 ? "disabled" : "active";
        await value.tenantService.setClientStatus(
          adminContext(),
          "tenant_demo",
          application.clientId,
          {
            schema_version: TENANT_ACCESS_SCHEMA_VERSION,
            status,
            reason_code: `history_${status}_${index}`,
          },
          `client-history-${String(index).padStart(6, "0")}`,
        );
      }
    });
    const grant = value.portalStore.read().grants.find((item) => item.grantId === approved.grantId);
    expect(grant?.state).toBe("active");
    expect(grant?.provisionedRef).toMatch(/^client:client_/u);
    expect((await value.tenantService.getState(adminContext())).data.operations).not.toContainEqual(
      expect.objectContaining({ action: "client.create" }),
    );
  });

  it("reuses credential issuance, one-time delivery, exchange, and current grant denial", async () => {
    const value = await fixture();
    const { owner, grantId, applicationId } = await approvedApplication(value);
    const issued = await value.bridge.issueCredential(owner, applicationId, {
      idempotencyKey: "credential-issue-0001",
      input: {
        label: "Demo key",
        tool_names: ["cargo.calculate"],
        expires_in_seconds: 86_400,
      },
    });
    expect(issued.data.api_key).toMatch(/^lmcpk_/u);
    expect(issued.data.operation.actor_ref).toBe("owner:portal_bridge");
    const apiKey = issued.data.api_key as string;
    const credentialId = issued.data.credential.credential_id;
    await value.bridge.acknowledgeCredentialDelivery(owner, applicationId, credentialId, {
      idempotencyKey: "credential-ack-00001",
      input: {},
    });

    const exchanged = await value.bridge.exchangeToken({
      apiKey,
      body: {
        schema_version: "2026-08-27.v1",
        requested_tool_names: ["cargo.calculate"],
      },
      clientIp: "198.51.100.40",
      requestId: "req_portal_exchange_01",
    });
    expect(exchanged.status).toBe("success");
    expect(JSON.stringify(await value.bridge.getCredentialState(owner, applicationId))).not.toContain(apiKey);
    const signCount = value.crypto.signer.signCount;
    const auditCount = value.crypto.audit.events.length;

    value.portalService.changeGrantState(identity("operator", "operator"), grantId, {
      idempotencyKey: "grant-suspend-00001",
      expectedVersion: 2,
      input: { state: "suspended" },
    });
    await expect(value.bridge.exchangeToken({
      apiKey,
      body: {
        schema_version: "2026-08-27.v1",
        requested_tool_names: ["cargo.calculate"],
      },
      clientIp: "198.51.100.40",
    })).rejects.toMatchObject({ code: "tool_entitlement_denied" });
    expect(value.crypto.signer.signCount).toBe(signCount);
    expect(value.crypto.audit.events).toHaveLength(auditCount + 1);
    expect(value.crypto.audit.events.at(-1)).toMatchObject({
      status: "blocked",
      reasonCode: "tool_entitlement_denied",
      jti: null,
    });
    const wrongSecret = `${apiKey.slice(0, -1)}${apiKey.endsWith("A") ? "B" : "A"}`;
    await expect(value.bridge.exchangeToken({
      apiKey: wrongSecret,
      body: {
        schema_version: "2026-08-27.v1",
        requested_tool_names: ["cargo.calculate"],
      },
      clientIp: "198.51.100.40",
    })).rejects.toMatchObject({ code: "authentication_failed" });
    expect(value.crypto.signer.signCount).toBe(signCount);
    expect(value.crypto.audit.events.at(-1)).toMatchObject({
      status: "blocked",
      reasonCode: "authentication_failed",
      tenantId: null,
      clientId: null,
      credentialId: null,
    });
  });

  it("cryptographically verifies a short JWT and executes the real cargo contract", async () => {
    const value = await fixture();
    const { owner, grantId, applicationId } = await approvedApplication(value);
    const issued = await value.bridge.issueCredential(owner, applicationId, {
      idempotencyKey: "credential-issue-0002",
      input: { label: "Runtime key", tool_names: ["cargo.calculate"], expires_in_seconds: 86_400 },
    });
    await value.bridge.acknowledgeCredentialDelivery(
      owner,
      applicationId,
      issued.data.credential.credential_id,
      { idempotencyKey: "credential-ack-00002", input: {} },
    );
    const exchanged = await value.bridge.exchangeToken({
      apiKey: issued.data.api_key as string,
      body: { schema_version: "2026-08-27.v1", requested_tool_names: ["cargo.calculate"] },
      clientIp: "198.51.100.41",
    });
    const result = await value.bridge.executeT0({
      accessToken: exchanged.data.access_token,
      toolName: "cargo.calculate",
      input: cargoRequest(),
    });
    expect(result).toMatchObject({ status: "success" });
    expect(JSON.stringify(result)).toContain('"version":"cargo-result@2026-08-11.v1"');
    value.portalService.changeGrantState(identity("operator", "operator"), grantId, {
      idempotencyKey: "grant-suspend-00002",
      expectedVersion: 2,
      input: { state: "suspended" },
    });
    await expect(value.bridge.executeT0({
      accessToken: exchanged.data.access_token,
      toolName: "cargo.calculate",
      input: cargoRequest(),
    })).rejects.toMatchObject({ code: "machine_authorization_denied" });
  });

  it.each(["credential", "client", "tenant", "owner"] as const)("rejects an issued JWT after current %s authority is disabled", async (authority) => {
    const value = await fixture();
    const { owner, applicationId } = await approvedApplication(value);
    const issued = await value.bridge.issueCredential(owner, applicationId, {
      idempotencyKey: `credential-issue-current-${authority}`,
      input: { label: "Current authority", tool_names: ["cargo.calculate"], expires_in_seconds: 86_400 },
    });
    const credentialId = issued.data.credential.credential_id;
    await value.bridge.acknowledgeCredentialDelivery(owner, applicationId, credentialId, { idempotencyKey: `credential-ack-current-${authority}`, input: {} });
    const exchanged = await value.bridge.exchangeToken({ apiKey: issued.data.api_key as string, body: { schema_version: "2026-08-27.v1", requested_tool_names: ["cargo.calculate"] }, clientIp: "198.51.100.42" });
    const application = value.portalStore.read().applications.find((item) => item.applicationId === applicationId)!;
    if (authority === "credential") await value.tenantService.revokeCredential(adminContext(), credentialId, { schema_version: TENANT_ACCESS_SCHEMA_VERSION, reason_code: "current_authority_test" }, "revoke-current-credential");
    if (authority === "client") await value.tenantService.setClientStatus(adminContext(), "tenant_demo", application.clientId, { schema_version: TENANT_ACCESS_SCHEMA_VERSION, status: "disabled", reason_code: "current_authority_test" }, "disable-current-client");
    if (authority === "tenant") await value.tenantService.setTenantStatus(adminContext(), "tenant_demo", { schema_version: TENANT_ACCESS_SCHEMA_VERSION, status: "suspended", reason_code: "current_authority_test" }, "suspend-current-tenant");
    if (authority === "owner") value.portalStore.transact("test.owner.suspend", `suspend-current-owner-${authority}`, "owner", (data) => { data.memberships.find((item) => item.organizationId === "org_demo" && item.userId === owner.identity.userId)!.status = "suspended"; return true; });
    await expect(value.bridge.executeT0({ accessToken: exchanged.data.access_token, toolName: "cargo.calculate", input: cargoRequest() })).rejects.toMatchObject({ code: "machine_authorization_denied" });
  });

  it("rechecks Portal authority after an asynchronous tenant authority read", async () => {
    const value = await fixture();
    const { owner, applicationId } = await approvedApplication(value);
    const issued = await value.bridge.issueCredential(owner, applicationId, { idempotencyKey: "credential-issue-race-01", input: { label: "Race", tool_names: ["cargo.calculate"], expires_in_seconds: 86_400 } });
    await value.bridge.acknowledgeCredentialDelivery(owner, applicationId, issued.data.credential.credential_id, { idempotencyKey: "credential-ack-race-0001", input: {} });
    const exchanged = await value.bridge.exchangeToken({ apiKey: issued.data.api_key as string, body: { schema_version: "2026-08-27.v1", requested_tool_names: ["cargo.calculate"] }, clientIp: "198.51.100.43" });
    const original = value.tenantService.getState.bind(value.tenantService);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(value.tenantService, "getState").mockImplementationOnce(async (...args) => { const state = await original(...args); await gate; return state; });
    const executing = value.bridge.executeT0({ accessToken: exchanged.data.access_token, toolName: "cargo.calculate", input: cargoRequest() });
    await Promise.resolve();
    value.portalStore.transact("test.owner.suspend", "suspend-owner-during-read", "owner", (data) => { data.memberships.find((item) => item.organizationId === "org_demo" && item.userId === owner.identity.userId)!.status = "suspended"; return true; });
    release();
    await expect(executing).rejects.toMatchObject({ code: "machine_authorization_denied" });
  });

  it("denies credential issuance to a platform reviewer even with an organization membership", async () => {
    const value = await fixture();
    const { owner, applicationId } = await approvedApplication(value);
    const dualRole = identity("dual_role", "reviewer");
    const invitation = value.portalService.inviteMember(owner, {
      idempotencyKey: "invite-dual-role-0001",
      input: {
        email: dualRole.identity.email,
        role: "developer",
        expiresAt: new Date((NOW_SECONDS + 3_600) * 1_000).toISOString(),
      },
    });
    value.portalService.claimInvitation(
      dualRole,
      (invitation.data as { invitationId: string }).invitationId,
      "claim-dual-role-00001",
    );

    await expect(value.bridge.issueCredential(dualRole, applicationId, {
      idempotencyKey: "reviewer-issue-denied-001",
      input: { label: "Forbidden key", tool_names: ["cargo.calculate"], expires_in_seconds: 86_400 },
    })).rejects.toMatchObject({ code: "application_access_denied" });
    expect((await value.tenantService.getState(adminContext())).data.credentials).toEqual([]);
  });

  it("withholds a replayed rotation secret and rejects the revoked replacement", async () => {
    const value = await fixture();
    const { owner, applicationId } = await approvedApplication(value);
    const issued = await value.bridge.issueCredential(owner, applicationId, {
      idempotencyKey: "credential-issue-0003",
      input: { label: "Rotating key", tool_names: ["cargo.calculate"], expires_in_seconds: 86_400 },
    });
    const originalCredentialId = issued.data.credential.credential_id;
    await value.bridge.acknowledgeCredentialDelivery(owner, applicationId, originalCredentialId, {
      idempotencyKey: "credential-ack-00003",
      input: {},
    });
    const rotation = {
      idempotencyKey: "credential-rotate-0001",
      input: { tool_names: ["cargo.calculate"] as const, expires_in_seconds: 86_400 },
    };
    const rotated = await value.bridge.rotateCredential(
      owner,
      applicationId,
      originalCredentialId,
      rotation,
    );
    const replayed = await value.bridge.rotateCredential(
      owner,
      applicationId,
      originalCredentialId,
      rotation,
    );
    expect(rotated).toMatchObject({ status: "success", replayed: false, secret_delivery: { status: "one_time" } });
    expect(rotated.data.api_key).toMatch(/^lmcpk_/u);
    expect(replayed).toMatchObject({
      status: "manual_review",
      replayed: true,
      secret_delivery: { status: "withheld" },
      data: { api_key: null },
    });
    const rotatedCredentialId = rotated.data.credential.credential_id;
    await value.bridge.acknowledgeCredentialDelivery(owner, applicationId, rotatedCredentialId, {
      idempotencyKey: "credential-ack-rotated-0001",
      input: {},
    });
    await value.bridge.revokeCredential(owner, applicationId, rotatedCredentialId, {
      idempotencyKey: "credential-revoke-00001",
      input: {},
    });
    await expect(value.bridge.exchangeToken({
      apiKey: rotated.data.api_key as string,
      body: { schema_version: "2026-08-27.v1", requested_tool_names: ["cargo.calculate"] },
      clientIp: "198.51.100.42",
    })).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("requires a dedicated REST audience in production mode", async () => {
    const value = await fixture();
    expect(() => createPortalAccessBridge({
      ...value.bridgeOptions,
      dataMode: "production",
    })).toThrowError(expect.objectContaining({ code: "rest_audience_not_isolated" }));
  });

  it("refuses production local execution when no MCP Runtime port is configured", async () => {
    const value = await fixture();
    expect(() => createPortalAccessBridge({ ...value.bridgeOptions, dataMode: "production",
      restTokenPolicy: { ...value.bridgeOptions.restTokenPolicy, audience: "portal-rest" },
    })).toThrow("runtime_executor_required");
  });
});
