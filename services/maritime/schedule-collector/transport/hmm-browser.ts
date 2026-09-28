import { isAbsolute } from "node:path";
import { z } from "zod";
import { CollectorRuntimeError, throwIfAborted } from "../errors";
import type { CarrierBrowserPort, CarrierHttpResponse } from "../ports";
import { captureScheduleResponse, withScheduleBrowser, type ScheduleBrowserOptions } from "./public-browser";

const ROOT = "https://www.hmm21.com";
const MAIN = "/e-service/general/schedule/ScheduleMain.do";
const CITIES = "/data_files/ebiz/locationJS/CitiesList.js";
const SELECT = "/e-service/general/schedule/selectPointToPointList.do";
const MOMENT = "https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.29.1/moment.min.js";
const Query = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("locations") }).strict(),
  z.object({
    operation: z.literal("schedules"),
    origin_id: z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}$/u),
    destination_id: z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}$/u),
    from: z.iso.date(), until: z.iso.date(),
  }).strict().refine(q => q.until >= q.from && Date.parse(q.until) - Date.parse(q.from) < 28 * 86_400_000),
]);

export function hmmBrowserRequestAllowed(value: string, method: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (value === MOMENT) return method === "GET";
    if (url.origin !== ROOT) return false;
    if (method === "GET") return [MAIN, CITIES].includes(url.pathname) ||
      /^\/(?:js|css)\/[A-Za-z0-9_./-]+\.(?:js|css)$/u.test(url.pathname);
    return method === "POST" && [SELECT,
      "/e-service/general/schedule/apiPointToPointList.do",
      "/e-service/general/schedule/selectLoadCallingPort.do",
    ].includes(url.pathname);
  } catch { return false; }
}

/** One query owns its anonymous sessions; no caller-supplied URLs, cookies or profiles. */
export function createHmmBrowserPort(options: ScheduleBrowserOptions): CarrierBrowserPort {
  if (!isAbsolute(options.executablePath)) throw new Error("schedule_browser_executable_path_invalid");
  let cities: CarrierHttpResponse | undefined;
  return {
    available: true,
    async search(input) {
      throwIfAborted(input.signal);
      const parsed = Query.safeParse(input.query);
      if (input.carrier !== "HMM" || !parsed.success) throw new CollectorRuntimeError("validation_error", "blocked", "hmm_browser_query_invalid");
      const query = parsed.data;
      if (query.operation === "locations" && cities) return cities;
      return withScheduleBrowser(options, ["www.hmm21.com", "cdnjs.cloudflare.com"], hmmBrowserRequestAllowed, async page => {
        // Attach a rejection handler immediately: failed navigation must not leave an unhandled waiter.
        const locationResponse = page.waitForResponse(ROOT + CITIES).then(captureScheduleResponse);
        void locationResponse.catch(() => undefined);
        const main = await page.goto(ROOT + MAIN, { waitUntil: "domcontentloaded" });
        if (main?.status() === 403 || main?.status() === 401 || /Access Denied/iu.test(await page.title())) {
          throw new CollectorRuntimeError("access_restricted", "unavailable", "hmm_browser_access_restricted");
        }
        if (await page.locator('iframe[src*="hcaptcha"], iframe[src*="recaptcha"]').count()) {
          throw new CollectorRuntimeError("access_restricted", "unavailable", "hmm_browser_challenge_required");
        }
        cities = await locationResponse;
        if (query.operation === "locations") return cities;
        for (const [selector, id] of [["#srchPointFrom", query.origin_id], ["#srchPointTo", query.destination_id]] as const) {
          await page.locator(selector).fill("");
          await page.locator(selector).pressSequentially(id);
          await page.locator("li:visible").filter({ hasText: new RegExp(`\\[${id}\\]`, "u") }).click();
        }
        await page.locator("#srchCityFrom").selectOption({ label: "CY" });
        await page.locator("#srchCityTo").selectOption({ label: "CY" });
        await page.locator("#srchSailDate").fill(query.from);
        const days = (Date.parse(query.until) - Date.parse(query.from)) / 86_400_000 + 1;
        await page.locator("#srchSelWeeks").selectOption({ label: `${Math.max(2, Math.ceil(days / 7))} weeks` });
        await page.locator("#srchSelPriority").selectOption({ label: "All" });
        const result = page.waitForResponse(ROOT + SELECT, { timeout: 60_000 }).then(captureScheduleResponse);
        void result.catch(() => undefined);
        await page.locator("#btnRetrieve").click();
        const response = await result;
        return response;
      }, input);
    },
  };
}
