import { describe, expect, it, vi } from "vitest";

import type { FreightcomRatePort } from "../../src/logistics_mcp/adapters/ports";
import {
  configDigestForValues,
  FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES,
  type PluginConfigTypedValue,
} from "../../src/logistics_mcp/control-plane/plugin-config-contracts";
import {
  pluginConfigGeneration,
  storedPluginConfigValues,
  type PluginConfigCurrentRecord,
} from "../../src/logistics_mcp/control-plane/plugin-config-store";
import { ManagedFreightcomConfigRuntime } from "../../src/logistics_mcp/server/plugin-config-runtime";

function values(timeout: number): readonly PluginConfigTypedValue[] {
  return FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES.map((value): PluginConfigTypedValue =>
    value.field_id === "request_timeout_ms" && value.kind === "integer"
      ? { ...value, value: timeout }
      : value,
  );
}

function current(): PluginConfigCurrentRecord {
  const stored = storedPluginConfigValues(FREIGHTCOM_LTL_DEFAULT_CONFIG_VALUES);
  const digest = configDigestForValues(stored.values);
  return {
    ...stored,
    revision: 0,
    configDigest: digest,
    moduleGeneration: pluginConfigGeneration(0, digest),
    activeReleaseId: "bootstrap_config",
    checkedAt: "2026-08-31T00:00:00.000Z",
  };
}

function result(label: string) {
  return {
    status: "manual_review" as const,
    data: { kind: "freightcom_rate", label },
    sourceRefs: [],
  };
}

describe("managed Freightcom plugin config runtime", () => {
  it("swaps only bounded configuration and exposes exact readback", async () => {
    const factories: number[] = [];
    const runtime = new ManagedFreightcomConfigRuntime(current(), (config) => {
      factories.push(config.requestTimeoutMs);
      return { requestRate: () => Promise.resolve(result(String(config.requestTimeoutMs))) };
    });
    expect((await runtime.requestRate({})).data).toMatchObject({ label: "20000" });
    const desired = values(18_000);
    const digest = configDigestForValues(desired);
    const applied = await runtime.apply({
      module_id: "freightcom-ltl",
      release_id: "release_config_001",
      revision: 1,
      config_digest: digest,
      values: desired,
      restart_policy: "controlled_restart",
    });
    expect(applied).toMatchObject({
      status: "readback_verified",
      release_id: "release_config_001",
      revision: 1,
      config_digest: digest,
      module_generation: pluginConfigGeneration(1, digest),
      reason_code: null,
    });
    expect(factories).toEqual([20_000, 18_000]);
    expect((await runtime.requestRate({})).data).toMatchObject({ label: "18000" });
    await expect(runtime.readback({
      module_id: "freightcom-ltl",
      release_id: "release_config_001",
      revision: 1,
      config_digest: digest,
    })).resolves.toMatchObject({ status: "readback_verified", reason_code: null });
    await expect(runtime.readback({
      module_id: "freightcom-ltl",
      release_id: "release_config_001",
      revision: 1,
      config_digest: configDigestForValues(values(19_000)),
    })).resolves.toMatchObject({ status: "mismatch", reason_code: "readback_mismatch" });
  });

  it("drains in-flight dispatch before swapping the adapter", async () => {
    let finish: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let factoryCalls = 0;
    const firstAdapter: FreightcomRatePort = {
      requestRate: async () => {
        await firstRequest;
        return result("old");
      },
    };
    const nextAdapter: FreightcomRatePort = {
      requestRate: () => Promise.resolve(result("new")),
    };
    const runtime = new ManagedFreightcomConfigRuntime(current(), () => (
      ++factoryCalls === 1 ? firstAdapter : nextAdapter
    ));
    const inFlight = runtime.requestRate({});
    await vi.waitFor(() => expect(runtime.snapshot().in_flight).toBe(1));
    const desired = values(17_000);
    const apply = runtime.apply({
      module_id: "freightcom-ltl",
      release_id: "release_config_002",
      revision: 1,
      config_digest: configDigestForValues(desired),
      values: desired,
      restart_policy: "controlled_restart",
    });
    await Promise.resolve();
    expect(factoryCalls).toBe(1);
    finish?.();
    await expect(inFlight).resolves.toEqual(result("old"));
    await expect(apply).resolves.toMatchObject({ status: "readback_verified" });
    expect(factoryCalls).toBe(2);
    await expect(runtime.requestRate({})).resolves.toEqual(result("new"));
  });

  it("blocks invalid or out-of-order mutations without swapping", async () => {
    const factory = vi.fn((): FreightcomRatePort => ({
      requestRate: () => Promise.resolve(result("safe")),
    }));
    const runtime = new ManagedFreightcomConfigRuntime(current(), factory);
    await expect(runtime.apply({
      module_id: "freightcom-ltl",
      release_id: "release_config_bad",
      revision: 0,
      config_digest: configDigestForValues(values(18_000)),
      values: values(18_000),
      restart_policy: "controlled_restart",
    })).resolves.toMatchObject({ status: "blocked", reason_code: "runtime_revision_conflict" });
    await expect(runtime.apply({
      module_id: "freightcom-ltl",
      release_id: "release_config_url",
      revision: 1,
      config_digest: configDigestForValues(values(18_000)),
      values: [
        ...values(18_000).slice(0, 4),
        { field_id: "credential_slot_id", kind: "secret_slot", value: "https://evil.invalid" },
      ],
      restart_policy: "controlled_restart",
    })).resolves.toMatchObject({ status: "blocked", reason_code: "config_values_invalid" });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().revision).toBe(0);
  });

  it("accepts a strictly newer unused revision after a skipped release", async () => {
    const factory = vi.fn((): FreightcomRatePort => ({
      requestRate: () => Promise.resolve(result("safe")),
    }));
    const runtime = new ManagedFreightcomConfigRuntime(current(), factory);
    const desired = values(18_000);
    const digest = configDigestForValues(desired);

    await expect(runtime.apply({
      module_id: "freightcom-ltl",
      release_id: "release_config_skipped",
      revision: 2,
      config_digest: digest,
      values: desired,
      restart_policy: "controlled_restart",
    })).resolves.toMatchObject({
      status: "readback_verified",
      revision: 2,
      release_id: "release_config_skipped",
    });
    expect(runtime.snapshot().revision).toBe(2);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("blocks request dispatch after the shared fatal fence trips", async () => {
    let fatal = false;
    const fatalFence = {
      isFatal: () => fatal,
      tripFatal: vi.fn((error: unknown): never => {
        fatal = true;
        throw error;
      }),
    };
    const adapter: FreightcomRatePort = {
      requestRate: vi.fn(() => Promise.resolve(result("must-not-run"))),
    };
    const RuntimeWithFence = ManagedFreightcomConfigRuntime as unknown as new (
      currentRecord: PluginConfigCurrentRecord,
      adapterFactory: () => FreightcomRatePort,
      fence: typeof fatalFence,
    ) => ManagedFreightcomConfigRuntime;
    const runtime = new RuntimeWithFence(current(), () => adapter, fatalFence);
    fatal = true;

    await expect(runtime.requestRate({})).rejects.toThrow();
    expect(fatalFence.tripFatal).toHaveBeenCalledTimes(1);
    expect(adapter.requestRate).not.toHaveBeenCalled();
  });
});
