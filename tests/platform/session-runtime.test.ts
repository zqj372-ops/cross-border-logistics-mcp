import { describe, expect, it, vi } from "vitest";

import { parseExecutionContext, type ExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  SessionContextMismatchError,
  SessionRegistryCapacityError,
  SessionRuntimeRegistry,
} from "../../src/logistics_mcp/platform/session-runtime";

function context(
  nowMs: number,
  overrides: Partial<{
    tenantId: string;
    actorId: string;
    actorRole: "sales" | "viewer";
    clientId: string;
    sessionId: string;
    scopes: string[];
    expiresAtMs: number;
  }> = {},
): ExecutionContext {
  const tenantId = overrides.tenantId ?? "tenant_demo";
  const actorId = overrides.actorId ?? "actor_sales";
  const actorRole = overrides.actorRole ?? "sales";
  const clientId = overrides.clientId ?? "client_demo";
  const sessionId = overrides.sessionId ?? "auth_session_demo";
  const expiresAtMs = overrides.expiresAtMs ?? nowMs + 60_000;
  return parseExecutionContext({
    tenant_id: tenantId,
    actor_id: actorId,
    actor_role: actorRole,
    roles: [actorRole],
    scopes: overrides.scopes ?? ["system:read"],
    client_id: clientId,
    session_id: sessionId,
    expires_at: Math.floor(expiresAtMs / 1000),
  });
}

function runtime() {
  return {
    server: { close: vi.fn(() => Promise.resolve()) },
    transport: {
      handleRequest: vi.fn(() => Promise.resolve(new Response(null))),
      close: vi.fn(() => Promise.resolve()),
    },
  };
}

describe("bounded session runtime registry", () => {
  it("purges idle sessions before get and closes both runtime objects", async () => {
    let now = Date.now();
    const registry = new SessionRuntimeRegistry({
      idleTtlMs: 100,
      maxLifetimeMs: 10_000,
      maxTokenLifetimeMs: 10_000,
      maxSessions: 2,
      clock: () => now,
    });
    const handle = runtime();
    const auth = context(now);

    await registry.register("mcp_idle_001", handle, auth);
    now += 101;

    await expect(registry.get("mcp_idle_001", auth)).resolves.toBeNull();
    expect(handle.server.close).toHaveBeenCalledTimes(1);
    expect(handle.transport.close).toHaveBeenCalledTimes(1);
  });

  it("expires a touched session at max lifetime and never extends beyond token expiry", async () => {
    let now = Date.now();
    const registry = new SessionRuntimeRegistry({
      idleTtlMs: 10_000,
      maxLifetimeMs: 500,
      maxTokenLifetimeMs: 250,
      maxSessions: 2,
      clock: () => now,
    });
    const handle = runtime();
    const auth = context(now, { expiresAtMs: now + 60_000 });

    await registry.register("mcp_token_cap_001", handle, auth);
    now += 200;
    await expect(registry.touch("mcp_token_cap_001", auth)).resolves.not.toBeNull();
    now += 51;
    await expect(registry.get("mcp_token_cap_001", auth)).resolves.toBeNull();
    expect(handle.server.close).toHaveBeenCalledTimes(1);

    const maxLifeHandle = runtime();
    const maxLifeAuth = context(now, { expiresAtMs: now + 60_000 });
    await registry.register("mcp_lifetime_001", maxLifeHandle, maxLifeAuth);
    now += 500;
    await expect(registry.get("mcp_lifetime_001", maxLifeAuth)).resolves.toBeNull();
    expect(maxLifeHandle.transport.close).toHaveBeenCalledTimes(1);
  });

  it("rejects new sessions at capacity after purging expired entries", async () => {
    let now = Date.now();
    const registry = new SessionRuntimeRegistry({
      idleTtlMs: 10_000,
      maxLifetimeMs: 10_000,
      maxTokenLifetimeMs: 10_000,
      maxSessions: 1,
      clock: () => now,
    });
    const first = runtime();
    const auth = context(now);
    await registry.register("mcp_capacity_001", first, auth);
    await expect(
      registry.register("mcp_capacity_002", runtime(), auth),
    ).rejects.toThrow(SessionRegistryCapacityError);

    now += 10_001;
    await expect(
      registry.register("mcp_capacity_002", runtime(), context(now)),
    ).resolves.toBeDefined();
    expect(first.server.close).toHaveBeenCalledTimes(1);
  });

  it("does not reuse or touch a session for a mismatched authenticated context", async () => {
    const now = Date.now();
    const registry = new SessionRuntimeRegistry({
      idleTtlMs: 10_000,
      maxLifetimeMs: 10_000,
      maxTokenLifetimeMs: 10_000,
      maxSessions: 2,
      clock: () => now,
    });
    const handle = runtime();
    const auth = context(now);
    await registry.register("mcp_context_001", handle, auth);
    const before = await registry.get("mcp_context_001", auth);

    await expect(
      registry.get(
        "mcp_context_001",
        context(now, { tenantId: "tenant_other" }),
      ),
    ).rejects.toThrow(SessionContextMismatchError);
    await expect(
      registry.touch(
        "mcp_context_001",
        context(now, { tenantId: "tenant_other" }),
      ),
    ).rejects.toThrow(SessionContextMismatchError);
    const after = await registry.get("mcp_context_001", auth);
    expect(after?.lastTouchedAtMs).toBe(before?.lastTouchedAtMs);
    expect(handle.server.close).not.toHaveBeenCalled();
  });

  it("closes sessions on delete, purge, and registry close", async () => {
    let now = Date.now();
    const registry = new SessionRuntimeRegistry({
      idleTtlMs: 100,
      maxLifetimeMs: 10_000,
      maxTokenLifetimeMs: 10_000,
      maxSessions: 3,
      clock: () => now,
    });
    const deleted = runtime();
    const purged = runtime();
    const closed = runtime();
    const auth = context(now);
    await registry.register("mcp_delete_001", deleted, auth);
    await registry.register("mcp_purge_001", purged, auth);
    await registry.register("mcp_close_001", closed, auth);

    await expect(registry.delete("mcp_delete_001")).resolves.toBe(true);
    now += 101;
    await expect(registry.purge()).resolves.toBe(2);
    expect(purged.transport.close).toHaveBeenCalledTimes(1);
    expect(closed.transport.close).toHaveBeenCalledTimes(1);
    await registry.close();
    await expect(registry.get("mcp_delete_001", auth)).resolves.toBeNull();
  });
});
