import { isProxy } from "node:util/types";

export interface AgentArtifactSafetyIssue {
  readonly kind: "credential_material" | "local_path";
  readonly reason: string;
}

export type AgentArtifactGraphErrorReason =
  | "proxy_rejected"
  | "cycle_rejected"
  | "prototype_rejected"
  | "symbol_key_rejected"
  | "accessor_rejected"
  | "unsupported_value";

export class AgentArtifactSafetyError extends Error {
  readonly code = "agent_artifact.invalid";
  readonly reason: AgentArtifactGraphErrorReason;

  constructor(reason: AgentArtifactGraphErrorReason) {
    super("Agent artifact input is invalid.");
    this.name = "AgentArtifactSafetyError";
    this.reason = reason;
  }
}

function rejectGraph(reason: AgentArtifactGraphErrorReason): never {
  throw new AgentArtifactSafetyError(reason);
}

/**
 * Validate an input graph without invoking getters, proxy traps or custom
 * serialization hooks. This is intentionally stricter than JSON's data model:
 * only ordinary objects and arrays containing data descriptors are accepted.
 */
export function assertSafeAgentDataGraph(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (
    typeof value === "function" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    rejectGraph("unsupported_value");
  }
  if (typeof value !== "object" || value === null) return;

  if (isProxy(value)) rejectGraph("proxy_rejected");
  if (seen.has(value)) rejectGraph("cycle_rejected");
  seen.add(value);

  let prototype: object | null;
  try {
    prototype = Reflect.getPrototypeOf(value);
  } catch {
    rejectGraph("prototype_rejected");
  }
  const expectedPrototype = Array.isArray(value)
    ? Array.prototype
    : Object.prototype;
  if (prototype !== expectedPrototype) rejectGraph("prototype_rejected");

  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    rejectGraph("proxy_rejected");
  }
  for (const key of keys) {
    if (typeof key !== "string") rejectGraph("symbol_key_rejected");
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      rejectGraph("proxy_rejected");
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      rejectGraph("accessor_rejected");
    }
    assertSafeAgentDataGraph(descriptor.value, seen);
  }
  seen.delete(value);
}

function issue(
  kind: AgentArtifactSafetyIssue["kind"],
  reason: string,
): AgentArtifactSafetyIssue {
  return { kind, reason };
}

