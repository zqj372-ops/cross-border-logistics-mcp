import { createHash } from "node:crypto";

import type {
  IdempotencyCommitRequest,
  IdempotencyRecord,
  IdempotencyRepository,
  IdempotencyReserveRequest,
  IdempotencyReserveResult,
} from "./repositories";

export type {
  IdempotencyCommitRequest,
  IdempotencyRecord,
  IdempotencyRepository,
  IdempotencyReserveRequest,
  IdempotencyReserveResult,
} from "./repositories";

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict";

  constructor() {
    super("The idempotency key was already used with a different request.");
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyStateError extends Error {
  readonly code = "idempotency_state_invalid";

  constructor() {
    super("The idempotency operation has no active reservation.");
    this.name = "IdempotencyStateError";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])] as const);
    return Object.fromEntries(entries);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new IdempotencyStateError();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new IdempotencyStateError();
  }
  return value;
}

export function hashPayload(payload: unknown): string {
  const serialized = JSON.stringify(canonicalize(payload));
  if (serialized === undefined) {
    throw new IdempotencyStateError();
  }
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function assertRequest(
  request: IdempotencyReserveRequest | IdempotencyCommitRequest,
): void {
  if (
    request.tenantId.length === 0 ||
    request.tool.length === 0 ||
    request.requestHash.length === 0 ||
    request.key.length < 16 ||
    request.key.length > 200
  ) {
    throw new IdempotencyStateError();
  }
}

export class MemoryIdempotencyRepository implements IdempotencyRepository {
  private readonly records = new Map<string, IdempotencyRecord>();

  constructor(
    private readonly ttlMs = 15 * 60 * 1000,
    private readonly clock: () => number = Date.now,
  ) {}

  private keyFor(tenantId: string, tool: string, key: string): string {
    return `${tenantId}\u0000${tool}\u0000${key}`;
  }

  private currentRecord(
    tenantId: string,
    tool: string,
    key: string,
  ): IdempotencyRecord | null {
    const mapKey = this.keyFor(tenantId, tool, key);
    const record = this.records.get(mapKey);
    if (record === undefined) {
      return null;
    }
    if (record.expiresAt <= this.clock()) {
      this.records.delete(mapKey);
      return null;
    }
    return record;
  }

  async reserve(
    request: IdempotencyReserveRequest,
  ): Promise<IdempotencyReserveResult> {
    await Promise.resolve();
    assertRequest(request);
    const existing = this.currentRecord(
      request.tenantId,
      request.tool,
      request.key,
    );
    if (existing !== null) {
      if (existing.requestHash !== request.requestHash) {
        throw new IdempotencyConflictError();
      }
      return {
        replayed: existing.status === "committed",
        record: clone(existing),
      };
    }

    const record: IdempotencyRecord = {
      tenantId: request.tenantId,
      tool: request.tool,
      key: request.key,
      requestHash: request.requestHash,
      previewRef: request.previewRef ?? null,
      status: "reserved",
      recordId: null,
      result: null,
      expiresAt: this.clock() + this.ttlMs,
    };
    this.records.set(
      this.keyFor(request.tenantId, request.tool, request.key),
      record,
    );
    return { replayed: false, record: clone(record) };
  }

  async commit(request: IdempotencyCommitRequest): Promise<IdempotencyRecord> {
    await Promise.resolve();
    assertRequest(request);
    const existing = this.currentRecord(
      request.tenantId,
      request.tool,
      request.key,
    );
    if (existing === null) {
      throw new IdempotencyStateError();
    }
    if (existing.requestHash !== request.requestHash) {
      throw new IdempotencyConflictError();
    }
    if (existing.status === "committed") {
      return clone(existing);
    }

    const committed: IdempotencyRecord = {
      ...existing,
      status: "committed",
      recordId: request.recordId ?? null,
      result: clone(request.result),
    };
    this.records.set(
      this.keyFor(request.tenantId, request.tool, request.key),
      committed,
    );
    return clone(committed);
  }

  async get(
    tenantId: string,
    tool: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    await Promise.resolve();
    const record = this.currentRecord(tenantId, tool, key);
    return record === null ? null : clone(record);
  }
}
