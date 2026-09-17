import { CollectorRuntimeError } from "../errors";

export type ApprovedHttpMethod = "GET" | "POST";

export interface ApprovedTarget {
  readonly carrier: string;
  readonly host: string;
  readonly port: 443;
  readonly methods: readonly ApprovedHttpMethod[];
  readonly path: `/${string}`;
  readonly allowedQueryKeys: readonly string[];
  readonly allowedBodyKeys: readonly string[];
  readonly allowedRequestHeaders?: readonly string[];
  readonly allowedRequestHeaderValues?: Readonly<Record<string, string>>;
  readonly sessionCookieHost?: string;
  readonly sourcePermissionRef: string;
  readonly livePolicyApprovalRef: string;
  readonly expiresAt: string;
}

export interface TransportPolicy {
  readonly approvedTargets: readonly ApprovedTarget[];
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRequestBodyBytes: number;
  readonly maxRequestsPerRun: number;
  readonly maxRetries: number;
}

export const DEFAULT_TRANSPORT_POLICY: TransportPolicy = Object.freeze({
  approvedTargets: [],
  timeoutMs: 20_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxRequestBodyBytes: 256 * 1024,
  maxRequestsPerRun: 15,
  maxRetries: 2,
});

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      `${label}_invalid`,
    );
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32;
  });
}

function assertPath(value: string): void {
  if (
    !value.startsWith("/") ||
    value.includes("//") ||
    value.includes("?") ||
    value.includes("#") ||
    containsControlCharacter(value)
  ) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "approved_path_invalid",
    );
  }
}

function assertTarget(target: ApprovedTarget): void {
  assertIdentifier(target.carrier, "carrier");
  if (
    target.host.length === 0 ||
    target.host.includes("*") ||
    /[/\\]/u.test(target.host) ||
    containsControlCharacter(target.host)
  ) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "approved_host_invalid",
    );
  }
  if (target.port !== 443) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "approved_port_invalid",
    );
  }
  assertPath(target.path);
  if (target.methods.length === 0) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "approved_method_missing",
    );
  }
  for (const method of target.methods) {
    if (method !== "GET" && method !== "POST") {
      throw new CollectorRuntimeError(
        "live_not_approved",
        "blocked",
        "approved_method_invalid",
      );
    }
  }
  for (const key of target.allowedQueryKeys) {
    assertIdentifier(key, "query_key");
  }
  for (const key of target.allowedBodyKeys) {
    assertIdentifier(key, "body_key");
  }
  for (const header of target.allowedRequestHeaders ?? []) {
    if (!/^[a-z0-9-]+$/u.test(header)) {
      throw new CollectorRuntimeError(
        "live_not_approved",
        "blocked",
        "approved_request_header_invalid",
      );
    }
  }
  for (const [header, value] of Object.entries(
    target.allowedRequestHeaderValues ?? {},
  )) {
    if (
      !/^[a-z0-9-]+$/u.test(header) ||
      !(target.allowedRequestHeaders ?? []).includes(header) ||
      value.length === 0 ||
      containsControlCharacter(value)
    ) {
      throw new CollectorRuntimeError(
        "live_not_approved",
        "blocked",
        "approved_request_header_value_invalid",
      );
    }
  }
  if (
    target.sessionCookieHost !== undefined &&
    (target.sessionCookieHost !== target.host ||
      target.sessionCookieHost.includes("*") ||
      /[/\\]/u.test(target.sessionCookieHost) ||
      containsControlCharacter(target.sessionCookieHost))
  ) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "approved_session_cookie_host_invalid",
    );
  }
  assertIdentifier(target.sourcePermissionRef, "source_permission_ref");
  assertIdentifier(target.livePolicyApprovalRef, "live_policy_approval_ref");
  if (!Number.isFinite(Date.parse(target.expiresAt))) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "approved_expiry_invalid",
    );
  }
}

export function validateTransportPolicy(
  policy: TransportPolicy,
): TransportPolicy {
  if (
    !Number.isSafeInteger(policy.timeoutMs) ||
    policy.timeoutMs < 1 ||
    policy.timeoutMs > 120_000
  ) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "transport_timeout_invalid",
    );
  }
  if (
    !Number.isSafeInteger(policy.maxResponseBytes) ||
    policy.maxResponseBytes < 1 ||
    policy.maxResponseBytes > 10 * 1024 * 1024
  ) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "transport_response_limit_invalid",
    );
  }
  if (
    !Number.isSafeInteger(policy.maxRequestBodyBytes) ||
    policy.maxRequestBodyBytes < 1 ||
    policy.maxRequestBodyBytes > 2 * 1024 * 1024
  ) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "transport_request_limit_invalid",
    );
  }
  if (
    !Number.isSafeInteger(policy.maxRequestsPerRun) ||
    policy.maxRequestsPerRun < 1 ||
    policy.maxRequestsPerRun > 100
  ) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "transport_request_budget_invalid",
    );
  }
  if (
    !Number.isSafeInteger(policy.maxRetries) ||
    policy.maxRetries < 0 ||
    policy.maxRetries > 2
  ) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "transport_retry_budget_invalid",
    );
  }
  const targets = policy.approvedTargets.map((target) => {
    assertTarget(target);
    return Object.freeze({
      ...target,
      methods: Object.freeze([...target.methods]),
      allowedQueryKeys: Object.freeze([...target.allowedQueryKeys]),
      allowedBodyKeys: Object.freeze([...target.allowedBodyKeys]),
      allowedRequestHeaders: Object.freeze([
        ...(target.allowedRequestHeaders ?? []),
      ]),
      allowedRequestHeaderValues: Object.freeze({
        ...(target.allowedRequestHeaderValues ?? {}),
      }),
    });
  });
  return Object.freeze({
    ...policy,
    approvedTargets: Object.freeze(targets),
  });
}

export function resolveApprovedTarget(
  policy: TransportPolicy,
  input: {
    readonly carrier: string;
    readonly method: ApprovedHttpMethod;
    readonly path: string;
    readonly query: Readonly<Record<string, string>>;
  },
  now: Date,
): ApprovedTarget {
  const target = policy.approvedTargets.find(
    (candidate) =>
      candidate.carrier === input.carrier &&
      candidate.methods.includes(input.method) &&
      candidate.path === input.path,
  );
  if (target === undefined) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "collector_live_target_not_approved",
    );
  }
  if (Date.parse(target.expiresAt) <= now.getTime()) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "collector_live_target_expired",
    );
  }
  const queryKeys = Object.keys(input.query);
  if (
    queryKeys.length !== target.allowedQueryKeys.length ||
    queryKeys.some((key) => !target.allowedQueryKeys.includes(key))
  ) {
    throw new CollectorRuntimeError(
      "live_not_approved",
      "blocked",
      "collector_live_query_not_approved",
    );
  }
  return target;
}
