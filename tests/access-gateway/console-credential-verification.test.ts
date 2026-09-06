import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

type VerificationInput = Readonly<{ kind: "t0" | "business" | "unified"; key: string; allowedNames: readonly string[]; mode: "fixtures" | "production"; fetchImpl?: typeof fetch; signal?: AbortSignal }>;
type VerificationResult = Readonly<{ status: string; stage: string; verification: string; operation: string | null; exchange_verified: boolean; sample_called: boolean; http_status: number | null; request_id: string | null; reason_codes: readonly string[]; summary: string }>;
let verifyCredentialAfterDelivery: (input: VerificationInput) => Promise<VerificationResult>;

beforeAll(async () => {
  const module = await import(pathToFileURL(resolve("apps/console/credential-verification.js")).href) as { verifyCredentialAfterDelivery: typeof verifyCredentialAfterDelivery };
  verifyCredentialAfterDelivery = module.verifyCredentialAfterDelivery;
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("automatic credential verification", () => {
  it("uses the same unified key directly for T0 and business samples without a copy or exchange step", async () => {
    const key = "flcbk_one_key_material";
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json({ status: "success", request_id: "req_direct_1", data: {} })));
    for (const operation of ["cargo.calculate", "quote.zone_preview"]) {
      const result = await verifyCredentialAfterDelivery({ kind: "unified", key, allowedNames: [operation], mode: "production", fetchImpl });
      expect(result).toMatchObject({ status: "success", operation, verification: "call_success", sample_called: true, exchange_verified: false });
      expect(JSON.stringify(result)).not.toContain(key);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual(["/api/v2/tools/cargo.calculate", "/api/v2/business/quote/zone-preview"]);
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ credentials: "omit", redirect: "error", headers: { Authorization: `ApiKey ${key}` } });
    expect(JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string)).toHaveProperty("schema_version", "business-call@2026-09-05.v1");
  });
  it("preserves a unified API source unavailable result without calling it an authentication failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ status: "unavailable", request_id: "req_source_503", reason_codes: ["data_not_ready"] }, 503));
    const result = await verifyCredentialAfterDelivery({ kind: "unified", key: "flcbk_one", allowedNames: ["customs.query"], mode: "production", fetchImpl });
    expect(result).toMatchObject({ status: "unavailable", verification: "source_unavailable", reason_codes: ["data_not_ready"], sample_called: true });
  });
  it("prefers cargo.calculate for T0, uses fixture routes, and never returns the key or token", async () => {
    const key = "lmcpk_private_key_material"; const token = "private.jwt.token";
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ status: "success", data: { access_token: token }, request_id: "req_exchange_1" }))
      .mockResolvedValueOnce(json({ status: "success", data: { calculated: true }, request_id: "req_call_1" }));
    const result = await verifyCredentialAfterDelivery({ kind: "t0", key, allowedNames: ["system.agent_context.get", "cargo.calculate"], mode: "fixtures", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/access/v1/token/exchange");
    const exchangeBody = fetchImpl.mock.calls[0]?.[1]?.body;
    expect(typeof exchangeBody).toBe("string");
    expect(JSON.parse(exchangeBody as string)).toEqual({ schema_version: "2026-08-27.v1", requested_tool_names: ["cargo.calculate"] });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("/api/fixture/v1/tools/cargo.calculate");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(result).toMatchObject({ status: "success", stage: "sample_call", verification: "call_success", operation: "cargo.calculate", exchange_verified: true, sample_called: true, http_status: 200, request_id: "req_call_1" });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("prefers quote preview and preserves manual_review instead of calling HTTP 200 a success", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ status: "success", data: { access_token: "business-token" } }))
      .mockResolvedValueOnce(json({ status: "manual_review", reason_codes: ["quote_source_evidence_missing"], request_id: "req_quote_1", data: { total_price: "100.00" } }));
    const result = await verifyCredentialAfterDelivery({ kind: "business", key: "flcbk_private", allowedNames: ["customs.query", "quote.zone_preview"], mode: "production", fetchImpl });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/access/v2/business/token/exchange");
    const exchangeBody = fetchImpl.mock.calls[0]?.[1]?.body;
    expect(typeof exchangeBody).toBe("string");
    expect(JSON.parse(exchangeBody as string)).toEqual({ schema_version: "business-exchange@2026-09-05.v1", requested_operations: ["quote.zone_preview"] });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("/api/v2/business/quote/zone-preview");
    expect(result).toMatchObject({ status: "manual_review", stage: "sample_call", verification: "source_requires_review", operation: "quote.zone_preview", exchange_verified: true, sample_called: true, request_id: "req_quote_1", reason_codes: ["quote_source_evidence_missing"] });
  });

  it("distinguishes connected but unavailable sources and strips hostile secret-shaped metadata", async () => {
    const key = "flcbk_secret_value"; const token = "secret-token-value";
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ status: "success", data: { access_token: token } }))
      .mockResolvedValueOnce(json({ status: "unavailable", reason_codes: [key, "quote_upstream_unavailable"], request_id: token, data: { leaked: key } }));
    const result = await verifyCredentialAfterDelivery({ kind: "business", key, allowedNames: ["quote.zone_preview"], mode: "production", fetchImpl });
    expect(result).toMatchObject({ status: "unavailable", verification: "source_unavailable", exchange_verified: true, sample_called: true });
    expect(result.reason_codes).toContain("quote_upstream_unavailable");
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("only verifies exchange for an allowed narrow scope without a safe automatic sample", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ status: "success", data: { access_token: "short-token" }, request_id: "req_exchange_only" }));
    const result = await verifyCredentialAfterDelivery({ kind: "t0", key: "lmcpk_key", allowedNames: ["system.agent_context.get"], mode: "production", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/access/v2/tools/token/exchange");
    expect(result).toMatchObject({ status: "success", stage: "token_exchange", verification: "exchange_only", operation: "system.agent_context.get", exchange_verified: true, sample_called: false, request_id: "req_exchange_only" });
  });

  it("fails closed for unknown scopes, rejected exchange, cancellation, and network errors", async () => {
    const never = vi.fn<typeof fetch>();
    await expect(verifyCredentialAfterDelivery({ kind: "business", key: "key", allowedNames: ["record.write"], mode: "production", fetchImpl: never })).resolves.toMatchObject({ status: "blocked", verification: "scope_unavailable", exchange_verified: false, sample_called: false });
    expect(never).not.toHaveBeenCalled();

    const rejected = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ status: "blocked", reason_codes: ["machine_authentication_failed"] }, 401));
    await expect(verifyCredentialAfterDelivery({ kind: "business", key: "key", allowedNames: ["customs.query"], mode: "production", fetchImpl: rejected })).resolves.toMatchObject({ status: "blocked", stage: "token_exchange", verification: "exchange_failed", http_status: 401, reason_codes: ["machine_authentication_failed"] });
    expect(rejected).toHaveBeenCalledOnce();

    const controller = new AbortController(); controller.abort();
    const cancelled = vi.fn<typeof fetch>();
    await expect(verifyCredentialAfterDelivery({ kind: "t0", key: "key", allowedNames: ["cargo.calculate"], mode: "production", fetchImpl: cancelled, signal: controller.signal })).resolves.toMatchObject({ status: "unavailable", verification: "cancelled", exchange_verified: false, sample_called: false });
    expect(cancelled).not.toHaveBeenCalled();

    const offline = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("secret connection detail"));
    const unavailable = await verifyCredentialAfterDelivery({ kind: "t0", key: "key", allowedNames: ["cargo.calculate"], mode: "production", fetchImpl: offline });
    expect(unavailable).toMatchObject({ status: "unavailable", verification: "connection_unavailable", exchange_verified: false, sample_called: false, reason_codes: ["connection_unavailable"] });
    expect(JSON.stringify(unavailable)).not.toContain("secret connection detail");
  });
});
