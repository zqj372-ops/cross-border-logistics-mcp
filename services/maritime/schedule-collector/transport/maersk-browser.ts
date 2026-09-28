import { isAbsolute } from "node:path";
import { z } from "zod";
import { MaerskConditionsSchema, MaerskLocationSchema, MaerskRoutingResponseSchema, maerskGeoId, maerskLocationLabel } from "../carriers/maersk";
import { CollectorRuntimeError, throwIfAborted } from "../errors";
import type { CarrierBrowserPort, CarrierHttpResponse } from "../ports";
import { captureScheduleResponse, withScheduleBrowser, type ScheduleBrowserOptions } from "./public-browser";

const ROOT = "https://www.maersk.com", API = "https://api.maersk.com", ASSETS = "https://assets.maerskline.com";
const LOCATIONS = "/synergy/reference-data/geography/locations", ROUTINGS = "/routing-unified/routing/routings-queries";
const location = z.object({ id: z.string().regex(/^[A-Z0-9]{8,32}$/u), name: z.string().trim().min(2).max(100) }).strict();
const querySchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("locations"), text: z.string().trim().min(2).max(100) }).strict(),
  z.object({ operation: z.literal("schedules"), origin: location, destination: location, from: z.iso.date(), until: z.iso.date() }).strict()
    .refine(query => query.until >= query.from && Date.parse(query.until) - Date.parse(query.from) < 28 * 86_400_000),
]);

export function maerskBrowserRequestAllowed(value: string, method: string): boolean {
  try {
    const url = new URL(value), keys = [...url.searchParams.keys()];
    if (url.username || url.password || url.hash) return false;
    if (url.origin === API) {
      if (["POST", "OPTIONS"].includes(method) && [ROUTINGS, "/deadlines/queries", "/dqcs/"].includes(url.pathname)) return keys.length === 0;
      if (method !== "GET" && method !== "OPTIONS") return false;
      if (url.pathname === LOCATIONS) return keys.length === 4 && keys.every(key => ["cityName", "pageSize", "sort", "type"].includes(key)) && url.searchParams.get("pageSize") === "25" && url.searchParams.get("type") === "city" && url.searchParams.get("sort") === "cityName";
      if (url.pathname === "/synergy/reference-data/vehicle/vessels") return keys.length === 1 && keys[0] === "vesselCodes";
      return keys.length === 0 && /^\/synergy\/reference-data\/geography\/locations\/[A-Z0-9]{8,32}$/u.test(url.pathname);
    }
    if (method !== "GET") return false;
    if (url.origin === ASSETS && url.pathname === "/content/keys/query/3BD5E85C-2CBF-4B9A-83B5-B8FBBF1A5A6A/en.json") return keys.length === 2 && keys.every(key => ["version", "carrierCode"].includes(key)) && url.searchParams.get("version") === "v0" && /^[a-z]{2,10}$/u.test(url.searchParams.get("carrierCode") ?? "");
    if (keys.length !== 0) return false;
    if (url.origin === ROOT) return ["/schedules/pointToPoint", "/locales/en.json", "/-u9t7HDt4fZn4/T8/LliXSYO0fd4Y/EDDwrtN9Ozkac29QOw/HgAzLVlZ/fX/MQCyAINjU"].includes(url.pathname) ||
      /^\/schedules\/assets\/[A-Za-z0-9_@./-]+\.(?:js|css|woff2?)$/u.test(url.pathname) || /^\/static\/[a-f0-9]+(?:\/e\/[0-9_]+\.js)?$/u.test(url.pathname) || /^\/akam\/13\/[a-f0-9]+$/u.test(url.pathname);
    return url.origin === ASSETS && (url.pathname === "/mop-rum.esm.js" || /^\/(?:integrated-global-nav|sharedfonts)\/[A-Za-z0-9./_-]+\.(?:js|css|woff2?)$/u.test(url.pathname) || /^\/content\/keys\/query\/[A-F0-9-]+\/en\.json$/u.test(url.pathname));
  } catch { return false; }
}

function parseQuery(input: Parameters<CarrierBrowserPort["search"]>[0]): z.infer<typeof querySchema> {
  throwIfAborted(input.signal);
  const parsed = querySchema.safeParse(input.query);
  if (input.carrier !== "MAERSK" || !parsed.success) throw new CollectorRuntimeError("validation_error", "blocked", "maersk_browser_query_invalid");
  return parsed.data;
}

export function createMaerskBrowserPort(options: ScheduleBrowserOptions): CarrierBrowserPort {
  if (!isAbsolute(options.executablePath)) throw new Error("schedule_browser_executable_path_invalid");
  return { available: true, async search(input) {
    parseQuery(input);
    return withMaerskBrowserPort(options, port => port.search(input), input);
  } };
}

