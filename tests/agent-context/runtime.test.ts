import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { buildAgentStandardPack } from "../../src/logistics_mcp/agent-context/pack";
import {
  agentContextDataSchema,
  createAgentAccessRuntime,
} from "../../src/logistics_mcp/agent-context/runtime";

const rootDir = resolve(import.meta.dirname, "../..");

describe("Agent access runtime", () => {
  it("returns a schema-valid read-only context and fixed resource projections", () => {
    const runtime = createAgentAccessRuntime({ pack: buildAgentStandardPack(rootDir) });
    const outcome = runtime.getContext({ profile_id: "runtime-caller", module_id: "cargo" });

    expect(runtime.available).toBe(true);
    expect(outcome.status).toBe("success");
    expect(() => agentContextDataSchema.parse(outcome.data)).not.toThrow();
    expect(runtime.readResource("logistics://modules/catalog").text).toContain("cargo");
    expect(runtime.readResource("logistics://agent/profiles").text).toContain("runtime-caller");
  });

  it("does not treat unknown profiles or a missing pack as success", () => {
    const runtime = createAgentAccessRuntime({ pack: buildAgentStandardPack(rootDir) });
    expect(runtime.getContext({ profile_id: "unknown-profile" }).status).toBe("blocked");
    const missing = createAgentAccessRuntime({ packPath: "/tmp/no-such-agent-standard-pack.json" });
    expect(missing.available).toBe(false);
    expect(missing.getContext({ profile_id: "runtime-caller" }).status).toBe("unavailable");
    expect(missing.readResource("logistics://agent/bootstrap").text).toContain("unavailable");
  });
});
