import { describe, expect, it, vi } from "vitest";

import type { CarrierAdapter } from "../../../services/maritime/schedule-collector/carriers/types";
import type {
  AuditEvent,
  CarrierHttpPort,
  CollectorPorts,
} from "../../../services/maritime/schedule-collector/ports";
import { InMemoryEvidenceStore } from "../../../services/maritime/schedule-collector/evidence";
import { createCollectorService } from "../../../services/maritime/schedule-collector/service";

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function auditSpy() {
  return { record: vi.fn((event: AuditEvent) => { void event; return Promise.resolve(); }) };
}

const LOCATION = {
  name: "SHANGHAI, SHANGHAI, CHINA",
  country_code: "CN",
  type: "city" as const,
  carrier_location_id: "CNSHA",
  mapping_source: "stubborn_fixture",
  source_full_name: "SHANGHAI, SHANGHAI, CHINA",
  unlocode: null,
};

/**
 * Adapter that intentionally ignores the abort signal and returns a complete
 * result after the deadline. A late success must never be published as
 * success; this is the regression the acceptance review reproduced.
 */
function stubbornAdapter(delayMs: number): CarrierAdapter {
  return {
    metadata: {
      id: "ONE",
      displayName: "Stubborn ONE fixture",
      adapterVersion: "stubborn-one@1",
      capabilityStatus: "live_verified",
      provenanceKind: "live",
      lastLiveVerifiedAt: "2026-09-17T00:00:00Z",
    },
    resolveLocations(lookup) {
      return Promise.resolve([
        {
          ...LOCATION,
          name: lookup.text.toUpperCase(),
          country_code: lookup.countryCode ?? "CN",
          carrier_location_id: lookup.carrierLocationId ?? "CNSHA",
        },
      ]);
    },
    async query(context) {
      await delay(delayMs);
      return {
        records: [],
        coverage: {
          requested_from: context.normalizedQuery.departure_from,
          requested_until: context.normalizedQuery.departure_until,
          covered_windows: [
            {
              from: context.normalizedQuery.departure_from,
              until: context.normalizedQuery.departure_until,
            },
          ],
          uncovered_windows: [],
          pages_read: [1],
          complete: true,
          truncated: false,
          failure_reason: null,
        },
        quality: {
          key_fields_complete: true,
          evaluation_status: "evaluated",
          conflicts: [],
          warnings: [],
          missing_field_count: 0,
        },
        evidenceRef: null,
      };
    },
  };
}

function stubbornLocationsAdapter(delayMs: number): CarrierAdapter {
  return {
    ...stubbornAdapter(delayMs),
    async resolveLocations(lookup) {
      await delay(delayMs);
      return [
        {
          ...LOCATION,
          name: lookup.text.toUpperCase(),
          country_code: lookup.countryCode ?? "CN",
          carrier_location_id: lookup.carrierLocationId ?? "CNSHA",
        },
      ];
    },
  };
}

const unusableHttp: CarrierHttpPort = {
  request() {
    return Promise.reject(new Error("http must not be called"));
  },
};

function ports(audit: { record(event: AuditEvent): Promise<void> }): CollectorPorts {
  return {
    clock: { now: () => new Date("2026-09-18T00:00:00Z") },
    context: {
      requestId: "req_stubborn_deadline",
      auditId: "schedule-live-audit-stubborn",
      localFixture: false,
    },
    audit,
    evidence: new InMemoryEvidenceStore(),
    http: unusableHttp,
  };
}

const input = {
  carrier: "ONE",
  origin: {
    text: "Shanghai",
    country_code: "CN",
    carrier_location_id: "CNSHA",
  },
  destination: {
    text: "Vancouver",
    country_code: "CA",
    carrier_location_id: "CAVAN",
  },
  from: "2026-09-18",
  until: "2026-10-15",
  routing: "any",
};

