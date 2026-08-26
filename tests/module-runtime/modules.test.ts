import { describe, expect, it } from "vitest";

import { CapabilityRegistry, ModuleHost } from "../../src/logistics_mcp/module-runtime";
import type { FreightcomRatePort } from "../../src/logistics_mcp/adapters/ports";
import {
  cargoModule,
  containerModule,
  createFreightcomLtlModule,
  FREIGHTCOM_RATE_CAPABILITY,
} from "../../src/logistics_mcp/modules";

describe("trusted domain modules", () => {
  it("exposes cargo and container through the module catalog without changing tool names", async () => {
    const host = new ModuleHost({
      capabilities: new CapabilityRegistry(),
      modules: [cargoModule, containerModule],
    });

    await host.mount();
    expect(host.catalog.list().map((tool) => tool.name)).toEqual([
      "cargo.calculate",
      "container.plan_summary",
    ]);
    expect(host.snapshot().modules).toEqual([
      expect.objectContaining({ module_id: "cargo", mounted: true, tool_names: ["cargo.calculate"] }),
      expect.objectContaining({ module_id: "container", mounted: true, tool_names: ["container.plan_summary"] }),
    ]);
    await host.close();
  });

  it("mounts the T1 Freightcom preview only through its named capability", async () => {
    const capabilities = new CapabilityRegistry();
    const adapter: FreightcomRatePort = {
      requestRate: () => Promise.resolve({ status: "unavailable", data: null, sourceRefs: [] }),
    };
    capabilities.provide(
      FREIGHTCOM_RATE_CAPABILITY,
      adapter,
      "freightcom-rate-port@2026-08-26.v1",
    );
    const host = new ModuleHost({
      capabilities,
      modules: [createFreightcomLtlModule()],
    });

    await host.mount();
    expect(host.catalog.list()).toEqual([
      expect.objectContaining({
        name: "quote.freightcom_ltl.preview",
        kind: "read",
        riskLevel: "T1",
        idempotentHint: false,
        module_id: "freightcom-ltl",
      }),
    ]);
    await host.close();
  });
});
