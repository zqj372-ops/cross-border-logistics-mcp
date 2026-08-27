import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSecretPepperProvider } from "../../services/access-gateway/production-crypto";
import {
  SqliteGatewayOperationalStore,
  TenantAccessGatewayRepository,
  gatewayOperationalPaths,
  initializeSqliteGatewayOperationalState,
} from "../../services/access-gateway/production-store";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  SqliteTenantAccessStore,
  initializeSqliteTenantAccessState,
} from "../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import {
  TENANT_ACCESS_SCHEMA_VERSION,
  TenantAccessService,
} from "../../src/logistics_mcp/control-plane/tenant-access-service";

const roots: string[] = [];

function root() {
  const value = mkdtempSync(join(tmpdir(), "logistics-mcp-gateway-store-"));
  mkdirSync(join(value, ".runtime"), { mode: 0o700 });
  roots.push(value);
  return value;
}

function admin() {
  return parseExecutionContext({
    tenant_id: "tenant_management",
    actor_id: "admin_operator",
    actor_role: "admin",
    roles: ["admin"],
    scopes: ["platform:admin", "tenant:admin"],
    client_id: "access_console",
    session_id: "admin_session",
    expires_at: 1_900_000_000,
  });
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("production gateway SQLite providers", () => {
  it("persists redacted credentials, audit and shared rate reservations", async () => {
    const applicationRoot = root();
    const pepperPath = join(applicationRoot, "pepper");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(pepperPath, Buffer.alloc(48, 0x4d), { mode: 0o400 });
    const pepper = new FileSecretPepperProvider({
      pepperPath,
      pepperVersion: "pepper-2026-08-v1",
    });
    await initializeSqliteTenantAccessState({
      applicationRoot,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
    });
    await initializeSqliteGatewayOperationalState({
      applicationRoot,
      instanceId: "gateway_01",
    });
    const paths = gatewayOperationalPaths(applicationRoot);
    expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.databasePath).mode & 0o777).toBe(0o600);

    const tenantStore = new SqliteTenantAccessStore({
      applicationRoot,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
    });
    const service = new TenantAccessService(tenantStore, {
      clock: () => 1_800_000_000,
      idGenerator: (() => {
        let sequence = 0;
        return (prefix: "event" | "key") => `${prefix}_${String(++sequence).padStart(8, "0")}`;
      })(),
      secretGenerator: () => "A".repeat(43),
      saltGenerator: () => new Uint8Array(16).fill(3),
      credentialSecretProvider: {
        hash: (secret, salt) => pepper.hashCredentialSecret({
          secret,
          salt,
          pepperVersion: pepper.pepperVersion,
        }),
        verify: (secret, salt, expectedHash) => pepper.verifyCredentialSecret({
          secret,
          material: { salt, expectedHash, pepperVersion: pepper.pepperVersion },
        }),
      },
    });
    await service.createTenant(admin(), {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: "tenant_demo",
      display_name: "Demo",
    }, "create-tenant-idem-0001");
    const issued = await service.issueCredential(admin(), {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: "tenant_demo",
      client_id: "codex_ops",
      label: "Codex",
      tool_names: ["cargo.calculate"],
      expires_in_seconds: 86_400,
    }, "issue-credential-idem-0001");
    await service.acknowledgeCredentialDelivery(admin(), issued.data.credential.credential_id, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      reason_code: "operator_confirmed_secure_storage",
    }, "ack-credential-idem-0001");

    const credentials = new TenantAccessGatewayRepository({
      store: tenantStore,
      pepperVersion: pepper.pepperVersion,
      nowSeconds: () => 1_800_000_000,
    });
    const record = await credentials.findForExchange(issued.data.credential.credential_id);
    expect(record).toMatchObject({
      tenant: { tenantId: "tenant_demo", status: "active" },
      client: { clientId: "codex_ops", status: "active" },
      credential: {
        deliveryStatus: "acknowledged",
        toolNames: ["cargo.calculate"],
        pepperVersion: "pepper-2026-08-v1",
      },
    });
    expect(JSON.stringify(await credentials.listState())).not.toMatch(/secretHash|secretSalt/u);
    await expect(credentials.markUsed(
      issued.data.credential.credential_id,
      "2027-01-15T08:00:00.000Z",
      1_800_000_000,
    )).resolves.toBe(true);
    await service.setClientStatus(admin(), "tenant_demo", "codex_ops", {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      status: "disabled",
      reason_code: "operator_disabled",
    }, "disable-client-idem-0001");
    await expect(credentials.findForExchange(
      issued.data.credential.credential_id,
    )).resolves.toMatchObject({ client: { status: "disabled" } });
    const disabledState = await credentials.listState();
    expect(disabledState).toMatchObject({
      clients: [{ clientId: "codex_ops", status: "disabled" }],
      credentials: [{ effectiveStatus: "client_disabled" }],
    });
    expect(disabledState.operations).toContainEqual(expect.objectContaining({
      action: "client.disable",
      clientId: "codex_ops",
    }));
    await expect(credentials.markUsed(
      issued.data.credential.credential_id,
      "2027-01-15T08:01:00.000Z",
      1_800_000_060,
    )).resolves.toBe(false);
    await expect(credentials.isRevoked({
      tenantId: "tenant_demo",
      clientId: "codex_ops",
      credentialId: issued.data.credential.credential_id,
      jti: "jwt_existing_0001",
    })).resolves.toBe(true);

    const operations = new SqliteGatewayOperationalStore({
      applicationRoot,
      instanceId: "gateway_01",
      rateLimitPerMinute: 2,
    });
    const reservation = {
      tenantId: "tenant_demo",
      clientId: "codex_ops",
      credentialId: issued.data.credential.credential_id,
      clientIp: "203.0.113.10",
      nowSeconds: 1_800_000_000,
    };
    await expect(operations.reserve(reservation)).resolves.toBe(true);
    await expect(operations.reserve({
      ...reservation,
      clientId: "enterprise_agent",
      credentialId: "key_other_0001",
      clientIp: "203.0.113.11",
    })).resolves.toBe(true);
    await expect(operations.reserve({
      ...reservation,
      clientId: "chatgpt_ops",
      credentialId: "key_other_0002",
      clientIp: "203.0.113.12",
    })).resolves.toBe(false);

    const nextWindow = reservation.nowSeconds + 60;
    await expect(operations.reserve({
      ...reservation,
      tenantId: "tenant_other_a",
      clientId: "client_other_a",
      credentialId: "key_other_a",
      nowSeconds: nextWindow,
    })).resolves.toBe(true);
    await expect(operations.reserve({
      ...reservation,
      tenantId: "tenant_other_b",
      clientId: "client_other_b",
      credentialId: "key_other_b",
      nowSeconds: nextWindow,
    })).resolves.toBe(true);
    await expect(operations.reserve({
      ...reservation,
      tenantId: "tenant_other_c",
      clientId: "client_other_c",
      credentialId: "key_other_c",
      nowSeconds: nextWindow,
    })).resolves.toBe(false);
    await operations.append({
      auditId: "audit_00000001",
      action: "token.exchange",
      status: "success",
      requestId: "req_00000001",
      tenantId: "tenant_demo",
      clientId: "codex_ops",
      credentialId: issued.data.credential.credential_id,
      toolNames: ["cargo.calculate"],
      requestHash: "sha256:v1:" + "a".repeat(64),
      jti: "jwt_00000001",
      reasonCode: null,
      createdAt: "2027-01-15T08:00:00.000Z",
    });
    await expect(operations.health()).resolves.toEqual({ ready: true, auditCount: 1 });

    await operations.close();
    await tenantStore.close();
  });
});
