import { describe, expect, it } from "vitest";

import { CapabilityRegistry, ModuleHost } from "../../src/logistics_mcp/module-runtime";
import { cargoModule, containerModule } from "../../src/logistics_mcp/modules";

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
});
