import { expect, it, vi } from "vitest";
import { parseMaerskLocations, parseMaerskSchedules } from "../../../../services/maritime/schedule-collector/carriers/maersk";
import { createMaerskBrowserPort, maerskBrowserRequestAllowed, withMaerskBrowserPort } from "../../../../services/maritime/schedule-collector/transport/maersk-browser";
import * as browserTransport from "../../../../services/maritime/schedule-collector/transport/public-browser";
import type { Page } from "playwright-core";
import { ScheduleRecordSchema } from "../../../../services/maritime/schedule-collector/contracts";
import type { CarrierParserContext } from "../../../../services/maritime/schedule-collector/carriers/types";

// Synthetic source shapes, not copied carrier or customer data.
const city = (name: string, country: string, id: string, code: string) => ({ cityName: name, countryName: country, countryCode: country, regionName: "Fixture", maerskGeoLocationId: id, maerskRkstCode: code, unLocCode: code, hasMaerskContainerYard: true, type: "CITY" });
const origin = city("Fixture Origin", "CN", "ORIGIN0000001", "CNAAA");
const destination = city("Fixture Destination", "CA", "DESTIN0000001", "CAAAA");
const facility = (source: typeof origin, id: string) => ({ ...source, maerskGeoLocationId: id, maerskRkstCode: source.unLocCode + "T1", type: "TERMINAL", localityName: source.cityName + " Terminal", timezoneId: source.countryCode === "CN" ? "Asia/Shanghai" : "America/Vancouver" });
const facilities = [facility(origin, "ORGFAC0000001"), facility(destination, "DSTFAC0000001")];
const resolved = (source: typeof origin) => ({ ...parseMaerskLocations([source])[0]!, input_text: source.cityName });
const context = (): CarrierParserContext => ({ requestId: "synthetic", evidenceRef: "evidence:synthetic", observedAt: "2026-09-27T00:00:00Z", origin: resolved(origin), destination: resolved(destination), normalizedQuery: { carrier: "MAERSK", query_origin: resolved(origin), query_destination: resolved(destination), departure_from: "2026-09-28", departure_until: "2026-10-25", date_filter_basis: "departure_from_first_ocean_leg", routing_filter: "any" } });
const location = (alternativeCode: string) => ({ dataObject: "CITY", alternativeCodes: [{ alternativeCodeType: "GEO_ID", alternativeCode }], cityCode: "" });
const call = (source: typeof facilities[number], departure: boolean) => ({ location: { facility: { alternativeCodes: location(source.maerskGeoLocationId).alternativeCodes, facilityCode: source.maerskRkstCode } }, departureVoyageNumber: "001E", arrivalVoyageNumber: "001E", departureService: { serviceName: "FIXTURE" }, estimatedTimeOfDeparture: departure ? "2026-10-01T08:00:00" : "2026-10-17T10:00:00", estimatedTimeOfArrival: departure ? "2026-09-30T08:00:00" : "2026-10-16T09:00:00" });
const row = () => ({ routeId: "fixture-route", estimatedTransitTime: "P15DT17H", routingLegs: [{ routingLegIdentifier: "fixture-leg", transportMode: { transportModeCode: "MVS" }, carriage: { carriageType: "OCEAN", vessel: { vesselName: "SYNTHETIC VESSEL" }, vesselPortCallStart: call(facilities[0]!, true), vesselPortCallEnd: call(facilities[1]!, false) } }] });
const bundle = () => ({ origin, destination, facilities, conditions: { requestType: "DATED_SCHEDULES", exportServiceType: "CY", importServiceType: "CY", timeRange: { routingsBasedOn: "DEPARTURE_DATE", earliestTime: "2026-09-28", latestTime: "2026-10-26" }, startLocation: location(origin.maerskGeoLocationId), endLocation: location(destination.maerskGeoLocationId) }, routings: [row()] });

it("reuses one anonymous page for location lookups within a bounded CLI operation", async () => {
  const goto = vi.fn(() => Promise.resolve({ status: () => 200 }));
  const page = { setViewportSize() {}, on() {}, goto,
    getByRole: () => ({ waitFor() {}, fill() {}, pressSequentially() {} }),
    waitForResponse: () => Promise.resolve({ status: () => 200, url: () => "https://api.maersk.com/synergy/reference-data/geography/locations", headers: () => ({ "content-type": "application/json" }), body: () => Promise.resolve(Buffer.from(JSON.stringify([origin]))) }),
  } as unknown as Page;
  const session = vi.spyOn(browserTransport, "withScheduleBrowser").mockImplementation(async (_options, _hosts, _allowed, run) => run(page));
  try {
    await withMaerskBrowserPort({ executablePath: "/fixture/browser" }, async port => {
      await port.search({ carrier: "MAERSK", query: { operation: "locations", text: "Fixture Origin" } });
      await port.search({ carrier: "MAERSK", query: { operation: "locations", text: "Fixture Destination" } });
    }, {});
    expect(session).toHaveBeenCalledOnce();
    expect(goto).toHaveBeenCalledOnce();
  } finally { session.mockRestore(); }
});

