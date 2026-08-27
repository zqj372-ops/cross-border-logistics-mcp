import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  SqliteTenantAccessStore,
  initializeSqliteTenantAccessState,
  tenantAccessPaths,
} from "../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import {
  TENANT_ACCESS_SCHEMA_VERSION,
  TenantAccessError,
  TenantAccessService,
} from "../../src/logistics_mcp/control-plane/tenant-access-service";

const temporaryRoots: string[] = [];
const stores: SqliteTenantAccessStore[] = [];

function applicationRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "logistics-mcp-tenant-access-"));
  mkdirSync(join(root, ".runtime"), { mode: 0o700 });
  temporaryRoots.push(root);
  return root;
}

function adminContext() {
  return parseExecutionContext({
    tenant_id: "tenant_management",
    actor_id: "admin_operator",
    actor_role: "admin",
    roles: ["admin"],
    scopes: ["platform:admin", "tenant:admin"],
    client_id: "admin_console",
    session_id: "admin_session",
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
  });
}

async function serviceFixture(options: {
  readonly nowSeconds?: number;
  readonly secrets?: readonly string[];
} = {}) {
  const root = applicationRoot();
  await initializeSqliteTenantAccessState({
    applicationRoot: root,
    instanceId: "instance_fixture_001",
    managementTenantId: "tenant_management",
  });
  const store = new SqliteTenantAccessStore({
    applicationRoot: root,
    instanceId: "instance_fixture_001",
    managementTenantId: "tenant_management",
  });
  stores.push(store);
  let nowSeconds = options.nowSeconds ?? 1_800_000_000;
  const secrets = [...(options.secrets ?? [
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  ])];
  let identifier = 0;
  const service = new TenantAccessService(store, {
    clock: () => nowSeconds,
    idGenerator: (prefix) => `${prefix}_${String(++identifier).padStart(8, "0")}`,
    secretGenerator: () => {
      const value = secrets.shift();
      if (value === undefined) throw new Error("test secret exhausted");
      return value;
    },
  });
  return {
    root,
    store,
    service,
    setNow(value: number) {
      nowSeconds = value;
    },
  };
}

async function createTenant(service: TenantAccessService) {
  return service.createTenant(
    adminContext(),
    {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: "tenant_demo_a",
      display_name: "北美演示租户",
    },
    "idem_create_tenant_0001",
  );
}

async function issueCredential(service: TenantAccessService, idempotencyKey: string) {
  return service.issueCredential(
    adminContext(),
    {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: "tenant_demo_a",
      client_id: "codex_ops",
      label: "运营 Codex",
      tool_names: ["cargo.calculate", "container.plan_summary"],
      expires_in_seconds: 86_400,
    },
    idempotencyKey,
  );
}

