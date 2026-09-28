import { expect, it } from "vitest";
import { parseYmlLocations, parseYmlSchedules, createYmlAdapter } from "../../../../services/maritime/schedule-collector/carriers/yml";
import { ScheduleRecordSchema } from "../../../../services/maritime/schedule-collector/contracts";
import type { CarrierParserContext } from "../../../../services/maritime/schedule-collector/carriers/types";
import { InMemoryEvidenceStore } from "../../../../services/maritime/schedule-collector/evidence";

const origin = { input_text: "Shanghai", name: "SHANGHAI", country_code: "CN", type: "city" as const, carrier_location_id: "CNSHA", mapping_source: "synthetic@1", source_full_name: "SHANGHAI (CNSHA)", unlocode: "CNSHA" };
const destination = { ...origin, input_text: "Vancouver", name: "VANCOUVER", country_code: "CA", carrier_location_id: "CAVAN", unlocode: "CAVAN" };
const context: CarrierParserContext = { requestId: "synthetic", evidenceRef: "evidence:synthetic", observedAt: "2026-09-27T00:00:00Z", origin, destination, normalizedQuery: { carrier: "YML", query_origin: origin, query_destination: destination, departure_from: "2026-09-28", departure_until: "2026-10-25", date_filter_basis: "departure_from_first_ocean_leg", routing_filter: "any" } };
const leg = { detailSeq: 1, locationCodeFrom: "CNSHA", locationCodeTo: "CAVAN", locationNameFrom: "SHANGHAI", locationNameTo: "VANCOUVER", terminalNameFrom: "SYNTHETIC ORIGIN TERMINAL", terminalNameTo: "SYNTHETIC DESTINATION TERMINAL", serviceCode: "TEST", vesselName: "SYNTHETIC VESSEL", comnVoyage: "001E", transitMode: "VESSEL", etd: "2026/10/01", eta: "2026/10/16" };
const row = { masterSeq: 1, placeOfReceiptCode: "CNSHA", placeOfDeliveryCode: "CAVAN", masterETD: leg.etd, masterETA: leg.eta, transitDays: 14, transshipment: null, routeDetails: [leg], cutoffCY: "2026/09/28 12:00", cutoffSI: "Contact local office", cutoffVGM: "Contact local office", maintenanceInfo: null, blockStatus: null };

it("reads the current Yang Ming format without inventing time, operator or transit arithmetic", () => {
  expect(parseYmlLocations([{ locationCode: "CNSHA", locationName: "SHANGHAI, SH (CNSHA)" }])[0]).toMatchObject({ carrier_location_id: "CNSHA", country_code: "CN" });
  const result = parseYmlSchedules([row], context);
  const record = ScheduleRecordSchema.parse(result.records[0]);
  expect(result.quality.key_fields_complete).toBe(true);
  expect(record.transit.source_total_days).toBe("14");
  expect(record.legs[0]?.events[0]).toMatchObject({ local_date: "2026-10-01", local_datetime: null, utc_datetime: null });
  expect(record.operating_carrier).toBeNull();
  expect(record.cutoffs.si).toMatchObject({ at: null, precision: "unknown", source_text: "Contact local office" });
});

it("rejects changed or restricted responses and marks disconnected itineraries for review", async () => {
  expect(() => parseYmlSchedules({ error: "denied" }, context)).toThrow();
  expect(() => parseYmlSchedules([{ ...row, blockStatus: "blocked" }], context)).toThrow();
  expect(() => parseYmlSchedules([{ ...row, routeDetails: [{ ...leg, etd: "2026/02/30" }] }], context)).toThrow();
  const disconnected = { ...row, routeDetails: [leg, { ...leg, detailSeq: 2, locationCodeFrom: "KRPUS" }] };
  expect(parseYmlSchedules([disconnected], context).quality.key_fields_complete).toBe(false);
  await expect(createYmlAdapter().query(context, { request() { return Promise.resolve({ status: 403, url: "https://www.yangming.com/api/P2P/GetP2PRoutes", contentType: "text/html", headers: {}, body: new TextEncoder().encode("Security Check") }); } }, new InMemoryEvidenceStore())).rejects.toMatchObject({ code: "access_restricted" });
});
