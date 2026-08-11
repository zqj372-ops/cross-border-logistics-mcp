import { createHash } from "node:crypto";

import type { ExecutionContext } from "./context";

export interface SessionRuntimeHandle {
  readonly server: { close(): Promise<void> };
  readonly transport: {
    handleRequest(
      request: Request,
      options?: { readonly parsedBody?: unknown },
    ): Promise<Response>;
    close(): Promise<void>;
  };
}

export interface SessionRuntimeRegistryOptions {
  readonly idleTtlMs: number;
  readonly maxLifetimeMs: number;
  readonly maxTokenLifetimeMs: number;
  readonly maxSessions: number;
  readonly clock?: () => number;
}

export interface SessionRuntimeLimits {
  readonly idleTtlMs: number;
  readonly maxLifetimeMs: number;
  readonly maxTokenLifetimeMs: number;
  readonly maxSessions: number;
}

export interface SessionRuntimeEntry<TRuntime extends SessionRuntimeHandle> {
  readonly sessionId: string;
  readonly runtime: TRuntime;
  readonly tenantId: string;
  readonly actorId: string;
  readonly clientId: string;
  readonly authSessionId: string;
  readonly contextFingerprint: string;
  readonly createdAtMs: number;
  readonly lastTouchedAtMs: number;
  readonly tokenExpiresAtMs: number;
}

export class SessionRegistryCapacityError extends Error {
  readonly code = "session.capacity_exhausted";

  constructor() {
    super("The MCP session capacity is exhausted.");
    this.name = "SessionRegistryCapacityError";
  }
}

export class SessionContextMismatchError extends Error {
  readonly code = "security.session_context_mismatch";

  constructor() {
    super("The MCP session is bound to a different authenticated context.");
    this.name = "SessionContextMismatchError";
  }
}

export class SessionRegistryClosedError extends Error {
  readonly code = "session.registry_closed";

  constructor() {
    super("The MCP session registry is closed.");
    this.name = "SessionRegistryClosedError";
  }
}

export class SessionTokenExpiredError extends Error {
  readonly code = "session.token_expired";

  constructor() {
    super("The authenticated token is not valid for a new MCP session.");
    this.name = "SessionTokenExpiredError";
  }
}

class SessionRuntimeCloseError extends Error {
  readonly code = "session.runtime_close_failed";

  constructor() {
    super("An MCP session runtime could not be closed cleanly.");
    this.name = "SessionRuntimeCloseError";
  }
}

function isPositiveFiniteInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function contextFingerprint(context: ExecutionContext): string {
  const normalized = JSON.stringify({
    tenantId: context.tenantId,
    actorId: context.actorId,
    role: context.role,
    roles: [...context.roles].sort(),
    scopes: [...context.scopes].sort(),
    clientId: context.clientId,
    sessionId: context.sessionId,
  });
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

function expired(
  entry: SessionRuntimeEntry<SessionRuntimeHandle>,
  nowMs: number,
  limits: SessionRuntimeLimits,
): boolean {
  return (
    nowMs >= entry.tokenExpiresAtMs ||
    nowMs - entry.createdAtMs >= limits.maxLifetimeMs ||
    nowMs - entry.lastTouchedAtMs >= limits.idleTtlMs
  );
}

function validateLimits(options: SessionRuntimeRegistryOptions): SessionRuntimeLimits {
  const limits = {
    idleTtlMs: options.idleTtlMs,
    maxLifetimeMs: options.maxLifetimeMs,
    maxTokenLifetimeMs: options.maxTokenLifetimeMs,
    maxSessions: options.maxSessions,
  };
  if (
    !isPositiveFiniteInteger(limits.idleTtlMs) ||
    !isPositiveFiniteInteger(limits.maxLifetimeMs) ||
    !isPositiveFiniteInteger(limits.maxTokenLifetimeMs) ||
    !isPositiveFiniteInteger(limits.maxSessions)
  ) {
    throw new TypeError("Session runtime limits must be positive safe integers.");
  }
  return Object.freeze(limits);
}

export class SessionRuntimeRegistry<TRuntime extends SessionRuntimeHandle = SessionRuntimeHandle> {
  readonly limits: SessionRuntimeLimits;

  private readonly clock: () => number;
  private readonly entries = new Map<string, SessionRuntimeEntry<TRuntime>>();
  private closed = false;

  constructor(options: SessionRuntimeRegistryOptions) {
    this.limits = validateLimits(options);
    this.clock = options.clock ?? Date.now;
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionRegistryClosedError();
  }

  private isExpired(entry: SessionRuntimeEntry<TRuntime>, nowMs: number): boolean {
    return expired(entry, nowMs, this.limits);
  }

  private async closeRuntime(entry: SessionRuntimeEntry<TRuntime>): Promise<void> {
    const failures: unknown[] = [];
    try {
      await entry.runtime.server.close();
    } catch (error: unknown) {
      failures.push(error);
    }
    try {
      await entry.runtime.transport.close();
    } catch (error: unknown) {
      failures.push(error);
    }
    if (failures.length > 0) throw new SessionRuntimeCloseError();
  }

  private async removeAndClose(
    sessionId: string,
  ): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return false;
    this.entries.delete(sessionId);
    await this.closeRuntime(entry);
    return true;
  }

  async purge(): Promise<number> {
    if (this.closed) return 0;
    const nowMs = this.clock();
    const expiredSessionIds = [...this.entries.values()]
      .filter((entry) => this.isExpired(entry, nowMs))
      .map((entry) => entry.sessionId);
    let firstFailure: unknown;
    for (const sessionId of expiredSessionIds) {
      try {
        await this.removeAndClose(sessionId);
      } catch (error: unknown) {
        firstFailure ??= error;
      }
    }
    if (firstFailure !== undefined) {
      throw firstFailure instanceof Error
        ? firstFailure
        : new SessionRuntimeCloseError();
    }
    return expiredSessionIds.length;
  }

  async register(
    sessionId: string,
    runtime: TRuntime,
    context: ExecutionContext,
  ): Promise<SessionRuntimeEntry<TRuntime>> {
    this.assertOpen();
    if (sessionId.length === 0 || sessionId.length > 200) {
      throw new TypeError("A valid MCP session ID is required.");
    }
    await this.purge();
    if (this.entries.has(sessionId)) {
      throw new Error("The MCP session ID is already registered.");
    }
    if (this.entries.size >= this.limits.maxSessions) {
      throw new SessionRegistryCapacityError();
    }

    const nowMs = this.clock();
    const tokenExpiresAtMs = context.expiresAt * 1000;
    if (!Number.isSafeInteger(tokenExpiresAtMs) || tokenExpiresAtMs <= nowMs) {
      throw new SessionTokenExpiredError();
    }
    const entry: SessionRuntimeEntry<TRuntime> = {
      sessionId,
      runtime,
      tenantId: context.tenantId,
      actorId: context.actorId,
      clientId: context.clientId,
      authSessionId: context.sessionId,
      contextFingerprint: contextFingerprint(context),
      createdAtMs: nowMs,
      lastTouchedAtMs: nowMs,
      tokenExpiresAtMs: Math.min(
        tokenExpiresAtMs,
        nowMs + this.limits.maxTokenLifetimeMs,
      ),
    };
    this.entries.set(sessionId, entry);
    return entry;
  }

  async get(
    sessionId: string,
    context: ExecutionContext,
  ): Promise<SessionRuntimeEntry<TRuntime> | null> {
    if (this.closed) return null;
    await this.purge();
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return null;
    if (entry.contextFingerprint !== contextFingerprint(context)) {
      throw new SessionContextMismatchError();
    }
    return entry;
  }

  async touch(
    sessionId: string,
    context: ExecutionContext,
  ): Promise<SessionRuntimeEntry<TRuntime> | null> {
    if (this.closed) return null;
    await this.purge();
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return null;
    if (entry.contextFingerprint !== contextFingerprint(context)) {
      throw new SessionContextMismatchError();
    }
    const nowMs = this.clock();
    const currentTokenExpiry = Math.min(
      entry.tokenExpiresAtMs,
      context.expiresAt * 1000,
    );
    const touched: SessionRuntimeEntry<TRuntime> = {
      ...entry,
      lastTouchedAtMs: nowMs,
      tokenExpiresAtMs: currentTokenExpiry,
    };
    if (this.isExpired(touched, nowMs)) {
      await this.removeAndClose(sessionId);
      return null;
    }
    this.entries.set(sessionId, touched);
    return touched;
  }

  async delete(sessionId: string): Promise<boolean> {
    if (this.closed) return false;
    return this.removeAndClose(sessionId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = [...this.entries.values()];
    this.entries.clear();
    const results = await Promise.allSettled(
      active.map((entry) => this.closeRuntime(entry)),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new SessionRuntimeCloseError();
    }
  }
}
