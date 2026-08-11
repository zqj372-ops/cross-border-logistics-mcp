import { Decimal } from "decimal.js";

import type { Notice } from "../../platform/envelope";
import type {
  CargoMetrics,
  ContainerProfile,
  VolumeMeasurement,
  WeightMeasurement,
} from "./models";

export type ContainerPlan = {
  readonly version: string;
  readonly plan_id: string;
  readonly container_type: ContainerProfile["container_type"];
  readonly physical_capacity: VolumeMeasurement;
  readonly operational_target: VolumeMeasurement;
  readonly max_payload: WeightMeasurement;
  readonly total_volume: VolumeMeasurement;
  readonly total_weight: WeightMeasurement;
  readonly utilization_ratio: string;
  readonly over_capacity: boolean;
  readonly overweight: boolean;
  readonly remaining_volume: VolumeMeasurement;
  readonly loading_order: readonly string[];
  readonly overflow_line_ids: readonly string[];
  readonly theoretical_only: true;
  readonly special_warnings: readonly Notice[];
  readonly source_ref_ids: readonly string[];
} & Record<string, unknown>;

export interface ContainerSummaryOptions {
  readonly plan_id: string;
  readonly loading_order: readonly string[];
  readonly overflow_line_ids: readonly string[];
  readonly source_ref_ids?: readonly string[];
  readonly additional_warnings?: readonly Notice[];
}

function decimalText(value: Decimal): string {
  const text = value.toFixed();
  return text === "-0" ? "0" : text;
}

function ratioText(value: Decimal): string {
  if (value.isNegative() || value.isZero()) {
    return "0.0000";
  }
  if (value.greaterThanOrEqualTo(1)) {
    return "1.0000";
  }
  return value.toFixed(4);
}

function normalizeVolume(measurement: VolumeMeasurement): Decimal {
  if (measurement.unit === "l") {
    return new Decimal(measurement.value).dividedBy(1000);
  }
  return new Decimal(measurement.value);
}

function normalizeWeight(measurement: WeightMeasurement): Decimal {
  if (measurement.unit === "g") {
    return new Decimal(measurement.value).dividedBy(1000);
  }
  if (measurement.unit === "lb") {
    return new Decimal(measurement.value).times("0.45359237");
  }
  return new Decimal(measurement.value);
}

function volumeMeasurement(value: Decimal): VolumeMeasurement {
  return { value: decimalText(value), unit: "cbm" };
}

function weightMeasurement(value: Decimal): WeightMeasurement {
  return { value: decimalText(value), unit: "kg" };
}

function notice(
  code: string,
  message: string,
  field = "source_ref_ids",
): Notice {
  return {
    code,
    message,
    severity: "warning",
    field,
  };
}

function minimumContainerCount(value: Decimal, capacity: Decimal): Decimal {
  if (value.isZero()) {
    return new Decimal(0);
  }
  return value.dividedBy(capacity).ceil();
}

