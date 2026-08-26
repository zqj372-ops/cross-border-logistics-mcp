import {
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAdminStaticHandler } from "../../src/logistics_mcp/server/admin-static";
import {
  createFixtureComposition,
  createProductionComposition,
} from "../../src/logistics_mcp/server/composition";
import { createRuntimeServer } from "../../src/logistics_mcp/server/start";

const ASSETS = {
  "index.html": "<!doctype html><title>Admin fixture</title><link rel=\"stylesheet\" href=\"./styles.css\"><script src=\"./app.js\"></script>",
  "styles.css": "body { color: black; }",
  "app.js": "window.adminFixture = false;",
  "fixture-data.js": "window.adminFixtureData = true;",
  "control-plane.js": "export const controlPlaneFixture = true;",
  "vendor/adminlte/adminlte.min.css": "/* adminlte fixture */",
  "vendor/adminlte/adminlte.min.js": "window.adminLteFixture = true;",
  "vendor/bootstrap/bootstrap.min.css": "/* bootstrap fixture */",
  "vendor/bootstrap/bootstrap.bundle.min.js": "window.bootstrapFixture = true;",
} as const;

const temporaryPaths: string[] = [];

async function makeAssets(names: readonly string[] = Object.keys(ASSETS)): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "logistics-mcp-admin-"));
  temporaryPaths.push(directory);
  await Promise.all(
    names.map(async (name) => {
      const file = resolve(directory, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, ASSETS[name as keyof typeof ASSETS]);
    }),
  );
  return directory;
}

async function listen(
  composition: Parameters<typeof createRuntimeServer>[0],
  adminUi: ReturnType<typeof createAdminStaticHandler>,
): Promise<{ readonly server: Server; readonly baseUrl: string }> {
  const server = createRuntimeServer(composition, { adminUi });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Admin static test server did not expose an address.");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
}

