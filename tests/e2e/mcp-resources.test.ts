import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildAgentStandardPack } from "../../src/logistics_mcp/agent-context/pack";
import { createAgentAccessRuntime } from "../../src/logistics_mcp/agent-context/runtime";
import {
  callTool,
  createFixtureHarness,
  initialize,
} from "./fixtures/tenant-fixtures";

const rootDir = resolve(import.meta.dirname, "../..");

describe("MCP Agent resources and context tool", () => {
  it("lists fixed resources and returns an allowlisted context projection", async () => {
    const harness = createFixtureHarness({
      agentAccessRuntime: createAgentAccessRuntime({ pack: buildAgentStandardPack(rootDir) }),
    });
    try {
      const sessionId = await initialize(harness);
      const listed = await harness.request({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/list",
        params: {},
      }, sessionId);
      const listBody = (await listed.json()) as {
        result?: { resources?: readonly { uri: string }[] };
      };
      expect(listBody.result?.resources?.map((resource) => resource.uri).sort()).toEqual([
        "logistics://agent/bootstrap",
        "logistics://agent/profiles",
        "logistics://contracts/envelope/current",
        "logistics://modules/catalog",
        "logistics://standards/index",
      ]);

      const read = await harness.request({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: "logistics://modules/catalog" },
      }, sessionId);
      const readBody = (await read.json()) as {
        result?: { contents?: readonly { text?: string }[] };
      };
      expect(readBody.result?.contents?.[0]?.text).toContain("cargo");

      const context = await callTool(harness, sessionId, "system.agent_context.get", {
        profile_id: "runtime-caller",
        module_id: "cargo",
      });
      expect(context.status).toBe("success");
      if (typeof context.data !== "object" || context.data === null) {
        throw new Error("agent context response did not contain a data object");
      }
      const contextData = context.data as Record<string, unknown>;
      expect(contextData.profile_id).toBe("runtime-caller");
      expect(contextData.selected_module_id).toBe("cargo");
    } finally {
      await harness.close();
    }
  });
});
