import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  postgresConfigurationFromEnvironment,
  readPostgresPassword,
} from "../../services/access-gateway/postgres-store";
import { evaluateAccessGatewayReadiness } from "../../services/access-gateway/start";

const roots: string[] = [];

function securePasswordFile(): string {
  const root = mkdtempSync(join(tmpdir(), "logistics-mcp-postgres-config-"));
  roots.push(root);
  const path = join(root, "password");
  writeFileSync(path, "test-password\n", { mode: 0o400 });
  chmodSync(path, 0o400);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PostgreSQL Access Gateway configuration", () => {
  it("requires explicit, file-backed connection settings without exposing the password", () => {
    const passwordFile = securePasswordFile();
    const configuration = postgresConfigurationFromEnvironment({
      ACCESS_GATEWAY_STORE_BACKEND: "postgresql",
      ACCESS_GATEWAY_POSTGRES_HOST: "mcp-postgresql",
      ACCESS_GATEWAY_POSTGRES_PORT: "5432",
      ACCESS_GATEWAY_POSTGRES_DATABASE: "freightclaw_mcp",
      ACCESS_GATEWAY_POSTGRES_USER: "freightclaw_mcp",
      ACCESS_GATEWAY_POSTGRES_PASSWORD_FILE: passwordFile,
      ACCESS_GATEWAY_POSTGRES_SCHEMA: "access_gateway",
      ACCESS_GATEWAY_POSTGRES_SSL_MODE: "disable",
      ACCESS_GATEWAY_POSTGRES_MAX_CONNECTIONS: "8",
    });

    expect(configuration).toEqual({
      backend: "postgresql",
      host: "mcp-postgresql",
      port: 5432,
      database: "freightclaw_mcp",
      user: "freightclaw_mcp",
      passwordFile,
      schema: "access_gateway",
      sslMode: "disable",
      maxConnections: 8,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statementTimeoutMillis: 5_000,
    });
    expect(JSON.stringify(configuration)).not.toContain("test-password");
    expect(readPostgresPassword(passwordFile)).toBe("test-password");
  });

  it("rejects plaintext secrets, connection URLs and injectable schema names", () => {
    const passwordFile = securePasswordFile();
    const base = {
      ACCESS_GATEWAY_STORE_BACKEND: "postgresql",
      ACCESS_GATEWAY_POSTGRES_HOST: "mcp-postgresql",
      ACCESS_GATEWAY_POSTGRES_PORT: "5432",
      ACCESS_GATEWAY_POSTGRES_DATABASE: "freightclaw_mcp",
      ACCESS_GATEWAY_POSTGRES_USER: "freightclaw_mcp",
      ACCESS_GATEWAY_POSTGRES_PASSWORD_FILE: passwordFile,
      ACCESS_GATEWAY_POSTGRES_SCHEMA: "access_gateway",
      ACCESS_GATEWAY_POSTGRES_SSL_MODE: "disable",
    } satisfies NodeJS.ProcessEnv;

    expect(() => postgresConfigurationFromEnvironment({
      ...base,
      ACCESS_GATEWAY_POSTGRES_PASSWORD: "plaintext",
    })).toThrow(/plaintext PostgreSQL secrets/u);
    expect(() => postgresConfigurationFromEnvironment({
      ...base,
      DATABASE_URL: "postgresql://example.invalid/database",
    })).toThrow(/connection URLs/u);
    expect(() => postgresConfigurationFromEnvironment({
      ...base,
      ACCESS_GATEWAY_POSTGRES_SCHEMA: "access_gateway;drop schema public",
    })).toThrow(/schema/u);
  });

  it("reports PostgreSQL as configured without promoting the candidate to production", () => {
    expect(evaluateAccessGatewayReadiness({
      tenantStoreReady: true,
      operationStoreReady: true,
      signingKeyCount: 1,
      adminConfigured: true,
      adminReady: true,
      databaseBackend: "postgresql",
    })).toEqual({
      httpStatus: 200,
      status: "manual_review",
      operationalReady: true,
      blockers: [
        "kms_signer_unconfigured",
        "managed_database_qualification_pending",
      ],
    });
  });
});
