import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

import type { AdminControlApiHandler } from "./admin-control-api";

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const PERMISSIONS_POLICY = "camera=(), geolocation=(), microphone=(), payment=(), usb=()";

const ASSETS = [
  { path: "/admin/", filename: "index.html", contentType: "text/html; charset=utf-8" },
  { path: "/admin/styles.css", filename: "styles.css", contentType: "text/css; charset=utf-8" },
  { path: "/admin/app.js", filename: "app.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/admin/control-plane.js", filename: "control-plane.js", contentType: "text/javascript; charset=utf-8" },
  { path: "/admin/fixture-data.js", filename: "fixture-data.js", contentType: "text/javascript; charset=utf-8" },
  {
    path: "/admin/vendor/adminlte/adminlte.min.css",
    filename: "vendor/adminlte/adminlte.min.css",
    contentType: "text/css; charset=utf-8",
  },
  {
    path: "/admin/vendor/adminlte/adminlte.min.js",
    filename: "vendor/adminlte/adminlte.min.js",
    contentType: "text/javascript; charset=utf-8",
  },
  {
    path: "/admin/vendor/bootstrap/bootstrap.min.css",
    filename: "vendor/bootstrap/bootstrap.min.css",
    contentType: "text/css; charset=utf-8",
  },
  {
    path: "/admin/vendor/bootstrap/bootstrap.bundle.min.js",
    filename: "vendor/bootstrap/bootstrap.bundle.min.js",
    contentType: "text/javascript; charset=utf-8",
  },
] as const;

const SNAPSHOT_PATH = "/admin/api/v1/snapshot";
const CONTROL_API_PATH = "/admin/api/v1/control";

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
  readonly adminControlApi?: AdminControlApiHandler;
  readonly snapshotProvider?: () =>
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
}

export interface AdminStaticHandler {
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

function isControlApiPath(path: string): boolean {
  return path === CONTROL_API_PATH || path.startsWith(`${CONTROL_API_PATH}/`);
}

function isLoopbackAddress(value: string | undefined): boolean {
  return (
    value === "localhost" ||
    value === "127.0.0.1" ||
    value === "[::1]" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1"
  );
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
  try {
    const host = new URL(`http://${request.headers.host ?? ""}`).hostname;
    const origin = request.headers.origin;
    return (
      isLoopbackAddress(host) &&
      (origin === undefined || isLoopbackAddress(new URL(origin).hostname))
    );
  } catch {
    return false;
  }
}

function methodAllowed(request: IncomingMessage, response: ServerResponse, allow: string): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  sendJson(request, response, 405, { status: "blocked", reason: "method_not_allowed" }, allow);
  return false;
}

export function createAdminStaticHandler(options: AdminStaticHandlerOptions): AdminStaticHandler {
  const state = stateFor(options);
  return {
    handle(request, response): boolean {
      const path = pathFromRequest(request);
      if (!isAdminPath(path)) return false;

      if (isControlApiPath(path) && options.adminControlApi?.handle(request, response)) {
        return true;
      }

      if (state.kind === "disabled") {
        sendJson(request, response, 404, { status: "blocked", reason: "admin_ui_disabled" });
        return true;
      }
      if (!isLoopbackRequest(request)) {
        sendJson(request, response, 404, { status: "blocked", reason: "admin_ui_disabled" });
        return true;
      }
      if (path === "/admin" && !methodAllowed(request, response, "GET, HEAD")) return true;
      if (state.kind === "invalid") {
        sendJson(request, response, 503, { status: "unavailable", reason: "admin_ui_config_invalid" });
        return true;
      }
      if (state.kind === "missing" && path === "/admin") {
        sendJson(request, response, 503, { status: "unavailable", reason: "admin_ui_assets_missing" });
        return true;
      }
      if (path === "/admin") {
        try {
          const requested = new URL(request.url ?? "/", "http://admin.invalid");
          const location = new URL("/admin/", "http://admin.invalid");
          location.search = requested.search;
          setSecurityHeaders(response);
          response.statusCode = 308;
          response.setHeader("location", `${location.pathname}${location.search}`);
          response.setHeader("content-length", "0");
          response.end();
        } catch {
          sendJson(request, response, 400, { status: "blocked", reason: "invalid_admin_redirect_target" });
        }
        return true;
      }

      if (path === SNAPSHOT_PATH) {
        if (request.method !== "GET") {
          sendJson(request, response, 405, { status: "blocked", reason: "method_not_allowed" }, "GET");
          return true;
        }
        if (options.snapshotProvider === undefined) {
          sendJson(request, response, 503, {
            status: "unavailable",
            reasons: ["admin_snapshot_provider_missing"],
          });
          return true;
        }
        void Promise.resolve()
          .then(() => options.snapshotProvider!())
          .then((snapshot) => {
            if (!response.destroyed) sendJson(request, response, 200, snapshot);
          })
          .catch(() => {
            if (!response.destroyed) {
              sendJson(request, response, 503, {
                status: "unavailable",
                reasons: ["admin_snapshot_unavailable"],
              });
            }
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
