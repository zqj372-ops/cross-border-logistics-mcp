import { decodeProtectedHeader, generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";

import { createRs256DelegationSigner } from "../../services/access-gateway/portal/business/delegation";
import { PortalBusinessService, type PortalBusinessClientResult } from "../../services/access-gateway/portal/business/service";
import type { PortalContext, PortalRole, PortalState } from "../../services/access-gateway/portal/contracts";

const identity = (platformRole: "reviewer" | "operator" | null = null) => ({ userId: "user-1", displayName: "User", email: "user@example.com", emailVerified: true, platformRole });
const context = (platformRole: "reviewer" | "operator" | null = null): PortalContext => ({ identity: identity(platformRole), organizationId: "org-1" });
const state = (role: PortalRole = "viewer", tenantId = "tenant-1"): PortalState => ({
  data_mode: "production", identity: identity(), current_organization: { organizationId: "org-1", tenantId, displayName: "One", status: "active", createdAt: "2026-09-05T00:00:00.000Z" },
  organizations: [{ organizationId: "org-1", displayName: "One", status: "active" }], users: [{ userId: "user-1", displayName: "User" }],
  memberships: [{ organizationId: "org-1", userId: "user-1", role, status: "active", createdAt: "2026-09-05T00:00:00.000Z" }],
  invitations: [], applications: [], requests: [], grants: [], catalog: [], operations: [],
});
const envelope = (value: PortalState) => ({ schema_version: "portal@2026-09-05.v1" as const, status: "success" as const, data: value, reason_codes: [] });
const clientResult: PortalBusinessClientResult = { schema_version: "source@v1", status: "success", data: { ok: true }, reason_codes: [] };

describe("portal business service", () => {
  it.each(["owner", "admin", "developer", "viewer"] as const)("routes read-only business operations for an active %s", async (role) => {
    const getState = vi.fn(() => envelope(state(role)));
    const customsQuery = vi.fn(() => Promise.resolve(clientResult));
    const taxEstimate = vi.fn(() => Promise.resolve(clientResult));
    const taxEstimateBatch = vi.fn(() => Promise.resolve(clientResult));
    const quotePreview = vi.fn(() => Promise.resolve(clientResult));
    const quoteExtract = vi.fn(() => Promise.resolve(clientResult));
    const freightcomPreview = vi.fn(() => Promise.resolve(clientResult));
    const service = new PortalBusinessService({ portalService: { getState }, connections: [{ organizationId: "org-1", tenantId: "tenant-1", enabledOperations: ["customs.query", "customs.tax.estimate", "quote.zone_preview", "quote.ai_extract_preview", "quote.freightcom_ltl.preview"], customsClient: { query: customsQuery }, taxClient: { estimate: taxEstimate, estimateBatch: taxEstimateBatch }, quoteClient: { preview: quotePreview, extract: quoteExtract }, freightcomClient: { preview: freightcomPreview } }] });
    expect(service.describe(context()).data?.operations.every((item) => item.configured)).toBe(true);
    await service.execute(context(), "customs.query", { query: "goods" }, "request-1");
    await service.execute(context(), "customs.tax.estimate", { lineId: "line-1" }, "request-4");
    await service.executeBatch(context(), { items: [{ lineId: "line-1" }] }, "request-5");
    await service.execute(context(), "quote.zone_preview", { postal_code: "A1A1A1" }, "request-2");
    await service.execute(context(), "quote.ai_extract_preview", { customer_message: "message" }, "request-3");
    await service.execute(context(), "quote.freightcom_ltl.preview", { packages: [] }, "request-6");
    expect(customsQuery).toHaveBeenCalledWith({ input: { query: "goods" }, actor: { type: "user", id: "user-1" }, requestId: "request-1" });
    expect(taxEstimate).toHaveBeenCalledWith({ input: { lineId: "line-1" }, actor: { type: "user", id: "user-1" }, requestId: "request-4" });
    expect(taxEstimateBatch).toHaveBeenCalledWith({ input: { items: [{ lineId: "line-1" }] }, actor: { type: "user", id: "user-1" }, requestId: "request-5" });
    expect(quotePreview).toHaveBeenCalledOnce(); expect(quoteExtract).toHaveBeenCalledOnce();
    expect(freightcomPreview).toHaveBeenCalledWith({ input: { packages: [] }, requestId: "request-6" });
  });

  it("blocks platform sessions, tenant mismatches and operations outside the configured whitelist", async () => {
    const query = vi.fn(() => Promise.resolve(clientResult));
    const mismatch = new PortalBusinessService({ portalService: { getState: () => envelope(state()) }, connections: [{ organizationId: "org-1", tenantId: "tenant-other", enabledOperations: ["customs.query"], customsClient: { query } }] });
    expect(mismatch.describe(context())).toMatchObject({ status: "blocked", reason_codes: ["business_connection_tenant_mismatch"] });
    const service = new PortalBusinessService({ portalService: { getState: () => envelope(state()) }, connections: [{ organizationId: "org-1", tenantId: "tenant-1", enabledOperations: [], customsClient: { query } }] });
    await expect(service.execute(context(), "customs.query", {}, "request-1")).resolves.toMatchObject({ status: "blocked", reason_codes: ["business_operation_not_enabled"] });
    await expect(service.execute(context("reviewer"), "customs.query", {}, "request-1")).resolves.toMatchObject({ status: "blocked", reason_codes: ["business_personnel_session_required"] });
    expect(query).not.toHaveBeenCalled();
  });

  it("reports an absent client as unavailable and never creates fixture success", async () => {
    const service = new PortalBusinessService({ portalService: { getState: () => envelope(state()) }, connections: [{ organizationId: "org-1", tenantId: "tenant-1", enabledOperations: ["customs.query"] }] });
    expect(service.describe(context()).data?.operations[0]).toMatchObject({ configured: false, reason_code: "business_client_unconfigured" });
    await expect(service.execute(context(), "customs.query", {}, "request-1")).resolves.toMatchObject({ status: "unavailable", data: null, reason_codes: ["business_client_unconfigured"] });
  });

  it("limits review management to organization owners and admins before the source reviewer check", async () => {
    const reviewQueue = vi.fn(() => Promise.resolve(clientResult));
    const quoteRecordClient = { reviewQueue } as never;
    const configured = (role: PortalRole) => new PortalBusinessService({ portalService: { getState: () => envelope(state(role)) }, connections: [{
      organizationId: "org-1", tenantId: "tenant-1", enabledOperations: ["quote.zone_preview"], recordOperations: ["quote.review_manage"], quoteRecordClient,
    }] });
    await expect(configured("developer").records(context(), "reviewQueue", {}, "req_review_12345678")).resolves.toMatchObject({ status: "blocked", reason_codes: ["quote_reviewer_role_required"] });
    expect(reviewQueue).not.toHaveBeenCalled();
    await configured("owner").records(context(), "reviewQueue", {}, "req_review_12345678");
    expect(reviewQueue).toHaveBeenCalledWith({ actor: { type: "user", id: "user-1" }, requestId: "req_review_12345678" });
  });
});

describe("RS256 downstream delegation signer", () => {
  it("issues a closed, short-lived, kid-bound JWT and returns the same structured claims", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
    const signer = await createRs256DelegationSigner({ issuer: "https://portal.example.invalid/", audience: "riskcustoms", keyId: "delegation-key-1", privateKey, ttlSeconds: 240, clock: () => new Date(1_788_566_400_000), jti: () => "jti-1" });
    const signed = await signer({ subject: "user-1", actorType: "user", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1", requestId: "request-1", scope: "customs.query" });
    expect(decodeProtectedHeader(signed.token)).toEqual({ alg: "RS256", typ: "JWT", kid: "delegation-key-1" });
    const verified = await jwtVerify(signed.token, publicKey, { algorithms: ["RS256"], issuer: "https://portal.example.invalid/", audience: "riskcustoms", currentDate: new Date(1_788_566_400_000) });
    expect(verified.payload).toEqual(signed.claims);
    expect(Object.keys(verified.payload).sort()).toEqual(["actor_type", "application_id", "aud", "exp", "iat", "iss", "jti", "nbf", "request_id", "scope", "service_caller_id", "sub", "tenant_id"]);
    expect(signed.claims.exp - signed.claims.iat).toBe(240);
  });

  it("signs the estimate method with the one shared customs.tax.estimate scope", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
    const signer = await createRs256DelegationSigner({ issuer: "https://portal.example.invalid/", audience: "riskcustoms", keyId: "delegation-key-1", privateKey, clock: () => new Date(1_788_566_400_000), jti: () => "jti-estimate" });
    const signed = await signer({ subject: "user-1", actorType: "user", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1", requestId: "req_12345678", scope: "customs.tax.estimate" });
    const verified = await jwtVerify(signed.token, publicKey, { algorithms: ["RS256"], issuer: "https://portal.example.invalid/", audience: "riskcustoms", currentDate: new Date(1_788_566_400_000) });
    expect(verified.payload.scope).toBe("customs.tax.estimate");
  });

  it("rejects invalid configuration, overlong lifetime and service subject impersonation", async () => {
    const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
    await expect(createRs256DelegationSigner({ issuer: "http://portal.example.invalid/", audience: "riskcustoms", keyId: "key-1", privateKey })).rejects.toThrow("delegation_signer_configuration_invalid");
    await expect(createRs256DelegationSigner({ issuer: "https://portal.example.invalid/", audience: "riskcustoms", keyId: "key-1", privateKey, ttlSeconds: 301 })).rejects.toThrow("delegation_signer_configuration_invalid");
    const signer = await createRs256DelegationSigner({ issuer: "https://portal.example.invalid/", audience: "riskcustoms", keyId: "key-1", privateKey });
    await expect(signer({ subject: "other-service", actorType: "service", tenantId: "tenant-1", serviceCallerId: "portal-bff", applicationId: "app-1", requestId: "request-1", scope: "customs.query" })).rejects.toThrow("delegation_service_subject_invalid");
  });
});
