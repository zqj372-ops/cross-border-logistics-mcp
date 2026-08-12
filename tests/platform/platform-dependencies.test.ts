import { describe, expect, it, vi } from "vitest";

import {
  MemoryAuditRepository,
} from "../../src/logistics_mcp/platform/audit";
import {
  MemoryIdempotencyRepository,
} from "../../src/logistics_mcp/platform/idempotency";
import {
  createFixturePlatformDependencies,
  createProductionPlatformAssembly,
  PlatformConfigurationError,
  type DurableAuditRepository,
  type DurableIdempotencyRepository,
  type DurableSessionBindingStore,
} from "../../src/logistics_mcp/platform/dependencies";
import { createMcpHttpHandler } from "../../src/logistics_mcp/server/http";

function durableAudit(ready = true): DurableAuditRepository {
  return {
    append: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve([])),
    durability: "durable" as const,
    health: vi.fn(() => Promise.resolve({ ready })),
    close: vi.fn(() => Promise.resolve()),
  };
}

function durableIdempotency(ready = true): DurableIdempotencyRepository {
  return {
    reserve: vi.fn(() => Promise.reject(new Error("fake reserve not used"))),
    commit: vi.fn(() => Promise.reject(new Error("fake commit not used"))),
    get: vi.fn(() => Promise.resolve(null)),
    durability: "durable" as const,
    health: vi.fn(() => Promise.resolve({ ready })),
    close: vi.fn(() => Promise.resolve()),
  };
}

function durableBinding(ready = true): DurableSessionBindingStore {
  return {
    durability: "durable",
    health: vi.fn(() => Promise.resolve({ ready })),
    close: vi.fn(() => Promise.resolve()),
    get: vi.fn(() => Promise.resolve(null)),
    put: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
  };
}

describe("platform dependency assembly", () => {
  it("requires explicit audit, idempotency, and session dependencies at the HTTP boundary", () => {
    expect(() =>
      createMcpHttpHandler({
        allowedOrigins: ["https://client.example.invalid"],
        allowedHosts: ["mcp.example.invalid"],
        authenticate: () => {
          throw new Error("must not authenticate");
        },
      } as never),
    ).toThrow(PlatformConfigurationError);
  });

  it("creates fixture memory stores and a bounded local session registry explicitly", () => {
    const dependencies = createFixturePlatformDependencies();

    expect(dependencies.auditRepository).toBeInstanceOf(MemoryAuditRepository);
    expect(dependencies.idempotencyRepository).toBeInstanceOf(
      MemoryIdempotencyRepository,
    );
    expect(dependencies.sessionRegistry.limits).toEqual({
      idleTtlMs: 5 * 60 * 1000,
      maxLifetimeMs: 15 * 60 * 1000,
      maxTokenLifetimeMs: 15 * 60 * 1000,
      maxSessions: 256,
    });
  });

  it("reports missing production durable dependencies without creating memory fallbacks", async () => {
    const assembly = createProductionPlatformAssembly({});

    expect(assembly.status).toBe("unavailable");
    expect(assembly.reasonCodes).toEqual([
      "platform_audit_repository_missing",
      "platform_idempotency_repository_missing",
      "platform_session_binding_store_missing",
    ]);
    await expect(assembly.readiness()).resolves.toMatchObject({
      ready: false,
      reasons: assembly.reasonCodes,
    });
    expect(assembly.errors).toHaveLength(3);
    expect(assembly.errors.every((error) => error instanceof PlatformConfigurationError)).toBe(true);
  });

  it("does not accept memory implementations as durable production dependencies", () => {
    const assembly = createProductionPlatformAssembly({
      auditRepository: new MemoryAuditRepository() as unknown as DurableAuditRepository,
      idempotencyRepository:
        new MemoryIdempotencyRepository() as unknown as DurableIdempotencyRepository,
      sessionBindingStore: {
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      } as unknown as DurableSessionBindingStore,
    });

    expect(assembly.status).toBe("unavailable");
    expect(assembly.reasonCodes).toEqual([
      "platform_audit_repository_not_durable",
      "platform_idempotency_repository_not_durable",
      "platform_session_binding_store_not_durable",
    ]);
  });

  it("uses fake durable health lifecycles only as readiness evidence", async () => {
    const assembly = createProductionPlatformAssembly({
      auditRepository: durableAudit(),
      idempotencyRepository: durableIdempotency(),
      sessionBindingStore: durableBinding(false),
    });

    expect(assembly.status).toBe("available");
    await expect(assembly.readiness()).resolves.toEqual({
      ready: false,
      reasons: ["platform_session_binding_store_unhealthy"],
    });
  });

  it("checks and closes one shared durable provider once", async () => {
    const health = vi.fn(() => Promise.resolve({ ready: true }));
    const close = vi.fn(() => Promise.resolve());
    const shared = {
      ...durableAudit(),
      ...durableIdempotency(),
      ...durableBinding(),
      health,
      close,
    } as DurableAuditRepository & DurableIdempotencyRepository & DurableSessionBindingStore;
    const assembly = createProductionPlatformAssembly({
      auditRepository: shared,
      idempotencyRepository: shared,
      sessionBindingStore: shared,
    });

    await expect(assembly.readiness()).resolves.toEqual({ ready: true, reasons: [] });
    expect(health).toHaveBeenCalledTimes(1);
    await assembly.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
