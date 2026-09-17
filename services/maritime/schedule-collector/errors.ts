export type CollectorIssueCode =
  | "ambiguous_location"
  | "location_not_found"
  | "auth_required"
  | "access_restricted"
  | "rate_limited"
  | "timeout"
  | "parse_error"
  | "schema_changed"
  | "incomplete_results"
  | "unsupported_filter"
  | "unsupported_route_type"
  | "validation_error"
  | "live_not_approved"
  | "not_implemented"
  | "synthetic_data"
  | "replay_data"
  | "unexpected_error";

export class CollectorRuntimeError extends Error {
  constructor(
    readonly code: CollectorIssueCode,
    readonly status:
      | "needs_input"
      | "manual_review"
      | "blocked"
      | "unavailable",
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "CollectorRuntimeError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CollectorRuntimeError(
      "timeout",
      "unavailable",
      "collector_aborted",
    );
  }
}

export function signalField(
  signal?: AbortSignal,
): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}
