import { describe, expect, it } from "vitest";

import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  HandlerUnavailableError,
  executeRegisteredTool,
} from "../../src/logistics_mcp/server/tool-registry";
import {
  phaseOneToolNames,
  registerPhaseOneTools,
} from "../../src/logistics_mcp/server/tool-registry";

const context = parseExecutionContext({
  tenant_id: "tenant_demo",
  actor_id: "actor_sales",
  actor_role: "sales",
  roles: ["sales"],
  scopes: ["quote:calculate"],
  client_id: "client_demo",
  session_id: "session_demo",
  expires_at: Math.floor(Date.now() / 1000) + 300,
});

describe("Phase 1 tool registry", () => {
  it("registers exactly the nine baseline tools", () => {
    expect(phaseOneToolNames).toEqual([
      "knowledge.search_curated",
      "system.get_data_status",
      "cargo.calculate",
      "container.plan_summary",
      "quote.canada_final_mile.calculate",
      "customs.ca.search",
      "customs.ca.estimate",
      "quote.save_draft",
      "review.create_task",
    ]);
    expect(registerPhaseOneTools().map((tool) => tool.name)).toEqual(
      phaseOneToolNames,
    );
  });

  it("describes an input/output schema and permission for every tool", () => {
    for (const tool of registerPhaseOneTools()) {
      expect(tool.inputSchemaId).toMatch(/2026-08-11\.v1/);
      expect(tool.outputSchemaId).toMatch(/schema\.json$/);
      expect(tool.permission).toMatch(/:/);
      expect(["read", "write"]).toContain(tool.kind);
    }
  });

  it("does not register generic or forbidden write capabilities", () => {
    const forbidden = [
      "commit_operation",
      "send_quote",
      "publish",
      "booking.submit",
      "rules.write",
    ];

    expect(
      registerPhaseOneTools().some((tool) =>
        forbidden.some((name) => tool.name.includes(name)),
      ),
    ).toBe(false);
  });

  it("fails closed when a domain handler has not been provided", async () => {
    const tool = registerPhaseOneTools().find(
      (candidate) => candidate.name === "cargo.calculate",
    );

    expect(tool).toBeDefined();
    await expect(
      executeRegisteredTool(tool!, {}, context, {
        requestId: "req_tool_001",
        auditId: "audit_tool_001",
      }),
    ).rejects.toThrow(HandlerUnavailableError);
  });
});
