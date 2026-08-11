import { describe, expect, it } from "vitest";

import {
  MemoryAuditRepository,
  redactAuditInput,
} from "../../src/logistics_mcp/platform/audit";
import {
  IdempotencyConflictError,
  MemoryIdempotencyRepository,
  hashPayload,
} from "../../src/logistics_mcp/platform/idempotency";

describe("redacted audit repository", () => {
  it("removes raw addresses, quote amounts, tax text, and credentials", () => {
    const redacted = redactAuditInput({
      postal_code: "A1A 1A1",
      full_address: "secret customer address",
      amount: "999.00",
      password: "secret password",
      raw_tax_document: "secret tax document",
      headers: {
        authorization: "Bearer secret-token",
        cookie: "session=secret-cookie",
      },
    });

    expect(redacted).toEqual({
      postal_code: "A1A 1A1",
      full_address: "[opaque]",
      amount: "[redacted]",
      password: "[redacted]",
      raw_tax_document: "[opaque]",
      headers: {
        authorization: "[redacted]",
        cookie: "[redacted]",
      },
    });
  });

  it("stores only a redacted metadata projection", async () => {
    const repository = new MemoryAuditRepository();

    await repository.append({
      audit_id: "audit_demo_001",
      tenant_id: "tenant_demo",
      actor_id: "actor_sales",
      client_id: "client_demo",
      request_id: "request_demo_001",
      tool: "quote.save_draft",
      schema_version: "2026-08-11.v1",
      status: "blocked",
      source_ids: [],
      versions: [],
      reason_codes: ["security.denied"],
      duration_ms: 4,
      idempotency_outcome: "not_applicable",
      readback_status: "not_applicable",
      metadata: {
        full_address: "secret customer address",
        raw_chat: "secret original chat",
        amount: "999.00",
      },
    });

    const stored = await repository.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.metadata).toEqual({
      full_address: "[opaque]",
      raw_chat: "[opaque]",
      amount: "[redacted]",
    });
    expect(JSON.stringify(stored)).not.toContain("secret");
  });
});

describe("idempotency repository", () => {
  it("returns the first committed result for an identical key", async () => {
    const store = new MemoryIdempotencyRepository();

    const firstReservation = await store.reserve({
      tenantId: "tenant_demo",
      tool: "quote.save_draft",
      key: "idem_demo_12345678",
      requestHash: "hash_a",
    });
    const firstCommit = await store.commit({
      tenantId: "tenant_demo",
      tool: "quote.save_draft",
      key: "idem_demo_12345678",
      requestHash: "hash_a",
      result: { recordId: "draft_1" },
      recordId: "draft_1",
    });
    const replayReservation = await store.reserve({
      tenantId: "tenant_demo",
      tool: "quote.save_draft",
      key: "idem_demo_12345678",
      requestHash: "hash_a",
    });

    expect(firstReservation.replayed).toBe(false);
    expect(firstCommit.result).toEqual({ recordId: "draft_1" });
    expect(replayReservation.replayed).toBe(true);
    expect(replayReservation.record.result).toEqual(firstCommit.result);
  });

  it("rejects a different request hash for the same tenant/tool/key", async () => {
    const store = new MemoryIdempotencyRepository();

    await store.reserve({
      tenantId: "tenant_demo",
      tool: "quote.save_draft",
      key: "idem_demo_87654321",
      requestHash: "hash_a",
    });

    await expect(
      store.reserve({
        tenantId: "tenant_demo",
        tool: "quote.save_draft",
        key: "idem_demo_87654321",
        requestHash: "hash_b",
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("keeps keys isolated by tenant and tool", async () => {
    const store = new MemoryIdempotencyRepository();

    await store.reserve({
      tenantId: "tenant_demo",
      tool: "quote.save_draft",
      key: "idem_demo_abcdefgh",
      requestHash: "hash_a",
    });

    await expect(
      store.reserve({
        tenantId: "tenant_other",
        tool: "quote.save_draft",
        key: "idem_demo_abcdefgh",
        requestHash: "hash_b",
      }),
    ).resolves.toMatchObject({ replayed: false });
  });

  it("computes a stable payload hash without retaining the payload", () => {
    expect(hashPayload({ b: 2, a: 1 })).toBe(hashPayload({ a: 1, b: 2 }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });
});
