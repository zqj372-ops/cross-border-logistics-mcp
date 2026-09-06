import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadPortalBusinessService } from "../../services/access-gateway/portal/business/config";
import {
  PortalBusinessService,
  type PortalBusinessClientResult,
  type PortalBusinessConnection,
} from "../../services/access-gateway/portal/business/service";
import { success, type PortalContext, type PortalState } from "../../services/access-gateway/portal/contracts";
import type { PortalService } from "../../services/access-gateway/portal/service";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const ctx: PortalContext = {
  identity: { userId: "owner-user", displayName: "Owner", email: "owner@example.test", emailVerified: true, platformRole: null },
  organizationId: "org-a",
};
const state: PortalState = {
  data_mode: "fixtures", identity: ctx.identity,
  current_organization: { organizationId: "org-a", tenantId: "tenant-a", displayName: "Alpha", status: "active", createdAt: "2026-09-05T00:00:00.000Z" },
  organizations: [{ organizationId: "org-a", displayName: "Alpha", status: "active" }],
  users: [{ userId: "owner-user", displayName: "Owner" }],
  memberships: [{ organizationId: "org-a", userId: "owner-user", role: "owner", status: "active", createdAt: "2026-09-05T00:00:00.000Z" }],
  invitations: [], applications: [], requests: [], grants: [], catalog: [], operations: [],
};
const clientResult: PortalBusinessClientResult = { schema_version: "source-test.v1", status: "success", data: { ok: true }, reason_codes: [] };

function projection(overrides: Partial<{ organizationId: string; tenantId: string; applicationId: string; clientId: string }> = {}) {
  return { organizationId: "org-a", tenantId: "tenant-a", applicationId: "app-a", clientId: "client-a", environment: "test" as const, ownerUserId: "owner-user", ...overrides };
}

function portal(application = projection()) {
  return {
    getState: vi.fn(() => success(state)),
    requireBusinessApplication: vi.fn(() => application),
  } as Pick<PortalService, "getState" | "requireBusinessApplication">;
}

function machine(overrides: Partial<{ tenantId: string; clientId: string; applicationId: string; credentialId: string }> = {}) {
  return { tenantId: "tenant-a", clientId: "client-a", applicationId: "app-a", credentialId: "credential-a", ...overrides };
}

