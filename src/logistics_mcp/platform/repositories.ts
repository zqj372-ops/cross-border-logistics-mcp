import type { EnvelopeStatus } from "./envelope";

export interface AuditEvent {
  readonly audit_id: string;
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly client_id: string;
  readonly request_id: string;
  readonly tool: string;
  readonly schema_version: string;
  readonly status: EnvelopeStatus;
  readonly source_ids: readonly string[];
  readonly versions: readonly string[];
  readonly reason_codes: readonly string[];
  readonly duration_ms: number;
  readonly idempotency_outcome:
    | "not_applicable"
    | "reserved"
    | "in_progress"
    | "replayed"
    | "conflict";
  readonly readback_status:
    | "not_applicable"
    | "pending"
    | "verified"
    | "missing"
    | "mismatch";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditRepository {
  append(event: AuditEvent): Promise<void>;
  list(): Promise<readonly AuditEvent[]>;
}

export type IdempotencyStatus = "reserved" | "committed";

export interface IdempotencyRecord {
  readonly tenantId: string;
  readonly tool: string;
  readonly key: string;
  readonly requestHash: string;
  readonly previewRef: string | null;
  readonly status: IdempotencyStatus;
  readonly recordId: string | null;
  readonly result: unknown;
  readonly expiresAt: number;
}

export interface IdempotencyReserveRequest {
  readonly tenantId: string;
  readonly tool: string;
  readonly key: string;
  readonly requestHash: string;
  readonly previewRef?: string | null;
}

export interface IdempotencyCommitRequest {
  readonly tenantId: string;
  readonly tool: string;
  readonly key: string;
  readonly requestHash: string;
  readonly result: unknown;
  readonly recordId?: string | null;
}

export interface IdempotencyReleaseRequest {
  readonly tenantId: string;
  readonly tool: string;
  readonly key: string;
  readonly requestHash: string;
  readonly expectedExpiresAt: number;
}

export interface IdempotencyReserveResult {
  readonly replayed: boolean;
  readonly inProgress: boolean;
  readonly record: IdempotencyRecord;
}

export interface IdempotencyRepository {
  reserve(
    request: IdempotencyReserveRequest,
  ): Promise<IdempotencyReserveResult>;
  commit(request: IdempotencyCommitRequest): Promise<IdempotencyRecord>;
  release(request: IdempotencyReleaseRequest): Promise<void>;
  get(
    tenantId: string,
    tool: string,
    key: string,
  ): Promise<IdempotencyRecord | null>;
}