/** One CLI operation owns the page; no session survives this callback. */
export function withMaerskBrowserPort<T>(options: ScheduleBrowserOptions, run: (port: CarrierBrowserPort) => Promise<T>, input: { readonly signal?: AbortSignal }): Promise<T> {
  if (!isAbsolute(options.executablePath)) throw new Error("schedule_browser_executable_path_invalid");
  return withScheduleBrowser(options, ["www.maersk.com", "api.maersk.com", "assets.maerskline.com"], maerskBrowserRequestAllowed, async page => {
    // Keep the destination dropdown clear of the responsive form's overlay.
    await page.setViewportSize({ width: 1440, height: 1200 });
    const facilities = new Map<string, Promise<CarrierHttpResponse>>();
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.origin === API && /^\/synergy\/reference-data\/geography\/locations\/[A-Z0-9]{8,32}$/u.test(url.pathname)) {
        const pending = captureScheduleResponse(response); void pending.catch(() => undefined);
        facilities.set(url.pathname.split("/").at(-1)!, pending);
      }
    });
    let initialized = false;
    return run({ available: true, async search(input) {
        const query = parseQuery(input);
        if (!initialized) {
          // Wait for the actual form below; unrelated scripts need not finish first.
          const main = await page.goto(ROOT + "/schedules/pointToPoint", { waitUntil: "commit", timeout: 60_000 });
          if (main?.status() !== 200) throw new CollectorRuntimeError("access_restricted", "unavailable", `maersk_browser_http_${main?.status() ?? 0}`);
          initialized = true;
        }
        const lookup = async (field: "From" | "To", text: string): Promise<CarrierHttpResponse> => {
          const box = page.getByRole("combobox", { name: `${field} (City, Country/Region)`, exact: true });
          await box.waitFor({ state: "visible", timeout: 60_000 });
          const pending = page.waitForResponse(response => response.request().method() === "GET" && response.url().split("?")[0] === API + LOCATIONS && new URL(response.url()).searchParams.get("cityName")?.toLowerCase() === text.toLowerCase()).then(captureScheduleResponse);
          void pending.catch(() => undefined);
          await box.fill(""); await box.pressSequentially(text, { delay: 110 });
          return pending;
        };
        if (query.operation === "locations") return lookup("From", query.text);
        const selected = [];
        for (const [field, expected] of [["From", query.origin], ["To", query.destination]] as const) {
          const response = await lookup(field, expected.name);
          if (response.status !== 200) throw new CollectorRuntimeError("access_restricted", "unavailable", "maersk_location_source_unavailable");
          const candidates = z.array(MaerskLocationSchema).max(100).parse(JSON.parse(new TextDecoder().decode(response.body)));
          const matches = candidates.filter(item => item.maerskGeoLocationId === expected.id && item.hasMaerskContainerYard && item.type === "CITY");
          if (matches.length !== 1) throw new CollectorRuntimeError("ambiguous_location", "manual_review", "maersk_location_identity_changed");
          const candidate = matches[0]!, label = maerskLocationLabel(candidate);
          const box = page.getByRole("combobox", { name: `${field} (City, Country/Region)`, exact: true });
          if (await box.getAttribute("aria-expanded") !== "true") await box.press("ArrowDown");
          await page.getByRole("option", { name: `${label} CY`, exact: true }).click();
          if (await box.inputValue() !== label) throw new CollectorRuntimeError("ambiguous_location", "manual_review", "maersk_selected_location_mismatch");
          selected.push(candidate);
        }
        if (await page.getByRole("button", { name: /Switch to Store Door \(SD\)/u }).count() !== 2) throw new CollectorRuntimeError("unsupported_filter", "unavailable", "maersk_cy_cy_not_selected");
        await page.getByRole("combobox", { name: "Date", exact: true }).selectOption({ label: "Departing" });
        await page.getByRole("combobox", { name: "Container type", exact: true }).selectOption({ label: "40' Dry High" });
        await page.getByRole("textbox", { name: "Date", exact: true }).fill(query.from.split("-").reverse().join("/"));
        const pending = page.waitForResponse(response => response.url() === API + ROUTINGS && response.request().method() === "POST", { timeout: 60_000 });
        void pending.catch(() => undefined);
        await page.getByRole("button", { name: "Search", exact: true }).click();
        const response = await pending, raw = await captureScheduleResponse(response);
        if (response.status() !== 200) return raw;
        const body = MaerskRoutingResponseSchema.parse(JSON.parse(new TextDecoder().decode(raw.body)));
        const ids = [...new Set(body.routings.flatMap(row => row.routingLegs.flatMap(leg => [maerskGeoId(leg.carriage.vesselPortCallStart.location.facility), maerskGeoId(leg.carriage.vesselPortCallEnd.location.facility)])))];
        if (ids.length > 100) throw new CollectorRuntimeError("incomplete_results", "unavailable", "maersk_facility_limit");
        const sources = [];
        for (const id of ids) {
          const source = await (facilities.get(id) ?? page.waitForResponse(API + LOCATIONS + "/" + id).then(captureScheduleResponse));
          if (source.status !== 200) throw new CollectorRuntimeError("access_restricted", "unavailable", "maersk_facility_unavailable");
          sources.push(MaerskLocationSchema.parse(JSON.parse(new TextDecoder().decode(source.body))));
        }
        return { ...raw, body: new TextEncoder().encode(JSON.stringify({ routings: body.routings, facilities: sources, origin: selected[0], destination: selected[1], conditions: MaerskConditionsSchema.parse(response.request().postDataJSON()) })) };
    } });
  }, input);
}
