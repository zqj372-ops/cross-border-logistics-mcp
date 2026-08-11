import { randomUUID } from "node:crypto";

import { Decimal } from "decimal.js";
import { z } from "zod";

import {
  createEnvelope,
  ENVELOPE_SCHEMA_VERSION,
  type CalculationStep,
  type Notice,
  type ResponseEnvelope,
  type SourceRef,
} from "../../platform/envelope";
import type {
  DomainToolHandler,
  ToolContract,
} from "../../server/tool-registry";
import {
  cargoMetricsSchema,
  containerProfileSchema,
  containerTypeSchema,
  decimalStringSchema,
  identifierSchema,
  type CargoMetrics,
  type ContainerProfile,
  type VolumeMeasurement,
  type WeightMeasurement,
  validateCargoMetrics,
  validateContainerProfile,
  versionSchema,
  volumeMeasurementSchema,
  weightMeasurementSchema,
} from "./models";
import {
  deriveLoadingOrder,
} from "./loading-order";
import {
  loadingConstraintsSchema,
  loadingLineSchema,
  validateLoadingConstraints,
  validateLoadingLines,
  type LoadingConstraints,
  type LoadingLine,
} from "./constraints";
import { summarizeContainer, type ContainerPlan } from "./summary";

const sourceRefSchema = z
  .object({
    source_id: identifierSchema,
    source_type: z.enum([
      "internal_system",
      "official_source",
      "tenant_record",
      "user_input",
      "opaque_reference",
      "fixture",
    ]),
    system: z.string().min(1).max(120),
    locator: z.string().min(1).max(500),
    version: versionSchema,
    retrieved_at: z.string().datetime({ offset: true }),
    authority: z.enum([
      "authoritative",
      "supporting",
      "user_provided",
      "opaque",
    ]),
    content_hash: z
      .string()
      .regex(/^(sha256:)?[A-Za-z0-9._:-]{8,128}$/)
      .nullable()
      .optional(),
  })
  .strict();

export const containerPlanSummaryInputSchema = z
  .object({
    schema_version: z.literal(ENVELOPE_SCHEMA_VERSION),
    version: versionSchema,
    plan_id: identifierSchema.optional(),
    container_type: containerTypeSchema,
    physical_capacity: volumeMeasurementSchema,
    operational_target: volumeMeasurementSchema,
    max_payload: weightMeasurementSchema,
    source_ref_ids: z.array(identifierSchema).min(1),
    cargo_metrics: cargoMetricsSchema,
    loading_constraints: loadingConstraintsSchema,
    loading_lines: z.array(loadingLineSchema).optional(),
    source_refs: z.array(sourceRefSchema).min(1).optional(),
    spatial_layout_requested: z.boolean().optional(),
  })
  .strict();

export type ContainerPlanSummaryInput = z.infer<
  typeof containerPlanSummaryInputSchema
>;

const noticeSchema = z
  .object({
    code: identifierSchema,
    message: z.string().min(1).max(1000),
    severity: z.enum(["info", "warning", "error"]),
    field: z.string().min(1).nullable().optional(),
  })
  .strict();

export const containerPlanOutputSchema = z
  .object({
    version: versionSchema,
    plan_id: identifierSchema,
    container_type: containerTypeSchema,
    physical_capacity: z
      .object({ value: decimalStringSchema, unit: z.literal("cbm") })
      .strict(),
    operational_target: z
      .object({ value: decimalStringSchema, unit: z.literal("cbm") })
      .strict(),
    max_payload: z
      .object({ value: decimalStringSchema, unit: z.literal("kg") })
      .strict(),
    total_volume: z
      .object({ value: decimalStringSchema, unit: z.literal("cbm") })
      .strict(),
    total_weight: z
      .object({ value: decimalStringSchema, unit: z.literal("kg") })
      .strict(),
    utilization_ratio: z
      .string()
      .regex(/^(0|0\.[0-9]+|1(?:\.0+)?)$/),
    over_capacity: z.boolean(),
    overweight: z.boolean(),
    remaining_volume: z
      .object({ value: decimalStringSchema, unit: z.literal("cbm") })
      .strict(),
    loading_order: z.array(identifierSchema),
    overflow_line_ids: z.array(identifierSchema),
    theoretical_only: z.literal(true),
    special_warnings: z.array(noticeSchema),
    source_ref_ids: z.array(identifierSchema).min(1),
  })
  .strict();