function capturedValue(match: RegExpExecArray): string {
  return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

function isAbstractPlaceholder(value: string): boolean {
  if (value.length === 0) return true;
  return [
    /^<[^<>\r\n]+>$/u,
    /^\$\{[^{}\r\n]+\}$/u,
    /^\{\{[^{}\r\n]+\}\}$/u,
    /^\[(?:REDACTED|PLACEHOLDER|EXAMPLE|REMOVED)\]$/iu,
    /^(?:value|key|token|secret|reference|authentication|injected|provided|server(?:[-_ ]provided)?)$/iu,
    /^(?:example|sample|dummy|fake|test)[-_][A-Za-z0-9]+$/iu,
    /^(?:REDACTED|PLACEHOLDER|EXAMPLE|TOKEN|YOUR_[A-Z0-9_]+|\*{3,})$/iu,
  ].some((pattern) => pattern.test(value));
}

function deduplicateIssues(
  findings: readonly AgentArtifactSafetyIssue[],
): readonly AgentArtifactSafetyIssue[] {
  const unique = new Map<string, AgentArtifactSafetyIssue>();
  for (const finding of findings) {
    unique.set(`${finding.kind}:${finding.reason}`, finding);
  }
  return [...unique.values()];
}

function isCredentialKey(key: string): boolean {
  const normalized = key.replace(/[-_ ]/g, "").toLowerCase();
  return /(?:password|secret|token|apikey|privatekey|credential|secretkey|secretaccesskey|accesskey|accesskeyid)$/u.test(normalized);
}

function requireScannerText(value: string): string {
  if (typeof value !== "string") {
    throw new AgentArtifactSafetyError("unsupported_value");
  }
  return value;
}

export function findCredentialMaterial(text: string): readonly AgentArtifactSafetyIssue[] {
  const safeText = requireScannerText(text);
  const findings: AgentArtifactSafetyIssue[] = [];

  const bearerHeader = /(?:^|[^A-Za-z0-9_]|\\[nrt])["']?authorization["']?\s*[:=]\s*(?:"\s*bearer\s+([^"\r\n]+)"|'\s*bearer\s+([^'\r\n]+)'|bearer\s+(\$\{[^}\r\n]+\}|\{\{[^}\r\n]+\}\}|<[^>\r\n]+>|\[[^\]\r\n]+\]|[^\s,;}\r\n]+))/gimu;
  for (let match = bearerHeader.exec(safeText); match !== null; match = bearerHeader.exec(safeText)) {
    if (!isAbstractPlaceholder(capturedValue(match))) {
      findings.push(issue("credential_material", "authorization_bearer_value"));
    }
  }

  const credentialAssignment = /(?:^|[^A-Za-z0-9_]|\\[nrt])["']?([A-Za-z][A-Za-z0-9_-]{1,63})["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\$\{[^}\r\n]+\}|\{\{[^}\r\n]+\}\}|<[^>\r\n]+>|\[[^\]\r\n]+\]|[^\s,;}\r\n]+))/gimu;
  for (
    let match = credentialAssignment.exec(safeText);
    match !== null;
    match = credentialAssignment.exec(safeText)
  ) {
    const key = match[1] ?? "";
    if (!isCredentialKey(key)) continue;
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!isAbstractPlaceholder(value)) {
      findings.push(
        issue(
          "credential_material",
          `credential_assignment:${key.replace(/[-_ ]/g, "").toLowerCase()}`,
        ),
      );
    }
  }

  const fixedPatterns: readonly [reason: string, pattern: RegExp][] = [
    ["pem_block", /-----BEGIN [A-Z0-9][A-Z0-9 ]{2,64}-----/gu],
    ["sk_token", /\bsk-[A-Za-z0-9_-]{16,}\b/gu],
    ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{22,})\b/gu],
    ["google_api_key", /\bAIza[A-Za-z0-9_-]{16,}\b/gu],
  ];
  for (const [reason, pattern] of fixedPatterns) {
    if (pattern.test(safeText)) findings.push(issue("credential_material", reason));
  }

  return deduplicateIssues(findings);
}

export function findLocalPathLeakage(text: string): readonly AgentArtifactSafetyIssue[] {
  const safeText = requireScannerText(text);
  const patterns: readonly [reason: string, pattern: RegExp][] = [
    ["mac_user_home", /\/Users\/(?!<)[^/\s"'<>]+(?=\/|$)/gu],
    ["linux_user_home", /\/home\/(?!<)[^/\s"'<>]+(?=\/|$)/gu],
    ["macos_user_temp", /(?:\/private)?\/var\/folders(?=\/|[\s"'`,;)}\]]|$)/gu],
    ["generated_tmp", /\/tmp\/generated(?=\/|[\s"'`,;)}\]]|$)/gu],
    ["windows_user_home", /[A-Za-z]:[\\/]+Users[\\/]+(?!<)[^\\/\s"'<>]+(?=[\\/]|$)/giu],
  ];
  return deduplicateIssues(
    patterns.flatMap(([reason, pattern]) =>
      pattern.test(safeText) ? [issue("local_path", reason)] : [],
    ),
  );
}

export function findAgentArtifactSafetyIssues(value: unknown): readonly AgentArtifactSafetyIssue[] {
  assertSafeAgentDataGraph(value);
  const serialized = JSON.stringify(value);
  const text = typeof value === "string" ? value : (serialized ?? "");
  return [...findCredentialMaterial(text), ...findLocalPathLeakage(text)];
}
