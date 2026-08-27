import {
  createHash,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  initializeSqliteTenantAccessState,
  SqliteTenantAccessStore,
  tenantAccessPaths,
} from "../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import { TenantAccessService } from "../../src/logistics_mcp/control-plane/tenant-access-service";
import { createAdminTenantAccessApiHandler } from "../../src/logistics_mcp/server/admin-tenant-access-api";
import { createProductionAccessGateway } from "./assembly";
import { createAccessGatewayHttpHandler } from "./http";
import {
  FileJwtSigningProvider,
  FileSecretPepperProvider,
} from "./production-crypto";
import {
  RemoteJwksAdminIdentityProvider,
  SystemGatewayClock,
  SystemGatewayRandomSource,
  UnavailableAdminIdentityProvider,
} from "./production-identity";
import {
  initializeSqliteGatewayOperationalState,
  gatewayOperationalPaths,
  SqliteGatewayOperationalStore,
  TenantAccessGatewayRepository,
} from "./production-store";

const PROFILE = "single-node-candidate";
const HEALTH_PATH = "/access/v1/healthz";
const READINESS_PATH = "/access/v1/readyz";
const MAX_ADMIN_BODY_BYTES = 32 * 1024;
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export interface GatewaySecretPaths {
  readonly secretsDir: string;
  readonly jwtSigningKeyPath: string;
  readonly jwtKeyHistoryPath: string;
  readonly credentialPepperPath: string;
}

export function gatewaySecretPaths(applicationRoot: string): GatewaySecretPaths {
  const secretsDir = join(resolve(applicationRoot), ".secrets");
  return Object.freeze({
    secretsDir,
    jwtSigningKeyPath: join(secretsDir, "jwt-signing-key.pem"),
    jwtKeyHistoryPath: join(secretsDir, "jwt-key-history.json"),
    credentialPepperPath: join(secretsDir, "credential-pepper.bin"),
  });
}

