import { isDeepStrictEqual } from "node:util";

import type { FreightcomRatePort } from "../adapters/ports";
import type {
  PluginConfigApplyInput,
  PluginConfigApplyObservation,
  PluginConfigApplyPort,
  PluginConfigFatalFence,
} from "../control-plane/plugin-config-apply";
import {
  createPluginConfigFatalFence,
} from "../control-plane/plugin-config-apply";
import {
  validatePluginConfigValues,
  type PluginConfigTypedValue,
} from "../control-plane/plugin-config-contracts";
import {
  pluginConfigGeneration,
  storedPluginConfigValues,
  type PluginConfigCurrentRecord,
  type StoredPluginConfigValues,
} from "../control-plane/plugin-config-store";

export type FreightcomConfigAdapterFactory = (
  values: StoredPluginConfigValues,
) => FreightcomRatePort;

function sortedValues(
  values: readonly PluginConfigTypedValue[],
): readonly PluginConfigTypedValue[] {
  return [...values].sort((left, right) => left.field_id.localeCompare(right.field_id));
}

export class ManagedFreightcomConfigRuntime
implements FreightcomRatePort, PluginConfigApplyPort {
  readonly #adapterFactory: FreightcomConfigAdapterFactory;
  #adapter: FreightcomRatePort;
  #releaseId: string;
  #revision: number;
  #configDigest: string;
  #moduleGeneration: string;
  #values: readonly PluginConfigTypedValue[];
  readonly #fatalFence: PluginConfigFatalFence;
  #inFlight = 0;
  #drainWaiters: Array<() => void> = [];
  #barrier: Promise<void> | null = null;
  #releaseBarrier: (() => void) | null = null;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    current: PluginConfigCurrentRecord,
    adapterFactory: FreightcomConfigAdapterFactory,
    fatalFence: PluginConfigFatalFence = createPluginConfigFatalFence(),
  ) {
    this.#adapterFactory = adapterFactory;
    this.#fatalFence = fatalFence;
    const values = storedPluginConfigValues(current.values);
    this.#adapter = adapterFactory(values);
    this.#releaseId = current.activeReleaseId;
    this.#revision = current.revision;
    this.#configDigest = current.configDigest;
    this.#moduleGeneration = current.moduleGeneration;
    this.#values = values.values;
  }

  async requestRate(input: unknown, signal?: AbortSignal) {
    this.#assertHealthy();
    while (this.#barrier !== null) await this.#barrier;
    this.#assertHealthy();
    const adapter = this.#adapter;
    this.#inFlight += 1;
    try {
      return await adapter.requestRate(input, signal);
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0) {
        const waiters = this.#drainWaiters;
        this.#drainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  apply(input: PluginConfigApplyInput): Promise<PluginConfigApplyObservation> {
    return this.#exclusive(async () => {
      this.#assertHealthy();
      if (input.module_id !== "freightcom-ltl") {
        return this.#unavailable("blocked", "plugin_config_not_supported");
      }
      let values: StoredPluginConfigValues;
      try {
        values = storedPluginConfigValues(validatePluginConfigValues(input.values));
      } catch {
        return this.#unavailable("blocked", "config_values_invalid");
      }
      if (
        input.release_id === this.#releaseId &&
        input.revision === this.#revision &&
        input.config_digest === this.#configDigest &&
        isDeepStrictEqual(sortedValues(values.values), sortedValues(this.#values))
      ) {
        return this.#observation("readback_verified", null);
      }
      if (!Number.isSafeInteger(input.revision) || input.revision <= this.#revision) {
        return this.#unavailable("blocked", "runtime_revision_conflict");
      }
      this.#openBarrier();
      try {
        await this.#drain();
        const nextAdapter = this.#adapterFactory(values);
        this.#adapter = nextAdapter;
        this.#releaseId = input.release_id;
        this.#revision = input.revision;
        this.#configDigest = input.config_digest;
        this.#moduleGeneration = pluginConfigGeneration(input.revision, input.config_digest);
        this.#values = values.values;
        return this.#observation("readback_verified", null);
      } catch {
        return this.#unavailable("unavailable", "adapter_restart_failed");
      } finally {
        this.#closeBarrier();
      }
    });
  }

  readback(input: Readonly<{
    module_id: "cargo" | "container" | "agent-access" | "freightcom-ltl";
    release_id: string;
    revision: number;
    config_digest: string;
  }>): Promise<PluginConfigApplyObservation> {
    if (input.module_id !== "freightcom-ltl") {
      return Promise.resolve(this.#unavailable("blocked", "plugin_config_not_supported"));
    }
    const exact =
      input.release_id === this.#releaseId &&
      input.revision === this.#revision &&
      input.config_digest === this.#configDigest;
    return Promise.resolve(this.#observation(
      exact ? "readback_verified" : "mismatch",
      exact ? null : "readback_mismatch",
    ));
  }

  snapshot(): Readonly<{
    release_id: string;
    revision: number;
    config_digest: string;
    module_generation: string;
    values: readonly PluginConfigTypedValue[];
    in_flight: number;
  }> {
    return Object.freeze({
      release_id: this.#releaseId,
      revision: this.#revision,
      config_digest: this.#configDigest,
      module_generation: this.#moduleGeneration,
      values: Object.freeze(this.#values.map((value) => Object.freeze({ ...value }))),
      in_flight: this.#inFlight,
    });
  }

  #observation(
    status: PluginConfigApplyObservation["status"],
    reasonCode: string | null,
  ): PluginConfigApplyObservation {
    return Object.freeze({
      status,
      release_id: this.#releaseId,
      revision: this.#revision,
      config_digest: this.#configDigest,
      module_generation: this.#moduleGeneration,
      values: Object.freeze(this.#values.map((value) => Object.freeze({ ...value }))),
      reason_code: reasonCode,
    });
  }

  #assertHealthy(): void {
    if (this.#fatalFence.isFatal()) {
      this.#fatalFence.tripFatal(new Error("plugin_config_runtime_fatal"));
    }
  }

  #unavailable(
    status: "blocked" | "unavailable",
    reasonCode: string,
  ): PluginConfigApplyObservation {
    return Object.freeze({
      status,
      release_id: null,
      revision: null,
      config_digest: null,
      module_generation: null,
      values: null,
      reason_code: reasonCode,
    });
  }

  #openBarrier(): void {
    if (this.#barrier !== null) throw new Error("Plugin config mutation barrier is already open.");
    this.#barrier = new Promise<void>((resolve) => {
      this.#releaseBarrier = resolve;
    });
  }

  #closeBarrier(): void {
    const release = this.#releaseBarrier;
    this.#releaseBarrier = null;
    this.#barrier = null;
    release?.();
  }

  #drain(): Promise<void> {
    if (this.#inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#drainWaiters.push(resolve));
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(operation, operation);
    this.#mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}