describe("portal business machine routing", () => {
  it("routes Freightcom through the server-owned organization connection for people and machines", async () => {
    const preview = vi.fn(() => Promise.resolve(clientResult));
    const service = new PortalBusinessService({ portalService: portal(), connections: [{
      organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["quote.freightcom_ltl.preview"],
      freightcomClient: { preview },
    }] });

    await service.execute(ctx, "quote.freightcom_ltl.preview", { details: { source: "person" } }, "req_freightcom_person_1");
    await service.executeMachine({ operation: "quote.freightcom_ltl.preview", input: { details: { source: "machine" } }, requestId: "req_freightcom_machine_1", batch: false, machine: machine() });

    expect(preview).toHaveBeenNthCalledWith(1, { input: { details: { source: "person" } }, requestId: "req_freightcom_person_1" });
    expect(preview).toHaveBeenNthCalledWith(2, { input: { details: { source: "machine" } }, requestId: "req_freightcom_machine_1" });
    expect(service.describe(ctx).data?.operations).toContainEqual({ operation: "quote.freightcom_ltl.preview", configured: true, reason_code: null });
  });

  it("keeps an unconfigured Freightcom connection unavailable without affecting other quote operations", async () => {
    const preview = vi.fn(() => Promise.resolve(clientResult));
    const service = new PortalBusinessService({ portalService: portal(), connections: [{
      organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["quote.zone_preview"],
      serviceActors: { quote: "quote-portal-service" }, quoteClient: { preview, extract: vi.fn() },
    }] });

    await expect(service.execute(ctx, "quote.zone_preview", {}, "req_quote_existing_1")).resolves.toEqual(clientResult);
    await expect(service.execute(ctx, "quote.freightcom_ltl.preview", {}, "req_freightcom_missing_1")).resolves.toMatchObject({ status: "blocked", reason_codes: ["business_operation_not_enabled"] });
    expect(preview).toHaveBeenCalledOnce();
  });

  it("uses the configured service identity and only allows batch dispatch for tax estimates", async () => {
    const query = vi.fn(() => Promise.resolve(clientResult)); const estimate = vi.fn(() => Promise.resolve(clientResult)); const estimateBatch = vi.fn(() => Promise.resolve(clientResult));
    const preview = vi.fn(() => Promise.resolve(clientResult)); const extract = vi.fn(() => Promise.resolve(clientResult));
    const service = new PortalBusinessService({ portalService: portal(), connections: [{
      organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["customs.query", "customs.tax.estimate", "quote.zone_preview", "quote.ai_extract_preview"],
      serviceActors: { customs: "customs-portal-service", quote: "quote-portal-service" },
      customsClient: { query }, taxClient: { estimate, estimateBatch }, quoteClient: { preview, extract },
    }] });
    await service.executeMachine({ operation: "customs.query", input: { query: "shirt" }, requestId: "req_machine_0001", batch: false, machine: machine(), actor: { type: "service", id: "customer-forged" } } as Parameters<typeof service.executeMachine>[0]);
    await service.executeMachine({ operation: "customs.tax.estimate", input: { lineId: "line-1" }, requestId: "req_machine_0002", batch: true, machine: machine() });
    await service.executeMachine({ operation: "quote.zone_preview", input: { postal_code: "M5V3A8" }, requestId: "req_machine_0003", batch: false, machine: machine() });
    expect(query).toHaveBeenCalledWith({ input: { query: "shirt" }, actor: { type: "service", id: "customs-portal-service" }, requestId: "req_machine_0001" });
    expect(estimateBatch).toHaveBeenCalledWith({ input: { lineId: "line-1" }, actor: { type: "service", id: "customs-portal-service" }, requestId: "req_machine_0002" });
    expect(preview).toHaveBeenCalledWith({ input: { postal_code: "M5V3A8" }, actor: { type: "service", id: "quote-portal-service" }, requestId: "req_machine_0003" });
    expect(estimate).not.toHaveBeenCalled(); expect(extract).not.toHaveBeenCalled();
    await expect(service.executeMachine({ operation: "customs.query", input: {}, requestId: "req_machine_0004", batch: true, machine: machine() })).resolves.toMatchObject({ status: "blocked", reason_codes: ["business_request_invalid"] });
    expect(query).toHaveBeenCalledOnce();
  });

  it("requires the current client projection to match application, tenant and organization before provider execution", async () => {
    const query = vi.fn(() => Promise.resolve(clientResult));
    const service = new PortalBusinessService({ portalService: portal(), connections: [{ organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["customs.query"], serviceActors: { customs: "customs-portal-service" }, customsClient: { query } }] });
    await expect(service.executeMachine({ operation: "customs.query", input: {}, requestId: "req_machine_0005", batch: false, machine: machine({ tenantId: "tenant-other" }) })).resolves.toMatchObject({ status: "blocked", reason_codes: ["business_application_denied"] });
    await expect(service.executeMachine({ operation: "customs.query", input: {}, requestId: "req_machine_0006", batch: false, machine: machine({ applicationId: "app-other" }) })).resolves.toMatchObject({ status: "blocked", reason_codes: ["business_application_denied"] });
    const wrongOrg = new PortalBusinessService({ portalService: portal(), connections: [{ organizationId: "org-other", tenantId: "tenant-a", enabledOperations: ["customs.query"], serviceActors: { customs: "customs-portal-service" }, customsClient: { query } }] });
    await expect(wrongOrg.executeMachine({ operation: "customs.query", input: {}, requestId: "req_machine_0007", batch: false, machine: machine() })).resolves.toMatchObject({ status: "unavailable", reason_codes: ["business_operation_unavailable"] });
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed without a provider, with a missing projection, or with duplicate tenant connections", async () => {
    const queryA = vi.fn(() => Promise.resolve(clientResult)); const queryB = vi.fn(() => Promise.resolve(clientResult));
    const withoutProvider = new PortalBusinessService({ portalService: portal(), connections: [{ organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["customs.query"], serviceActors: { customs: "customs-portal-service" } }] });
    expect(withoutProvider.isAvailable("tenant-a", "customs.query")).toBe(false);
    await expect(withoutProvider.executeMachine({ operation: "customs.query", input: {}, requestId: "req_machine_0008", batch: false, machine: machine() })).resolves.toMatchObject({ status: "unavailable", reason_codes: ["business_operation_unavailable"] });

    const missingProjection = new PortalBusinessService({ portalService: { getState: portal().getState }, connections: [{ organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["customs.query"], serviceActors: { customs: "customs-portal-service" }, customsClient: { query: queryA } }] });
    await expect(missingProjection.executeMachine({ operation: "customs.query", input: {}, requestId: "req_machine_0009", batch: false, machine: machine() })).resolves.toMatchObject({ status: "blocked", reason_codes: ["business_application_denied"] });

    const duplicate = new PortalBusinessService({ portalService: portal(), connections: [
      { organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["customs.query"], serviceActors: { customs: "customs-service-a" }, customsClient: { query: queryA } },
      { organizationId: "org-b", tenantId: "tenant-a", enabledOperations: ["customs.query"], serviceActors: { customs: "customs-service-b" }, customsClient: { query: queryB } },
    ] });
    expect(duplicate.isAvailable("tenant-a", "customs.query")).toBe(false);
    await expect(duplicate.executeMachine({ operation: "customs.query", input: {}, requestId: "req_machine_0010", batch: false, machine: machine() })).resolves.toMatchObject({ status: "unavailable", reason_codes: ["business_operation_unavailable"] });
    expect(queryA).not.toHaveBeenCalled(); expect(queryB).not.toHaveBeenCalled();
  });
});

