import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, jwtVerify } from "jose";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { BUSINESS_MCP_TOOLS, type ApplicationMcpTool, type BusinessMcpTool } from "../../src/logistics_mcp/platform/application-tools";
import { createProductionComposition } from "../../src/logistics_mcp/server/composition";
import { createBusinessRuntimeProvider } from "../../src/logistics_mcp/server/business-provider";
import { SqliteProductionStore } from "../../src/logistics_mcp/platform/sqlite-production-store";
import { SyntheticJwtSigner } from "../../services/access-gateway/synthetic";
import { ApplicationMcpAccessService } from "../../services/access-gateway/portal/business-access/mcp";

const inputs: Record<BusinessMcpTool, Record<string, unknown>> = {
  "customs.query": { query: "synthetic private item", ruleDate: "2026-09-05", attributes: { originCountry: "CN" } },
  "customs.tax.estimate": { lineId: "line_fixture", ruleDate: "2026-09-05" },
  "quote.ai_extract_preview": { customer_message: "synthetic private item" },
  "quote.zone_preview": { postal_code: "M5V 2T6", cbm: "1", weight_kg: "100", piece_count: 1, packaging_type: "pallet",
    address_type: "commercial", requires_liftgate: false, requires_pallet_jack: false, requires_appointment: false,
    explicit_pallet_count: 1, is_stackable: false, detention_minutes: 0 },
  "quote.freightcom_ltl.preview": { services: ["service-ltl-1"], details: {
    origin: { address: { address_line_1: "10 Fixture Rd", city: "Toronto", region: "ON", country: "CA", postal_code: "M5V 2T6" }, residential: false, tailgate_required: false },
    destination: { address: { address_line_1: "20 Fixture Rd", city: "Vancouver", region: "BC", country: "CA", postal_code: "V6B 1A1" }, residential: false, tailgate_required: false,
      ready_at: { hour: 9, minute: 0 }, ready_until: { hour: 16, minute: 0 }, signature_requirement: "not-required" },
    expected_ship_date: { year: 2026, month: 9, day: 8 }, packaging_type: "pallet", shipment_classification: "B2B",
    packaging_properties: { pallet_type: "ltl", has_stackable_pallets: false, pallets: [{ measurements: { weight: { unit: "lb", value: "500" }, cuboid: { unit: "in", l: "48", w: "40", h: "50" } }, description: "fixture", freight_class: "70", num_pieces: 1 }], pallet_service_details: { appointment_delivery: true, protect_from_freeze: true } },
  } },
};

it("executes all five business tools through production composition, preserves unavailable sources, persists redacted audit and observes revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "business-mcp-e2e-"));
  const store = new SqliteProductionStore(join(root, "runtime.sqlite"));
  const signer = new SyntheticJwtSigner();
  const jwks = createLocalJWKSet({ keys: (await signer.getJwks()).keys.map(key => ({ ...key })) });
  const verifier = { verify: async (token: string) => (await jwtVerify(token, jwks, { algorithms: ["RS256"], issuer: "https://issuer.example.invalid/", audience: "mcp" })).payload };
  let active = true, executions = 0;
  const current = (tools: readonly ApplicationMcpTool[]) => {
    if (!active) throw new Error("revoked");
    return { tenantId: "tenant_fixture", clientId: "client_fixture", applicationId: "app_fixture", credentialId: "bkey_0123456789abcdef01234567", toolNames: [...tools] };
  };
  const access = new ApplicationMcpAccessService({ signer, verifier, issuer: "https://issuer.example.invalid/", audience: "mcp", limiter: { reserve: () => Promise.resolve(true) },
    authority: { authorizeMcpApiKey: (_key, tools) => Promise.resolve(current(tools)), authorizeMcpCredential: input => Promise.resolve(current(input.requestedToolNames)) } });
  const token = (await access.exchange("synthetic-api-key", { schema_version: "application-mcp-exchange@2026-09-06.v1", requested_tool_names: BUSINESS_MCP_TOOLS }, "127.0.0.1")).data.access_token;
  const provider = createBusinessRuntimeProvider({ baseUrl: "https://provider.example.invalid/", allowedHosts: ["provider.example.invalid"], runtimeSecret: "s".repeat(48), fetchImpl: async (_resource, init) => {
    expect(new Headers(init?.headers).get("x-freightclaw-runtime-token")).toBe("s".repeat(48));
    const bearer = new Headers(init?.headers).get("authorization")!.slice(7);
    expect(bearer).toBe(token);
    await access.verify(bearer);
    executions++;
    return Response.json({ schema_version: "portal-business@2026-09-05.v1", status: "unavailable", data: null, reason_codes: ["synthetic_source_unready"] });
  } });
  let enabled=true,notifications=0;const listeners=new Set<()=>void>();
  const managed={catalogDefinitions:provider.definitions,get definitions(){return enabled?provider.definitions:[];},subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};}};
  const composition = createProductionComposition({ dataMode: "production", profile: "business-v1", businessProvider: managed,
    auditRepository: store, idempotencyRepository: store, sessionBindingStore: store, sessionOwnerId: "instance_fixture",
    allowedHosts: ["runtime.example.invalid"], allowedOrigins: ["https://client.example.invalid"],
    tokenPolicy: { issuer: "https://issuer.example.invalid/", audience: "mcp", maxLifetimeSeconds: 300 },
    tokenVerifier: { kind: "token_verifier", verify: async value => { await access.verify(value); return verifier.verify(value); }, health: () => Promise.resolve({ ready: true }), close: () => Promise.resolve() },
  });
  const client = new Client({ name: "business-mcp-regression", version: "1" });
  client.setNotificationHandler(ToolListChangedNotificationSchema,()=>{notifications++;});
  const transport = new StreamableHTTPClientTransport(new URL("https://runtime.example.invalid/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: (resource, init) => {
      const headers = new Headers(init?.headers); headers.set("host", "runtime.example.invalid"); headers.set("origin", "https://client.example.invalid");
      return composition.handler(new Request(resource, { ...init, headers }));
    },
  });
  try {
    expect(composition.definitions).toHaveLength(8);
    expect(await composition.readiness()).toEqual({ ready: true, reasons: [] });
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([...BUSINESS_MCP_TOOLS].sort());
    for (const name of BUSINESS_MCP_TOOLS) {
      const result = await client.callTool({ name, arguments: inputs[name] });
      expect(result.structuredContent, JSON.stringify(result.structuredContent)).toMatchObject({ status: "unavailable", data: { operation: name, result: { reason_codes: ["synthetic_source_unready"] } } });
    }
    expect(executions).toBe(5);
    const audit = await store.list();
    expect(audit.filter(item => BUSINESS_MCP_TOOLS.includes(item.tool as BusinessMcpTool))).toHaveLength(5);
    expect(JSON.stringify(audit)).not.toContain("synthetic private item");
    expect(JSON.stringify(audit)).not.toContain(token);
    enabled=false;for(const listener of listeners)listener();
    expect((await client.listTools()).tools).toHaveLength(0);
    await vi.waitFor(()=>expect(notifications).toBeGreaterThan(0),{timeout:2000});
    enabled=true;for(const listener of listeners)listener();
    expect((await client.listTools()).tools).toHaveLength(5);
    active = false;
    await expect(client.callTool({ name: "customs.query", arguments: inputs["customs.query"] })).rejects.toThrow();
    expect(executions).toBe(5);
  } finally {
    await client.close();
    await composition.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
