import {
  CollectorContractError,
  parseCollectorQueryInput,
  parseCollectorResultData,
  type CollectorQueryInput,
  type CollectorResultData,
  type NormalizedCollectorQuery,
  type ResolvedLocation,
} from "./contracts";
import { CollectorRuntimeError, type CollectorIssueCode } from "./errors";
import {
  findLocationCandidates,
  resolveLocationCandidates,
} from "./locations";
import { normalizeQuery } from "./normalize";
import type {
  CarrierBrowserPort,
  CarrierHttpPort,
  CollectorEnvelopeResult,
  CollectorPorts,
  EvidenceStore,
} from "./ports";
import {
  createEnvelope,
  type Notice,
  type SourceRef,
} from "../../../src/logistics_mcp/platform/envelope";
import {
  createCarrierRegistry,
  listCarrierMetadata,
} from "./carriers/registry";
import { normalizeCarrierId } from "./carriers/aliases";
import type { CarrierAdapter, CarrierMetadata } from "./carriers/types";

export interface CollectorServiceOptions {
  readonly ports: CollectorPorts;
  readonly adapters?: readonly CarrierAdapter[];
  readonly deadlineMs?: number;
  readonly dateFilterBasis?:
    | "departure_from_first_ocean_leg"
    | "departure_from_origin"
    | "unknown";
}

export interface CollectorOperationOptions {
  readonly signal?: AbortSignal;
}

export interface CollectorServiceApi {
  carriers(): CollectorEnvelopeResult;
  resolveLocations(input: {
    readonly carrier: string;
    readonly text: string;
    readonly countryCode?: string | null;
    readonly locationId?: string | null;
  }, options?: CollectorOperationOptions): Promise<CollectorEnvelopeResult>;
  query(
    input: unknown,
    options?: CollectorOperationOptions,
  ): Promise<CollectorEnvelopeResult>;
}

const DEFAULT_DATE_FILTER_BASIS = "departure_from_first_ocean_leg" as const;
const DEFAULT_DEADLINE_MS = 120_000;
const SOURCE_WARNING_MESSAGES: Readonly<Record<string, string>> = {
  one_request_terms_cy_cy: "ONE query uses CY/CY receipt and delivery terms.",
  one_cargo_nature_gp_only: "ONE query covers general-purpose cargo only.",
  one_document_cutoff_not_mapped: "ONE documentation cutoff is not verified as a Shipping Instructions cutoff.",
};

function notice(
  code: string,
  message: string,
  severity: Notice["severity"],
): Notice {
  return { code, message, severity };
}

function sourceRef(
  metadata: CarrierMetadata,
  provenance: CollectorResultData["provenance"],
  evidenceReference: string | null,
): SourceRef {
  const isFixture = provenance.kind !== "live";
  return {
    source_id: `carrier-${metadata.id.toLocaleLowerCase()}-observation`,
    source_type: isFixture ? "fixture" : "official_source",
    system: metadata.displayName,
    locator: evidenceReference ?? `collector:${metadata.id}`,
    version: provenance.parser_version,
    retrieved_at:
      provenance.fetched_at ?? provenance.fixture_generated_at ?? "1970-01-01T00:00:00Z",
    authority: isFixture ? "supporting" : "authoritative",
    content_hash: null,
  };
}

function statusForData(
  data: CollectorResultData,
): {
  readonly status: "success" | "manual_review" | "blocked" | "unavailable";
  readonly blockers: readonly Notice[];
  readonly warnings: readonly Notice[];
} {
  if (data.provenance.kind === "synthetic") {
    return {
      status: "manual_review",
      blockers: [
        notice(
          "synthetic_data",
          "Synthetic collector data is not a live carrier result.",
          "error",
        ),
      ],
      warnings: [],
    };
  }
  if (data.provenance.kind === "replay") {
    return {
      status: "manual_review",
      blockers: [
        notice(
          "replay_data",
          "Replay evidence is not a fresh live result.",
          "error",
        ),
      ],
      warnings: [],
    };
  }
  switch (data.run_status) {
    case "ok":
      return { status: "success", blockers: [], warnings: [] };
    case "no_results":
      return {
        status: "success",
        blockers: [],
        warnings: [
          notice(
            "no_matching_records",
            "The covered source query returned no matching schedules.",
            "warning",
          ),
        ],
      };
    case "partial":
      return {
        status: "manual_review",
        blockers: [
          notice(
            "incomplete_results",
            "The source query coverage is incomplete or conflicting.",
            "error",
          ),
        ],
        warnings: [],
      };
    case "unsupported":
    case "not_run":
      return {
        status: "blocked",
        blockers: [
          notice(
            data.run_status === "unsupported"
              ? "unsupported_filter"
              : "live_not_approved",
            "The requested collector operation is not enabled.",
            "error",
          ),
        ],
        warnings: [],
      };
    case "failed":
      return {
        status: "unavailable",
        blockers: [
          notice(
            "collector_unavailable",
            "The source query did not produce a usable result.",
            "error",
          ),
        ],
        warnings: [],
      };
  }
}

