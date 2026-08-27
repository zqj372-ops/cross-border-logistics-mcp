import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runDeterministicSmokeCalls,
  runT0DeploymentSmoke,
} from "../../services/access-gateway/deployment-smoke";
import { calculateCargo } from "../../src/logistics_mcp/domains/cargo/service";
import { planContainerSummary } from "../../src/logistics_mcp/domains/container/service";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";

afterEach(() => {
  delete process.env.DEPLOYMENT_SMOKE_CONFIRM;
  delete process.env.DEPLOYMENT_SMOKE_ENVIRONMENT;
});

describe("T0 deployment smoke safety", () => {
  it("refuses synthetic writes unless staging is explicitly selected", async () => {
    process.env.DEPLOYMENT_SMOKE_CONFIRM = "run-synthetic-write";
    process.env.DEPLOYMENT_SMOKE_ENVIRONMENT = "production";
    await expect(runT0DeploymentSmoke()).rejects.toThrow(
      "DEPLOYMENT_SMOKE_ENVIRONMENT must equal staging.",
    );
  });

  it("calls both deterministic tools with representative inputs that really succeed", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const caller = {
      callTool: vi.fn((request: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(request);
        return Promise.resolve({ structuredContent: { status: "success" } });
      }),
    };
    await expect(runDeterministicSmokeCalls(caller)).resolves.toEqual([
      "cargo.calculate",
      "container.plan_summary",
    ]);
    expect(calls.map(({ name }) => name)).toEqual([
      "cargo.calculate",
      "container.plan_summary",
    ]);
    const cargo = calls[0];
    const container = calls[1];
    if (cargo === undefined || container === undefined) throw new Error("Smoke calls are missing.");
    const context = parseExecutionContext({
      tenant_id: "tenant_smoke",
      actor_id: "key_smoke",
      actor_role: "service",
      roles: ["service"],
      scopes: ["tool:cargo.calculate", "tool:container.plan_summary"],
      client_id: "deployment_smoke",
      session_id: "deployment_smoke_session",
      expires_at: 1_900_000_000,
    });
    expect(calculateCargo(cargo.arguments, context).status).toBe("success");
    expect(planContainerSummary(container.arguments).status).toBe("success");
  });
});