describe("portal quote record routing", () => {
  function recordService(recordOperations: PortalBusinessConnection["recordOperations"] = ["quote.record_save", "quote.record_read", "quote.review_read"]) {
    const prepare = vi.fn(() => Promise.resolve(clientResult)); const save = vi.fn(() => Promise.resolve(clientResult)); const get = vi.fn(() => Promise.resolve(clientResult));
    const list = vi.fn(() => Promise.resolve(clientResult)); const reviewTasks = vi.fn(() => Promise.resolve(clientResult));
    const quoteRecordClient = { prepare, save, get, list, reviewTasks } as unknown as NonNullable<PortalBusinessConnection["quoteRecordClient"]>;
    const service = new PortalBusinessService({ portalService: portal(), connections: [{ organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["quote.zone_preview"], recordOperations, quoteRecordClient }] });
    return { service, prepare, save, get, list, reviewTasks };
  }

  it("derives the personnel actor and forwards save intent, idempotency and personal read filters", async () => {
    const x = recordService();
    const request = { postal_code: "M5V3A8", weight_kg: "100.00" };
    await x.service.records(ctx, "prepare", request, "req_record_0001");
    await x.service.records(ctx, "save", { request, preview_handle: "p".repeat(32), intent: "save_draft" }, "req_record_0002", "idem_record_save_0001");
    await x.service.records(ctx, "list", { cursor: "cursor-1", limit: 25, status: "manual_required" }, "req_record_0003");
    await x.service.records(ctx, "get", { record_ref: "record-owner-1" }, "req_record_0004");
    await x.service.records(ctx, "review", { record_ref: "record-owner-1" }, "req_record_0005");
    const actor = { type: "user", id: "owner-user" };
    expect(x.prepare).toHaveBeenCalledWith({ input: request, actor, requestId: "req_record_0001" });
    expect(x.save).toHaveBeenCalledWith({ input: request, previewHandle: "p".repeat(32), idempotencyKey: "idem_record_save_0001", actor, requestId: "req_record_0002" });
    expect(x.list).toHaveBeenCalledWith({ cursor: "cursor-1", limit: 25, status: "manual_required", actor, requestId: "req_record_0003" });
    expect(x.get).toHaveBeenCalledWith({ recordRef: "record-owner-1", actor, requestId: "req_record_0004" });
    expect(x.reviewTasks).toHaveBeenCalledWith({ recordRef: "record-owner-1", actor, requestId: "req_record_0005" });
  });

  it("enforces record permissions and rejects missing save intent, idempotency, and extra fields before the client", async () => {
    const x = recordService(["quote.record_read"]);
    await expect(x.service.records(ctx, "save", { request: {}, preview_handle: "p".repeat(32), intent: "save_draft" }, "req_record_0006", "idem_record_save_0002")).resolves.toMatchObject({ status: "unavailable", reason_codes: ["quote_record_operation_unconfigured"] });
    expect(x.save).not.toHaveBeenCalled();

    const allowed = recordService();
    const invalid: Array<["save" | "list" | "get" | "review", unknown, string | undefined]> = [
      ["save", { request: {}, preview_handle: "p".repeat(32), intent: "publish" }, "idem_record_save_0003"],
      ["save", { request: {}, preview_handle: "p".repeat(32), intent: "save_draft" }, undefined],
      ["save", { request: {}, preview_handle: "p".repeat(32), intent: "save_draft", tenant_id: "tenant-other" }, "idem_record_save_0004"],
      ["list", { limit: 25, actor: "other-user" }, undefined],
      ["get", { record_ref: "record-owner-1", extra: true }, undefined],
      ["review", { record_ref: "record-owner-1", tenant_id: "tenant-other" }, undefined],
    ];
    for (const [action, input, key] of invalid) {
      await expect(allowed.service.records(ctx, action, input, `req_invalid_${action}_01`, key)).resolves.toMatchObject({ status: "blocked", reason_codes: ["business_request_invalid"] });
    }
    expect(allowed.save).not.toHaveBeenCalled(); expect(allowed.list).not.toHaveBeenCalled(); expect(allowed.get).not.toHaveBeenCalled(); expect(allowed.reviewTasks).not.toHaveBeenCalled();
  });
});