function envelopeFromData(
  data: CollectorResultData,
  ports: CollectorPorts,
): CollectorEnvelopeResult {
  const mapped = statusForData(data);
  const envelope = createEnvelope({
    requestId: ports.context.requestId,
    auditId: ports.context.auditId,
    status: mapped.status,
    data,
    sourceRefs: [
      sourceRef(
        {
          id: data.carrier.id,
          displayName: data.carrier.sales_carrier,
          adapterVersion: data.carrier.adapter_version,
          capabilityStatus: data.carrier.capability_status,
          provenanceKind: data.provenance.kind,
          lastLiveVerifiedAt: data.carrier.last_live_verified_at,
        },
        data.provenance,
        data.provenance.source_refs[0] ?? data.records[0]?.evidence_ref ?? null,
      ),
    ],
    assumptions:
      data.provenance.kind === "synthetic"
        ? [
            notice(
              "synthetic_fixture_only",
              "This is a synthetic design fixture and not a live observation.",
              "info",
            ),
          ]
        : [],
    warnings: [...new Map([
      ...mapped.warnings,
      ...data.quality.warnings.map((code) => notice(code,
        SOURCE_WARNING_MESSAGES[code] ?? `Source restriction: ${code}.`, "warning")),
    ].map((entry) => [entry.code, entry] as const)).values()],
    blockers: mapped.blockers,
    reviewStatus: mapped.status === "manual_review" ? "manual_review" : "not_required",
  });
  return { data, envelope };
}

function errorEnvelope(
  error: unknown,
  ports: CollectorPorts,
): CollectorEnvelopeResult {
  if (
    error instanceof CollectorContractError &&
    error.code === "invalid_query"
  ) {
    const envelope = createEnvelope({
      requestId: ports.context.requestId,
      auditId: ports.context.auditId,
      status: "needs_input",
      data: null,
      blockers: [
        notice("validation_error", "The collector input is invalid.", "error"),
      ],
      reviewStatus: "pending",
    });
    return { data: null, envelope };
  }
  const runtime =
    error instanceof CollectorRuntimeError
      ? error
      : error instanceof CollectorContractError
        ? new CollectorRuntimeError(
            "schema_changed",
            "unavailable",
            error.message,
          )
        : new CollectorRuntimeError(
            "unexpected_error",
            "unavailable",
            "collector_internal_error",
          );
  const mapped = {
    status: runtime.status,
    reviewStatus:
      runtime.status === "manual_review" ? "manual_review" : "not_required",
  } as const;
  const envelope = createEnvelope({
    requestId: ports.context.requestId,
    auditId: ports.context.auditId,
    status: mapped.status,
    data: null,
    blockers: [notice(runtime.code, runtime.message, "error")],
    reviewStatus: mapped.reviewStatus,
  });
  return { data: null, envelope };
}

function issueCodeFromError(error: unknown): CollectorIssueCode {
  return error instanceof CollectorRuntimeError
    ? error.code
    : "unexpected_error";
}

function mergeSignals(
  left: AbortSignal | undefined,
  right: AbortSignal | undefined,
): AbortSignal | undefined {
  if (left === undefined) return right;
  if (right === undefined || left === right) return left;
  return AbortSignal.any([left, right]);
}

function scopedHttpPort(
  port: CarrierHttpPort,
  signal: AbortSignal,
): CarrierHttpPort {
  return {
    request(input) {
      const merged = mergeSignals(input.signal, signal);
      return merged === undefined || merged === input.signal
        ? port.request(input)
        : port.request({ ...input, signal: merged });
    },
  };
}