function normalizedRoot(applicationRoot: string): string {
  if (!isAbsolute(applicationRoot)) throw new TypeError("Application root must be absolute.");
  const root = realpathSync(resolve(applicationRoot));
  const entry = lstatSync(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new TypeError("Application root must be a real directory.");
  }
  return root;
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function initializeAccessGatewayState(input: Readonly<{
  applicationRoot: string;
  instanceId: string;
  managementTenantId: string;
}>): Promise<Readonly<{
  jwtPublicKeySha256: string;
  pepperSha256: string;
}>> {
  const root = normalizedRoot(input.applicationRoot);
  const runtimeDir = join(root, ".runtime");
  const secrets = gatewaySecretPaths(root);
  const tenantPaths = tenantAccessPaths(root);
  const operationalPaths = gatewayOperationalPaths(root);
  if (
    entryExists(secrets.secretsDir) ||
    entryExists(tenantPaths.stateDir) ||
    entryExists(operationalPaths.stateDir)
  ) {
    throw new TypeError("Access Gateway state is already initialized or incomplete.");
  }
  const runtimeExisted = entryExists(runtimeDir);
  try {
    mkdirSync(runtimeDir, { mode: 0o700 });
    chmodSync(runtimeDir, 0o700);
    mkdirSync(secrets.secretsDir, { mode: 0o700 });
    chmodSync(secrets.secretsDir, 0o700);
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
    const publicDer = publicKey.export({ type: "spki", format: "der" });
    const pepper = randomBytes(48);
    writeFileSync(secrets.jwtSigningKeyPath, privatePem, { flag: "wx", mode: 0o400 });
    writeFileSync(secrets.credentialPepperPath, pepper, { flag: "wx", mode: 0o400 });
    chmodSync(secrets.jwtSigningKeyPath, 0o400);
    chmodSync(secrets.credentialPepperPath, 0o400);
    await initializeSqliteTenantAccessState({
      applicationRoot: root,
      instanceId: input.instanceId,
      managementTenantId: input.managementTenantId,
    });
    await initializeSqliteGatewayOperationalState({
      applicationRoot: root,
      instanceId: input.instanceId,
    });
    return Object.freeze({
      jwtPublicKeySha256: createHash("sha256").update(publicDer).digest("hex"),
      pepperSha256: createHash("sha256").update(pepper).digest("hex"),
    });
  } catch (error) {
    rmSync(secrets.secretsDir, { recursive: true, force: true });
    rmSync(tenantPaths.stateDir, { recursive: true, force: true });
    rmSync(operationalPaths.stateDir, { recursive: true, force: true });
    if (!runtimeExisted) rmSync(runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

function requiredSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function listSetting(name: string): readonly string[] {
  const values = requiredSetting(name).split(",").map((value) => value.trim());
  if (values.some((value) => value.length === 0) || new Set(values).size !== values.length) {
    throw new Error(`${name} must contain unique non-empty values.`);
  }
  return Object.freeze(values);
}

function positiveIntegerSetting(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

function consoleRootFromEntry(): string {
  const entryDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(entryDirectory, "../../access-console"),
    resolve(entryDirectory, "../../apps/access-console"),
  ];
  const selected = candidates.find((candidate) => {
    try {
      return statSync(join(candidate, "index.html")).isFile();
    } catch {
      return false;
    }
  });
  if (selected === undefined) throw new Error("Access Console root is unavailable.");
  return selected;
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  securityHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", String(Buffer.byteLength(serialized)));
  response.end(serialized);
}

function sendAsset(response: ServerResponse, path: string, contentType: string): void {
  const body = readFileSync(path);
  securityHeaders(response);
  response.statusCode = 200;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", String(body.byteLength));
  response.end(body);
}

function staticConsole(
  request: IncomingMessage,
  response: ServerResponse,
  consoleRoot: string,
): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const path = (request.url ?? "/").split("?", 1)[0];
  const asset = path === "/" || path === "/access-console" || path === "/access-console/"
    ? ["index.html", "text/html; charset=utf-8"] as const
    : path === "/access-console/app.js"
      ? ["app.js", "text/javascript; charset=utf-8"] as const
      : path === "/access-console/styles.css"
        ? ["styles.css", "text/css; charset=utf-8"] as const
        : null;
  if (asset === null) return false;
  sendAsset(response, join(consoleRoot, asset[0]), asset[1]);
  return true;
}

type AdminProvider = UnavailableAdminIdentityProvider | RemoteJwksAdminIdentityProvider;

function adminProviderFromEnvironment(managementTenantId: string): Readonly<{
  provider: AdminProvider;
  configured: boolean;
}> {
  const values = [
    process.env.ACCESS_GATEWAY_ADMIN_JWKS_URL?.trim(),
    process.env.ACCESS_GATEWAY_ADMIN_ISSUER?.trim(),
    process.env.ACCESS_GATEWAY_ADMIN_AUDIENCE?.trim(),
    process.env.ACCESS_GATEWAY_ADMIN_JWKS_HOST?.trim(),
  ];
  const configured = values.filter((value) => value !== undefined && value.length > 0);
  if (configured.length === 0) {
    return Object.freeze({ provider: new UnavailableAdminIdentityProvider(), configured: false });
  }
  if (configured.length !== values.length) {
    throw new Error("Administrator IdP settings must be supplied together.");
  }
  return Object.freeze({
    provider: new RemoteJwksAdminIdentityProvider({
      jwksUrl: values[0]!,
      issuer: values[1]!,
      audience: values[2]!,
      allowedHosts: Object.freeze([values[3]!] as const),
      managementTenantId,
    }),
    configured: true,
  });
}

export interface AccessGatewayStartHandle {
  readonly close: () => Promise<void>;
  readonly port: number;
}

export async function startAccessGateway(): Promise<AccessGatewayStartHandle> {
  if (requiredSetting("ACCESS_GATEWAY_PROFILE") !== PROFILE) {
    throw new Error(`ACCESS_GATEWAY_PROFILE must be ${PROFILE}.`);
  }
  const applicationRoot = normalizedRoot(requiredSetting("ACCESS_GATEWAY_APPLICATION_ROOT"));
  const instanceId = requiredSetting("ACCESS_GATEWAY_INSTANCE_ID");
  const managementTenantId = requiredSetting("ACCESS_GATEWAY_MANAGEMENT_TENANT_ID");
  const issuer = requiredSetting("ACCESS_GATEWAY_JWT_ISSUER");
  const audience = requiredSetting("ACCESS_GATEWAY_JWT_AUDIENCE");
  const pepperVersion = requiredSetting("ACCESS_GATEWAY_PEPPER_VERSION");
  const allowedHosts = listSetting("ACCESS_GATEWAY_ALLOWED_HOSTS");
  const allowedOrigins = listSetting("ACCESS_GATEWAY_ALLOWED_ORIGINS");
  const trustedProxyAddresses = listSetting("ACCESS_GATEWAY_TRUSTED_PROXY_ADDRESSES");
  if (trustedProxyAddresses.some((value) => isIP(value) === 0)) {
    throw new Error("ACCESS_GATEWAY_TRUSTED_PROXY_ADDRESSES must contain IP addresses.");
  }
  const port = positiveIntegerSetting("ACCESS_GATEWAY_PORT", 8081, 65_535);
  const rateLimitPerMinute = positiveIntegerSetting(
    "ACCESS_GATEWAY_RATE_LIMIT_PER_MINUTE",
    30,
    10_000,
  );
  const secrets = gatewaySecretPaths(applicationRoot);
  const privateKeyPath = process.env.ACCESS_GATEWAY_JWT_PRIVATE_KEY_PATH?.trim() ||
    secrets.jwtSigningKeyPath;
  const keyHistoryPath = process.env.ACCESS_GATEWAY_JWT_KEY_HISTORY_PATH?.trim() ||
    secrets.jwtKeyHistoryPath;
  const pepperPath = process.env.ACCESS_GATEWAY_PEPPER_PATH?.trim() ||
    secrets.credentialPepperPath;
  const jwtTtlSeconds = positiveIntegerSetting("ACCESS_GATEWAY_JWT_TTL_SECONDS", 300, 900);
  const keyRetentionSeconds = positiveIntegerSetting(
    "ACCESS_GATEWAY_JWT_KEY_RETENTION_SECONDS",
    1_230,
    7 * 24 * 60 * 60,
  );
  if (keyRetentionSeconds < 1_230) {
    throw new Error("ACCESS_GATEWAY_JWT_KEY_RETENTION_SECONDS must cover TTL, skew and JWKS cache.");
  }
  const clock = new SystemGatewayClock();
  const randomSource = new SystemGatewayRandomSource();
  const pepper = new FileSecretPepperProvider({ pepperPath, pepperVersion });
  const signer = new FileJwtSigningProvider({
    privateKeyPath,
    historyPath: keyHistoryPath,
    nowSeconds: () => clock.nowSeconds(),
    retentionSeconds: keyRetentionSeconds,
  });
  const tenantStore = new SqliteTenantAccessStore({
    applicationRoot,
    instanceId,
    managementTenantId,
  });
  const operations = new SqliteGatewayOperationalStore({
    applicationRoot,
    instanceId,
    rateLimitPerMinute,
  });
  const credentials = new TenantAccessGatewayRepository({
    store: tenantStore,
    pepperVersion,
    nowSeconds: () => clock.nowSeconds(),
  });
  const admin = adminProviderFromEnvironment(managementTenantId);
  const tenantAccessService = new TenantAccessService(tenantStore, {
    credentialSecretProvider: {
      hash: (secret, salt) => pepper.hashCredentialSecret({
        secret,
        salt,
        pepperVersion: pepper.pepperVersion,
      }),
      verify: (secret, salt, expectedHash) => pepper.verifyCredentialSecret({
        secret,
        material: { salt, expectedHash, pepperVersion: pepper.pepperVersion },
      }),
    },
  });
  const gateway = createProductionAccessGateway({
    adminIdentityProvider: admin.provider,
    auditRepository: operations,
    clock,
    credentialRepository: credentials,
    jwtSigningProvider: signer,
    randomSource,
    rateLimitRepository: operations,
    revocationRepository: credentials,
    secretPepperProvider: pepper,
  }, {
    issuer,
    audience,
    defaultTtlSeconds: jwtTtlSeconds,
  });
  const gatewayHandler = createAccessGatewayHttpHandler({
    gateway,
    allowedHosts,
    allowedOrigins,
    trustedProxyAddresses,
    allowLoopbackHttp: true,
  });
  const adminHandler = createAdminTenantAccessApiHandler({
    dataMode: "production",
    productionWritesEnabled: true,
    service: tenantAccessService,
    authenticate: async (token) => {
      const principal = await admin.provider.authenticateAdmin(token);
      const sessionDigest = createHash("sha256").update(token, "utf8").digest("hex").slice(0, 24);
      return {
        tenant_id: principal.tenantId,
        actor_id: principal.actorId,
        actor_role: principal.role,
        roles: principal.roles,
        scopes: principal.scopes,
        client_id: "access_console",
        session_id: `idp_${sessionDigest}`,
        expires_at: clock.nowSeconds() + 60,
      };
    },
    managementTenantId,
    allowedOrigins,
    allowedHosts,
    allowLoopbackHttp: true,
    trustedProxyAddresses,
    maxBodyBytes: MAX_ADMIN_BODY_BYTES,
  });
  const consoleRoot = consoleRootFromEntry();
  for (const name of ["index.html", "styles.css", "app.js"] as const) {
    if (!statSync(join(consoleRoot, name)).isFile()) {
      throw new Error("Access Console assets are incomplete.");
    }
  }
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?", 1)[0];
    if (request.method === "GET" && path === HEALTH_PATH) {
      sendJson(response, 200, {
        status: "success",
        data: { service: "access-gateway", profile: PROFILE, process_ready: true },
      });
      return;
    }
    if (request.method === "GET" && path === READINESS_PATH) {
      void Promise.all([
        tenantStore.health(),
        operations.health(),
        signer.getJwks(),
        admin.provider.health(),
      ]).then(([tenantHealth, operationHealth, jwks, adminHealth]) => {
        const operationalReady = tenantHealth.ready && operationHealth.ready &&
          jwks.keys.length >= 1 && jwks.keys.length <= 2;
        sendJson(response, operationalReady ? 200 : 503, {
          status: operationalReady ? "manual_review" : "unavailable",
          data: {
            service: "access-gateway",
            profile: PROFILE,
            operational_ready: operationalReady,
            admin_idp_ready: adminHealth.ready,
            production_eligible: false,
            audit_count: operationHealth.auditCount,
          },
          blockers: [
            ...(admin.configured && adminHealth.ready ? [] : ["enterprise_idp_unconfigured"]),
            "kms_signer_unconfigured",
            "managed_database_unconfigured",
          ],
        });
      }).catch(() => sendJson(response, 503, {
        status: "unavailable",
        data: null,
        blockers: ["access_gateway_dependency_unavailable"],
      }));
      return;
    }
    if (gatewayHandler.handle(request, response)) return;
    if (adminHandler.handle(request, response)) return;
    if (staticConsole(request, response, consoleRoot)) return;
    securityHeaders(response);
    response.statusCode = 404;
    response.setHeader("cache-control", "no-store");
    response.end();
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolvePromise();
    });
  });
  let closed = false;
  return Object.freeze({
    port,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => error === undefined ? resolvePromise() : reject(error));
      });
      await Promise.all([
        operations.close(),
        tenantStore.close(),
        "close" in admin.provider ? admin.provider.close() : Promise.resolve(),
      ]);
    },
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void startAccessGateway().then((runtime) => {
    const shutdown = () => void runtime.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }).catch(() => {
    console.error("Access Gateway startup failed.");
    process.exitCode = 1;
  });
}
