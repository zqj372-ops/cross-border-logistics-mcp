import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { loadPortalBusinessService } from "../../services/access-gateway/portal/business/config";
import type { PortalContext, PortalState } from "../../services/access-gateway/portal/contracts";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
const ctx: PortalContext = { identity: { userId: "user-1", displayName: "User", email: "user@example.com", emailVerified: true, platformRole: null }, organizationId: "org-1" };
function state(tenantId = "tenant-1"): PortalState { return { data_mode: "production", identity: ctx.identity, current_organization: { organizationId: "org-1", tenantId, displayName: "One", status: "active", createdAt: "2026-09-05T00:00:00.000Z" }, organizations: [{ organizationId: "org-1", displayName: "One", status: "active" }], users: [{ userId: "user-1", displayName: "User" }], memberships: [{ organizationId: "org-1", userId: "user-1", role: "viewer", status: "active", createdAt: "2026-09-05T00:00:00.000Z" }], invitations: [], applications: [], requests: [], grants: [], catalog: [], operations: [] }; }
const portal = (tenantId = "tenant-1") => ({ getState: () => ({ schema_version: "portal@2026-09-05.v1" as const, status: "success" as const, data: state(tenantId), reason_codes: [] }) });
function file(root: string, name: string, content: string, mode = 0o600): string { const path = join(root, name); writeFileSync(path, content, { mode }); chmodSync(path, mode); return path; }
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("portal business deployment configuration", () => {
  it("loads no source connection when the optional configuration path is absent", async () => {
    const service = await loadPortalBusinessService({ portalService: portal() });
    expect(service.describe(ctx).data?.operations.every((item) => !item.configured)).toBe(true);
    await expect(service.execute(ctx, "customs.query", {}, "request-1")).resolves.toMatchObject({ status: "unavailable", reason_codes: ["business_connection_unconfigured"] });
  });

  it("rejects malformed, duplicate, incomplete and unsafe explicit configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "portal-business-config-")); roots.push(root);
    const cases: unknown[] = [
      { connections: [], unknown: true },
      { connections: [], publicAccess: { organizationId: "org-1", tenantId: "tenant-1", applicationId: "app-1", clientId: "client-1", enabledOperations: ["customs.query"] } },
      { connections: [], publicAccess: { organizationId: "org-1", tenantId: "tenant-1", applicationId: "app-1", clientId: "client-1", enabledOperations: ["quote.zone_preview"] } },
      { connections: [{ organizationId: "org-1", tenantId: "tenant-1", enabledOperations: ["customs.query"], customs: { baseUrl: "https://customs.example.invalid", serviceCallerId: "caller", applicationId: "app", connectionSecretFile: "/missing", issuer: "https://issuer.example.invalid/", audience: "customs", keyId: "key", delegationPrivateKeyFile: "/missing" } }, { organizationId: "org-1", tenantId: "tenant-2", enabledOperations: ["quote.zone_preview"] }] },
      { connections: [{ organizationId: "org-1", tenantId: "tenant-1", enabledOperations: ["customs.query"] }] },
      { connections: [{ organizationId: "org-1", tenantId: "tenant-1", enabledOperations: ["customs.tax.estimate"] }] },
      { connections: [{ organizationId: "org-1", tenantId: "tenant-1", enabledOperations: ["customs.query"], customs: { baseUrl: "http://external.example.invalid", serviceCallerId: "caller", applicationId: "app", connectionSecretFile: "/missing", issuer: "https://issuer.example.invalid/", audience: "customs", keyId: "key", delegationPrivateKeyFile: "/missing" } }] },
    ];
    for (const [index, value] of cases.entries()) {
      const configPath = file(root, `invalid-${index}.json`, JSON.stringify(value), 0o644);
      await expect(loadPortalBusinessService({ portalService: portal(), configPath })).rejects.toThrow("portal_business_config_invalid");
    }
    const missingSecretConfig = file(root, "missing-secret.json", JSON.stringify({ connections: [{ organizationId: "org-1", tenantId: "tenant-1", enabledOperations: ["customs.query"], customs: { baseUrl: "https://customs.example.invalid", serviceCallerId: "caller", applicationId: "app", connectionSecretFile: "/definitely-missing-portal-secret", issuer: "https://issuer.example.invalid/", audience: "customs", keyId: "key", delegationPrivateKeyFile: "/definitely-missing-portal-key" } }] }), 0o644);
    await expect(loadPortalBusinessService({ portalService: portal(), configPath: missingSecretConfig })).rejects.toThrow("portal_business_file_invalid");
  });

  it("uses the existing customs connector for the independently enabled tax estimate operation", async () => {
    const root = mkdtempSync(join(tmpdir(), "portal-business-config-")); roots.push(root);
    const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
    const secretPath = file(root, "connection.secret", "local-connection-secret\n");
    const keyPath = file(root, "delegation.pem", await exportPKCS8(privateKey));
    const configPath = file(root, "business.json", JSON.stringify({ connections: [{
      organizationId: "org-1", tenantId: "tenant-1", enabledOperations: ["customs.tax.estimate"],
      customs: { baseUrl: "https://customs.example.invalid", serviceCallerId: "portal-bff", applicationId: "customs-app", connectionSecretFile: secretPath,
        issuer: "https://portal.example.invalid/", audience: "customs-source", keyId: "delegation-key", delegationPrivateKeyFile: keyPath },
    }] }), 0o644);
    const service = await loadPortalBusinessService({ portalService: portal(), configPath });
    expect(service.describe(ctx).data?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "customs.query", configured: false, reason_code: "business_operation_not_enabled" }),
      expect.objectContaining({ operation: "customs.tax.estimate", configured: true, reason_code: null }),
    ]));
  });

  it("assembles an explicitly configured Freightcom connector while keeping its production credential server-owned", async () => {
    const root = mkdtempSync(join(tmpdir(), "portal-business-config-")); roots.push(root);
    const credentialPath = file(root, "freightcom.credential", "freightcom-production-credential\n");
    const requests: Array<{ method: string; url: string; authorization: string | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === "/rate") {
        request.resume(); response.writeHead(202).end(JSON.stringify({ request_id: "provider-rate-fixture" })); return;
      }
      if (request.method === "GET" && request.url === "/rate/provider-rate-fixture") {
        response.writeHead(200).end(JSON.stringify({ status: { done: true, total: 0, complete: 0 }, rates: [] })); return;
      }
      response.writeHead(404).end(JSON.stringify({}));
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address unavailable");
    const configPath = file(root, "business.json", JSON.stringify({ connections: [{
      organizationId: "org-1", tenantId: "tenant-1", enabledOperations: ["quote.freightcom_ltl.preview"],
      freightcom: { connectionId: "freightcom-account-one", credentialFile: credentialPath, baseUrl: `http://127.0.0.1:${address.port}/` },
    }] }), 0o644);
    const service = await loadPortalBusinessService({ portalService: portal(), configPath, allowLoopbackFixtures: true });
    const input = { details: {
      origin: { address: { address_line_1: "10 Origin Rd", city: "Toronto", region: "ON", country: "CA", postal_code: "M5V 2T6" } },
      destination: { address: { address_line_1: "20 Destination Ave", city: "Vancouver", region: "BC", country: "CA", postal_code: "V6B 1A1" }, ready_at: { hour: 9, minute: 0 }, ready_until: { hour: 16, minute: 0 }, signature_requirement: "not-required" },
      expected_ship_date: { year: 2026, month: 9, day: 8 }, packaging_type: "pallet",
      packaging_properties: { pallet_type: "ltl", has_stackable_pallets: false, pallets: [{ measurements: { weight: { unit: "lb", value: "500" }, cuboid: { unit: "in", l: "48", w: "40", h: "50" } }, description: "machine parts", freight_class: "70", num_pieces: 1 }], pallet_service_details: {} }, shipment_classification: "B2B",
    } };
    const result = await service.execute(ctx, "quote.freightcom_ltl.preview", input, "req_freightcom_config_1");
    expect(result).toMatchObject({ status: "manual_review" });
    expect(result.reason_codes).toEqual(["freightcom_no_rates_returned", "freightcom_fixture_data"]);
    expect(requests).toEqual([
      { method: "POST", url: "/rate", authorization: "freightcom-production-credential" },
      { method: "GET", url: "/rate/provider-rate-fixture", authorization: "freightcom-production-credential" },
    ]);
    expect(JSON.stringify(result)).not.toContain("freightcom-production-credential");
  });

  it("assembles a real quote client with file-backed secrets and an ephemeral RS256 delegation", async () => {
    const root = mkdtempSync(join(tmpdir(), "portal-business-config-")); roots.push(root);
    const { privateKey, publicKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
    const secretPath = file(root, "connection.secret", "local-connection-secret\n");
    const keyPath = file(root, "delegation.pem", await exportPKCS8(privateKey));
    let observed = false;
    const server = createServer((request, response) => { void (async () => {
      try {
        const auth = request.headers.authorization; const delegation = request.headers["x-freightclaw-delegation"];
        if (auth !== "Bearer local-connection-secret" || typeof delegation !== "string") { response.writeHead(401).end(); return; }
        const verified = await jwtVerify(delegation, publicKey, { algorithms: ["RS256"], issuer: "https://portal.example.invalid/", audience: "quote-source" });
        observed = verified.payload.sub === "user-1" && verified.payload.tenant_id === "tenant-1" && verified.payload.scope === "quote.ai_extract_preview";
        response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ schema_version: "quote-preview@2026-09-05.v2", status: "unavailable", data: null, reason_codes: ["source_not_ready"], source_refs: [], request_id: "req_12345678" }));
      } catch { response.writeHead(500).end(); }
    })();
    }); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address unavailable");
    const configPath = file(root, "business.json", JSON.stringify({ connections: [{ organizationId: "org-1", tenantId: "tenant-1", enabledOperations: ["quote.ai_extract_preview"], quote: { baseUrl: `http://127.0.0.1:${address.port}`, serviceCallerId: "portal-bff", applicationId: "quote-app", connectionSecretFile: secretPath, issuer: "https://portal.example.invalid/", audience: "quote-source", keyId: "delegation-key", delegationPrivateKeyFile: keyPath } }] }), 0o644);
    const service = await loadPortalBusinessService({ portalService: portal(), configPath, allowLoopbackFixtures: true });
    expect(service.describe(ctx).data?.operations.find((item) => item.operation === "quote.ai_extract_preview")?.configured).toBe(true);
    const result = await service.execute(ctx, "quote.ai_extract_preview", { customer_message: "one pallet" }, "req_12345678");
    expect(result).toMatchObject({ status: "unavailable", reason_codes: ["source_not_ready"] });
    expect(observed).toBe(true);
  });

  it("blocks an organization-to-tenant mapping mismatch at use time", async () => {
    const root = mkdtempSync(join(tmpdir(), "portal-business-config-")); roots.push(root);
    const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
    const secretPath = file(root, "connection.secret", "local-connection-secret\n");
    const keyPath = file(root, "delegation.pem", await exportPKCS8(privateKey));
    const configPath = file(root, "business.json", JSON.stringify({ connections: [{ organizationId: "org-1", tenantId: "tenant-other", enabledOperations: ["customs.query"], customs: { baseUrl: "https://customs.example.invalid", serviceCallerId: "portal-bff", applicationId: "customs-app", connectionSecretFile: secretPath, issuer: "https://portal.example.invalid/", audience: "customs-source", keyId: "delegation-key", delegationPrivateKeyFile: keyPath } }] }), 0o644);
    const service = await loadPortalBusinessService({ portalService: portal("tenant-1"), configPath });
    expect(service.describe(ctx)).toMatchObject({ status: "blocked", reason_codes: ["business_connection_tenant_mismatch"] });
  });
});