function scopedEvidenceStore(
  store: EvidenceStore,
  signal: AbortSignal,
): EvidenceStore {
  return {
    write(input) {
      const merged = mergeSignals(input.signal, signal);
      return merged === undefined || merged === input.signal
        ? store.write(input)
        : store.write({ ...input, signal: merged });
    },
    read: (reference) => store.read(reference),
  };
}

function scopedBrowserPort(
  port: CarrierBrowserPort,
  signal: AbortSignal,
): CarrierBrowserPort {
  return {
    available: port.available,
    search(input) {
      const merged = mergeSignals(input.signal, signal);
      return merged === undefined || merged === input.signal
        ? port.search(input)
        : port.search({ ...input, signal: merged });
    },
  };
}

function scopedPorts(ports: CollectorPorts, signal: AbortSignal): CollectorPorts {
  const base = {
    clock: ports.clock,
    context: ports.context,
    audit: ports.audit,
    evidence: scopedEvidenceStore(ports.evidence, signal),
    http: scopedHttpPort(ports.http, signal),
  };
  return ports.browser === undefined
    ? base
    : {
        ...base,
        browser: scopedBrowserPort(ports.browser, signal),
      };
}

async function withOperationDeadline<T>(
  callerSignal: AbortSignal | undefined,
  deadlineMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (callerSignal?.aborted) {
    throw new CollectorRuntimeError(
      "timeout",
      "unavailable",
      "collector_aborted",
    );
  }
  const controller = new AbortController();
  let rejectDeadline!: (error: CollectorRuntimeError) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const abortOperation = (message: string): void => {
    rejectDeadline(
      new CollectorRuntimeError("timeout", "unavailable", message),
    );
    controller.abort();
  };
  const onCallerAbort = (): void =>
    abortOperation("collector_aborted");
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(
    () => abortOperation("collector_deadline_exceeded"),
    deadlineMs,
  );
  try {
    const operationPromise = operation(controller.signal);
    void operationPromise.catch(() => undefined);
    return await Promise.race([operationPromise, deadline]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function adapterFor(
  registry: ReadonlyMap<string, CarrierAdapter>,
  carrier: string,
): CarrierAdapter {
  const normalized = normalizeCarrierId(carrier);
  if (normalized === null) {
    throw new CollectorRuntimeError(
      "validation_error",
      "needs_input",
      "collector_carrier_invalid",
    );
  }
  const adapter = registry.get(normalized);
  if (adapter === undefined) {
    throw new CollectorRuntimeError(
      "unsupported_route_type",
      "blocked",
      "collector_carrier_unsupported",
    );
  }
  return adapter;
}

function queryForMetadata(
  input: CollectorQueryInput,
  origin: ResolvedLocation,
  destination: ResolvedLocation,
  dateFilterBasis:
    | "departure_from_first_ocean_leg"
    | "departure_from_origin"
    | "unknown",
): NormalizedCollectorQuery {
  return normalizeQuery(input, origin, destination, { dateFilterBasis });
}

function evidenceRefsFromRecords(
  records: readonly CollectorResultData["records"][number][],
): readonly string[] {
  return [...new Set(records.map((record) => record.evidence_ref))];
}

function runStatusFor(
  adapter: CarrierAdapter,
  result: {
    readonly records: CollectorResultData["records"];
    readonly coverage: CollectorResultData["coverage"];
    readonly quality: CollectorResultData["quality"];
  },
): CollectorResultData["run_status"] {
  if (adapter.metadata.provenanceKind !== "live") return "partial";
  if (!result.coverage.complete) return "partial";
  if (
    result.quality.key_fields_complete !== true ||
    result.quality.evaluation_status !== "evaluated" ||
    result.quality.conflicts.length > 0
  ) {
    return "partial";
  }
  if (result.records.length === 0) return "no_results";
  return "ok";
}

export function createCollectorService(
  options: CollectorServiceOptions,
): CollectorServiceApi {
  const registry = createCarrierRegistry(options.adapters ?? []);
  const dateFilterBasis =
    options.dateFilterBasis ?? DEFAULT_DATE_FILTER_BASIS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > DEFAULT_DEADLINE_MS
  ) {
    throw new CollectorRuntimeError(
      "validation_error",
      "blocked",
      "collector_deadline_invalid",
    );
  }

  return {
    carriers() {
      const metadata = listCarrierMetadata();
      const data = {
        carriers: metadata.map((carrier) => ({
          id: carrier.id,
          display_name: carrier.displayName,
          adapter_version: carrier.adapterVersion,
          capability_status: carrier.capabilityStatus,
          last_live_verified_at: carrier.lastLiveVerifiedAt,
        })),
      };
      const envelope = createEnvelope({
        requestId: options.ports.context.requestId,
        auditId: options.ports.context.auditId,
        status: "success",
        data,
        sourceRefs: [
          {
            source_id: "collector-carrier-registry",
            source_type: "internal_system",
            system: "schedule-collector",
            locator: "carrier-registry",
            version: "carrier-registry@2026-09-17.v1",
            retrieved_at: options.ports.clock.now().toISOString(),
            authority: "supporting",
            content_hash: null,
          },
        ],
      });
      return { data, envelope };
    },
    async resolveLocations(input, operationOptions) {
      try {
        return await withOperationDeadline(
          operationOptions?.signal,
          deadlineMs,
          async (signal) => {
            const ports = scopedPorts(options.ports, signal);
            const carrier = normalizeCarrierId(input.carrier);
            if (carrier === null) {
              throw new CollectorRuntimeError(
                "validation_error",
                "needs_input",
                "collector_carrier_invalid",
              );
            }
            const adapter = adapterFor(registry, carrier);
            const candidates = await adapter.resolveLocations(
              {
                text: input.text,
                countryCode: input.countryCode ?? null,
                carrierLocationId: input.locationId ?? null,
                signal,
              },
              ports.http,
            );
            const lookup = {
              text: input.text,
              country_code: input.countryCode ?? null,
              carrier_location_id: input.locationId ?? null,
            } as const;
            const matches = findLocationCandidates(lookup, candidates);
            if (matches.length === 0) {
              throw new CollectorRuntimeError(
                "location_not_found",
                "needs_input",
                "collector_location_not_found",
              );
            }
            const data = {
              carrier,
              query: input.text,
              candidates: matches,
              resolved:
                matches.length === 1
                  ? resolveLocationCandidates(lookup, matches)
                  : null,
            };
            if (matches.length > 1) {
              const envelope = createEnvelope({
                requestId: ports.context.requestId,
                auditId: ports.context.auditId,
                status: "needs_input",
                data,
                sourceRefs: [
                  {
                    source_id: "collector-location-candidates",
                    source_type: "internal_system",
                    system: "schedule-collector",
                    locator: `location:${carrier}`,
                    version: adapter.metadata.adapterVersion,
                    retrieved_at: ports.clock.now().toISOString(),
                    authority: "supporting",
                    content_hash: null,
                  },
                ],
                blockers: [
                  notice(
                    "ambiguous_location",
                    "Multiple carrier locations match; select a carrier_location_id.",
                    "error",
                  ),
                ],
                reviewStatus: "pending",
              });
              return { data, envelope };
            }
            const envelope = createEnvelope({
              requestId: ports.context.requestId,
              auditId: ports.context.auditId,
              status: "success",
              data,
              sourceRefs: [
                {
                  source_id: "collector-location-resolution",
                  source_type: "internal_system",
                  system: "schedule-collector",
                  locator: `location:${carrier}`,
                  version: adapter.metadata.adapterVersion,
                  retrieved_at: ports.clock.now().toISOString(),
                  authority: "supporting",
                  content_hash: null,
                },
              ],
            });
            return { data, envelope };
          },
        );
      } catch (error: unknown) {
        await options.ports.audit.record({
          requestId: options.ports.context.requestId,
          event: "query_failed",
          at: options.ports.clock.now().toISOString(),
          carrier: input.carrier,
          status: "error",
          issue_code: issueCodeFromError(error),
        });
        return errorEnvelope(error, options.ports);
      }
    },
    async query(input, operationOptions) {
      let carrier: string | null = null;
      try {
        return await withOperationDeadline(
          operationOptions?.signal,
          deadlineMs,
          async (signal) => {
            const ports = scopedPorts(options.ports, signal);
            const parsedInput = parseCollectorQueryInput(input);
            carrier = parsedInput.carrier;
            await ports.audit.record({
              requestId: ports.context.requestId,
              event: "query_started",
              at: ports.clock.now().toISOString(),
              carrier,
              status: "started",
              issue_code: null,
            });
            const adapter = adapterFor(registry, carrier);
            const originCandidates = await adapter.resolveLocations(
              {
                text: parsedInput.origin.text,
                countryCode: parsedInput.origin.country_code,
                carrierLocationId: parsedInput.origin.carrier_location_id,
                signal,
              },
              ports.http,
            );
            const destinationCandidates = await adapter.resolveLocations(
              {
                text: parsedInput.destination.text,
                countryCode: parsedInput.destination.country_code,
                carrierLocationId: parsedInput.destination.carrier_location_id,
                signal,
              },
              ports.http,
            );
            const origin = resolveLocationCandidates(
              {
                text: parsedInput.origin.text,
                country_code: parsedInput.origin.country_code,
                carrier_location_id: parsedInput.origin.carrier_location_id,
              },
              originCandidates,
            );
            const destination = resolveLocationCandidates(
              {
                text: parsedInput.destination.text,
                country_code: parsedInput.destination.country_code,
                carrier_location_id: parsedInput.destination.carrier_location_id,
              },
              destinationCandidates,
            );
            const normalizedQuery = queryForMetadata(
              parsedInput,
              origin,
              destination,
              dateFilterBasis,
            );
            const result = await adapter.query(
              {
                requestId: ports.context.requestId,
                normalizedQuery,
                origin,
                destination,
                evidenceRef: "",
                observedAt: ports.clock.now().toISOString(),
                signal,
              },
              ports.http,
              ports.evidence,
            );
            const filteredResult = {
              ...result,
              records:
                normalizedQuery.routing_filter === "any"
                  ? result.records
                  : result.records.filter(
                      (record) =>
                        record.routing === normalizedQuery.routing_filter,
                    ),
            };
            const runStatus = runStatusFor(adapter, filteredResult);
            const provenanceKind = adapter.metadata.provenanceKind;
            const coverage =
              provenanceKind !== "live"
                ? {
                    ...result.coverage,
                    complete: false,
                    uncovered_windows: [
                      {
                        from: normalizedQuery.departure_from,
                        until: normalizedQuery.departure_until,
                      },
                    ],
                    failure_reason:
                      provenanceKind === "synthetic"
                        ? "synthetic_fixture_not_live"
                        : "replay_data_not_live",
                  }
                : result.coverage;
            const observedAt = ports.clock.now().toISOString();
            const data = parseCollectorResultData({
              collector_contract_version: "ocean-schedule-collector@2026-09-17.v1",
              run_status: runStatus,
              query: normalizedQuery,
              carrier: {
                id: adapter.metadata.id,
                sales_carrier: adapter.metadata.displayName,
                adapter_version: adapter.metadata.adapterVersion,
                capability_status: adapter.metadata.capabilityStatus,
                last_live_verified_at: adapter.metadata.lastLiveVerifiedAt,
              },
              records: filteredResult.records,
              coverage,
              provenance: {
                kind: provenanceKind,
                fetched_at: provenanceKind === "live" ? observedAt : null,
                fixture_generated_at:
                  provenanceKind === "synthetic" ? observedAt : null,
                source_updated_at: null,
                parser_version: adapter.metadata.adapterVersion,
                source_refs: [
                  ...(result.evidenceRef === null ? [] : [result.evidenceRef]),
                  ...(result.evidenceRefs ?? []),
                  ...evidenceRefsFromRecords(result.records),
                ].filter((value, index, all) => all.indexOf(value) === index),
              },
              quality: result.quality,
            });
            await ports.audit.record({
              requestId: ports.context.requestId,
              event: "query_completed",
              at: observedAt,
              carrier,
              status: data.run_status,
              issue_code: null,
            });
            return envelopeFromData(data, ports);
          },
        );
      } catch (error: unknown) {
        await options.ports.audit.record({
          requestId: options.ports.context.requestId,
          event: "query_failed",
          at: options.ports.clock.now().toISOString(),
          carrier,
          status: "error",
          issue_code: issueCodeFromError(error),
        });
        return errorEnvelope(error, options.ports);
      }
    },
  };
}
