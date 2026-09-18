import { describe, expect, it, vi } from "vitest";

import { createSyntheticOoclAdapter } from "../../../services/maritime/schedule-collector/carriers/oocl";
import { parseCoscoScheduleResponse } from "../../../services/maritime/schedule-collector/carriers/cosco";
import type { CarrierAdapter } from "../../../services/maritime/schedule-collector/carriers/types";
import { InMemoryEvidenceStore } from "../../../services/maritime/schedule-collector/evidence";
import { createCollectorService } from "../../../services/maritime/schedule-collector/service";
import { validateEnvelope } from "../../../src/logistics_mcp/platform/envelope";
import {
  syntheticOoclLocationCandidates,
  syntheticOoclScheduleResponse,
} from "../../../services/maritime/schedule-collector/fixtures/synthetic-oocl";
import { syntheticCoscoScheduleResponse } from "../../../services/maritime/schedule-collector/fixtures/synthetic-cosco";
import {
  CollectorQueryInputSchema,
  ResolvedLocationSchema,
} from "../../../services/maritime/schedule-collector/contracts";
import { normalizeQuery } from "../../../services/maritime/schedule-collector/normalize";

const TEST_ORIGIN = ResolvedLocationSchema.parse({
  input_text: "Shanghai",
  name: "Shanghai",
  country_code: "CN",
  type: "city",
  carrier_location_id: "test-origin",
  mapping_source: "test",
  source_full_name: "Shanghai, China",
  unlocode: null,
});

const TEST_DESTINATION = ResolvedLocationSchema.parse({
  input_text: "Vancouver",
  name: "Vancouver",
  country_code: "CA",
  type: "city",
  carrier_location_id: "test-destination",
  mapping_source: "test",
  source_full_name: "Vancouver, Canada",
  unlocode: null,
});

function testQuery() {
  return {
    carrier: "COSCO",
    origin: {
      text: "Shanghai",
      country_code: "CN",
      carrier_location_id: null,
    },
    destination: {
      text: "Vancouver",
      country_code: "CA",
      carrier_location_id: null,
    },
    from: "2026-09-17",
    until: "2026-10-14",
    routing: "any",
  };
}

function lifecycleAdapter(options: {
  readonly entered?: () => void;
} = {}): CarrierAdapter {
  return {
    metadata: {
      id: "COSCO",
      displayName: "COSCO",
      adapterVersion: "test@1",
      capabilityStatus: "live_verified",
      provenanceKind: "live",
      lastLiveVerifiedAt: "2026-09-17T00:00:00Z",
    },
    resolveLocations(input) {
      return Promise.resolve(
        input.text === "Shanghai" ? [TEST_ORIGIN] : [TEST_DESTINATION],
      );
    },
    query(_context, http) {
      options.entered?.();
      return http.request({
        carrier: "COSCO",
        method: "GET",
        path: "/lifecycle",
      }).then((response) => ({
        records: [],
        coverage: {
          requested_from: "2026-09-17",
          requested_until: "2026-10-14",
          covered_windows: [],
          uncovered_windows: [],
          pages_read: [1],
          complete: true,
          truncated: false,
          failure_reason: null,
        },
        quality: {
          key_fields_complete: true,
          evaluation_status: "evaluated" as const,
          conflicts: [],
          warnings: [],
          missing_field_count: 0,
        },
        evidenceRef: null,
        evidenceRefs: [],
        response,
      }));
    },
  };
}

