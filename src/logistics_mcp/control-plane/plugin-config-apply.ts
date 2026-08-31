import {
  freezePluginConfigOutput,
  type PluginConfigApplyObservationStatus,
  type PluginConfigModuleId,
  type PluginConfigRestartPolicy,
  type PluginConfigTypedValue,
} from "./plugin-config-contracts";

export type PluginConfigApplyInput = Readonly<{
  module_id: "freightcom-ltl";
  release_id: string;
  revision: number;
  config_digest: string;
  values: readonly PluginConfigTypedValue[];
  restart_policy: PluginConfigRestartPolicy;
}>;

export type PluginConfigApplyObservation = Readonly<{
  status: PluginConfigApplyObservationStatus;
  release_id: string | null;
  revision: number | null;
  config_digest: string | null;
  module_generation: string | null;
  values: readonly PluginConfigTypedValue[] | null;
  reason_code: string | null;
}>;

export interface PluginConfigApplyPort {
  readonly apply: (input: PluginConfigApplyInput) => Promise<PluginConfigApplyObservation>;
  readonly readback?: (input: Readonly<{
    module_id: PluginConfigModuleId;
    release_id: string;
    revision: number;
    config_digest: string;
  }>) => Promise<PluginConfigApplyObservation>;
}

export function snapshotPluginConfigObservation(
  value: PluginConfigApplyObservation,
): PluginConfigApplyObservation {
  const output: PluginConfigApplyObservation = {
    status: value.status,
    release_id: value.release_id,
    revision: value.revision,
    config_digest: value.config_digest,
    module_generation: value.module_generation,
    values: value.values === null
      ? null
      : value.values.map((entry) => ({ ...entry })),
    reason_code: value.reason_code,
  };
  return freezePluginConfigOutput(output);
}
