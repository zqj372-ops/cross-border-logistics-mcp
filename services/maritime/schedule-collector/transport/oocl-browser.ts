import { isAbsolute } from "node:path";
import { z } from "zod";
import { parseOoclLocations } from "../carriers/oocl";
import { CollectorRuntimeError, throwIfAborted } from "../errors";
import type { CarrierBrowserPort } from "../ports";
import { captureScheduleResponse, withScheduleBrowser, type ScheduleBrowserOptions } from "./public-browser";

const ROOT = "https://moc.oocl.com";
const BASE = "/nj_prs_wss/";
const CITIES = BASE + "mocss/secured/supportData/gsp/cityAutoComplete";
const RESULT = BASE + "mocss/secured/supportData/nsso/searchHubToHubRoute";
const Location = z.object({ id: z.string().regex(/^\d{1,20}$/u), name: z.string().min(1).max(200) }).strict();
const Query = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("locations"), text: z.string().min(2).max(100) }).strict(),
  z.object({ operation: z.literal("schedules"), origin: Location, destination: Location, from: z.iso.date(), until: z.iso.date() }).strict()
    .refine(q => q.until >= q.from && Date.parse(q.until) - Date.parse(q.from) < 28 * 86_400_000),
]);

export function ooclBrowserRequestAllowed(value: string, method: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    const keys = [...url.searchParams.keys()];
    if (url.origin === ROOT) {
      if (url.pathname === RESULT) return method === "POST" && keys.length === 0;
      if (method !== "GET") return false;
      if (url.pathname === CITIES) return keys.length === 2 && keys.includes("userQuery") && keys.includes("bound");
      return keys.length === 0 && ([BASE, BASE + "captchaConfig"].includes(url.pathname) ||
        /^\/nj_prs_wss\/(?:common|bower_components|client\/sailing_schedules|client\/map)\/[A-Za-z0-9_./-]+\.(?:js|css|json|html)$/u.test(url.pathname));
    }
    if (url.origin !== "https://cs-captcha-public.cargosmart.com" || method !== "GET") return false;
    if (url.pathname === "/captcha/public/getCustomer") return keys.length === 1 && keys[0] === "appKey";
    if (url.pathname === "/captcha/public/get") return keys.length === 3 && keys.every(key => ["appKey", "captchaType", "sessionKey"].includes(key));
    return keys.length === 0 && ["/captcha/public/js/cs_captcha.js", "/captcha/public/js/crypto-js.js", "/captcha/public/js/block-puzzle.js", "/captcha/public/css/block-puzzle.css"].includes(url.pathname);
  } catch { return false; }
}

export function createOoclBrowserPort(options: ScheduleBrowserOptions): CarrierBrowserPort {
  if (!isAbsolute(options.executablePath)) throw new Error("schedule_browser_executable_path_invalid");
  return {
    available: true,
    async search(input) {
      throwIfAborted(input.signal);
      const parsed = Query.safeParse(input.query);
      if (input.carrier !== "OOCL" || !parsed.success) throw new CollectorRuntimeError("validation_error", "blocked", "oocl_browser_query_invalid");
      const query = parsed.data;
      return withScheduleBrowser(options, ["moc.oocl.com", "cs-captcha-public.cargosmart.com"], ooclBrowserRequestAllowed, async page => {
        const main = await page.goto(ROOT + BASE + "#/sailing_schedules/search?PREFER_LANGUAGE=en-US", { waitUntil: "domcontentloaded" });
        if (main?.status() !== 200) throw new CollectorRuntimeError("access_restricted", "unavailable", `oocl_browser_http_${main?.status() ?? 0}`);
        const lookup = async (field: "origin" | "destination", text: string) => {
          const result = page.waitForResponse(response => response.url().split("?")[0] === ROOT + CITIES).then(captureScheduleResponse);
          void result.catch(() => undefined);
          await page.locator(`input[name="${field}"]`).fill(text);
          return result;
        };
        if (query.operation === "locations") return lookup("origin", query.text);
        for (const field of ["origin", "destination"] as const) {
          const expected = query[field];
          const result = await lookup(field, expected.name.split(",")[0]!);
          const candidates = parseOoclLocations(JSON.parse(new TextDecoder().decode(result.body)) as unknown);
          if (!candidates.some(candidate => candidate.carrier_location_id === expected.id && candidate.name === expected.name)) {
            throw new CollectorRuntimeError("ambiguous_location", "manual_review", "oocl_location_identity_changed");
          }
          const escaped = expected.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
          await page.getByRole("option").filter({ hasText: new RegExp(`^${escaped} (?:CY|Door)`, "u") }).click();
        }
        await page.getByRole("textbox").nth(2).fill(query.from);
        await page.getByRole("combobox").selectOption({ label: String(Math.max(2, Math.ceil(((Date.parse(query.until) - Date.parse(query.from)) / 86_400_000 + 1) / 7))) });
        const result = page.waitForResponse(ROOT + RESULT, { timeout: 60_000 }).then(captureScheduleResponse);
        void result.catch(() => undefined);
        await page.getByRole("button", { name: "Search", exact: true }).click();
        // Only the site's automatic public flow is used. There is no puzzle solver,
        // token import, authenticated profile, or retry through another identity.
        return result;
      }, input);
    },
  };
}
