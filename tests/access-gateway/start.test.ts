import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalJWKSet, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { FileSecretPepperProvider } from "../../services/access-gateway/production-crypto";
import {
  adminIdentityConfigurationFromEnvironment,
  evaluateAccessGatewayReadiness,
  gatewaySecretPaths,
  initializeAccessGatewayState,
  startAccessGateway,
} from "../../services/access-gateway/start";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import { SqliteTenantAccessStore } from "../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import {
  TENANT_ACCESS_SCHEMA_VERSION,
  TenantAccessService,
} from "../../src/logistics_mcp/control-plane/tenant-access-service";

const roots: string[] = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Port allocation failed.");
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error === undefined ? resolvePromise() : reject(error));
  });
  return address.port;
}

function admin() {
  return parseExecutionContext({
    tenant_id: "tenant_management",
    actor_id: "admin_operator",
    actor_role: "admin",
    roles: ["admin"],
    scopes: ["platform:admin", "tenant:admin"],
    client_id: "bootstrap",
    session_id: "bootstrap_session",
    expires_at: 1_900_000_000,
  });
}

const ENV_KEYS = [
  "ACCESS_GATEWAY_PROFILE",
  "ACCESS_GATEWAY_APPLICATION_ROOT",
  "ACCESS_GATEWAY_INSTANCE_ID",
  "ACCESS_GATEWAY_MANAGEMENT_TENANT_ID",
  "ACCESS_GATEWAY_JWT_ISSUER",
  "ACCESS_GATEWAY_JWT_AUDIENCE",
  "ACCESS_GATEWAY_PEPPER_VERSION",
  "ACCESS_GATEWAY_LEGACY_PEPPER_VERSION",
  "ACCESS_GATEWAY_PEPPER_HISTORY_PATH",
  "ACCESS_GATEWAY_ALLOWED_HOSTS",
  "ACCESS_GATEWAY_ALLOWED_ORIGINS",
  "ACCESS_GATEWAY_TRUSTED_PROXY_ADDRESSES",
  "ACCESS_GATEWAY_PORT",
  "ACCESS_GATEWAY_ADMIN_JWKS_URL",
  "ACCESS_GATEWAY_ADMIN_JWKS_HOST",
  "ACCESS_GATEWAY_ADMIN_ISSUER",
  "ACCESS_GATEWAY_ADMIN_AUDIENCE",
  "ACCESS_GATEWAY_ADMIN_IDENTITY_MODE",
  "ACCESS_GATEWAY_ADMIN_ALLOWED_EMAILS",
  "ACCESS_GATEWAY_ADMIN_ALLOWED_SUBJECTS",
  "ACCESS_GATEWAY_ADMIN_MAX_TOKEN_AGE_SECONDS",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("standalone Access Gateway runtime", () => {
  it("builds an explicit Cloudflare Access administrator mapping without secrets or broad roles", () => {
    expect(adminIdentityConfigurationFromEnvironment({
      ACCESS_GATEWAY_ADMIN_JWKS_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
      ACCESS_GATEWAY_ADMIN_JWKS_HOST: "team.cloudflareaccess.com",
      ACCESS_GATEWAY_ADMIN_ISSUER: "https://team.cloudflareaccess.com",
      ACCESS_GATEWAY_ADMIN_AUDIENCE: "app-audience",
      ACCESS_GATEWAY_ADMIN_IDENTITY_MODE: "cloudflare-access",
      ACCESS_GATEWAY_ADMIN_ALLOWED_EMAILS: "admin@example.com,security@example.com",
      ACCESS_GATEWAY_ADMIN_ALLOWED_SUBJECTS: "subject-1,subject-2",
      ACCESS_GATEWAY_ADMIN_MAX_TOKEN_AGE_SECONDS: "900",
    }, "tenant_management")).toEqual({
      configured: true,
      options: {
        jwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
        allowedHosts: ["team.cloudflareaccess.com"],
        issuer: "https://team.cloudflareaccess.com",
        audience: "app-audience",
        managementTenantId: "tenant_management",
        claimMode: "cloudflare-access",
        allowedEmails: ["admin@example.com", "security@example.com"],
        allowedSubjects: ["subject-1", "subject-2"],
        maxTokenAgeSeconds: 900,
      },
    });
  });

  it("fails closed when Cloudflare Access has no explicit administrator mapping", () => {
    expect(() => adminIdentityConfigurationFromEnvironment({
      ACCESS_GATEWAY_ADMIN_JWKS_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
      ACCESS_GATEWAY_ADMIN_JWKS_HOST: "team.cloudflareaccess.com",
      ACCESS_GATEWAY_ADMIN_ISSUER: "https://team.cloudflareaccess.com",
      ACCESS_GATEWAY_ADMIN_AUDIENCE: "app-audience",
      ACCESS_GATEWAY_ADMIN_IDENTITY_MODE: "cloudflare-access",
    }, "tenant_management")).toThrow(/ALLOWED_EMAILS/u);
  });

  it("fails readiness closed when a configured administrator IdP is unavailable", () => {
    expect(evaluateAccessGatewayReadiness({
      tenantStoreReady: true,
      operationStoreReady: true,
      signingKeyCount: 1,
      adminConfigured: true,
      adminReady: false,
    })).toEqual({
      httpStatus: 503,
      status: "unavailable",
      operationalReady: false,
      blockers: [
        "enterprise_idp_unavailable",
        "kms_signer_unconfigured",
        "managed_database_unconfigured",
      ],
    });
  });

  it("removes every artifact from a failed initialization so a safe retry can succeed", async () => {
    const applicationRoot = mkdtempSync(join(tmpdir(), "logistics-mcp-access-init-"));
    roots.push(applicationRoot);
    await expect(initializeAccessGatewayState({
      applicationRoot,
      instanceId: "invalid instance id",
      managementTenantId: "tenant_management",
    })).rejects.toBeDefined();
    const secrets = gatewaySecretPaths(applicationRoot);
    expect(existsSync(secrets.secretsDir)).toBe(false);
    expect(existsSync(join(applicationRoot, ".runtime", "mcp-tenant-access"))).toBe(false);
    expect(existsSync(join(applicationRoot, ".runtime", "access-gateway-operations"))).toBe(false);

    const initialized = await initializeAccessGatewayState({
      applicationRoot,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
    });
    expect(initialized.jwtPublicKeySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(initialized.pepperSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("serves candidate readiness, JWKS and a real API Key to short JWT exchange", async () => {
    const applicationRoot = mkdtempSync(join(tmpdir(), "logistics-mcp-access-runtime-"));
    roots.push(applicationRoot);
    mkdirSync(join(applicationRoot, "placeholder"));
    await initializeAccessGatewayState({
      applicationRoot,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
    });
    const secrets = gatewaySecretPaths(applicationRoot);
    const pepper = new FileSecretPepperProvider({
      pepperPath: secrets.credentialPepperPath,
      pepperVersion: "pepper-2026-08-v1",
      historyPath: secrets.credentialPepperHistoryPath,
    });
    const store = new SqliteTenantAccessStore({
      applicationRoot,
      instanceId: "gateway_01",
      managementTenantId: "tenant_management",
    });
    const service = new TenantAccessService(store, {
      credentialSecretProvider: {
        pepperVersion: pepper.pepperVersion,
        hash: (secret, salt) => pepper.hashCredentialSecret({
          secret,
          salt,
          pepperVersion: pepper.pepperVersion,
        }),
        verify: (secret, salt, expectedHash, pepperVersion) => pepper.verifyCredentialSecret({
          secret,
          material: { salt, expectedHash, pepperVersion },
        }),
      },
    });
    await service.createTenant(admin(), {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: "tenant_demo",
      display_name: "Demo",
    }, "bootstrap-tenant-idem-0001");
    const issued = await service.issueCredential(admin(), {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: "tenant_demo",
      client_id: "codex_ops",
      label: "Codex",
      tool_names: ["cargo.calculate"],
      expires_in_seconds: 86_400,
    }, "bootstrap-key-idem-0001");
    if (issued.data.api_key === null) throw new Error("Bootstrap key was withheld.");
    await service.acknowledgeCredentialDelivery(admin(), issued.data.credential.credential_id, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      reason_code: "operator_confirmed_secure_storage",
    }, "bootstrap-ack-idem-0001");
    await store.close();

    const port = await availablePort();
    const host = `127.0.0.1:${port}`;
    const origin = `http://${host}`;
    Object.assign(process.env, {
      ACCESS_GATEWAY_PROFILE: "single-node-candidate",
      ACCESS_GATEWAY_APPLICATION_ROOT: applicationRoot,
      ACCESS_GATEWAY_INSTANCE_ID: "gateway_01",
      ACCESS_GATEWAY_MANAGEMENT_TENANT_ID: "tenant_management",
      ACCESS_GATEWAY_JWT_ISSUER: "https://www.freightclaw.net/",
      ACCESS_GATEWAY_JWT_AUDIENCE: "logistics-mcp-t0",
      ACCESS_GATEWAY_PEPPER_VERSION: "pepper-2026-08-v1",
      ACCESS_GATEWAY_ALLOWED_HOSTS: host,
      ACCESS_GATEWAY_ALLOWED_ORIGINS: origin,
      ACCESS_GATEWAY_TRUSTED_PROXY_ADDRESSES: "192.0.2.10",
      ACCESS_GATEWAY_PORT: String(port),
    });
    const runtime = await startAccessGateway();
    try {
      const readiness = await fetch(`${origin}/access/v1/readyz`);
      expect(readiness.status).toBe(200);
      const readinessBody = await readiness.json() as {
        readonly status: string;
        readonly data: { readonly operational_ready: boolean; readonly production_eligible: boolean };
        readonly blockers: readonly string[];
      };
      expect(readinessBody).toMatchObject({
        status: "manual_review",
        data: { operational_ready: true, production_eligible: false },
      });
      expect(readinessBody.blockers).toEqual(expect.arrayContaining([
        "enterprise_idp_unconfigured",
        "kms_signer_unconfigured",
        "managed_database_unconfigured",
      ]));
      const consoleResponse = await fetch(`${origin}/`);
      expect(consoleResponse.status).toBe(200);
      expect(await consoleResponse.text()).toContain("租户与 API Key");
      const operationsOverview = await fetch(`${origin}/admin/api/v1/access/overview`);
      expect(operationsOverview.status).toBe(401);
      expect(await operationsOverview.json()).toMatchObject({
        schema_version: "2026-08-30.v1",
        status: "blocked",
        reason_codes: ["authentication_failed"],
      });

      for (const adminPath of ["/admin", "/admin/"] as const) {
        const adminResponse = await fetch(`${origin}${adminPath}`, { redirect: "manual" });
        expect(adminResponse.status).toBe(308);
        expect(adminResponse.headers.get("location")).toBe("/access-console/");
        expect(adminResponse.headers.get("cache-control")).toBe("no-store");
      }

      const exchange = await fetch(`${origin}/access/v1/token/exchange`, {
        method: "POST",
        headers: {
          authorization: `ApiKey ${issued.data.api_key}`,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema_version: "2026-08-27.v1",
          requested_tool_names: ["cargo.calculate"],
        }),
      });
      expect(exchange.status).toBe(200);
      const exchangeBody = await exchange.json() as {
        data: { access_token: string; expires_in: number };
      };
      expect(exchangeBody.data.expires_in).toBe(300);
      const jwksResponse = await fetch(`${origin}/.well-known/jwks.json`);
      expect(jwksResponse.status).toBe(200);
      const jwks = await jwksResponse.json() as { keys: Record<string, unknown>[] };
      const verified = await jwtVerify(
        exchangeBody.data.access_token,
        createLocalJWKSet(jwks),
        {
          algorithms: ["RS256"],
          issuer: "https://www.freightclaw.net/",
          audience: "logistics-mcp-t0",
        },
      );
      expect(verified.payload).toMatchObject({
        tenant_id: "tenant_demo",
        client_id: "codex_ops",
        scopes: ["tool:cargo.calculate"],
      });
    } finally {
      await runtime.close();
    }
  });
});
