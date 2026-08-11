import {
  createEnvelope,
  ENVELOPE_SCHEMA_VERSION,
  type CalculationStep,
  type EnvelopeStatus,
  type Notice,
  type ResponseEnvelope,
  type SourceRef,
} from "../../platform/envelope";
import type { ExecutionContext } from "../../platform/context";
import { cargoDiagnostic, type CargoValidationFailure } from "./diagnostics";
import { calculateCargoMetrics } from "./metrics";
import {
  calculateChargeableWeight,
  calculateVolumetricWeight,
} from "./chargeable";
import type {
  BubbleMethod,
  CargoResult,
  ChargeableWeight,
  DimensionalRule,
} from "./models";

export interface CargoCalculationOutcome {
  readonly status: EnvelopeStatus;
  readonly data: Record<string, unknown> | null;
  readonly sourceRefs?: readonly SourceRef[];
  readonly assumptions?: readonly Notice[];
  readonly warnings?: readonly Notice[];
  readonly blockers?: readonly Notice[];
  readonly calculationTrace?: readonly CalculationStep[];
  readonly reviewStatus?: "not_required" | "pending" | "approved" | "rejected" | "manual_review";
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const REQUEST_FIELDS = new Set([
  "schema_version",
  "version",
  "cargo_lines",
  "dimensional_divisor",
  "bubble_rule",
  "channel_code",
  "source_refs",
]);
const BUBBLE_RULE_FIELDS = new Set([
  "channel",
  "mode",
  "method",
  "ratio",
  "rule_version",
  "source_ref_ids",
  "divisor",
  "density",
  "unit",
  "rounding",
  "supplier",
]);
const SOURCE_REF_FIELDS = new Set([
  "source_id",
  "source_type",
  "system",
  "locator",
  "version",
  "retrieved_at",
  "authority",
  "content_hash",
]);
const SOURCE_TYPES = new Set<SourceRef["source_type"]>([
  "internal_system",
  "official_source",
  "tenant_record",
  "user_input",
  "opaque_reference",
  "fixture",
]);
const AUTHORITIES = new Set<SourceRef["authority"]>([
  "authoritative",
  "supporting",
  "user_provided",
  "opaque",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailure(value: unknown): value is CargoValidationFailure {
  return isRecord(value) && value.ok === false;
}

function unknownField(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.keys(value).find((field) => !allowed.has(field));
}

function failureNotice(failure: CargoValidationFailure): Notice {
  return {
    code: failure.code,
    message: failure.diagnostic.message,
    severity: "error",
    ...(failure.diagnostic.field === undefined ? {} : { field: failure.diagnostic.field }),
  };
}

function failedOutcome(
  failure: CargoValidationFailure,
  sourceRefs: readonly SourceRef[] = [],
  calculationTrace: readonly CalculationStep[] = [],
): CargoCalculationOutcome {
  return {
    status: failure.status,
    data: null,
    sourceRefs,
    assumptions: [],
    warnings: [],
    blockers: [failureNotice(failure)],
    calculationTrace,
    reviewStatus: failure.status === "manual_review" ? "manual_review" : "not_required",
  };
}

function sourceRefArray(value: unknown): SourceRef[] | CargoValidationFailure {
  if (!Array.isArray(value) || value.length === 0) {
    return cargoDiagnostic(
      "cargo.source_refs_required",
      "needs_input",
      "At least one source reference is required.",
      "source_refs",
    );
  }
  const refs: SourceRef[] = [];
  for (const [index, candidate] of value.entries()) {
    const field = `source_refs[${index}]`;
    if (!isRecord(candidate)) {
      return cargoDiagnostic(
        "cargo.source_ref_invalid",
        "needs_input",
        `${field} must be an object.`,
        field,
      );
    }
    const extra = unknownField(candidate, SOURCE_REF_FIELDS);
    if (extra !== undefined) {
      return cargoDiagnostic(
        "cargo.unknown_field",
        "needs_input",
        `${field}.${extra} is not an allowed source reference field.`,
        `${field}.${extra}`,
      );
    }
    if (typeof candidate.source_id !== "string" || !IDENTIFIER_PATTERN.test(candidate.source_id)) {
      return cargoDiagnostic(
        "cargo.source_ref_invalid",
        "needs_input",
        `${field}.source_id is invalid.`,
        `${field}.source_id`,
      );
    }
    if (typeof candidate.source_type !== "string" || !SOURCE_TYPES.has(candidate.source_type as SourceRef["source_type"])) {
      return cargoDiagnostic(
        "cargo.source_ref_invalid",
        "needs_input",
        `${field}.source_type is invalid.`,
        `${field}.source_type`,
      );
    }
    if (typeof candidate.system !== "string" || candidate.system.length < 1 || candidate.system.length > 120) {
      return cargoDiagnostic(
        "cargo.source_ref_invalid",
        "needs_input",
        `${field}.system is invalid.`,
        `${field}.system`,
      );
    }
    if (typeof candidate.locator !== "string" || candidate.locator.length < 1 || candidate.locator.length > 500) {
      return cargoDiagnostic(
        "cargo.source_ref_invalid",
        "needs_input",
        `${field}.locator is invalid.`,
        `${field}.locator`,
      );
    }
    if (typeof candidate.version !== "string" || !VERSION_PATTERN.test(candidate.version)) {
      return cargoDiagnostic(
        "cargo.source_ref_invalid",
        "needs_input",
        `${field}.version is invalid.`,
        `${field}.version`,
      );
    }
    if (typeof candidate.retrieved_at !== "string" || Number.isNaN(Date.parse(candidate.retrieved_at))) {
      return cargoDiagnostic(
        "cargo.source_ref_invalid",
        "needs_input",
        `${field}.retrieved_at must be an ISO date-time.`,
        `${field}.retrieved_at`,
      );
    }
    if (typeof candidate.authority !== "string" || !AUTHORITIES.has(candidate.authority as SourceRef["authority"])) {
      return cargoDiagnostic(
        "cargo.source_ref_invalid",
        "needs_input",
        `${field}.authority is invalid.`,
        `${field}.authority`,
      );
    }
    if (candidate.content_hash !== undefined && candidate.content_hash !== null && typeof candidate.content_hash !== "string") {
      return cargoDiagnostic(
        "cargo.source_ref_invalid",
        "needs_input",
        `${field}.content_hash must be a string or null.`,
        `${field}.content_hash`,
      );
    }
    refs.push({
      source_id: candidate.source_id,
      source_type: candidate.source_type as SourceRef["source_type"],
      system: candidate.system,
      locator: candidate.locator,
      version: candidate.version,
      retrieved_at: candidate.retrieved_at,
      authority: candidate.authority as SourceRef["authority"],
      ...(candidate.content_hash === undefined ? {} : { content_hash: candidate.content_hash }),
    });
  }
  if (new Set(refs.map((ref) => ref.source_id)).size !== refs.length) {
    return cargoDiagnostic(
      "cargo.source_ref_ids_duplicate",
      "needs_input",
      "source_refs source_id values must be unique.",
      "source_refs",
    );
  }
  return refs;
}

function parseRequest(
  input: unknown,
):
  | {
      readonly version: string;
      readonly cargoLines: readonly unknown[];
      readonly dimensionalDivisor: unknown;
      readonly bubbleRule: Record<string, unknown>;
      readonly channelCode: string;
      readonly sourceRefs: readonly SourceRef[];
    }
  | CargoValidationFailure {
  if (!isRecord(input)) {
    return cargoDiagnostic(
      "cargo.request_required",
      "needs_input",
      "cargo.calculate input must be an object.",
      "input",
    );
  }
  const extra = unknownField(input, REQUEST_FIELDS);
  if (extra !== undefined) {
    return cargoDiagnostic(
      "cargo.unknown_field",
      "needs_input",
      `${extra} is not an allowed cargo.calculate input field.`,
      extra,
    );
  }
  if (input.schema_version !== ENVELOPE_SCHEMA_VERSION) {
    return cargoDiagnostic(
      "cargo.schema_version_invalid",
      "needs_input",
      `schema_version must be ${ENVELOPE_SCHEMA_VERSION}.`,
      "schema_version",
    );
  }
  if (typeof input.version !== "string" || !VERSION_PATTERN.test(input.version)) {
    return cargoDiagnostic(
      "cargo.version_invalid",
      "needs_input",
      "version must be a versioned identifier.",
      "version",
    );
  }
  if (!Array.isArray(input.cargo_lines) || input.cargo_lines.length === 0) {
    return cargoDiagnostic(
      "cargo.lines_required",
      "needs_input",
      "At least one cargo line is required.",
      "cargo_lines",
    );
  }
  if (typeof input.channel_code !== "string" || input.channel_code.length === 0 || input.channel_code.length > 120) {
    return cargoDiagnostic(
      "cargo.channel_required",
      "needs_input",
      "channel_code is required.",
      "channel_code",
    );
  }
  if (!isRecord(input.bubble_rule)) {
    return cargoDiagnostic(
      "cargo.bubble_rule_required",
      "needs_input",
      "bubble_rule is required.",
      "bubble_rule",
    );
  }
  const bubbleRuleExtra = unknownField(input.bubble_rule, BUBBLE_RULE_FIELDS);
  if (bubbleRuleExtra !== undefined) {
    return cargoDiagnostic(
      "cargo.unknown_field",
      "needs_input",
      `bubble_rule.${bubbleRuleExtra} is not an allowed field.`,
      `bubble_rule.${bubbleRuleExtra}`,
    );
  }
  const sourceRefs = sourceRefArray(input.source_refs);
  if (isFailure(sourceRefs)) {
    return sourceRefs;
  }
  return {
    version: input.version,
    cargoLines: input.cargo_lines,
    dimensionalDivisor: input.dimensional_divisor,
    bubbleRule: input.bubble_rule,
    channelCode: input.channel_code,
    sourceRefs,
  };
}

function normalizedRule(
  request: ReturnType<typeof parseRequest> extends infer T
    ? T extends { readonly bubbleRule: infer R }
      ? T & { readonly bubbleRule: R }
      : never
    : never,
): DimensionalRule | CargoValidationFailure {
  const bubbleRule = request.bubbleRule;
  const methodValue = bubbleRule.mode ?? bubbleRule.method;
  if (typeof methodValue !== "string" || !new Set<BubbleMethod>(["none", "full", "half", "ratio", "fixed_density"]).has(methodValue as BubbleMethod)) {
    return cargoDiagnostic(
      "cargo.bubble_method_invalid",
      "needs_input",
      "bubble_rule.mode is required and must be supported.",
      "bubble_rule.mode",
    );
  }
  if (bubbleRule.mode !== undefined && bubbleRule.method !== undefined && bubbleRule.mode !== bubbleRule.method) {
    return cargoDiagnostic(
      "cargo.bubble_method_conflict",
      "manual_review",
      "bubble_rule.mode and bubble_rule.method conflict.",
      "bubble_rule",
    );
  }
  if (typeof bubbleRule.rule_version !== "string" || !VERSION_PATTERN.test(bubbleRule.rule_version)) {
    return cargoDiagnostic(
      "cargo.rule_version_missing",
      "needs_input",
      "bubble_rule.rule_version is required.",
      "bubble_rule.rule_version",
    );
  }
  const channel = bubbleRule.channel ?? request.channelCode;
  if (typeof channel !== "string" || channel.length === 0 || channel.length > 120) {
    return cargoDiagnostic(
      "cargo.channel_required",
      "needs_input",
      "bubble_rule.channel or channel_code is required.",
      "bubble_rule.channel",
    );
  }
  if (bubbleRule.channel !== undefined && bubbleRule.channel !== request.channelCode) {
    return cargoDiagnostic(
      "cargo.channel_conflict",
      "manual_review",
      "bubble_rule.channel and channel_code must match.",
      "bubble_rule.channel",
    );
  }
  if (!Array.isArray(bubbleRule.source_ref_ids) || bubbleRule.source_ref_ids.length === 0 || bubbleRule.source_ref_ids.some((id) => typeof id !== "string" || !IDENTIFIER_PATTERN.test(id))) {
    return cargoDiagnostic(
      "cargo.rule_source_refs_required",
      "needs_input",
      "bubble_rule.source_ref_ids is required and must contain valid identifiers.",
      "bubble_rule.source_ref_ids",
    );
  }
  if (new Set(bubbleRule.source_ref_ids).size !== bubbleRule.source_ref_ids.length) {
    return cargoDiagnostic(
      "cargo.source_ref_ids_duplicate",
      "needs_input",
      "bubble_rule.source_ref_ids must be unique.",
      "bubble_rule.source_ref_ids",
    );
  }
  if (bubbleRule.unit !== "kg") {
    return cargoDiagnostic(
      "cargo.dimensional_output_unit_invalid",
      "needs_input",
      "bubble_rule.unit must be kg.",
      "bubble_rule.unit",
    );
  }
  if (!isRecord(bubbleRule.rounding)) {
    return cargoDiagnostic(
      "cargo.rounding_required",
      "needs_input",
      "bubble_rule.rounding is required.",
      "bubble_rule.rounding",
    );
  }
  const rule: Record<string, unknown> = {
    channel,
    rule_version: bubbleRule.rule_version,
    source_ref_ids: bubbleRule.source_ref_ids,
    unit: "kg",
    rounding: bubbleRule.rounding,
    method: methodValue,
    ...(bubbleRule.ratio === undefined ? {} : { ratio: bubbleRule.ratio }),
    ...(bubbleRule.supplier === undefined ? {} : { supplier: bubbleRule.supplier }),
  };
  if (bubbleRule.density !== undefined) {
    rule.density = bubbleRule.density;
  }
  if (bubbleRule.divisor !== undefined) {
    rule.divisor = bubbleRule.divisor;
  }
  if (rule.density === undefined && rule.divisor === undefined && request.dimensionalDivisor !== null && request.dimensionalDivisor !== undefined) {
    if (isRecord(request.dimensionalDivisor) && request.dimensionalDivisor.unit === "kg_per_cbm") {
      rule.density = request.dimensionalDivisor;
    } else if (isRecord(request.dimensionalDivisor) && request.dimensionalDivisor.unit === "cbm_per_kg") {
      rule.divisor = request.dimensionalDivisor;
    } else {
      return cargoDiagnostic(
        "cargo.dimensional_unit_invalid",
        "needs_input",
        "dimensional_divisor must explicitly use kg_per_cbm or cbm_per_kg.",
        "dimensional_divisor.unit",
      );
    }
  }
  return rule as unknown as DimensionalRule;
}

function ensureSourcesCover(
  sourceRefs: readonly SourceRef[],
  requiredIds: readonly string[],
): CargoValidationFailure | null {
  const available = new Set(sourceRefs.map((ref) => ref.source_id));
  const missing = requiredIds.find((id) => !available.has(id));
  if (missing === undefined) {
    return null;
  }
  return cargoDiagnostic(
    "cargo.source_ref_missing",
    "manual_review",
    `No source reference was supplied for ${missing}.`,
    "source_refs",
  );
}

function asCargoResult(
  metrics: ReturnType<typeof calculateCargoMetrics> extends infer T
    ? T extends { readonly metrics: infer M }
      ? M
      : never
    : never,
  volumetric: { readonly value: string; readonly unit: "kg" },
  chargeable: ChargeableWeight,
): CargoResult {
  return {
    version: "cargo-result@2026-08-11.v1",
    metrics: {
      ...metrics,
      volumetric_weight: volumetric,
    },
    chargeable_weight: chargeable,
  };
}

export function calculateCargo(
  input: unknown,
  context: ExecutionContext,
): CargoCalculationOutcome {
  void context;
  const parsed = parseRequest(input);
  if (isFailure(parsed)) {
    return failedOutcome(parsed);
  }
  const rule = normalizedRule(parsed);
  if (isFailure(rule)) {
    return failedOutcome(rule, parsed.sourceRefs);
  }
  const metrics = calculateCargoMetrics(parsed.cargoLines);
  if (isFailure(metrics)) {
    return failedOutcome(metrics, parsed.sourceRefs);
  }
  const requiredSourceIds = [
    ...metrics.source_ref_ids,
    ...rule.source_ref_ids,
  ];
  const sourceFailure = ensureSourcesCover(parsed.sourceRefs, requiredSourceIds);
  if (sourceFailure !== null) {
    return failedOutcome(sourceFailure, parsed.sourceRefs, metrics.calculation_trace);
  }
  const volumetric = calculateVolumetricWeight({
    volume: metrics.metrics.total_volume,
    rule,
  });
  if (isFailure(volumetric)) {
    return failedOutcome(volumetric, parsed.sourceRefs, metrics.calculation_trace);
  }
  const chargeable = calculateChargeableWeight({
    actual: metrics.metrics.actual_weight.value,
    volumetric: volumetric.volumetric_weight.value,
    method: rule.method,
    ...(rule.ratio === undefined ? {} : { ratio: rule.ratio }),
    ruleVersion: rule.rule_version,
    sourceRefIds: rule.source_ref_ids,
    ...(rule.supplier === undefined ? {} : { supplierRule: rule.supplier }),
  });
  if (isFailure(chargeable)) {
    return failedOutcome(chargeable, parsed.sourceRefs, metrics.calculation_trace);
  }
  const chargeableWeight: ChargeableWeight = {
    version: chargeable.version,
    actual_weight: chargeable.actual_weight,
    volumetric_weight: chargeable.volumetric_weight,
    bubble_weight: chargeable.bubble_weight,
    customer_chargeable_weight: chargeable.customer_chargeable_weight,
    supplier_chargeable_weight: chargeable.supplier_chargeable_weight,
    bubble_share_ratio: chargeable.bubble_share_ratio,
    method: chargeable.method,
    rule_version: chargeable.rule_version,
    source_ref_ids: chargeable.source_ref_ids,
  };
  const data: Record<string, unknown> = {
    ...asCargoResult(
      metrics.metrics,
      volumetric.volumetric_weight,
      chargeableWeight,
    ),
  };
  const usedSourceIds = new Set(requiredSourceIds);
  const outputSourceRefs = parsed.sourceRefs.filter((ref) => usedSourceIds.has(ref.source_id));
  return {
    status: "success",
    data,
    sourceRefs: outputSourceRefs,
    assumptions: [],
    warnings: [],
    blockers: [],
    calculationTrace: [
      ...metrics.calculation_trace,
      ...volumetric.calculation_trace,
      ...chargeable.calculation_trace,
    ],
    reviewStatus: "not_required",
  };
}

export function calculateCargoEnvelope(
  input: unknown,
  context: ExecutionContext,
  requestId: string,
  auditId: string,
): ResponseEnvelope {
  const outcome = calculateCargo(input, context);
  return createEnvelope({
    requestId,
    auditId,
    status: outcome.status,
    data: outcome.data,
    ...(outcome.sourceRefs === undefined ? {} : { sourceRefs: outcome.sourceRefs }),
    ...(outcome.assumptions === undefined ? {} : { assumptions: outcome.assumptions }),
    ...(outcome.warnings === undefined ? {} : { warnings: outcome.warnings }),
    ...(outcome.blockers === undefined ? {} : { blockers: outcome.blockers }),
    ...(outcome.calculationTrace === undefined ? {} : { calculationTrace: outcome.calculationTrace }),
    ...(outcome.reviewStatus === undefined ? {} : { reviewStatus: outcome.reviewStatus }),
  });
}
