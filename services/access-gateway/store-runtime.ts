import type { TenantAccessRepository } from "../../src/logistics_mcp/control-plane/tenant-access-repository";
import {
  SqliteTenantAccessStore,
} from "../../src/logistics_mcp/control-plane/sqlite-tenant-access-store";
import type { GatewayAuditRepository, RateLimitRepository } from "./ports";
import {
  PostgresGatewayStore,
  postgresConfigurationFromEnvironment,
} from "./postgres-store";
import type { GatewayOperationsReader } from "./operations-overview";
import { SqliteGatewayOperationalStore } from "./production-store";

export type GatewayStoreBackend = "sqlite" | "postgresql";

export interface GatewayOperationalStore extends
  GatewayAuditRepository,
  RateLimitRepository,
  GatewayOperationsReader {
  health(): Promise<{ readonly ready: boolean; readonly auditCount: number }>;
  close(): Promise<void>;
}

export interface OpenGatewayStoresResult {
  readonly backend: GatewayStoreBackend;
  readonly tenantStore: TenantAccessRepository;
  readonly operationalStore: GatewayOperationalStore;
  close(): Promise<void>;
}

export function gatewayStoreBackendFromEnvironment(
  environment: NodeJS.ProcessEnv,
): GatewayStoreBackend {
  const value = environment.ACCESS_GATEWAY_STORE_BACKEND?.trim() || "sqlite";
  if (value !== "sqlite" && value !== "postgresql") {
    throw new Error("ACCESS_GATEWAY_STORE_BACKEND must be sqlite or postgresql.");
  }
  return value;
}

export async function openGatewayStores(input: Readonly<{
  environment: NodeJS.ProcessEnv;
  applicationRoot: string;
  instanceId: string;
  managementTenantId: string;
  rateLimitPerMinute?: number;
  legacyCredentialPepperVersion?: string;
}>): Promise<OpenGatewayStoresResult> {
  const backend = gatewayStoreBackendFromEnvironment(input.environment);
  if (backend === "postgresql") {
    if (input.legacyCredentialPepperVersion !== undefined) {
      throw new Error("Legacy SQLite pepper migration setting is invalid for PostgreSQL.");
    }
    const store = await PostgresGatewayStore.open({
      configuration: postgresConfigurationFromEnvironment(input.environment),
      instanceId: input.instanceId,
      managementTenantId: input.managementTenantId,
      ...(input.rateLimitPerMinute === undefined
        ? {}
        : { rateLimitPerMinute: input.rateLimitPerMinute }),
    });
    return Object.freeze({
      backend,
      tenantStore: store,
      operationalStore: store,
      close: () => store.close(),
    });
  }

  const tenantStore = new SqliteTenantAccessStore({
    applicationRoot: input.applicationRoot,
    instanceId: input.instanceId,
    managementTenantId: input.managementTenantId,
    ...(input.legacyCredentialPepperVersion === undefined
      ? {}
      : { legacyCredentialPepperVersion: input.legacyCredentialPepperVersion }),
  });
  try {
    const operationalStore = new SqliteGatewayOperationalStore({
      applicationRoot: input.applicationRoot,
      instanceId: input.instanceId,
      ...(input.rateLimitPerMinute === undefined
        ? {}
        : { rateLimitPerMinute: input.rateLimitPerMinute }),
    });
    let closed = false;
    return Object.freeze({
      backend,
      tenantStore,
      operationalStore,
      close: async () => {
        if (closed) return;
        closed = true;
        await Promise.all([operationalStore.close(), tenantStore.close()]);
      },
    });
  } catch (error) {
    await tenantStore.close().catch(() => undefined);
    throw error;
  }
}
