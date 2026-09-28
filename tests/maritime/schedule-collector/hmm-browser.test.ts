import { describe, expect, it, vi } from "vitest";
import { createHmmBrowserPort, hmmBrowserRequestAllowed } from "../../../services/maritime/schedule-collector/transport/hmm-browser";
import { createOoclBrowserPort, ooclBrowserRequestAllowed } from "../../../services/maritime/schedule-collector/transport/oocl-browser";
import { openBrowserTunnel } from "../../../services/maritime/schedule-collector/transport/browser-tunnel";
import { createServer, request } from "node:http";
import { chromium, type Route } from "playwright-core";
import * as connector from "../../../services/maritime/schedule-collector/transport/node-connector";
import { withScheduleBrowser } from "../../../services/maritime/schedule-collector/transport/public-browser";

describe("HMM public browser boundary", () => {
  it("blocks disallowed large telemetry without aborting the permitted query, while bounding allowed bodies", async () => {
    let guard: (route: Route) => Promise<void> = () => Promise.resolve();
    const page = { setDefaultTimeout() {}, on() {} };
    const browser = { close: vi.fn(() => Promise.resolve()), newContext: () => Promise.resolve({
      route: (_pattern: string, handler: typeof guard) => { guard = handler; },
      routeWebSocket() {}, newPage: () => Promise.resolve(page),
      newCDPSession: () => Promise.resolve({ send() {}, on() {} }),
    }) };
    const launch = vi.spyOn(chromium, "launch").mockResolvedValue(browser as never);
    const dns = vi.spyOn(connector, "resolvePublicAddress").mockResolvedValue({ address: "8.8.8.8", family: 4 });
    const run = async (url: string) => withScheduleBrowser({ executablePath: "/fixture/browser" },
      ["fixture.example.invalid"], value => value.endsWith("/query"), async () => {
        const abort = vi.fn(() => Promise.resolve()), proceed = vi.fn(() => Promise.resolve());
        await guard({ request: () => ({ url: () => url, method: () => "POST", redirectedFrom: () => null,
          postDataBuffer: () => Buffer.alloc(20_000) }), abort, continue: proceed } as unknown as Route);
        expect(abort).toHaveBeenCalledOnce();
        expect(proceed).not.toHaveBeenCalled();
        return "blocked request only";
      }, {});
    try {
      await expect(run("https://telemetry.example.invalid/collect")).resolves.toBe("blocked request only");
      await expect(run("https://fixture.example.invalid/query")).rejects.toMatchObject({ code: "rate_limited" });
    } finally { launch.mockRestore(); dns.mockRestore(); }
  });
  it("allows only the observed read flow, never redirects, login, booking or arbitrary hosts", () => {
    const root = "https://www.hmm21.com";
    expect(hmmBrowserRequestAllowed(`${root}/e-service/general/schedule/ScheduleMain.do`, "GET")).toBe(true);
    expect(hmmBrowserRequestAllowed(`${root}/e-service/general/schedule/selectPointToPointList.do`, "POST")).toBe(true);
    expect(hmmBrowserRequestAllowed(`${root}/js/e-service/general/schedule/scheduleSub01.js`, "GET")).toBe(true);
    for (const [url, method] of [
      [`${root}/e-service/auth/getUserJwt.do`, "GET"],
      [`${root}/e-service/general/booking/create.do`, "POST"],
      [`${root}/e-service/general/schedule/ScheduleMain.do?redirect=https://127.0.0.1`, "GET"],
      [`${root}/js/a.js`, "POST"],
      ["https://www.hmm21.com.example.invalid/js/a.js", "GET"],
      ["http://www.hmm21.com/js/a.js", "GET"],
      ["https://user:secret@www.hmm21.com/js/a.js", "GET"],
      ["https://www.hmm21.com:8443/js/a.js", "GET"],
    ]) expect(hmmBrowserRequestAllowed(url!, method!)).toBe(false);
  });

  it("rejects untrusted browser inputs and cancelled work before launching", async () => {
    const port = createHmmBrowserPort({ executablePath: "/fixture/browser" });
    await expect(port.search({ carrier: "OOCL", query: { operation: "locations" } })).rejects.toMatchObject({ code: "validation_error" });
    await expect(port.search({ carrier: "HMM", query: { operation: "locations", url: "https://127.0.0.1" } })).rejects.toMatchObject({ code: "validation_error" });
    await expect(port.search({ carrier: "HMM", query: { operation: "schedules", origin_id: "CNSHA", destination_id: "CAVAN", from: "2026-09-01", until: "2026-12-01" } })).rejects.toMatchObject({ code: "validation_error" });
    await expect(port.search({ carrier: "HMM", query: { operation: "locations" }, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "timeout" });
    const date = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2027-01-01T00:00:00Z"));
    try {
      await expect(port.search({ carrier: "HMM", query: { operation: "locations" } })).rejects.toMatchObject({ code: "live_not_approved" });
    } finally { date.mockRestore(); }
  });

  it("limits OOCL to the public form and automatic captcha initialization, with no puzzle submission", async () => {
    expect(ooclBrowserRequestAllowed("https://moc.oocl.com/nj_prs_wss/", "GET")).toBe(true);
    expect(ooclBrowserRequestAllowed("https://moc.oocl.com/nj_prs_wss/mocss/secured/supportData/gsp/cityAutoComplete?userQuery=Fixture&bound=OB", "GET")).toBe(true);
    expect(ooclBrowserRequestAllowed("https://cs-captcha-public.cargosmart.com/captcha/public/get?appKey=fixture&captchaType=fixture&sessionKey=fixture", "GET")).toBe(true);
    expect(ooclBrowserRequestAllowed("https://cs-captcha-public.cargosmart.com/captcha/public/check", "POST")).toBe(false);
    expect(ooclBrowserRequestAllowed("https://moc.oocl.com/nj_prs_wss/booking", "POST")).toBe(false);
    expect(ooclBrowserRequestAllowed("https://moc.oocl.com/nj_prs_wss/?redirect=https://127.0.0.1", "GET")).toBe(false);
    const port = createOoclBrowserPort({ executablePath: "/fixture/browser" });
    await expect(port.search({ carrier: "OOCL", query: { operation: "locations", text: "Fixture", cookies: "forbidden" } })).rejects.toMatchObject({ code: "validation_error" });
  });

  it("pins CONNECT to the approved public address and denies other hosts or private addresses", async () => {
    const targets: string[] = [];
    const upstream = createServer();
    upstream.on("connect", (req, socket) => { targets.push(req.url!); socket.end("HTTP/1.1 200 Connection Established\r\n\r\n"); });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("fixture bind");
    const bridge = await openBrowserTunnel(new Map([["fixture.example.invalid", "8.8.8.8"]]), address.port);
    const proxy = new URL(bridge.server);
    async function connectTo(target: string) {
      return new Promise<number>((resolve, reject) => {
        const req = request({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: target });
        req.on("error", reject);
        req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode!); });
        req.on("response", res => { res.resume(); resolve(res.statusCode!); });
        req.end();
      });
    }
    try {
      expect(await connectTo("fixture.example.invalid:443")).toBe(200);
      expect(await connectTo("127.0.0.1:443")).toBe(403);
      expect(await connectTo("fixture.example.invalid:80")).toBe(403);
      expect(targets).toEqual(["8.8.8.8:443"]);
      await expect(openBrowserTunnel(new Map([["fixture.example.invalid", "127.0.0.1"]]))).rejects.toMatchObject({ code: "access_restricted" });
    } finally {
      await bridge.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
