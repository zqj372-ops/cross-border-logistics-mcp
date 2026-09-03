import type { ExecutionContext } from "../../platform/context";
import { isTrustedExecutionContext } from "../../platform/context";
import type { AdapterResult, FreightcomRatePort } from "../ports";
import type { FetchImplementation } from "../http-client";
import { readBoundedRegularFile } from "../runtime-file";
import {
  FreightcomRateAdapter,
  type FreightcomRateAdapterOptions,
} from "./freightcom-rate-adapter";
import { DEFAULT_FREIGHTCOM_TEST_BASE_URL } from "./freightcom-test-client";

const SECRET_MAX_BYTES = 8 * 1024;
const FREIGHTCOM_TEST_HOST = "customer-external-api.ssd-test.freightcom.com";
const TENANT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export interface FreightcomTestRuntimeDependencies {
  readonly fetchImpl?: FetchImplementation;
  readonly readSecretFile?: (path: string) => string | Promise<string>;
  readonly clock?: () => Date;
  readonly sleep?: FreightcomRateAdapterOptions["sleep"];
}

function unavailable(code: string, message: string): AdapterResult {
  return {
    status: "blocked",
    data: null,
    sourceRefs: [],
    calculationTrace: [],
    blockers: [{ code, message, severity: "error", field: null }],
    reviewStatus: "manual_review",
  };
}

function split(value: string | undefined): string[] {
  return (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

function enabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "false") return false;
  if (normalized !== "true") {
    throw new Error("MCP_FREIGHTCOM_TEST_ENABLED must be true or false.");
  }
  return true;
}

class TenantBoundFreightcomPort implements FreightcomRatePort {
  readonly #adapter: FreightcomRateAdapter;
  readonly #allowedTenants: ReadonlySet<string>;

  constructor(adapter: FreightcomRateAdapter, allowedTenants: readonly string[]) {
    this.#adapter = adapter;
    this.#allowedTenants = new Set(allowedTenants);
  }

  requestRate(
    input: unknown,
    signal?: AbortSignal,
    context?: ExecutionContext,
  ): Promise<AdapterResult> {
    if (!isTrustedExecutionContext(context)) {
      return Promise.resolve(unavailable(
        "freightcom.execution_context_required",
        "Freightcom test preview requires a server-authenticated execution context.",
      ));
    }
    if (!this.#allowedTenants.has(context.tenantId)) {
      return Promise.resolve(unavailable(
        "freightcom.tenant_not_allowed",
        "The authenticated tenant is not allowed to use the Freightcom test preview.",
      ));
    }
    return this.#adapter.requestRate(input, signal);
  }
}

export function createFreightcomTestAdapterFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: FreightcomTestRuntimeDependencies = {},
): FreightcomRatePort | undefined {
  if (!enabled(env.MCP_FREIGHTCOM_TEST_ENABLED)) return undefined;
  const secretPath = env.MCP_FREIGHTCOM_TEST_AUTH_SECRET_FILE?.trim();
  const outboundHosts = new Set(split(env.MCP_ALLOWED_OUTBOUND_HOSTS).map((host) => host.toLowerCase()));
  const allowedTenants = [...new Set(split(env.MCP_FREIGHTCOM_TEST_ALLOWED_TENANTS))];
  if (
    secretPath === undefined || secretPath.length === 0 ||
    !outboundHosts.has(FREIGHTCOM_TEST_HOST) ||
    allowedTenants.length === 0 ||
    allowedTenants.some((tenant) => tenant === "*" || !TENANT_IDENTIFIER.test(tenant))
  ) return undefined;

  const readSecret = dependencies.readSecretFile ?? (
    (path: string) => readBoundedRegularFile(path, SECRET_MAX_BYTES)
  );
  const adapter = new FreightcomRateAdapter({
    mode: "test",
    baseUrl: DEFAULT_FREIGHTCOM_TEST_BASE_URL,
    allowedHosts: [FREIGHTCOM_TEST_HOST],
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
    maxPollAttempts: 30,
    pollDelayMs: 2_000,
    timeoutMs: 20_000,
    maxResponseBytes: 2 * 1024 * 1024,
    headerProvider: async () => {
      try {
        const value = await readSecret(secretPath);
        if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > SECRET_MAX_BYTES) {
          throw new Error("invalid secret");
        }
        const token = value.trim();
        if (token.length === 0 || /[\r\n]/u.test(token)) throw new Error("invalid secret");
        return { Authorization: token };
      } catch {
        throw new Error("Freightcom authorization is unavailable.");
      }
    },
  });
  return new TenantBoundFreightcomPort(adapter, allowedTenants);
}
