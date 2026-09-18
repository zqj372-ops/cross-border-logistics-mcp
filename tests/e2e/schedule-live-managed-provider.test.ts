import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, jwtVerify } from "jose";
import { expect, it } from "vitest";

import { createEnvelope } from "../../src/logistics_mcp/platform/envelope";
import { SCHEDULE_MCP_TOOLS } from "../../src/logistics_mcp/platform/application-tools";
import { createProductionComposition } from "../../src/logistics_mcp/server/composition";
import { loadManagedScheduleProvider } from "../../src/logistics_mcp/server/schedule-provider";
import { signProviderRelease } from "../../src/logistics_mcp/module-runtime/provider-release-cli";
import { SqliteProductionStore } from "../../src/logistics_mcp/platform/sqlite-production-store";
import { ScheduleLiveCarriersDataSchema, SCHEDULE_LIVE_VERSION } from "../../services/maritime/schedule-live/contracts";
import { createApplicationMcpHttpHandler } from "../../services/access-gateway/portal/business-access/mcp-http";
import { ApplicationMcpAccessService } from "../../services/access-gateway/portal/business-access/mcp";
import { SyntheticJwtSigner } from "../../services/access-gateway/synthetic";

const runtimeSecret = "s".repeat(48);
const sha256 = (bytes: Uint8Array | string): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function startPortalHandler() {
  const holder: { handler?: ReturnType<typeof createApplicationMcpHttpHandler> } = {};
  const server = createServer((request, response) => {
    if (!holder.handler?.handle(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = `http://${host}`;
  const calls: string[] = [];
  holder.handler = createApplicationMcpHttpHandler({
    mode: "fixtures",
    runtimeSecret,
    providerHealth: () => Promise.resolve(true),
    allowedHosts: [host],
    allowedOrigins: [origin],
    trustedProxyAddresses: [],
    service: {
      repositoryKind: "synthetic",
      exchange: () => Promise.reject(new Error("unused")),
      authorize: () => Promise.reject(new Error("unused")),
    },
    mcpAccess: {
      exchange: () => Promise.reject(new Error("unused")),
      verify: (token, tools = []) => {
        const required = tools ?? [];
        calls.push(`verify:${required.join(",")}`);
        void token;
        return Promise.resolve({
          tenantId: "tenant_fixture",
          clientId: "client_fixture",
          applicationId: "app_fixture",
          credentialId: "bkey_0123456789abcdef01234567",
          toolNames: [...required],
        });
      },
    },
    executor: {
      execute: (request) => {
        calls.push(`execute:${request.operation}`);
        return Promise.resolve(createEnvelope({
          requestId: request.requestId,
          auditId: "schedule-provider-test-audit",
          status: "success",
          data: ScheduleLiveCarriersDataSchema.parse({
            carriers: [{
              id: "ONE",
              display_name: "Ocean Network Express",
              adapter_version: "one-schedule-parser@1",
              capability_status: "live_verified",
              last_live_verified_at: "2026-09-17T10:26:31Z",
            }],
          }),
          sourceRefs: [],
        }));
      },
    },
  });
  return {
    origin,
    calls,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function prepareRelease(root: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const artifact = Buffer.from(JSON.stringify({
    schema_version: "private-provider@2026-09-06.v1",
    base_url: "https://provider.example.invalid/",
    contract_version: SCHEDULE_LIVE_VERSION,
    tools: [...SCHEDULE_MCP_TOOLS],
  }));
  const sbom = Buffer.from(JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    components: [],
  }));
  const now = Date.now();
  const payload = {
    schema_version: "provider-release@2026-09-06.v1",
    module_id: "maritime.schedule_collector",
    version: "1.0.0",
    revision: 1,
    enabled: true,
    artifact_file: "artifact.json",
    artifact_digest: sha256(artifact),
    sbom_file: "sbom.json",
    sbom_digest: sha256(sbom),
    source_commit: "a".repeat(40),
    issued_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 7 * 86_400_000).toISOString(),
  };
  await writeFile(join(root, "private.pem"), privatePem, { mode: 0o600 });
  await writeFile(join(root, "trusted-signers.json"), JSON.stringify({ "release-key-1": publicPem }), { mode: 0o644 });
  await writeFile(join(root, "artifact.json"), artifact, { mode: 0o644 });
  await writeFile(join(root, "sbom.json"), sbom, { mode: 0o644 });
  await writeFile(join(root, "payload.json"), JSON.stringify(payload), { mode: 0o644 });
  await signProviderRelease({
    payloadFile: join(root, "payload.json"),
    privateKeyFile: join(root, "private.pem"),
    keyId: "release-key-1",
    allowedHosts: ["provider.example.invalid"],
    outputFile: join(root, "release.json"),
    moduleId: "maritime.schedule_collector",
  });
  await writeFile(join(root, "runtime-secret"), runtimeSecret, { mode: 0o600 });
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  return {
    statePath: join(stateDirectory, "provider-activation.json"),
    environment: {
      MCP_SCHEDULE_RELEASE_FILE: join(root, "release.json"),
      MCP_SCHEDULE_SIGNERS_FILE: join(root, "trusted-signers.json"),
      MCP_SCHEDULE_RELEASE_STATE_PATH: join(stateDirectory, "provider-activation.json"),
      MCP_SCHEDULE_PROVIDER_ALLOWED_HOST: "provider.example.invalid",
      MCP_SCHEDULE_PROVIDER_SECRET_FILE: join(root, "runtime-secret"),
    } satisfies NodeJS.ProcessEnv,
  };
}

it("loads the signed three-tool schedule release from a real HTTP handler and survives a restart journal readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "schedule-managed-"));
  const portal = await startPortalHandler();
  const store = new SqliteProductionStore(join(root, "runtime.sqlite"));
  const signer = new SyntheticJwtSigner();
  const jwks = createLocalJWKSet({ keys: (await signer.getJwks()).keys.map((key) => ({ ...key })) });
  const verifier = {
    verify: async (token: string) =>
      (await jwtVerify(token, jwks, { algorithms: ["RS256"], issuer: "https://issuer.example.invalid/", audience: "mcp" })).payload,
  };
  const active = true;
  const access = new ApplicationMcpAccessService({
    signer,
    verifier,
    issuer: "https://issuer.example.invalid/",
    audience: "mcp",
    limiter: { reserve: () => Promise.resolve(true) },
    authority: {
      authorizeMcpApiKey: (_key, tools) => active
        ? Promise.resolve({
            tenantId: "tenant_fixture",
            clientId: "client_fixture",
            applicationId: "app_fixture",
            credentialId: "bkey_0123456789abcdef01234567",
            toolNames: [...tools],
          })
        : Promise.reject(new Error("revoked")),
      authorizeMcpCredential: (input) => active
        ? Promise.resolve({
            tenantId: "tenant_fixture",
            clientId: "client_fixture",
            applicationId: "app_fixture",
            credentialId: "bkey_0123456789abcdef01234567",
            toolNames: [...input.requestedToolNames],
          })
        : Promise.reject(new Error("revoked")),
    },
  });
  const token = (await access.exchange("synthetic-schedule-key", {
    schema_version: "application-mcp-exchange@2026-09-06.v1",
    requested_tool_names: [...SCHEDULE_MCP_TOOLS],
  }, "127.0.0.1")).data.access_token;
  const fetchImpl: typeof fetch = async (input, init) => {
    const source = input instanceof Request ? input.url : String(input);
    const url = new URL(source);
    const target = new URL(`${url.pathname}${url.search}`, portal.origin);
    const headers = new Headers(init?.headers);
    const response = await fetch(target, {
      method: init?.method ?? "GET",
      headers,
      ...(init?.body === undefined || init.body === null ? {} : { body: init.body }),
    });
    return response;
  };
  let runtime: Awaited<ReturnType<typeof loadManagedScheduleProvider>> | undefined;
  try {
    const release = await prepareRelease(root);
    runtime = await loadManagedScheduleProvider(release.environment, { fetchImpl });
    expect(runtime.definitions.map((tool) => tool.name).sort()).toEqual([...SCHEDULE_MCP_TOOLS].sort());
    expect(runtime.definitions.every((tool) => tool.moduleId === "maritime.schedule_collector")).toBe(true);
    expect(await runtime.health()).toEqual({ ready: true });
    const journal = JSON.parse(await readFile(release.statePath, "utf8")) as {
      readonly revision: number;
      readonly release_digest: string;
    };
    expect(journal.revision).toBe(1);
    expect(journal.release_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const composition = createProductionComposition({
      dataMode: "production",
      profile: "schedule-live-v1",
      scheduleProvider: runtime,
      auditRepository: store,
      idempotencyRepository: store,
      sessionBindingStore: store,
      sessionOwnerId: "instance_fixture",
      allowedHosts: ["runtime.example.invalid"],
      allowedOrigins: ["https://client.example.invalid"],
      tokenPolicy: { issuer: "https://issuer.example.invalid/", audience: "mcp", maxLifetimeSeconds: 300 },
      tokenVerifier: {
        kind: "token_verifier",
        verify: async (value) => {
          await access.verify(value);
          return verifier.verify(value);
        },
        health: () => Promise.resolve({ ready: true }),
        close: () => Promise.resolve(),
      },
    });
    const client = new Client({ name: "schedule-managed-provider", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("https://runtime.example.invalid/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (resource, init) => {
        const headers = new Headers(init?.headers);
        headers.set("host", "runtime.example.invalid");
        headers.set("origin", "https://client.example.invalid");
        return composition.handler(new Request(resource, { ...init, headers }));
      },
    });
    try {
      expect(await composition.readiness()).toEqual({ ready: true, reasons: [] });
      await client.connect(transport as Parameters<Client["connect"]>[0]);
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([...SCHEDULE_MCP_TOOLS].sort());
      const call = await client.callTool({ name: "maritime.schedule.carriers", arguments: {} });
      expect(call.structuredContent).toMatchObject({
        status: "success",
        data: { carriers: [{ id: "ONE" }] },
      });
    } finally {
      await client.close();
      await composition.close();
    }

    await runtime.close();
    runtime = await loadManagedScheduleProvider(release.environment, { fetchImpl });
    expect(runtime.definitions).toHaveLength(3);
    expect(await runtime.health()).toEqual({ ready: true });
    const restarted = JSON.parse(await readFile(release.statePath, "utf8")) as { readonly revision: number };
    expect(restarted.revision).toBe(1);
    expect(portal.calls).toContain("execute:maritime.schedule.carriers");
  } finally {
    await runtime?.close();
    await portal.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
