import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBusinessMachineHttpHandler, type BusinessMachineExecutionPort } from "../../services/access-gateway/portal/business-access/http";
import type { BusinessOperation } from "../../services/access-gateway/portal/business-access/contracts";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())); });

function rateInput() {
  return { details: {
    origin: { address: { address_line_1: "10 Origin Rd", city: "Toronto", region: "ON", country: "CA", postal_code: "M5V 2T6" } },
    destination: { address: { address_line_1: "20 Destination Ave", city: "Vancouver", region: "BC", country: "CA", postal_code: "V6B 1A1" }, ready_at: { hour: 9, minute: 0 }, ready_until: { hour: 16, minute: 0 }, signature_requirement: "not-required" },
    expected_ship_date: { year: 2026, month: 9, day: 8 }, packaging_type: "pallet",
    packaging_properties: { pallet_type: "ltl", has_stackable_pallets: false, pallets: [{ measurements: { weight: { unit: "lb", value: "500" }, cuboid: { unit: "in", l: "48", w: "40", h: "50" } }, description: "machine parts", freight_class: "70", num_pieces: 1 }], pallet_service_details: {} }, shipment_classification: "B2B",
  } };
}

type Authorization = (token: string, operation: BusinessOperation) => Promise<{ tenantId: string; clientId: string; applicationId: string; credentialId: string; operation: BusinessOperation }>;
async function start(authorize: Authorization, execute: BusinessMachineExecutionPort["execute"]) {
  const holder: { handler?: ReturnType<typeof createBusinessMachineHttpHandler> } = {};
  const server = createServer((request, response) => { if (!holder.handler?.handle(request, response)) { response.statusCode = 404; response.end(); } });
  servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  const host = `127.0.0.1:${address.port}`;
  holder.handler = createBusinessMachineHttpHandler({ mode: "fixtures", service: { repositoryKind: "synthetic", exchange: vi.fn(), authorize } as never, executor: { execute }, allowedHosts: [host], allowedOrigins: [], trustedProxyAddresses: [] });
  return `http://${host}`;
}

describe("Freightcom Business API v2", () => {
  it("requires the exact operation grant and preserves the closed Freightcom result", async () => {
    const authorize = vi.fn(() => Promise.resolve({ tenantId: "tenant-one", clientId: "client-one", applicationId: "app-one", credentialId: "key-one", operation: "quote.freightcom_ltl.preview" as const }));
    const execute = vi.fn<BusinessMachineExecutionPort["execute"]>((request) => Promise.resolve({ schema_version: "portal-freightcom-rate@2026-09-05.v1", status: "manual_review", data: { provider: "freightcom", rates: [] }, reason_codes: ["freightcom_no_rates_returned"], source_refs: [], request_id: request.requestId, saved: false, sendable: false, bookable: false }));
    const origin = await start(authorize, execute);
    const response = await fetch(`${origin}/api/v2/business/quote/freightcom-ltl-preview`, { method: "POST", headers: { authorization: "Bearer short-business-token", "content-type": "application/json" }, body: JSON.stringify({ schema_version: "business-call@2026-09-05.v1", input: rateInput() }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ schema_version: "portal-freightcom-rate@2026-09-05.v1", status: "manual_review", saved: false, sendable: false, bookable: false });
    expect(authorize).toHaveBeenCalledWith("short-business-token", "quote.freightcom_ltl.preview");
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ operation: "quote.freightcom_ltl.preview", batch: false, input: rateInput(), machine: { tenantId: "tenant-one", applicationId: "app-one" } });
  });

  it("rejects tenant injection and malformed provider input before authorization", async () => {
    const authorize = vi.fn(); const execute = vi.fn(); const origin = await start(authorize, execute);
    for (const input of [{ ...rateInput(), tenant_id: "tenant-attacker" }, { details: { origin: {} } }]) {
      const response = await fetch(`${origin}/api/v2/business/quote/freightcom-ltl-preview`, { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ schema_version: "business-call@2026-09-05.v1", input }) });
      expect(response.status).toBe(400);
    }
    expect(authorize).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
});
