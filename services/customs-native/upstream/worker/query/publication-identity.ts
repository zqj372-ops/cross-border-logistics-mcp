import { z } from "zod";

import type { PublicationSnapshotRow, SourceRow } from "../repositories/customs";

const QUERY_CONTRACT_VERSION = "riskcustoms-query.v1" as const;
const SUPPORTED_OPERATIONS = ["status", "query"] as const;
const StrictDateTimeSchema = z.string().datetime({ offset: true });
const IdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export interface M2MContractIdentity {
  readonly serviceVersion: string;
  readonly contractVersion: typeof QUERY_CONTRACT_VERSION;
  readonly publishedAt: string | null;
  readonly supportedOperations: readonly ["status", "query"];
  readonly releaseIds: readonly string[];
  readonly snapshotHash: string | null;
  readonly releaseHash: string | null;
  readonly ruleDate: string;
}

export interface M2MPublicationReadiness {
  readonly ready: boolean;
  readonly testData: boolean;
  readonly reasons: readonly string[];
  readonly evaluatedAt: string | null;
  readonly lastSourceCheckAt: string | null;
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && IdentifierPattern.test(item)) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseReasons(value: string | null | undefined): { readonly valid: boolean; readonly reasons: string[] } {
  if (typeof value !== "string") return { valid: false, reasons: [] };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      return { valid: false, reasons: [] };
    }
    return { valid: true, reasons: parsed };
  } catch {
    return { valid: false, reasons: [] };
  }
}

function normalizeIsoDateTime(value: unknown): string | null {
  if (typeof value !== "string" || !StrictDateTimeSchema.safeParse(value).success || !validDate(value.slice(0, 10))) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function releaseIdentityIsM2MSafe(source: SourceRow): boolean {
  let officialUrl: URL;
  try {
    officialUrl = new URL(source.official_url);
  } catch {
    return false;
  }
  return officialUrl.protocol === "https:"
    && officialUrl.username === ""
    && officialUrl.password === ""
    && source.authority.trim().length > 0
    && source.dataset.trim().length > 0
    && source.edition.trim().length > 0
    && source.revision.trim().length > 0
    && validDate(source.published_at.slice(0, 10))
    && validDate(source.effective_from)
    && (source.effective_to === null || (validDate(source.effective_to) && source.effective_to >= source.effective_from))
    && normalizeIsoDateTime(source.retrieved_at) !== null;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export async function publicationIdentity(
  snapshot: PublicationSnapshotRow | null,
  releaseRows: readonly SourceRow[],
  requestedRuleDate: string | null,
  serviceVersion?: string,
): Promise<M2MContractIdentity | null> {
  // M2M identity describes the caller's evaluated rule date. A latest-prior
  // snapshot may have an older publication rule_date, but must not silently
  // rewrite the requested date in the response contract.
  const ruleDate = requestedRuleDate ?? snapshot?.rule_date;
  if (!validDate(ruleDate)) return null;
  const releaseIds = parseStringArray(snapshot?.release_ids_json);
  const snapshotHash = /^[a-f0-9]{64}$/u.test(snapshot?.gate_report_sha256 ?? "")
    ? snapshot!.gate_report_sha256.toLowerCase()
    : null;
  const releaseIdentity = releaseIds.flatMap((releaseId) => {
    const source = releaseRows.find((row) => row.id === releaseId);
    return source && source.status === "published" && releaseIdentityIsM2MSafe(source) && /^[a-f0-9]{64}$/u.test(source.manifest_sha256)
      ? [{ releaseId, manifestSha256: source.manifest_sha256.toLowerCase() }]
      : [];
  });
  const releaseHash = releaseIdentity.length === releaseIds.length && releaseIds.length > 0
    ? await sha256Hex(releaseIdentity.map((entry) => `${entry.releaseId}:${entry.manifestSha256}`).sort().join("|"))
    : null;
  if (!serviceVersion?.trim()) return null;
  return {
    serviceVersion: serviceVersion.trim(),
    contractVersion: QUERY_CONTRACT_VERSION,
    publishedAt: normalizeIsoDateTime(snapshot?.evaluated_at),
    supportedOperations: [...SUPPORTED_OPERATIONS] as ["status", "query"],
    releaseIds,
    snapshotHash,
    releaseHash,
    ruleDate,
  };
}

export function snapshotReleaseIds(snapshot: PublicationSnapshotRow | null): string[] {
  return parseStringArray(snapshot?.release_ids_json);
}

/**
 * M2M readiness is deliberately stricter than liveness. It requires the
 * persisted publication gate to be ready, an explicit production marker, and
 * a syntactically valid empty reasons array. A malformed or non-empty reasons
 * value therefore fails closed even if a legacy row says ready=1.
 */
export function m2mPublicationReadiness(
  snapshot: PublicationSnapshotRow | null,
  identity: M2MContractIdentity,
  gateReady: boolean,
): M2MPublicationReadiness {
  const parsedReasons = parseReasons(snapshot?.reasons_json);
  const testData = snapshot?.test_data === 0 ? false : true;
  const identityComplete = identity.publishedAt !== null
    && identity.releaseIds.length > 0
    && identity.snapshotHash !== null
    && identity.releaseHash !== null;
  const ready = gateReady
    && snapshot?.ready === 1
    && testData === false
    && parsedReasons.valid
    && parsedReasons.reasons.length === 0
    && identityComplete;
  const reasons = [...parsedReasons.reasons];
  if (!parsedReasons.valid) reasons.push("Publication snapshot reasons are invalid.");
  if (snapshot?.ready !== 1) reasons.push("No reviewed publication snapshot is available.");
  if (testData) reasons.push("Publication snapshot is marked as test data or lacks a production marker.");
  if (!gateReady) reasons.push("Publication snapshot release identity is not ready.");
  if (!identityComplete) reasons.push("Publication snapshot M2M identity is incomplete.");
  return {
    ready,
    testData,
    reasons: ready ? [] : [...new Set(reasons)],
    evaluatedAt: identity.publishedAt,
    lastSourceCheckAt: normalizeIsoDateTime(snapshot?.last_source_check_at),
  };
}

export { normalizeIsoDateTime };
