import { chromium, type Page, type Response } from "playwright-core";
import { abortErrorFromSignal, CollectorRuntimeError, throwIfAborted } from "../errors";
import type { CarrierHttpResponse } from "../ports";
import { resolvePublicAddress } from "./node-connector";
import { openBrowserTunnel } from "./browser-tunnel";

export interface ScheduleBrowserOptions {
  readonly executablePath: string;
  readonly proxyPort?: number;
  readonly headed?: boolean;
}
const MAX_BYTES = 4 * 1024 * 1024;
export async function captureScheduleResponse(response: Response): Promise<CarrierHttpResponse> {
  const bytes = await response.body();
  if (bytes.byteLength > MAX_BYTES) throw new CollectorRuntimeError("incomplete_results", "unavailable", "schedule_browser_response_too_large");
  return {
    status: response.status(), url: response.url(),
    contentType: response.headers()["content-type"] ?? null,
    headers: {}, body: bytes, // Never retain session headers or the bootstrap document.
  };
}


export async function withScheduleBrowser<T>(
  options: ScheduleBrowserOptions,
  hosts: readonly string[],
  allowed: (url: string, method: string) => boolean,
  run: (page: Page) => Promise<T>,
  input: { readonly signal?: AbortSignal },
): Promise<T> {
  // Same expiry as the approved HMM/OOCL public-source policies; this optional
  // transport must not turn a time-bounded approval into perpetual access.
  if (Date.now() >= Date.parse("2026-12-31T23:59:59Z")) throw new CollectorRuntimeError("live_not_approved", "blocked", "collector_live_target_expired");
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(90_000)]);
  const pins = new Map(await Promise.all(hosts.map(async host =>
    [host, (await resolvePublicAddress(host, signal)).address] as const)));
  throwIfAborted(signal);
  const tunnel = await openBrowserTunnel(pins, options.proxyPort);
  const browser = await chromium.launch({
    executablePath: options.executablePath, headless: !options.headed, chromiumSandbox: true, timeout: 30_000,
    proxy: { server: tunnel.server }, args: ["--disable-quic"],
  }).catch(async () => { await tunnel.close(); throw new CollectorRuntimeError("unexpected_error", "unavailable", "schedule_browser_launch_failed"); });
  const close = (): void => { void browser.close().catch(() => undefined); };
  signal.addEventListener("abort", close, { once: true });
  let limit: CollectorRuntimeError | undefined;
  try {
    throwIfAborted(signal);
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", locale: "en-US" });
    let requests = 0;
    await context.route("**/*", async route => {
      const request = route.request();
      const permitted = !request.redirectedFrom() && allowed(request.url(), request.method());
      if (++requests > 180 || (permitted && (request.postDataBuffer()?.byteLength ?? 0) > 16_384)) {
        limit = new CollectorRuntimeError("rate_limited", "unavailable", "schedule_browser_request_budget_exceeded");
        await route.abort(); close(); return;
      }
      if (!permitted) await route.abort();
      else await route.continue();
    });
    await context.routeWebSocket("**/*", socket => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("dialog", dialog => { void dialog.dismiss().catch(() => undefined); });
    const network = await context.newCDPSession(page);
    await network.send("Network.enable");
    page.on("response", response => {
      if (response.status() >= 300 && response.status() < 400) {
        limit = new CollectorRuntimeError("access_restricted", "unavailable", "schedule_browser_redirect_rejected"); close();
      }
    });
    let totalBytes = 0;
    const sizes = new Map<string, number>();
    network.on("Network.dataReceived", (event: { requestId: string; dataLength: number }) => {
      totalBytes += event.dataLength;
      const size = (sizes.get(event.requestId) ?? 0) + event.dataLength;
      sizes.set(event.requestId, size);
      if (size > MAX_BYTES || totalBytes > 20 * 1024 * 1024) {
        limit = new CollectorRuntimeError("incomplete_results", "unavailable", "schedule_browser_response_too_large"); close();
      }
    });
    const result = await run(page);
    throwIfAborted(signal);
    if (limit) throw limit;
    return result;
  } catch (error: unknown) {
    throw abortErrorFromSignal(signal) ?? limit ?? (error instanceof CollectorRuntimeError ? error :
      new CollectorRuntimeError("unexpected_error", "unavailable", "schedule_browser_flow_failed"));
  } finally {
    signal.removeEventListener("abort", close);
    await browser.close().finally(() => tunnel.close());
  }
}
