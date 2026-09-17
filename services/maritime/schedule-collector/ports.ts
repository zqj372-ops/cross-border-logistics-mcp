export interface Clock {
  now(): Date;
}

export interface RequestContext {
  readonly requestId: string;
  readonly auditId: string;
  readonly localFixture: boolean;
}

export interface AuditEvent {
  readonly requestId: string;
  readonly event:
    | "query_started"
    | "location_resolved"
    | "query_completed"
    | "query_failed"
    | "evidence_written";
  readonly at: string;
  readonly carrier: string | null;
  readonly status: string;
  readonly issue_code: string | null;
}

export interface AuditPort {
  record(event: AuditEvent): Promise<void>;
}

export interface EvidenceWriteInput {
  readonly requestId: string;
  readonly carrier: string;
  readonly kind: "http_response" | "dom" | "screenshot" | "fixture";
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly redactions: readonly string[];
}

export interface EvidenceReference {
  readonly ref: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly storedAt: string;
}

export interface EvidenceStore {
  write(input: EvidenceWriteInput): Promise<EvidenceReference>;
  read(reference: string): Promise<Uint8Array>;
}

export interface CarrierHttpRequest {
  readonly carrier: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface CarrierHttpResponse {
  readonly status: number;
  readonly url: string;
  readonly contentType: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface CarrierHttpPort {
  request(input: CarrierHttpRequest): Promise<CarrierHttpResponse>;
}

export interface CarrierBrowserPort {
  readonly available: boolean;
  search(input: {
    readonly carrier: string;
    readonly query: unknown;
    readonly signal?: AbortSignal;
  }): Promise<CarrierHttpResponse>;
}

export interface CollectorPorts {
  readonly clock: Clock;
  readonly context: RequestContext;
  readonly audit: AuditPort;
  readonly evidence: EvidenceStore;
  readonly http: CarrierHttpPort;
  readonly browser?: CarrierBrowserPort;
}

export interface CollectorEnvelopeResult {
  readonly data: unknown;
  readonly envelope: unknown;
}

export interface CollectorService {
  resolveLocations(input: {
    readonly carrier: string;
    readonly text: string;
    readonly countryCode?: string | null;
  }): Promise<unknown>;
  query(input: unknown): Promise<CollectorEnvelopeResult>;
}