describe("portal business record configuration", () => {
  function file(root: string, name: string, value: string, mode = 0o600) {
    const path = join(root, name); writeFileSync(path, value, { mode }); chmodSync(path, mode); return path;
  }
  function connector(baseUrl: string, secretPath = "/missing-secret", keyPath = "/missing-key") {
    return { baseUrl, serviceCallerId: "portal-service", applicationId: "quote-app", connectionSecretFile: secretPath,
      issuer: "https://portal.example.invalid/", audience: "quote-source", keyId: "delegation-key", delegationPrivateKeyFile: keyPath };
  }

  it("requires record actions to use a quote connector with zone preview and requires read when save is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "portal-record-config-")); roots.push(root);
    const invalid = [
      { connections: [{ organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["customs.query"], recordOperations: ["quote.record_read"], customs: connector("https://customs.example.invalid") }] },
      { connections: [{ organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["quote.ai_extract_preview"], recordOperations: ["quote.record_read"], quote: connector("https://quote.example.invalid") }] },
      { connections: [{ organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["quote.zone_preview"], recordOperations: ["quote.record_save"], quote: connector("https://quote.example.invalid") }] },
      { connections: [{ organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["quote.zone_preview"], recordOperations: ["quote.document_generate", "quote.record_read"], quote: connector("https://quote.example.invalid") }] },
      { connections: [
        { organizationId: "org-a", tenantId: "tenant-a", enabledOperations: ["customs.query"], customs: connector("https://customs-a.example.invalid") },
        { organizationId: "org-b", tenantId: "tenant-a", enabledOperations: ["customs.query"], customs: connector("https://customs-b.example.invalid") },
      ] },
    ];
    for (const [index, configuration] of invalid.entries()) {
      const configPath = file(root, `invalid-${index}.json`, JSON.stringify(configuration), 0o644);
      await expect(loadPortalBusinessService({ portalService: portal(), configPath })).rejects.toThrow("portal_business_config_invalid");
    }
  });

  it("assembles the record client only for an explicit valid quote record configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "portal-record-config-")); roots.push(root);
    const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
    const secretPath = file(root, "connection.secret", "local-connection-secret\n");
    const keyPath = file(root, "delegation.pem", await exportPKCS8(privateKey));
    const configPath = file(root, "valid.json", JSON.stringify({ connections: [{ organizationId: "org-a", tenantId: "tenant-a",
      enabledOperations: ["quote.zone_preview"], recordOperations: ["quote.record_save", "quote.record_read"],
      quote: connector("https://quote.example.invalid", secretPath, keyPath),
    }] }), 0o644);
    const service = await loadPortalBusinessService({ portalService: portal(), configPath });
    expect(service.isAvailable("tenant-a", "quote.zone_preview")).toBe(true);
    await expect(service.records(ctx, "save", { request: {}, preview_handle: "p".repeat(32), intent: "save_draft" }, "req_record_0007", "idem_record_save_0005")).resolves.toMatchObject({ status: "needs_input", reason_codes: ["quote_record_request_invalid"] });
  });
});