async function acknowledgeCredential(
  service: TenantAccessService,
  credentialId: string,
  idempotencyKey: string,
) {
  return service.acknowledgeCredentialDelivery(
    adminContext(),
    credentialId,
    {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      reason_code: "operator_confirmed_secure_storage",
    },
    idempotencyKey,
  );
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Tenant Access SQLite store and service", () => {
  it("uses explicit secure initialization and rejects identity drift", async () => {
    const root = applicationRoot();
    const paths = tenantAccessPaths(root);
    expect(() => new SqliteTenantAccessStore({
      applicationRoot: root,
      instanceId: "instance_fixture_001",
      managementTenantId: "tenant_management",
    })).toThrow(TenantAccessError);

    await initializeSqliteTenantAccessState({
      applicationRoot: root,
      instanceId: "instance_fixture_001",
      managementTenantId: "tenant_management",
    });
    expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.databasePath).mode & 0o777).toBe(0o600);
    expect(statSync(paths.markerPath).mode & 0o777).toBe(0o400);

    const store = new SqliteTenantAccessStore({
      applicationRoot: root,
      instanceId: "instance_fixture_001",
      managementTenantId: "tenant_management",
    });
    stores.push(store);
    await expect(store.health()).resolves.toEqual({ ready: true });
    expect(() => new SqliteTenantAccessStore({
      applicationRoot: root,
      instanceId: "instance_other",
      managementTenantId: "tenant_management",
    })).toThrow(TenantAccessError);
  });

  it("migrates an existing v1 credential store through v3 with explicit pepper provenance", async () => {
    const root = applicationRoot();
    const canonicalRoot = realpathSync(root);
    const paths = tenantAccessPaths(canonicalRoot);
    mkdirSync(paths.stateDir, { mode: 0o700 });
    const storeId = "access_11111111111111111111111111111111";
    const legacy = new DatabaseSync(paths.databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE access_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        access_store_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        management_tenant_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE tenants (
        tenant_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE credentials (
        credential_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        client_id TEXT NOT NULL,
        label TEXT NOT NULL,
        actor_role TEXT NOT NULL CHECK (actor_role = 'service'),
        roles_json TEXT NOT NULL CHECK (roles_json = '["service"]'),
        scopes_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        key_prefix TEXT NOT NULL,
        secret_last_four TEXT NOT NULL,
        secret_salt BLOB NOT NULL,
        secret_hash BLOB NOT NULL,
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        rotated_from_id TEXT REFERENCES credentials(credential_id)
      ) STRICT;
      CREATE TABLE access_events (
        event_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        credential_id TEXT REFERENCES credentials(credential_id),
        actor_ref TEXT NOT NULL,
        action TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE access_idempotency (
        action TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (action, idempotency_key)
      ) STRICT;
    `);
    legacy.prepare(`
      INSERT INTO access_meta VALUES (1, 1, ?, 'instance_fixture_001', 'tenant_management')
    `).run(storeId);
    legacy.prepare(`
      INSERT INTO tenants VALUES (
        'tenant_demo_a', '北美演示租户', 'active',
        '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'
      )
    `).run();
    legacy.prepare(`
      INSERT INTO credentials VALUES (
        'key_legacy_0001', 'tenant_demo_a', 'codex_ops', '运营 Codex',
        'service', '["service"]', '["tool:cargo.calculate"]', 'active',
        'lmcpk_key_legacy_0001', 'AAAA', ?, ?,
        '2026-08-27T00:00:00.000Z', 1802505600, '2026-08-27T00:01:00.000Z',
        NULL, NULL
      )
    `).run(Buffer.alloc(16, 1), Buffer.alloc(32, 2));
    legacy.prepare(`
      INSERT INTO access_events VALUES (
        'event_tenant_legacy', 'tenant_demo_a', NULL, 'admin:console',
        'tenant.created', 'operator_created', '2026-08-27T00:00:00.000Z'
      )
    `).run();
    legacy.prepare(`
      INSERT INTO access_events VALUES (
        'event_key_legacy', 'tenant_demo_a', 'key_legacy_0001', 'admin:console',
        'credential.delivery_acknowledged', 'operator_acknowledged',
        '2026-08-27T00:00:30.000Z'
      )
    `).run();
    legacy.close();
    chmodSync(paths.databasePath, 0o600);
    writeFileSync(paths.markerPath, `${JSON.stringify({
      marker_format: "mcp-tenant-access-identity/v1",
      schema_version: 1,
      access_store_id: storeId,
      application_root: canonicalRoot,
      database_path: paths.databasePath,
      instance_id: "instance_fixture_001",
      management_tenant_id: "tenant_management",
    }, null, 2)}\n`, { mode: 0o400 });
    chmodSync(paths.markerPath, 0o400);

    expect(() => new SqliteTenantAccessStore({
      applicationRoot: root,
      instanceId: "instance_fixture_001",
      managementTenantId: "tenant_management",
    })).toThrow(TenantAccessError);
    const unchanged = new DatabaseSync(paths.databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    expect(unchanged.prepare("SELECT schema_version FROM access_meta WHERE singleton = 1").get())
      .toEqual({ schema_version: 1 });
    unchanged.close();

    const migrated = new SqliteTenantAccessStore({
      applicationRoot: root,
      instanceId: "instance_fixture_001",
      managementTenantId: "tenant_management",
      legacyCredentialPepperVersion: "pepper-legacy-v1",
    });
    stores.push(migrated);
    const migratedState = await migrated.getState();
    expect(migratedState.clients).toEqual([{
        tenantId: "tenant_demo_a",
        clientId: "codex_ops",
        label: "运营 Codex",
        status: "active",
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:01:00.000Z",
    }]);
    expect(migratedState.events).toContainEqual(expect.objectContaining({
      eventId: "event_key_legacy",
      clientId: "codex_ops",
    }));
    expect(migratedState.events).toContainEqual(expect.objectContaining({
      eventId: "event_tenant_legacy",
      clientId: null,
    }));
    expect(migratedState.credentials[0]?.pepperVersion).toBe("pepper-legacy-v1");
    expect(JSON.parse(readFileSync(paths.markerPath, "utf8"))).toMatchObject({ schema_version: 3 });
    await migrated.close();

    const reopened = new SqliteTenantAccessStore({
      applicationRoot: root,
      instanceId: "instance_fixture_001",
      managementTenantId: "tenant_management",
    });
    stores.push(reopened);
    await expect(reopened.health()).resolves.toEqual({ ready: true });
  });

  it("creates tenants idempotently and rejects conflicting replays", async () => {
    const { service } = await serviceFixture();
    await expect(createTenant(service)).resolves.toMatchObject({
      status: "success",
      replayed: false,
      data: { tenant: { tenant_id: "tenant_demo_a", status: "active" } },
    });
    await expect(createTenant(service)).resolves.toMatchObject({
      status: "success",
      replayed: true,
      data: { tenant: { tenant_id: "tenant_demo_a" } },
    });
    await expect(service.createTenant(
      adminContext(),
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        tenant_id: "tenant_changed",
        display_name: "冲突租户",
      },
      "idem_create_tenant_0001",
    )).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("reveals an API key once, stores no plaintext, and authenticates into existing claims", async () => {
    const { root, service } = await serviceFixture();
    await createTenant(service);
    const issued = await issueCredential(service, "idem_issue_credential_0001");
    expect(issued).toMatchObject({
      status: "success",
      replayed: false,
      secret_delivery: { status: "one_time" },
      data: {
        credential: {
          tenant_id: "tenant_demo_a",
          client_id: "codex_ops",
          actor_role: "service",
          roles: ["service"],
          tool_names: ["cargo.calculate", "container.plan_summary"],
          status: "active",
          delivery_status: "pending",
          effective_status: "pending_delivery",
          allowed_actions: ["acknowledge_delivery", "revoke"],
        },
        operation: {
          action: "credential.issue",
          from_status: "absent",
          to_status: "pending_delivery",
          status: "success",
        },
      },
    });
    expect(issued.data.api_key).toMatch(/^lmcpk_key_[A-Za-z0-9_]+_[A-Za-z0-9_-]{43}$/);
    if (issued.data.api_key === null) throw new Error("expected one-time API key");
    const issuedApiKey = issued.data.api_key;

    const replay = await issueCredential(service, "idem_issue_credential_0001");
    expect(replay).toMatchObject({
      status: "manual_review",
      replayed: true,
      secret_delivery: { status: "withheld" },
      data: { api_key: null },
    });

    const paths = tenantAccessPaths(root);
    expect(readFileSync(paths.databasePath).includes(Buffer.from(issuedApiKey))).toBe(false);
    const state = await service.getState(adminContext());
    expect(JSON.stringify(state)).not.toContain(issuedApiKey);
    expect(JSON.stringify(state)).not.toMatch(/secret_hash|secret_salt/i);

    await expect(service.verifyApiKey(issuedApiKey)).rejects.toMatchObject({
      code: "authentication_failed",
    });

    const acknowledged = await acknowledgeCredential(
      service,
      issued.data.credential.credential_id,
      "idem_ack_credential_0001",
    );
    expect(acknowledged).toMatchObject({
      status: "success",
      data: {
        credential: {
          delivery_status: "acknowledged",
          effective_status: "active",
          allowed_actions: ["rotate", "revoke"],
        },
        operation: {
          action: "credential.delivery_acknowledge",
          from_status: "pending_delivery",
          to_status: "active",
          status: "success",
        },
      },
    });

    const claims = await service.verifyApiKey(issuedApiKey);
    expect(claims).toMatchObject({
      tenant_id: "tenant_demo_a",
      actor_role: "service",
      roles: ["service"],
      scopes: ["tool:cargo.calculate", "tool:container.plan_summary"],
      client_id: "codex_ops",
    });

    const acknowledgedState = await service.getState(adminContext());
    expect(acknowledgedState.data.operations.map((operation) => operation.operation_id)).toContain(
      acknowledged.data.operation.operation_id,
    );
  });

  it("enforces allowed transitions instead of accepting no-op or premature actions", async () => {
    const { service } = await serviceFixture();
    await createTenant(service);
    await expect(service.setTenantStatus(
      adminContext(),
      "tenant_demo_a",
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "active",
        reason_code: "operator_reactivated",
      },
      "idem_noop_tenant_status_0001",
    )).rejects.toMatchObject({ code: "tenant_status_unchanged" });

    const issued = await issueCredential(service, "idem_pending_credential_0001");
    await expect(service.rotateCredential(
      adminContext(),
      issued.data.credential.credential_id,
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        tool_names: ["system.agent_context.get"],
        expires_in_seconds: 86_400,
        reason_code: "scheduled_rotation",
      },
      "idem_rotate_pending_0001",
    )).rejects.toMatchObject({ code: "credential_delivery_pending" });

    await service.setTenantStatus(
      adminContext(),
      "tenant_demo_a",
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "suspended",
        reason_code: "operator_suspended",
      },
      "idem_suspend_pending_tenant_0001",
    );
    const suspended = await service.getState(adminContext());
    expect(suspended.data.credentials).toContainEqual(expect.objectContaining({
      credential_id: issued.data.credential.credential_id,
      effective_status: "tenant_suspended",
      allowed_actions: ["revoke"],
    }));
    await expect(acknowledgeCredential(
      service,
      issued.data.credential.credential_id,
      "idem_ack_suspended_credential_0001",
    )).rejects.toMatchObject({ code: "tenant_not_active" });
  });

  it("fails closed for disallowed scopes, suspended tenants, expiry, revoke, and rotation", async () => {
    const fixture = await serviceFixture({ nowSeconds: 1_800_000_000 });
    const { service } = fixture;
    await createTenant(service);
    await expect(service.issueCredential(
      adminContext(),
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        tenant_id: "tenant_demo_a",
        client_id: "bad_client",
        label: "越权客户端",
        tool_names: ["quote.save_draft"],
        expires_in_seconds: 86_400,
      },
      "idem_bad_scope_0001",
    )).rejects.toMatchObject({ code: "scope_not_allowed" });

    const issued = await issueCredential(service, "idem_issue_credential_0002");
    if (issued.data.api_key === null) throw new Error("expected one-time API key");
    const issuedApiKey = issued.data.api_key;
    await acknowledgeCredential(
      service,
      issued.data.credential.credential_id,
      "idem_ack_credential_0002",
    );
    await service.setTenantStatus(
      adminContext(),
      "tenant_demo_a",
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "suspended",
        reason_code: "operator_suspended",
      },
      "idem_suspend_tenant_0001",
    );
    await expect(service.verifyApiKey(issuedApiKey)).rejects.toMatchObject({
      code: "authentication_failed",
    });

    await service.setTenantStatus(
      adminContext(),
      "tenant_demo_a",
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "active",
        reason_code: "operator_reactivated",
      },
      "idem_activate_tenant_0001",
    );
    const rotated = await service.rotateCredential(
      adminContext(),
      issued.data.credential.credential_id,
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        tool_names: ["system.agent_context.get"],
        expires_in_seconds: 86_400,
        reason_code: "scheduled_rotation",
      },
      "idem_rotate_credential_0001",
    );
    if (rotated.data.api_key === null) throw new Error("expected rotated API key");
    const rotatedApiKey = rotated.data.api_key;
    await expect(service.verifyApiKey(issuedApiKey)).rejects.toMatchObject({
      code: "authentication_failed",
    });
    await expect(service.verifyApiKey(rotatedApiKey)).rejects.toMatchObject({
      code: "authentication_failed",
    });
    await acknowledgeCredential(
      service,
      rotated.data.credential.credential_id,
      "idem_ack_credential_0003",
    );
    await expect(service.verifyApiKey(rotatedApiKey)).resolves.toMatchObject({
      tenant_id: "tenant_demo_a",
      scopes: ["tool:system.agent_context.get"],
    });

    const rotatedState = await service.getState(adminContext());
    const rotatedCredential = rotatedState.data.credentials.find((item) => (
      item.credential_id === rotated.data.credential.credential_id
    ));
    expect(rotatedCredential).toMatchObject({
      tool_names: ["system.agent_context.get"],
      effective_status: "active",
    });

    await service.revokeCredential(
      adminContext(),
      rotated.data.credential.credential_id,
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        reason_code: "operator_revoked",
      },
      "idem_revoke_credential_0001",
    );
    await expect(service.verifyApiKey(rotatedApiKey)).rejects.toMatchObject({
      code: "authentication_failed",
    });

    const expiring = await issueCredential(service, "idem_issue_credential_0003");
    if (expiring.data.api_key === null) throw new Error("expected expiring API key");
    await acknowledgeCredential(
      service,
      expiring.data.credential.credential_id,
      "idem_ack_credential_0004",
    );
    fixture.setNow(1_800_086_400);
    await expect(service.verifyApiKey(expiring.data.api_key)).rejects.toMatchObject({
      code: "authentication_failed",
    });
  });

  it("persists client disablement and blocks every credential for that client", async () => {
    const { service } = await serviceFixture();
    await createTenant(service);
    const issued = await issueCredential(service, "idem_client_issue_0001");
    if (issued.data.api_key === null) throw new Error("expected one-time API key");
    await acknowledgeCredential(
      service,
      issued.data.credential.credential_id,
      "idem_client_ack_0001",
    );

    await expect(service.setClientStatus(
      adminContext(),
      "tenant_demo_a",
      "codex_ops",
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "disabled",
        reason_code: "compromised_client",
      },
      "idem_client_disable_0001",
    )).resolves.toMatchObject({
      status: "success",
      data: {
        client: { client_id: "codex_ops", status: "disabled" },
        operation: { action: "client.disable", from_status: "active", to_status: "disabled" },
      },
    });
    await expect(service.verifyApiKey(issued.data.api_key)).rejects.toMatchObject({
      code: "authentication_failed",
    });
    const disabled = await service.getState(adminContext());
    expect(disabled.data.clients).toEqual(expect.arrayContaining([
      expect.objectContaining({ client_id: "codex_ops", status: "disabled" }),
    ]));
    expect(disabled.data.credentials).toEqual(expect.arrayContaining([
      expect.objectContaining({
        credential_id: issued.data.credential.credential_id,
        effective_status: "client_disabled",
        allowed_actions: ["revoke"],
      }),
    ]));

    await service.setClientStatus(
      adminContext(),
      "tenant_demo_a",
      "codex_ops",
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "active",
        reason_code: "client_reenabled",
      },
      "idem_client_enable_0001",
    );
    await expect(service.verifyApiKey(issued.data.api_key)).resolves.toMatchObject({
      client_id: "codex_ops",
    });
  });

  it("keeps delivery state authoritative after the acknowledgement event leaves the 256-row view", async () => {
    const { service } = await serviceFixture();
    await createTenant(service);
    const issued = await issueCredential(service, "idem_history_issue_0001");
    await acknowledgeCredential(
      service,
      issued.data.credential.credential_id,
      "idem_history_ack_0001",
    );

    for (let index = 0; index < 260; index += 1) {
      const status = index % 2 === 0 ? "suspended" : "active";
      await service.setTenantStatus(
        adminContext(),
        "tenant_demo_a",
        {
          schema_version: TENANT_ACCESS_SCHEMA_VERSION,
          status,
          reason_code: `history_${status}_${index}`,
        },
        `idem_history_status_${String(index).padStart(4, "0")}`,
      );
    }

    const state = await service.getState(adminContext());
    const credential = state.data.credentials.find((value) => (
      value.credential_id === issued.data.credential.credential_id
    ));
    expect(state.data.operations).toHaveLength(256);
    expect(credential).toMatchObject({
      delivery_status: "acknowledged",
      effective_status: "active",
      allowed_actions: ["rotate", "revoke"],
    });

    await expect(service.rotateCredential(
      adminContext(),
      issued.data.credential.credential_id,
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        tool_names: ["system.agent_context.get"],
        expires_in_seconds: 86_400,
        reason_code: "history_rotation",
      },
      "idem_history_rotate_0001",
    )).resolves.toMatchObject({
      status: "success",
      data: { credential: { effective_status: "pending_delivery" } },
    });
  });

  it("treats reordered entitlement lists as the same canonical rotation request", async () => {
    const { service } = await serviceFixture({
      secrets: [
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      ],
    });
    await createTenant(service);
    const issued = await issueCredential(service, "idem_canonical_issue_0001");
    await acknowledgeCredential(
      service,
      issued.data.credential.credential_id,
      "idem_canonical_ack_0001",
    );
    const idempotencyKey = "idem_canonical_rotate_0001";
    const first = await service.rotateCredential(
      adminContext(),
      issued.data.credential.credential_id,
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        tool_names: ["container.plan_summary", "cargo.calculate"],
        expires_in_seconds: 86_400,
        reason_code: "canonical_rotation",
      },
      idempotencyKey,
    );
    const replay = await service.rotateCredential(
      adminContext(),
      issued.data.credential.credential_id,
      {
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        tool_names: ["cargo.calculate", "container.plan_summary"],
        expires_in_seconds: 86_400,
        reason_code: "canonical_rotation",
      },
      idempotencyKey,
    );

    expect(first).toMatchObject({ status: "success", replayed: false });
    expect(replay).toMatchObject({
      status: "manual_review",
      replayed: true,
      secret_delivery: { status: "withheld" },
      data: {
        credential: { credential_id: first.data.credential.credential_id },
        api_key: null,
      },
    });
  });

  it("requires the management tenant and both admin scopes", async () => {
    const { service } = await serviceFixture();
    const wrongTenant = parseExecutionContext({
      tenant_id: "tenant_other",
      actor_id: "admin_other",
      actor_role: "admin",
      roles: ["admin"],
      scopes: ["platform:admin", "tenant:admin"],
      client_id: "admin_console",
      session_id: "admin_other_session",
      expires_at: Math.floor(Date.now() / 1000) + 3_600,
    });
    await expect(service.getState(wrongTenant)).rejects.toMatchObject({
      code: "management_tenant_mismatch",
    });
    const missingScope = parseExecutionContext({
      tenant_id: "tenant_management",
      actor_id: "admin_operator",
      actor_role: "admin",
      roles: ["admin"],
      scopes: ["platform:admin"],
      client_id: "admin_console",
      session_id: "admin_session_2",
      expires_at: Math.floor(Date.now() / 1000) + 3_600,
    });
    await expect(service.getState(missingScope)).rejects.toMatchObject({
      code: "tenant_admin_scope_required",
    });
  });
});
