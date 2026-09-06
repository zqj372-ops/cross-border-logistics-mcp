import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createPortalFixtureRuntime } from "../../services/access-gateway/portal/fixture";
import { createPortalMachineHttpHandler } from "../../services/access-gateway/portal/machine-http";
import { startPortalServer } from "../../services/access-gateway/portal/server";
import { createBusinessAccessFixture } from "../../services/access-gateway/portal/business-access/fixture";
import { createBusinessMachineHttpHandler } from "../../services/access-gateway/portal/business-access/http";
import { loadPortalBusinessService } from "../../services/access-gateway/portal/business/config";
import { createProductionT0HttpHandler } from "../../services/access-gateway/portal/t0-http";

if (!process.argv.includes("--fixtures")) throw new Error("explicit_fixtures_argument_required");
const port = Number(process.env.PORTAL_FIXTURE_PORT ?? "8882");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("fixture_port_invalid");
const origin = `http://127.0.0.1:${port}`;
const databaseDirectory = resolve(process.env.PORTAL_FIXTURE_DIRECTORY ?? ".runtime/console-fixture");
const runtime = await createPortalFixtureRuntime({ databaseDirectory });
const boundaries = { allowedHosts: [`127.0.0.1:${port}`], allowedOrigins: [origin] };
try {
  const businessService = await loadPortalBusinessService({ portalService: runtime.service, ...(process.env.PORTAL_BUSINESS_CONFIG_FILE ? { configPath: process.env.PORTAL_BUSINESS_CONFIG_FILE } : {}), allowLoopbackFixtures: true });
  const pepperPath = resolve(databaseDirectory, "business-fixture.pepper");
  if (!existsSync(pepperPath)) writeFileSync(pepperPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  const pepperStat = lstatSync(pepperPath);
  if (!pepperStat.isFile() || pepperStat.isSymbolicLink() || pepperStat.size !== 32 || (pepperStat.mode & 0o077) !== 0) throw new Error("business_fixture_pepper_invalid");
  const credentialPepper = readFileSync(pepperPath);
  const businessAccess = await createBusinessAccessFixture({ databasePath: resolve(databaseDirectory, "business-access.sqlite"), portalService: runtime.service, credentialPepper, operationAuthority: { isAvailable: (tenantId, operation) => businessService.isAvailable(tenantId, operation) }, tenantClientAuthority: { requireActive: (tenantId, clientId) => runtime.requireActiveTenantClient(tenantId, clientId) } });
  credentialPepper.fill(0);
  const unifiedBridge = runtime.createUnifiedBridge(businessAccess.service);
  const machine = createPortalMachineHttpHandler({ mode: "fixtures", bridge: unifiedBridge, ...boundaries });
  const t0Machine = createProductionT0HttpHandler({ mode: "fixtures", bridge: unifiedBridge, ...boundaries, trustedProxyAddresses: [] });
  const businessMachine = createBusinessMachineHttpHandler({ mode: "fixtures", service: businessAccess.service, executor: { execute: async (request) => businessService.executeMachine(request) }, ...boundaries, trustedProxyAddresses: [] });
  const server = await startPortalServer({ mode: "fixtures", service: runtime.service, bridge: unifiedBridge, organizationBridge: runtime.organizationBridge, businessService, businessAccessService: businessAccess.service, businessMachineHandler: { handle: (request,response) => t0Machine.handle(request,response)||businessMachine.handle(request,response) }, port, staticDirectory: "dist/console", machineHandler: machine });
  console.log(`FreightClaw local acceptance workspace: ${server.origin}/console/`);
  console.log("Isolated fixture identities and local storage. Business availability is verified per request.");
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await server.close(); businessAccess.repository.close(); await runtime.close(); process.exitCode = 0; };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
} catch (error) { await runtime.close(); throw error; }
