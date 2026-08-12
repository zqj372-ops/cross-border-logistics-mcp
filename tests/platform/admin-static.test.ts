import type { Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
} as const;

const temporaryPaths: string[] = [];

async function makeAssets(names: readonly string[] = Object.keys(ASSETS)): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "logistics-mcp-admin-"));
  temporaryPaths.push(directory);
  await Promise.all(
    names.map((name) => writeFile(resolve(directory, name), ASSETS[name as keyof typeof ASSETS])),
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

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("admin static runtime boundary", () => {
  it("is closed by default", async () => {
    const directory = await makeAssets();
    const composition = createFixtureComposition({ dataMode: "fixtures" });
    const { server, baseUrl } = await listen(
      composition,
      createAdminStaticHandler({ staticDir: directory }),
    );
    try {
      const response = await fetch(`${baseUrl}/admin/app.js?fixture=1`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ status: "blocked", reason: "admin_ui_disabled" });
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

  it("returns fixed security headers and a provider-missing snapshot without fixture data", async () => {
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
