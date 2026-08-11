import { describe, expect, it } from "vitest";

import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  createFixtureComposition,
  createProductionComposition,
} from "../../src/logistics_mcp/server/composition";
import { quoteInput } from "./fixtures/tenant-fixtures";
import { securityClaims } from "./fixtures/security-fixtures";

describe("gateway composition modes", () => {
  it("keeps production adapters disabled until endpoint, tenant and readiness contracts are verified", async () => {
    const composition = createProductionComposition({
      dataMode: "production",
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => securityClaims,
    });
    try {
      expect(composition.dataMode).toBe("production");
      expect(composition.definitions).toHaveLength(9);
      expect(composition.adapters.quote).not.toBe(composition.adapters.status);

      const context = parseExecutionContext(securityClaims);
      const quoteHandler = composition.handlers["quote.canada_final_mile.calculate"];
      if (quoteHandler === undefined) throw new Error("quote handler was not registered");
      const quote = await quoteHandler(quoteInput(), context);
      expect(quote.status).toBe("unavailable");
      expect(quote.data).toBeNull();

      const customs = await composition.adapters.customs.getStatus({ fixture: "ignored" });
      expect(customs.status).toBe("unavailable");
      expect(JSON.stringify(customs)).toContain("customs.adapter_disabled");
    } finally {
      await composition.close();
    }
  });

  it("does not allow fixture adapters under a production data mode", () => {
    expect(() =>
      createFixtureComposition({
        dataMode: "production",
      } as never),
    ).toThrow("Fixture adapters require DATA_MODE=fixtures.");
  });

  it("keeps the default production HTTP entrypoint fail-closed without a verifier", async () => {
    let authenticateCalls = 0;
    const composition = createProductionComposition({
      dataMode: "production",
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      authenticate: () => {
        authenticateCalls += 1;
        return securityClaims;
      },
    });
    try {
      const response = await composition.handler(
        new Request("https://mcp.example.invalid/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer fake-production-token",
            origin: "https://client.example.invalid",
          host: "mcp.example.invalid",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "fixture-client", version: "1.0.0" },
            },
          }),
        }),
      );
      expect(response.status).toBe(503);
      expect((await response.json()) as { status: string }).toMatchObject({ status: "unavailable" });
      expect(authenticateCalls).toBe(0);
    } finally {
      await composition.close();
    }
  });
});
