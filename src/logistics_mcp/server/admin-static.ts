import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const PERMISSIONS_POLICY = "camera=(), geolocation=(), microphone=(), payment=(), usb=()";

const ASSETS = [
  { path: "/admin", filename: "index.html", contentType: "text/html; charset=utf-8" },
  { path: "/admin/", filename: "index.html", contentType: "text/html; charset=utf-8" },
  { path: "/admin/styles.css", filename: "styles.css", contentType: "text/css; charset=utf-8" },
  { path: "/admin/app.js", filename: "app.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/admin/fixture-data.js", filename: "fixture-data.js", contentType: "text/javascript; charset=utf-8" },
] as const;

const SNAPSHOT_PATH = "/admin/api/v1/snapshot";

interface LoadedAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

type AdminState =
  | { readonly kind: "disabled" }
  | { readonly kind: "invalid" }
  | { readonly kind: "missing" }
  | { readonly kind: "enabled"; readonly assets: ReadonlyMap<string, LoadedAsset> };

export interface AdminStaticHandlerOptions {
  readonly staticDir: string;
  readonly enabledSetting?: string;
}

export interface AdminStaticHandler {
  readonly available: boolean;
  handle(request: IncomingMessage, response: ServerResponse): boolean;
}

function loadAssets(staticDir: string): ReadonlyMap<string, LoadedAsset> | null {
  const assets = new Map<string, LoadedAsset>();
  try {
    for (const asset of ASSETS) {
      const filename = resolve(staticDir, asset.filename);
      if (!statSync(filename).isFile()) return null;
      assets.set(asset.path, {
        body: readFileSync(filename),
        contentType: asset.contentType,
      });
    }
  } catch {
    return null;
  }
  return assets;
}

function stateFor(options: AdminStaticHandlerOptions): AdminState {
  const setting = options.enabledSetting?.trim();
  if (setting === undefined || setting === "false") return { kind: "disabled" };
  if (setting !== "true") return { kind: "invalid" };
  const assets = loadAssets(options.staticDir);
  return assets === null ? { kind: "missing" } : { kind: "enabled", assets };
}

function pathFromRequest(request: IncomingMessage): string {
  const [path = "/"] = (request.url ?? "/").split("?", 1);
  return path;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("permissions-policy", PERMISSIONS_POLICY);
  response.setHeader("cache-control", "no-store");
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  allow?: string,
): void {
  const bytes = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
  setSecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", String(bytes));
  if (allow !== undefined) response.setHeader("allow", allow);
  if (request.method !== "GET" && request.method !== "HEAD") request.resume();
  response.end(request.method === "HEAD" ? undefined : body);
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown,
  allow?: string,
): void {
  send(request, response, status, "application/json; charset=utf-8", JSON.stringify(body), allow);
}

function isAdminPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
}

function methodAllowed(request: IncomingMessage, response: ServerResponse, allow: string): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  sendJson(request, response, 405, { status: "blocked", reason: "method_not_allowed" }, allow);
  return false;
}

export function createAdminStaticHandler(options: AdminStaticHandlerOptions): AdminStaticHandler {
  const state = stateFor(options);
  return {
    available: state.kind === "enabled",
    handle(request, response): boolean {
      const path = pathFromRequest(request);
      if (!isAdminPath(path)) return false;

      if (state.kind === "disabled") {
        sendJson(request, response, 404, { status: "blocked", reason: "admin_ui_disabled" });
        return true;
      }
      if (state.kind === "invalid") {
        sendJson(request, response, 503, { status: "unavailable", reason: "admin_ui_config_invalid" });
        return true;
      }

      if (path === SNAPSHOT_PATH) {
        if (request.method !== "GET") {
          sendJson(request, response, 405, { status: "blocked", reason: "method_not_allowed" }, "GET");
          return true;
        }
        sendJson(request, response, 503, {
          status: "unavailable",
          reasons: ["admin_snapshot_provider_missing"],
        });
        return true;
      }

      const asset = ASSETS.find((candidate) => candidate.path === path);
      if (asset === undefined) {
        sendJson(request, response, 404, { status: "blocked", reason: "admin_route_not_found" });
        return true;
      }
      if (!methodAllowed(request, response, "GET, HEAD")) return true;
      if (state.kind === "missing") {
        sendJson(request, response, 503, { status: "unavailable", reason: "admin_ui_assets_missing" });
        return true;
      }
      const loaded = state.assets.get(asset.path);
      if (loaded === undefined) {
        sendJson(request, response, 503, { status: "unavailable", reason: "admin_ui_assets_missing" });
        return true;
      }
      send(request, response, 200, loaded.contentType, loaded.body);
      return true;
    },
  };
}