function distinct(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function summarizeContainer(
  profile: ContainerProfile,
  cargoMetrics: CargoMetrics,
  options: ContainerSummaryOptions,
): ContainerPlan {
  const totalVolume = normalizeVolume(cargoMetrics.total_volume);
  const totalWeight = normalizeWeight(cargoMetrics.actual_weight);
  const physicalCapacity = normalizeVolume(profile.physical_capacity);
  const operationalTarget = normalizeVolume(profile.operational_target);
  const maxPayload = normalizeWeight(profile.max_payload);
  const operationalRatio = totalVolume.dividedBy(operationalTarget);
  const weightRatio = totalWeight.dividedBy(maxPayload);
  const physicalRatio = totalVolume.dividedBy(physicalCapacity);
  const operationalOverflow = Decimal.max(totalVolume.minus(operationalTarget), 0);
  const physicalOverflow = Decimal.max(totalVolume.minus(physicalCapacity), 0);
  const payloadOverflow = Decimal.max(totalWeight.minus(maxPayload), 0);
  const remainingVolume = Decimal.max(operationalTarget.minus(totalVolume), 0);
  const remainingPayload = Decimal.max(maxPayload.minus(totalWeight), 0);
  const overOperationalTarget = totalVolume.greaterThan(operationalTarget);
  const overPhysicalCapacity = totalVolume.greaterThan(physicalCapacity);
  const overweight = totalWeight.greaterThan(maxPayload);
  const overCapacity = overOperationalTarget || overPhysicalCapacity;

  const bottleneck =
    overOperationalTarget || overPhysicalCapacity || overweight
      ? overCapacity && overweight
        ? "volume_and_weight"
        : overCapacity
          ? "volume"
          : "weight"
      : operationalRatio.greaterThanOrEqualTo(weightRatio)
        ? "volume"
        : "weight";

  const operationalContainers = minimumContainerCount(
    totalVolume,
    operationalTarget,
  );
  const physicalContainers = minimumContainerCount(totalVolume, physicalCapacity);
  const payloadContainers = minimumContainerCount(totalWeight, maxPayload);
  const minimumContainers = Decimal.max(
    operationalContainers,
    physicalContainers,
    payloadContainers,
  );

  const warnings: Notice[] = [
    notice(
      "container.theory-only",
      "仅返回理论容量与运营目标汇总，不代表现场装载结果。",
    ),
    notice(
      "container.capacity.bottleneck",
      `当前瓶颈为 ${bottleneck}；运营方数比率 ${operationalRatio.toFixed(4)}，载重比率 ${weightRatio.toFixed(4)}。`,
    ),
    notice(
      "container.plan.minimum-containers",
      `按运营方数、物理方数和最大载重，至少需要 ${decimalText(minimumContainers)} 个柜。`,
    ),
    notice(
      "container.overflow.summary",
      `汇总溢出：超运营目标 ${decimalText(operationalOverflow)} cbm；超物理容量 ${decimalText(physicalOverflow)} cbm；超载 ${decimalText(payloadOverflow)} kg。`,
    ),
    notice(
      "container.payload.remaining",
      `剩余运营载重 ${decimalText(remainingPayload)} kg。`,
    ),
  ];

  if (profile.operational_target.value !== profile.physical_capacity.value) {
    warnings.push(
      notice(
        "container.capacity.operational-target-distinct",
        `物理容量 ${decimalText(physicalCapacity)} cbm 与运营目标 ${decimalText(operationalTarget)} cbm 分开保留。`,
      ),
    );
  }

  if (operationalTarget.greaterThan(physicalCapacity)) {
    warnings.push(
      notice(
        "container.capacity.profile-conflict",
        "运营目标大于物理容量，柜型配置需要人工复核。",
      ),
    );
  }

  if (overOperationalTarget) {
    warnings.push(
      notice(
        "container.capacity.operational-exceeded",
        `运营目标超出 ${decimalText(operationalOverflow)} cbm；实际运营方数比率 ${operationalRatio.toFixed(4)}。`,
      ),
    );
  }

  if (overPhysicalCapacity) {
    warnings.push(
      notice(
        "container.capacity.physical-exceeded",
        `物理容量超出 ${decimalText(physicalOverflow)} cbm；实际物理方数比率 ${physicalRatio.toFixed(4)}。`,
      ),
    );
  }

  if (overweight) {
    warnings.push(
      notice(
        "container.payload.exceeded",
        `最大载重超出 ${decimalText(payloadOverflow)} kg；需要运营人员复核。`,
      ),
    );
  }

  warnings.push(...(options.additional_warnings ?? []));

  return {
    version: `container-plan@${profile.version}/cargo@${cargoMetrics.version}`,
    plan_id: options.plan_id,
    container_type: profile.container_type,
    physical_capacity: volumeMeasurement(physicalCapacity),
    operational_target: volumeMeasurement(operationalTarget),
    max_payload: weightMeasurement(maxPayload),
    total_volume: volumeMeasurement(totalVolume),
    total_weight: weightMeasurement(totalWeight),
    utilization_ratio: ratioText(operationalRatio),
    over_capacity: overCapacity,
    overweight,
    remaining_volume: volumeMeasurement(remainingVolume),
    loading_order: [...options.loading_order],
    overflow_line_ids: distinct(options.overflow_line_ids),
    theoretical_only: true,
    special_warnings: warnings,
    source_ref_ids: distinct([
      ...profile.source_ref_ids,
      ...(options.source_ref_ids ?? []),
    ]),
  };
}