describe("collector deadline with an uncooperative adapter", () => {
  it("never publishes a late complete query as success", async () => {
    const audit = auditSpy();
    const service = createCollectorService({
      deadlineMs: 5,
      ports: ports(audit),
      adapters: [stubbornAdapter(30)],
    });

    const result = (await service.query(input)) as {
      readonly envelope: {
        readonly status: string;
        readonly data: unknown;
        readonly blockers: readonly { readonly message?: string }[];
      };
    };
    expect(result.envelope.status).toBe("unavailable");
    expect(result.envelope.data).toBeNull();
    expect(result.envelope.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "timeout",
          message: "collector_deadline_exceeded",
        }),
      ]),
    );
    expect(
      audit.record.mock.calls.some(([event]) => event.event === "query_completed"),
    ).toBe(false);
    expect(audit.record.mock.calls.map(([event]) => event)).toContainEqual(
      expect.objectContaining({
        event: "query_failed",
        issue_code: "timeout",
      }),
      );
  });

  it("never publishes a late location result after the caller cancels", async () => {
    const audit = auditSpy();
    const service = createCollectorService({
      deadlineMs: 1_000,
      ports: ports(audit),
      adapters: [{ ...stubbornLocationsAdapter(30), metadata: { ...stubbornAdapter(0).metadata, adapterVersion: "stubborn-one-locations@1" } }],
    });
    const controller = new AbortController();
    const pending = service.resolveLocations(
      {
        carrier: "ONE",
        text: "Shanghai",
        countryCode: "CN",
      },
      { signal: controller.signal },
    );
    await delay(10);
    controller.abort();

    const result = (await pending) as {
      readonly envelope: {
        readonly status: string;
        readonly data: unknown;
        readonly blockers: readonly { readonly message?: string }[];
      };
    };
    expect(result.envelope.status).toBe("unavailable");
    expect(result.envelope.data).toBeNull();
    expect(result.envelope.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "collector_aborted" }),
      ]),
    );
    expect(audit.record.mock.calls.map(([event]) => event)).toContainEqual(
      expect.objectContaining({
        event: "query_failed",
        issue_code: "timeout",
      }),
      );
  });

  it("keeps the deadline over slow terminal audit persistence", async () => {
    const audit = {
      record: vi.fn(async (event: AuditEvent) => {
        if (event.event === "query_completed") await delay(30);
      }),
    };
    const service = createCollectorService({
      deadlineMs: 5,
      ports: ports(audit),
      adapters: [stubbornAdapter(0)],
    });

    const result = (await service.query(input)) as {
      readonly envelope: {
        readonly status: string;
        readonly data: unknown;
        readonly blockers: readonly { readonly message?: string }[];
      };
    };
    expect(result.envelope.status).toBe("unavailable");
    expect(result.envelope.data).toBeNull();
    expect(result.envelope.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "collector_deadline_exceeded" }),
      ]),
    );
    expect(audit.record.mock.calls.map(([event]) => event)).toContainEqual(
      expect.objectContaining({
        event: "query_failed",
        issue_code: "timeout",
      }),
      );
  });

  it("keeps caller cancellation over terminal audit persistence", async () => {
    const controller = new AbortController();
    const audit = {
      record: vi.fn(async (event: AuditEvent) => {
        if (event.event === "query_completed") {
          controller.abort();
          await delay(30);
        }
      }),
    };
    const service = createCollectorService({
      deadlineMs: 1_000,
      ports: ports(audit),
      adapters: [stubbornAdapter(0)],
    });

    const result = (await service.query(input, {
      signal: controller.signal,
    })) as {
      readonly envelope: {
        readonly status: string;
        readonly data: unknown;
        readonly blockers: readonly { readonly message?: string }[];
      };
    };
    expect(result.envelope.status).toBe("unavailable");
    expect(result.envelope.data).toBeNull();
    expect(result.envelope.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "collector_aborted" }),
      ]),
    );
    expect(audit.record.mock.calls.map(([event]) => event)).toContainEqual(
      expect.objectContaining({
        event: "query_failed",
        issue_code: "timeout",
      }),
      );
  });
});