async function requestStatus(url: string, headers: Readonly<Record<string, string>>): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("admin static runtime boundary", () => {
  it("delegates control routes before static fallback, including when UI assets are disabled", async () => {
    const directory = await makeAssets();
    const composition = createFixtureComposition({ dataMode: "fixtures" });
    const controlApi = {
      handle: vi.fn((_request: IncomingMessage, response: ServerResponse): boolean => {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ delegated: true }));
        return true;
      }),
    };
    const { server, baseUrl } = await listen(
      composition,
      createAdminStaticHandler({
        staticDir: directory,
        adminControlApi: controlApi,
      }),
    );
    try {
      const delegated = await fetch(`${baseUrl}/admin/api/v1/control/state`);
      expect(delegated.status).toBe(200);
      expect(await delegated.json()).toEqual({ delegated: true });
      expect(controlApi.handle).toHaveBeenCalledTimes(1);

      const fallback = await fetch(`${baseUrl}/admin/api/v1/not-control`);
      expect(fallback.status).toBe(404);
      expect(await fallback.json()).toEqual({ status: "blocked", reason: "admin_ui_disabled" });
      expect(controlApi.handle).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(server);
      await composition.close();
    }
  });

  it("serves the explicit control-plane and vendor allowlist without exposing node_modules", async () => {
    const directory = await makeAssets();
    const composition = createFixtureComposition({ dataMode: "fixtures" });
    const { server, baseUrl } = await listen(
      composition,
      createAdminStaticHandler({ enabledSetting: "true", staticDir: directory }),
    );
    try {
      for (const path of [
        "/admin/control-plane.js",
        "/admin/vendor/adminlte/adminlte.min.css",
        "/admin/vendor/adminlte/adminlte.min.js",
        "/admin/vendor/bootstrap/bootstrap.min.css",
        "/admin/vendor/bootstrap/bootstrap.bundle.min.js",
      ]) {
        const response = await fetch(`${baseUrl}${path}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }

      for (const path of [
        "/admin/node_modules/admin-lte/dist/css/adminlte.min.css",
        "/admin/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js",
      ]) {
        const response = await fetch(`${baseUrl}${path}`);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ status: "blocked", reason: "admin_route_not_found" });
      }
    } finally {
      await closeServer(server);
      await composition.close();
    }
  });

  it("is closed by default", async () => {
    const directory = await makeAssets();
    const composition = createFixtureComposition({ dataMode: "fixtures" });
    let snapshotCalls = 0;
    const { server, baseUrl } = await listen(
      composition,
      createAdminStaticHandler({
        staticDir: directory,
        snapshotProvider: () => {
          snapshotCalls += 1;
          return {};
        },
      }),
    );
    try {
      const response = await fetch(`${baseUrl}/admin/app.js?fixture=1`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ status: "blocked", reason: "admin_ui_disabled" });
      expect((await fetch(`${baseUrl}/admin/api/v1/snapshot`)).status).toBe(404);
      expect(snapshotCalls).toBe(0);
    } finally {
      await closeServer(server);
      await composition.close();
    }
  });

  it("redirects /admin to the slash canonical path without reflecting the host", async () => {
    const directory = await makeAssets();
    const composition = createFixtureComposition({ dataMode: "fixtures" });
    const { server, baseUrl } = await listen(
      composition,
      createAdminStaticHandler({ enabledSetting: "true", staticDir: directory }),
    );
    try {
      const manual = await fetch(`${baseUrl}/admin?fixture=1`, { redirect: "manual" });
      expect(manual.status).toBe(308);
      expect(manual.headers.get("location")).toBe("/admin/?fixture=1");
      expect(manual.headers.get("cache-control")).toBe("no-store");
      expect(manual.headers.get("content-security-policy")).toContain("default-src 'self'");

      const head = await fetch(`${baseUrl}/admin?fixture=1`, {
        method: "HEAD",
        redirect: "manual",
      });
      expect(head.status).toBe(308);
      expect(head.headers.get("location")).toBe("/admin/?fixture=1");
      expect(await head.text()).toBe("");

      const followed = await fetch(`${baseUrl}/admin?fixture=1`);
      expect(followed.status).toBe(200);
      expect(followed.url).toBe(`${baseUrl}/admin/?fixture=1`);
      const html = await followed.text();
      expect(html).toContain("./styles.css");
      expect(html).toContain("./app.js");
      expect(new URL("./styles.css", followed.url).pathname).toBe("/admin/styles.css");
      expect(new URL("./app.js", followed.url).pathname).toBe("/admin/app.js");
    } finally {
      await closeServer(server);
      await composition.close();
    }
  });

  it("serves only the four allowlisted resources, supports HEAD, and rejects writes", async () => {
    const directory = await makeAssets();
    const composition = createFixtureComposition({ dataMode: "fixtures" });
    const { server, baseUrl } = await listen(
      composition,
      createAdminStaticHandler({ enabledSetting: "true", staticDir: directory }),
    );
    try {
      for (const path of ["/admin/", "/admin/styles.css", "/admin/app.js", "/admin/fixture-data.js"]) {
        const response = await fetch(`${baseUrl}${path}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      const head = await fetch(`${baseUrl}/admin/`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");

      const adminPost = await fetch(`${baseUrl}/admin`, {
        method: "POST",
        redirect: "manual",
      });
      expect(adminPost.status).toBe(405);
      expect(adminPost.headers.get("location")).toBeNull();

      const post = await fetch(`${baseUrl}/admin/app.js`, { method: "POST" });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
      const apiPost = await fetch(`${baseUrl}/admin/api/v1/snapshot`, { method: "POST" });
      expect(apiPost.status).toBe(405);
      expect(apiPost.headers.get("allow")).toBe("GET");
    } finally {
      await closeServer(server);
      await composition.close();
    }
  });

  it("blocks traversal and unknown paths without a SPA fallback", async () => {
    const directory = await makeAssets();
    const composition = createFixtureComposition({ dataMode: "fixtures" });
    const { server, baseUrl } = await listen(
      composition,
      createAdminStaticHandler({ enabledSetting: "true", staticDir: directory }),
    );
    try {
      for (const path of ["/admin/secret.txt", "/admin/%2e%2e/%2e%2e/etc/passwd", "/admin/app.js/extra"]) {
        const response = await fetch(`${baseUrl}${path}`);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ status: "blocked" });
      }
    } finally {
      await closeServer(server);
      await composition.close();
    }
  });

  it("returns fixed security headers and fails closed without a snapshot provider", async () => {
    const directory = await makeAssets();
    const composition = createFixtureComposition({ dataMode: "fixtures" });
    const { server, baseUrl } = await listen(
      composition,
      createAdminStaticHandler({ enabledSetting: "true", staticDir: directory }),
    );
    try {
      const response = await fetch(`${baseUrl}/admin`);
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("permissions-policy")).toBe(
        "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      );

      const snapshot = await fetch(`${baseUrl}/admin/api/v1/snapshot?fixture=1`);
      expect(snapshot.status).toBe(503);
      expect(snapshot.headers.get("cache-control")).toBe("no-store");
      expect(await snapshot.json()).toEqual({
        status: "unavailable",
        reasons: ["admin_snapshot_provider_missing"],
      });
      const snapshotText = await (await fetch(`${baseUrl}/admin/api/v1/snapshot`)).text();
      expect(/fixture|secret|token|password|price|quote/i.test(snapshotText)).toBe(false);
    } finally {
      await closeServer(server);
      await composition.close();
    }
  });

  it("serves a provider snapshot without caching or leaking provider failures", async () => {
    const directory = await makeAssets();
    const composition = createFixtureComposition({ dataMode: "fixtures" });
    let calls = 0;
    const { server, baseUrl } = await listen(
      composition,
      createAdminStaticHandler({
        enabledSetting: "true",
        staticDir: directory,
        snapshotProvider: () => {
          calls += 1;
          return { schema_version: "2026-08-11.v1", environment: "演示环境" };
        },
      }),
    );
    try {
      const response = await fetch(`${baseUrl}/admin/api/v1/snapshot`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        schema_version: "2026-08-11.v1",
        environment: "演示环境",
      });
      expect(calls).toBe(1);
      const wrongHostStatus = await requestStatus(`${baseUrl}/admin/api/v1/snapshot`, {
        host: "attacker.example.invalid",
      });
      const wrongOrigin = await fetch(`${baseUrl}/admin/api/v1/snapshot`, {
        headers: { origin: "https://attacker.example.invalid" },
      });
      expect(wrongHostStatus).toBe(404);
      expect(wrongOrigin.status).toBe(404);
      expect(calls).toBe(1);
    } finally {
      await closeServer(server);
      await composition.close();
    }

    const failedComposition = createFixtureComposition({ dataMode: "fixtures" });
    const failed = await listen(
      failedComposition,
      createAdminStaticHandler({
        enabledSetting: "true",
        staticDir: directory,
        snapshotProvider: () => {
          throw new Error("Bearer secret-value from https://private.example.invalid");
        },
      }),
    );
    try {
      const response = await fetch(`${failed.baseUrl}/admin/api/v1/snapshot`);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        status: "unavailable",
        reasons: ["admin_snapshot_unavailable"],
      });
      expect(body).not.toContain("secret-value");
      expect(body).not.toContain("private.example.invalid");
    } finally {
      await closeServer(failed.server);
      await failedComposition.close();
    }
  });

  it("uses a redacted live snapshot without changing fixture readiness", async () => {
    const previousEnabled = process.env.MCP_ADMIN_UI_ENABLED;
    const previousMode = process.env.MCP_DATA_MODE;
    process.env.MCP_ADMIN_UI_ENABLED = "true";
    process.env.MCP_DATA_MODE = "fixtures";
    const composition = createFixtureComposition({ dataMode: "fixtures" });
    const server = createRuntimeServer(composition);
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No admin address.");
    try {
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${baseUrl}/admin/api/v1/snapshot`);
      expect(response.status).toBe(200);
      const body = await response.text();
      const snapshot = JSON.parse(body) as Record<string, unknown>;
      expect(snapshot).toMatchObject({
        schema_version: "2026-08-11.v1",
        environment: "演示环境",
        health: { readyz: { status: "blocked" } },
        clients: [],
        audit: [],
      });
      expect((snapshot.tools as Array<{ name?: string }>)).toHaveLength(11);
      expect((snapshot.tools as Array<{ name?: string }>).map((tool) => tool.name))
        .toContain("quote.freightcom_ltl.preview");
      expect((snapshot.roles as unknown[])).toHaveLength(7);
      expect((snapshot.sources as unknown[])).toHaveLength(4);
      expect(body).not.toMatch(
        /https?:\/\/|Bearer|token|secret|password|client_id|tenant_id|actor_id|request_id|audit_id|source_id|endpoint_ref|secret_ref|MCP_/i,
      );
      const ready = await fetch(`${baseUrl}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({
        status: "not_ready",
        reasons: ["fixture_mode_not_production_ready"],
      });
    } finally {
      await closeServer(server);
      await composition.close();
      if (previousEnabled === undefined) delete process.env.MCP_ADMIN_UI_ENABLED;
      else process.env.MCP_ADMIN_UI_ENABLED = previousEnabled;
      if (previousMode === undefined) delete process.env.MCP_DATA_MODE;
      else process.env.MCP_DATA_MODE = previousMode;
    }
  });

  it("fails closed for invalid settings and incomplete assets", async () => {
    const incompleteDirectory = await makeAssets(["index.html"]);
    const invalidComposition = createFixtureComposition({ dataMode: "fixtures" });
    const invalid = await listen(
      invalidComposition,
      createAdminStaticHandler({ enabledSetting: "yes", staticDir: incompleteDirectory }),
    );
    try {
      const response = await fetch(`${invalid.baseUrl}/admin`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable", reason: "admin_ui_config_invalid" });
    } finally {
      await closeServer(invalid.server);
      await invalidComposition.close();
    }

    const missingComposition = createFixtureComposition({ dataMode: "fixtures" });
    const missing = await listen(
      missingComposition,
      createAdminStaticHandler({ enabledSetting: "true", staticDir: incompleteDirectory }),
    );
    try {
      const response = await fetch(`${missing.baseUrl}/admin`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable", reason: "admin_ui_assets_missing" });
    } finally {
      await closeServer(missing.server);
      await missingComposition.close();
    }
  });

  it("does not promote production readiness when the admin UI is enabled", async () => {
    const directory = await makeAssets();
    const composition = createProductionComposition({ dataMode: "production" });
    const { server, baseUrl } = await listen(
      composition,
      createAdminStaticHandler({ enabledSetting: "true", staticDir: directory }),
    );
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "not_ready" });
    } finally {
      await closeServer(server);
      await composition.close();
    }
  });
});