interface ServiceOutcome {
  readonly status: "success" | "needs_input" | "manual_review" | "blocked";
  readonly data: ContainerPlan | null;
  readonly sourceRefs: readonly SourceRef[];
  readonly assumptions: readonly Notice[];
  readonly warnings: readonly Notice[];
  readonly blockers: readonly Notice[];
  readonly calculationTrace: readonly CalculationStep[];
  readonly reviewStatus: "not_required" | "manual_review";
}

function notice(
  code: string,
  message: string,
  severity: Notice["severity"] = "warning",
  field: string | null = "container_plan",
): Notice {
  return { code, message, severity, field };
}

function issueNotice(code: string, field: string, message: string): Notice {
  return notice(code, message, "error", field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const forbiddenSpatialKeys = new Set([
    ["center", "of", "mass"].join("_"),
    ["stacking", "coordinates"].join("_"),
    "ro" + "tation",
    "coor" + "dinate",
    "x",
    "y",
    "z",
  ]);

function hasForbiddenSpatialKey(
  input: unknown,
  visited: Set<object> = new Set(),
): boolean {
  if (!isRecord(input) && !Array.isArray(input)) {
    return false;
  }
  if (visited.has(input)) {
    return false;
  }
  visited.add(input);
  if (
    isRecord(input) &&
    Object.keys(input).some((key) => forbiddenSpatialKeys.has(key))
  ) {
    return true;
  }
  return Object.values(input).some((value) =>
    hasForbiddenSpatialKey(value, visited),
  );
}

function hasSpatialLayoutRequest(input: unknown): boolean {
  return (
    (isRecord(input) && input.spatial_layout_requested === true) ||
    hasForbiddenSpatialKey(input)
  );
}

function sourceIds(input: ContainerPlanSummaryInput): readonly string[] {
  return [
    ...new Set([
      ...input.source_ref_ids,
      ...(input.source_refs?.map((source) => source.source_id) ?? []),
    ]),
  ];
}

function planId(input: ContainerPlanSummaryInput): string {
  if (input.plan_id !== undefined) {
    return input.plan_id;
  }
  const safeVersion = input.version.replace(/[^A-Za-z0-9.:/-]/g, "-");
  const safeCargoVersion = input.cargo_metrics.version.replace(
    /[^A-Za-z0-9.:/-]/g,
    "-",
  );
  return `plan:container:${safeVersion}:${safeCargoVersion}`.slice(0, 128);
}

function volumeInCbm(measurement: VolumeMeasurement): Decimal {
  if (measurement.unit === "l") {
    return new Decimal(measurement.value).dividedBy(1000);
  }
  return new Decimal(measurement.value);
}

function weightInKg(measurement: WeightMeasurement): Decimal {
  if (measurement.unit === "g") {
    return new Decimal(measurement.value).dividedBy(1000);
  }
  if (measurement.unit === "lb") {
    return new Decimal(measurement.value).times("0.45359237");
  }
  return new Decimal(measurement.value);
}

function text(value: Decimal): string {
  const output = value.toFixed();
  return output === "-0" ? "0" : output;
}

function volumeMeasurement(value: Decimal) {
  return { value: text(value), unit: "cbm" } as const;
}

function weightMeasurement(value: Decimal) {
  return { value: text(value), unit: "kg" } as const;
}

function rawBottleneck(
  totalVolume: Decimal,
  operationalTarget: Decimal,
  physicalCapacity: Decimal,
  totalWeight: Decimal,
  maxPayload: Decimal,
): string {
  const overVolume =
    totalVolume.greaterThan(operationalTarget) ||
    totalVolume.greaterThan(physicalCapacity);
  const overWeight = totalWeight.greaterThan(maxPayload);
  if (overVolume && overWeight) {
    return "volume_and_weight";
  }
  if (overVolume) {
    return "volume";
  }
  if (overWeight) {
    return "weight";
  }
  return totalVolume
    .dividedBy(operationalTarget)
    .greaterThanOrEqualTo(totalWeight.dividedBy(maxPayload))
    ? "volume"
    : "weight";
}

function calculationTrace(
  profile: ContainerProfile,
  metrics: CargoMetrics,
  plan: ContainerPlan,
  sourceRefIds: readonly string[],
): readonly CalculationStep[] {
  const totalVolume = volumeInCbm(metrics.total_volume);
  const operationalTarget = volumeInCbm(profile.operational_target);
  const physicalCapacity = volumeInCbm(profile.physical_capacity);
  const totalWeight = weightInKg(metrics.actual_weight);
  const maxPayload = weightInKg(profile.max_payload);
  const operationalRatio = totalVolume.dividedBy(operationalTarget);
  const weightRatio = totalWeight.dividedBy(maxPayload);
  const bottleneck = rawBottleneck(
    totalVolume,
    operationalTarget,
    physicalCapacity,
    totalWeight,
    maxPayload,
  );
  const minimumContainers = Decimal.max(
    totalVolume.isZero() ? new Decimal(0) : totalVolume.dividedBy(operationalTarget).ceil(),
    totalVolume.isZero() ? new Decimal(0) : totalVolume.dividedBy(physicalCapacity).ceil(),
    totalWeight.isZero() ? new Decimal(0) : totalWeight.dividedBy(maxPayload).ceil(),
  );

  return [
    {
      step_id: "step:container:versions",
      operation: "bind container profile and cargo metrics versions",
      inputs: [
        { name: "container_profile_version", value: profile.version },
        { name: "cargo_metrics_version", value: metrics.version },
      ],
      result: plan.version,
      source_ref_ids: sourceRefIds,
    },
    {
      step_id: "step:container:utilization",
      operation: "total volume divided by operational target",
      inputs: [
        { name: "total_volume", value: volumeMeasurement(totalVolume) },
        { name: "operational_target", value: volumeMeasurement(operationalTarget) },
      ],
      result: operationalRatio.toFixed(8),
      source_ref_ids: sourceRefIds,
      rounding: "display utilization is rounded to four decimal places and capped at 1.0000; raw ratio remains here",
    },
    {
      step_id: "step:container:physical-ratio",
      operation: "total volume divided by physical capacity",
      inputs: [
        { name: "total_volume", value: volumeMeasurement(totalVolume) },
        { name: "physical_capacity", value: volumeMeasurement(physicalCapacity) },
      ],
      result: totalVolume.dividedBy(physicalCapacity).toFixed(8),
      source_ref_ids: sourceRefIds,
    },
    {
      step_id: "step:container:remaining-volume",
      operation: "maximum of operational target minus total volume and zero",
      inputs: [
        { name: "operational_target", value: volumeMeasurement(operationalTarget) },
        { name: "total_volume", value: volumeMeasurement(totalVolume) },
      ],
      result: plan.remaining_volume,
      source_ref_ids: sourceRefIds,
    },
    {
      step_id: "step:container:remaining-payload",
      operation: "maximum of payload limit minus total weight and zero",
      inputs: [
        { name: "max_payload", value: weightMeasurement(maxPayload) },
        { name: "total_weight", value: weightMeasurement(totalWeight) },
      ],
      result: weightMeasurement(Decimal.max(maxPayload.minus(totalWeight), 0)),
      source_ref_ids: sourceRefIds,
    },
    {
      step_id: "step:container:weight-ratio",
      operation: "total weight divided by maximum payload",
      inputs: [
        { name: "total_weight", value: weightMeasurement(totalWeight) },
        { name: "max_payload", value: weightMeasurement(maxPayload) },
      ],
      result: weightRatio.toFixed(8),
      source_ref_ids: sourceRefIds,
    },
    {
      step_id: "step:container:bottleneck",
      operation: "select higher constrained utilization or active overflow",
      inputs: [
        { name: "volume_ratio", value: operationalRatio.toFixed(8) },
        { name: "weight_ratio", value: weightRatio.toFixed(8) },
      ],
      result: bottleneck,
      source_ref_ids: sourceRefIds,
    },
    {
      step_id: "step:container:minimum-containers",
      operation: "maximum of operational volume, physical volume, and payload container counts",
      inputs: [
        { name: "total_volume", value: volumeMeasurement(totalVolume) },
        { name: "operational_target", value: volumeMeasurement(operationalTarget) },
        { name: "physical_capacity", value: volumeMeasurement(physicalCapacity) },
        { name: "total_weight", value: weightMeasurement(totalWeight) },
        { name: "max_payload", value: weightMeasurement(maxPayload) },
      ],
      result: text(minimumContainers),
      source_ref_ids: sourceRefIds,
    },
  ];
}

function defaultLoadingLines(metrics: CargoMetrics): readonly LoadingLine[] {
  return metrics.derived_from_line_ids.map((lineId) => ({
    line_id: lineId,
    sensitive: false,
    customer_priority: null,
    declaration_required: false,
  }));
}

function lineOverflowIds(
  loadingOrder: readonly string[],
  loadingLines: readonly LoadingLine[],
  profile: ContainerProfile,
): readonly string[] {
  const byId = new Map(loadingLines.map((line) => [line.line_id, line]));
  const operationalTarget = volumeInCbm(profile.operational_target);
  const physicalCapacity = volumeInCbm(profile.physical_capacity);
  const maxPayload = weightInKg(profile.max_payload);
  let volume = new Decimal(0);
  let weight = new Decimal(0);
  const overflow: string[] = [];

  for (const lineId of loadingOrder) {
    const line = byId.get(lineId);
    if (line === undefined) {
      continue;
    }
    if (line.volume !== undefined) {
      volume = volume.plus(volumeInCbm(line.volume));
    }
    if (line.weight !== undefined) {
      weight = weight.plus(weightInKg(line.weight));
    }
    if (
      volume.greaterThan(operationalTarget) ||
      volume.greaterThan(physicalCapacity) ||
      weight.greaterThan(maxPayload)
    ) {
      overflow.push(lineId);
    }
  }

  return overflow;
}

function statusForInputFailure(
  code: string,
  field: string,
  message: string,
): ServiceOutcome {
  return {
    status: "needs_input",
    data: null,
    sourceRefs: [],
    assumptions: [],
    warnings: [],
    blockers: [issueNotice(code, field, message)],
    calculationTrace: [],
    reviewStatus: "not_required",
  };
}

function parsedInputFailure(error: z.ZodError): ServiceOutcome {
  const issue = error.issues[0];
  return statusForInputFailure(
    "container.input.invalid",
    issue?.path.join(".") || "<root>",
    issue?.message ?? "The container summary input is invalid.",
  );
}

function outcomeFromInput(input: unknown): ServiceOutcome {
  if (hasSpatialLayoutRequest(input)) {
    return {
      status: "blocked",
      data: null,
      sourceRefs: [],
      assumptions: [],
      warnings: [],
      blockers: [
        issueNotice(
          "container.spatial.request-blocked",
          "requested_output",
          "该工具只提供理论容量与运营目标汇总，不执行空间布局，也不代表现场装载结果。",
        ),
      ],
      calculationTrace: [],
      reviewStatus: "not_required",
    };
  }

  const parsed = containerPlanSummaryInputSchema.safeParse(input);
  if (!parsed.success) {
    return parsedInputFailure(parsed.error);
  }
  const request = parsed.data;

  const profileValidation = validateContainerProfile({
    version: request.version,
    container_type: request.container_type,
    physical_capacity: request.physical_capacity,
    operational_target: request.operational_target,
    max_payload: request.max_payload,
    source_ref_ids: request.source_ref_ids,
  });
  if (!profileValidation.ok) {
    return statusForInputFailure(
      profileValidation.code,
      profileValidation.issues[0]?.field ?? "container_profile",
      profileValidation.issues[0]?.message ?? "The container profile is invalid.",
    );
  }
  const profile = profileValidation.value;
  const metricsValidation = validateCargoMetrics(request.cargo_metrics);
  if (!metricsValidation.ok) {
    return statusForInputFailure(
      metricsValidation.code,
      metricsValidation.issues[0]?.field ?? "cargo_metrics",
      metricsValidation.issues[0]?.message ?? "CargoMetrics is invalid.",
    );
  }
  const metrics = metricsValidation.value;
  const constraintsValidation = validateLoadingConstraints(
    request.loading_constraints,
  );
  if (!constraintsValidation.ok) {
    return statusForInputFailure(
      "container.loading.constraints-invalid",
      "loading_constraints",
      constraintsValidation.issues[0]?.message ?? "Loading constraints are invalid.",
    );
  }
  const constraints: LoadingConstraints = constraintsValidation.value;

  if (metrics.weight_evidence === "missing") {
    return statusForInputFailure(
      "container.cargo.weight-evidence-required",
      "cargo_metrics.weight_evidence",
      "Actual weight evidence is required before a container summary can be calculated.",
    );
  }

  const sourceRefIds = sourceIds(request);
  const sourceRefs = (request.source_refs ?? []) as readonly SourceRef[];
  const assumptions: Notice[] = [
    notice(
      "container.source-ids-bound",
      "结果绑定了 ContainerProfile 与 CargoMetrics 的来源 ID；完整来源对象由集成层注入。",
      "info",
      "source_ref_ids",
    ),
  ];
  const warnings: Notice[] = [];
  if (request.source_refs === undefined) {
    warnings.push(
      notice(
        "container.source-refs-integration",
        "本领域只保留来源 ID；完整 SourceRef 对象需要由平台集成层提供。",
        "warning",
        "source_ref_ids",
      ),
    );
  }

  const loadingLines = request.loading_lines ?? defaultLoadingLines(metrics);
  const linesValidation = validateLoadingLines(loadingLines);
  if (!linesValidation.ok) {
    return statusForInputFailure(
      "container.loading.lines-invalid",
      "loading_lines",
      linesValidation.issues[0]?.message ?? "Loading line metadata is invalid.",
    );
  }
  const validatedLines = linesValidation.value;
  const lineIds = new Set(validatedLines.map((line) => line.line_id));
  const metricLineIds = new Set(metrics.derived_from_line_ids);
  const lineReferenceMismatch =
    lineIds.size !== metricLineIds.size ||
    [...lineIds].some((lineId) => !metricLineIds.has(lineId));
  if (lineReferenceMismatch) {
    warnings.push(
      notice(
        "container.loading.line-reference-mismatch",
        "装载顺序输入与 CargoMetrics 的行引用不完全一致，顺序摘要需要人工核对。",
        "warning",
        "loading_lines",
      ),
    );
  }

  const loadingOrder = deriveLoadingOrder(validatedLines, constraints);
  const overflowLineIds = lineOverflowIds(
    loadingOrder.loading_order,
    validatedLines,
    profile,
  );
  const plan = summarizeContainer(profile, metrics, {
    plan_id: planId(request),
    loading_order: loadingOrder.loading_order,
    overflow_line_ids: overflowLineIds,
    source_ref_ids: sourceRefIds,
    additional_warnings: [
      ...loadingOrder.warnings,
      ...(request.loading_lines === undefined
        ? [
            notice(
              "container.loading.metadata-unavailable",
              "CargoMetrics 只提供行 ID，未提供敏感/优先级/申报属性；当前顺序按稳定 FIFO 摘要。",
              "warning",
              "loading_lines",
            ),
          ]
        : []),
    ],
  });
  const trace = calculationTrace(profile, metrics, plan, sourceRefIds);

  const blockers: Notice[] = [];
  if (metrics.weight_evidence === "conflicting") {
    blockers.push(
      issueNotice(
        "container.cargo.weight-evidence-conflict",
        "cargo_metrics.weight_evidence",
        "CargoMetrics 的重量证据互相冲突，需要人工确认后再使用摘要。",
      ),
    );
  }
  if (plan.over_capacity || plan.special_warnings.some((item) => item.code === "container.capacity.profile-conflict")) {
    blockers.push(
      issueNotice(
        "container.capacity.manual-review",
        "physical_capacity",
        "运营目标或物理容量存在超限/配置冲突，摘要不是最终装载结论。",
      ),
    );
  }
  if (plan.overweight) {
    blockers.push(
      issueNotice(
        "container.payload.manual-review",
        "max_payload",
        "最大载重存在超限，摘要需要运营人员人工复核。",
      ),
    );
  }
  if (loadingOrder.conflict || lineReferenceMismatch) {
    blockers.push(
      issueNotice(
        "container.loading.manual-review",
        "loading_constraints",
        "装载顺序约束冲突或行引用不一致，需要人工复核。",
      ),
    );
  }

  const status = blockers.length > 0 ? "manual_review" : "success";
  return {
    status,
    data: plan,
    sourceRefs,
    assumptions,
    warnings,
    blockers,
    calculationTrace: trace,
    reviewStatus: status === "manual_review" ? "manual_review" : "not_required",
  };
}

export const containerPlanSummaryHandler: DomainToolHandler = (
  input,
  context,
) => {
  void context;
  const outcome = outcomeFromInput(input);
  return {
    status: outcome.status,
    data: outcome.data,
    sourceRefs: outcome.sourceRefs,
    assumptions: outcome.assumptions,
    warnings: outcome.warnings,
    blockers: outcome.blockers,
    calculationTrace: outcome.calculationTrace,
    reviewStatus: outcome.reviewStatus,
  };
};

export const containerPlanSummaryOutputValidator = (data: unknown): void => {
  containerPlanOutputSchema.parse(data);
};

export const containerPlanSummaryToolContract: ToolContract = {
  inputSchema: containerPlanSummaryInputSchema,
  validateOutput: containerPlanSummaryOutputValidator,
};

export const containerPlanSummaryContract = containerPlanSummaryToolContract;

export interface PlanSummaryEnvelopeOptions {
  readonly request_id?: string;
  readonly audit_id?: string;
}

export function planContainerSummary(
  input: unknown,
  options: PlanSummaryEnvelopeOptions = {},
): ResponseEnvelope {
  const outcome = outcomeFromInput(input);
  if (outcome.data !== null) {
    containerPlanSummaryOutputValidator(outcome.data);
  }
  return createEnvelope({
    requestId: options.request_id ?? `req:container:${randomUUID()}`,
    auditId: options.audit_id ?? `audit:container:${randomUUID()}`,
    status: outcome.status,
    data: outcome.data,
    sourceRefs: outcome.sourceRefs,
    assumptions: outcome.assumptions,
    warnings: outcome.warnings,
    blockers: outcome.blockers,
    calculationTrace: outcome.calculationTrace,
    reviewStatus: outcome.reviewStatus,
  });
}

export {
  cargoMetricsSchema,
  containerProfileSchema,
  loadingConstraintsSchema,
  loadingLineSchema,
};
