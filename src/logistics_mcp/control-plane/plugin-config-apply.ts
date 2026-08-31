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

/**
 * Narrow fatal capability shared by the config service, managed adapter and
 * request-readiness boundary. The mutation coordinator itself stays private
 * to the control-plane assembly.
 */
export interface PluginConfigFatalFence {
  readonly isFatal: () => boolean;
  readonly tripFatal: (error: unknown) => never;
}

export class PluginConfigRuntimeFatalError extends Error {
  readonly code = "fatal" as const;

  constructor() {
    super("plugin_config_runtime_fatal");
    this.name = "PluginConfigRuntimeFatalError";
    Object.setPrototypeOf(this, new.target.prototype);
    Object.freeze(this);
  }
}

export function createPluginConfigFatalFence(): PluginConfigFatalFence {
  let fatalError: PluginConfigRuntimeFatalError | undefined;
  const fence: PluginConfigFatalFence = {
    isFatal: () => fatalError !== undefined,
    tripFatal: (error: unknown): never => {
      void error;
      fatalError ??= new PluginConfigRuntimeFatalError();
      throw fatalError;
    },
  };
  return Object.freeze(fence);
}

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
