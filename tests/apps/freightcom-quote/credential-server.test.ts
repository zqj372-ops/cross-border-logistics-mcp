import { afterEach, describe, expect, it, vi } from "vitest";

import { createCredentialServer } from "../../../apps/freightcom-credential/server.mjs";

const servers: Array<ReturnType<typeof createCredentialServer>["server"]> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function start(storeCredential = vi.fn(() => Promise.resolve())) {
  const created = createCredentialServer({ port: 56571, storeCredential });
  servers.push(created.server);
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = created.server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  return { ...created, storeCredential, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("Freightcom browser credential entry", () => {
  it("stores a submitted token without rendering it back", async () => {
    const harness = await start();
    const page = await fetch(`${harness.baseUrl}/`);
    const body = await page.text();
    const nonce = body.match(/name="nonce" value="([a-f0-9]+)"/u)?.[1];
    expect(nonce).toBeTruthy();
    const token = "synthetic-browser-token-123";
    const response = await fetch(`${harness.baseUrl}/save`, {
      method: "POST",
      headers: {
        origin: harness.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ nonce: nonce ?? "", token }),
    });

    expect(response.status).toBe(200);
    expect(harness.storeCredential).toHaveBeenCalledWith(token);
    expect(await response.text()).not.toContain(token);
    expect(await (await fetch(`${harness.baseUrl}/status`)).json()).toEqual({ stored: true });
  });

  it("rejects an invalid nonce before storage", async () => {
    const harness = await start();
    const response = await fetch(`${harness.baseUrl}/save`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nonce: "wrong", token: "synthetic-browser-token-123" }),
    });

    expect(response.status).toBe(400);
    expect(harness.storeCredential).not.toHaveBeenCalled();
  });

  it("returns a bounded error when Keychain storage fails", async () => {
    const harness = await start(vi.fn(() => Promise.reject(new Error("synthetic failure"))));
    const body = await (await fetch(`${harness.baseUrl}/`)).text();
    const nonce = body.match(/name="nonce" value="([a-f0-9]+)"/u)?.[1] ?? "";

    const response = await fetch(`${harness.baseUrl}/save`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nonce, token: "synthetic-browser-token-123" }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ stored: false, reason: "keychain_update_failed" });
  });
});