describe("schedule collector service", () => {
  it("enforces one operation deadline and aborts the downstream request", async () => {
    let requestSignal: AbortSignal | undefined;
    const service = createCollectorService({
      deadlineMs: 25,
      ports: {
        clock: { now: () => new Date("2026-09-17T00:00:00Z") },
        context: {
          requestId: "request_deadline",
          auditId: "audit_deadline",
          localFixture: true,
        },
        audit: { record: () => Promise.resolve() },
        evidence: new InMemoryEvidenceStore(),
        http: {
          request(input) {
            requestSignal = input.signal;
            return new Promise((_, reject) => {
              input.signal?.addEventListener(
                "abort",
                () => reject(new Error("request aborted")),
                { once: true },
              );
            });
          },
        },
      },
      adapters: [lifecycleAdapter()],
    });

    const result = await service.query(testQuery());
    const envelope = validateEnvelope(result.envelope);
    expect(envelope.status).toBe("unavailable");
    expect(envelope.blockers).toContainEqual(
      expect.objectContaining({ code: "timeout", message: "collector_deadline_exceeded" }),
    );
    expect(requestSignal?.aborted).toBe(true);
  });

  it("propagates caller cancellation and returns a structured unavailable result", async () => {
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    const service = createCollectorService({
      deadlineMs: 1_000,
      ports: {
        clock: { now: () => new Date("2026-09-17T00:00:00Z") },
        context: {
          requestId: "request_cancelled",
          auditId: "audit_cancelled",
          localFixture: true,
        },
        audit: { record: () => Promise.resolve() },
        evidence: new InMemoryEvidenceStore(),
        http: {
          request(input) {
            requestSignal = input.signal;
            return new Promise((_, reject) => {
              input.signal?.addEventListener(
                "abort",
                () => reject(new Error("request aborted")),
                { once: true },
              );
            });
          },
        },
      },
      adapters: [lifecycleAdapter({ entered: () => entered() })],
    });

    const controller = new AbortController();
    const pending = service.query(testQuery(), { signal: controller.signal });
    await enteredPromise;
    controller.abort();

    const envelope = validateEnvelope((await pending).envelope);
    expect(envelope.status).toBe("unavailable");
    expect(envelope.blockers).toContainEqual(
      expect.objectContaining({ code: "timeout", message: "collector_aborted" }),
    );
    expect(requestSignal?.aborted).toBe(true);
  });

  it("returns synthetic fixture data only through a manual_review envelope", async () => {
    const audit = { record: vi.fn(() => Promise.resolve()) };
    const service = createCollectorService({
      ports: {
        clock: { now: () => new Date("2026-09-17T00:00:00Z") },
        context: {
          requestId: "request_synthetic_service",
          auditId: "audit_synthetic_service",
          localFixture: true,
        },
        audit,
        evidence: new InMemoryEvidenceStore(),
        http: {
          request: vi.fn(() =>
            Promise.reject(new Error("synthetic fixture must not use HTTP")),
          ),
        },
      },
      adapters: [
        createSyntheticOoclAdapter({
          origin: syntheticOoclLocationCandidates.origin,
          destination: syntheticOoclLocationCandidates.destination,
          response: syntheticOoclScheduleResponse,
          observedAt: "2026-09-17T00:00:00Z",
        }),
      ],
    });

    const result = await service.query({
      carrier: "OOCL",
      origin: {
        text: "Shanghai",
        country_code: "CN",
        carrier_location_id: null,
      },
      destination: {
        text: "Toronto",
        country_code: "CA",
        carrier_location_id: null,
      },
      from: "2026-09-17",
      until: "2026-10-28",
      routing: "any",
    });

    const envelope = validateEnvelope(result.envelope);
    expect(envelope.status).toBe("manual_review");
    expect(envelope.blockers.map((entry) => entry.code)).toContain(
      "synthetic_data",
    );
    expect(envelope.data).toMatchObject({
      run_status: "partial",
      provenance: { kind: "synthetic" },
      coverage: { complete: false },
    });
    expect(audit.record).toHaveBeenCalled();
  });

  it("projects source warnings into the shared envelope without losing domain evidence", async () => {
    const base = createSyntheticOoclAdapter({
      origin: syntheticOoclLocationCandidates.origin,
      destination: syntheticOoclLocationCandidates.destination,
      response: syntheticOoclScheduleResponse,
      observedAt: "2026-09-17T00:00:00Z",
    });
    const adapter: CarrierAdapter = {
      ...base,
      async query(...args) {
        const result = await base.query(...args);
        return { ...result, quality: { ...result.quality, warnings: [
          "one_request_terms_cy_cy", "one_cargo_nature_gp_only",
          "one_document_cutoff_not_mapped", "one_request_terms_cy_cy",
        ] } };
      },
    };
    const service = createCollectorService({
      ports: {
        clock: { now: () => new Date("2026-09-17T00:00:00Z") },
        context: { requestId: "request_warning_projection", auditId: "audit_warning_projection", localFixture: true },
        audit: { record: () => Promise.resolve() },
        evidence: new InMemoryEvidenceStore(),
        http: { request: () => Promise.reject(new Error("must not use network")) },
      },
      adapters: [adapter],
    });
    const result = await service.query({ carrier: "OOCL", origin: { text: "Shanghai", country_code: "CN", carrier_location_id: null }, destination: { text: "Toronto", country_code: "CA", carrier_location_id: null }, from: "2026-09-17", until: "2026-10-28", routing: "any" });
    const envelope = validateEnvelope(result.envelope);
    expect(envelope.status).toBe("manual_review");
    expect(envelope.warnings.map((warning) => warning.code)).toEqual([
      "one_request_terms_cy_cy", "one_cargo_nature_gp_only", "one_document_cutoff_not_mapped",
    ]);
    expect(envelope.warnings.every((warning) => warning.severity === "warning")).toBe(true);
    expect(envelope.data).toMatchObject({ quality: { warnings: [
      "one_request_terms_cy_cy", "one_cargo_nature_gp_only", "one_document_cutoff_not_mapped", "one_request_terms_cy_cy",
    ] } });
  });

  it("maps invalid input to needs_input without calling a carrier", async () => {
    const service = createCollectorService({
      ports: {
        clock: { now: () => new Date("2026-09-17T00:00:00Z") },
        context: {
          requestId: "request_invalid",
          auditId: "audit_invalid",
          localFixture: true,
        },
        audit: { record: vi.fn(() => Promise.resolve()) },
        evidence: new InMemoryEvidenceStore(),
        http: {
          request: vi.fn(() => Promise.reject(new Error("must not be called"))),
        },
      },
    });
    const result = await service.query({
      carrier: "OOCL",
      origin: { text: "上海", country_code: "CN", carrier_location_id: null },
      destination: {
        text: "Vancouver",
        country_code: "CA",
        carrier_location_id: null,
      },
      from: "2026-02-30",
      until: "2026-03-01",
      routing: "any",
    });
    expect(validateEnvelope(result.envelope).status).toBe("needs_input");
  });

  it("applies routing filters without reclassifying unverified multi-segment rows", async () => {
    const direct = syntheticCoscoScheduleResponse.data.content.data[0];
    const unknown = {
      ...direct,
      id: "2",
      deList1: [{ type: "transfer" }],
    };
    const input = CollectorQueryInputSchema.parse({
      carrier: "COSCO",
      origin: {
        text: "Shanghai",
        country_code: "CN",
        carrier_location_id: null,
      },
      destination: {
        text: "Vancouver",
        country_code: "CA",
        carrier_location_id: null,
      },
      from: "2026-09-17",
      until: "2026-10-14",
      routing: "direct",
    });
    const origin = ResolvedLocationSchema.parse({
      input_text: "Shanghai",
      name: "Shanghai",
      country_code: "CN",
      type: "city",
      carrier_location_id: "synthetic-cosco-shanghai",
      mapping_source: "cosco_find_city_district",
      source_full_name: "Shanghai,Shanghai,Shanghai,China",
      unlocode: "CNSHA",
    });
    const destination = ResolvedLocationSchema.parse({
      input_text: "Vancouver",
      name: "Vancouver",
      country_code: "CA",
      type: "city",
      carrier_location_id: "synthetic-cosco-vancouver-ca",
      mapping_source: "cosco_find_city_district",
      source_full_name: "Vancouver, ,BC,Canada",
      unlocode: "CAVCR",
    });
    const parsed = parseCoscoScheduleResponse(
      {
        ...syntheticCoscoScheduleResponse,
        data: {
          content: {
            ...syntheticCoscoScheduleResponse.data.content,
            data: [unknown],
          },
        },
      },
      {
        requestId: "request_routing",
        normalizedQuery: normalizeQuery(input, origin, destination),
        origin,
        destination,
        evidenceRef: "evidence:request_routing:COSCO:sha256:fixture",
        observedAt: "2026-09-17T00:00:00Z",
      },
    );
    const adapter: CarrierAdapter = {
      metadata: {
        id: "COSCO",
        displayName: "COSCO",
        adapterVersion: "fixture@1",
        capabilityStatus: "implemented_unverified",
        provenanceKind: "live",
        lastLiveVerifiedAt: null,
      },
      resolveLocations: (input) =>
        Promise.resolve(
          input.text.toLowerCase() === "shanghai" ? [origin] : [destination],
        ),
      query: () => Promise.resolve(parsed),
    };
    const service = createCollectorService({
      ports: {
        clock: { now: () => new Date("2026-09-17T00:00:00Z") },
        context: {
          requestId: "request_routing_service",
          auditId: "audit_routing_service",
          localFixture: true,
        },
        audit: { record: () => Promise.resolve() },
        evidence: new InMemoryEvidenceStore(),
        http: { request: () => Promise.reject(new Error("must not be called")) },
      },
      adapters: [adapter],
    });
    const result = await service.query(input);
    const envelope = validateEnvelope(result.envelope);
    expect(envelope.status).toBe("manual_review");
    expect(envelope.data).toMatchObject({
      run_status: "partial",
      records: [],
    });
  });
});