it("retains official geographic IDs and distinct departures that share a route ID", () => {
  expect(parseMaerskLocations([origin, { ...destination, hasMaerskContainerYard: false }])).toHaveLength(1);
  expect(resolved(origin)).toMatchObject({ carrier_location_id: "ORIGIN0000001", unlocode: "CNAAA" });
  const data = bundle();
  const next = row(); next.routingLegs[0]!.carriage.vesselPortCallStart.estimatedTimeOfDeparture = "2026-10-08T08:00:00";
  data.routings.push(next);
  const parsed = parseMaerskSchedules(data, context());
  const first = ScheduleRecordSchema.parse(parsed.records[0]);
  expect(new Set(parsed.records.map(record => record.record_id)).size).toBe(2);
  expect(first.operating_carrier).toBeNull();
  expect(first.legs[0]?.events[0]).toMatchObject({ local_datetime: "2026-10-01T08:00:00", timezone: "Asia/Shanghai", utc_datetime: null });
  expect(first.legs[0]?.events[1]?.timezone).toBe("America/Vancouver");
  expect(first.transit.source_total_minutes).toBe("22620");
  expect(first.cutoffs.si).toBeNull();
  expect(parsed.quality.warnings).toContain("maersk_deadlines_not_collected");
});

it("rejects incomplete source identity, dates and unsupported legs without manufacturing ports", () => {
  for (const mutate of [
    (data: ReturnType<typeof bundle>) => { data.facilities = []; },
    (data: ReturnType<typeof bundle>) => { data.conditions.endLocation = location("WRONG00000001"); },
    (data: ReturnType<typeof bundle>) => { data.conditions.timeRange.latestTime = "2026-10-02"; },
    (data: ReturnType<typeof bundle>) => { data.routings[0]!.routingLegs[0]!.carriage.vesselPortCallStart.estimatedTimeOfDeparture = "2026-02-30T12:00:00"; },
    (data: ReturnType<typeof bundle>) => { data.routings[0]!.routingLegs[0]!.transportMode.transportModeCode = "TRUCK"; },
  ]) { const data = bundle(); mutate(data); expect(() => parseMaerskSchedules(data, context())).toThrow(); }
  const mismatch = bundle(); mismatch.facilities = [{ ...facilities[0]!, unLocCode: "CNBBB" }, facilities[1]!];
  expect(parseMaerskSchedules(mismatch, context()).quality.key_fields_complete).toBe(false);
});

it("limits the browser to observed public schedule requests and rejects invalid input before launch", async () => {
  const root = "https://api.maersk.com";
  const translations = "https://assets.maerskline.com/content/keys/query/3BD5E85C-2CBF-4B9A-83B5-B8FBBF1A5A6A/en.json?version=v0&carrierCode=maeu";
  expect(maerskBrowserRequestAllowed(translations, "GET")).toBe(true);
  expect(maerskBrowserRequestAllowed(translations + "&url=https://127.0.0.1", "GET")).toBe(false);
  expect(maerskBrowserRequestAllowed(root + "/synergy/reference-data/geography/locations?cityName=Fixture&pageSize=25&sort=cityName&type=city", "GET")).toBe(true);
  expect(maerskBrowserRequestAllowed(root + "/synergy/reference-data/geography/locations?cityName=Fixture&pageSize=25&sort=cityName&type=city", "OPTIONS")).toBe(true);
  expect(maerskBrowserRequestAllowed(root + "/routing-unified/routing/routings-queries", "POST")).toBe(true);
  for (const url of [root + "/booking", root + "/synergy/reference-data/geography/locations?redirect=https://127.0.0.1", "https://api.maersk.com.evil.invalid/routing-unified/routing/routings-queries", "https://user:secret@api.maersk.com/routing-unified/routing/routings-queries"]) expect(maerskBrowserRequestAllowed(url, "POST")).toBe(false);
  const port = createMaerskBrowserPort({ executablePath: "/fixture/browser" });
  await expect(port.search({ carrier: "MAERSK", query: { operation: "locations", text: "Fixture", url: "https://127.0.0.1" } })).rejects.toMatchObject({ code: "validation_error" });
  const controller = new AbortController(); controller.abort();
  await expect(port.search({ carrier: "MAERSK", query: { operation: "locations", text: "Fixture" }, signal: controller.signal })).rejects.toMatchObject({ code: "timeout" });
});
