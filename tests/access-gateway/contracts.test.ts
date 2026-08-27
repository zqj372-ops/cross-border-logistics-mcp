import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { canonicalJsonHash } from "../../services/access-gateway/canonical-json";

const schemaDirectory = fileURLToPath(new URL("../../schemas/access-gateway/", import.meta.url));

function createAjv(): Ajv2020 {
  return new Ajv2020({ allErrors: true, strict: true });
}

function assertClosedObjects(value: unknown, path = "schema"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertClosedObjects(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (record.type === "object") {
    expect(record.additionalProperties, `${path} must be closed`).toBe(false);
    expect(record.required, `${path} must declare required fields`).toBeDefined();
  }
  Object.entries(record).forEach(([key, item]) => assertClosedObjects(item, `${path}.${key}`));
}

describe("Unified Access Gateway Draft 2020-12 contracts", () => {
  it("ships closed schemas for exchange, errors, and JWKS", () => {
    const files = readdirSync(schemaDirectory).filter((file) => file.endsWith(".schema.json")).sort();
    expect(files).toEqual([
      "error-envelope.schema.json",
      "exchange-request.schema.json",
      "exchange-response.schema.json",
      "jwks-response.schema.json",
    ]);

    const ajv = createAjv();
    for (const file of files) {
      const schema = JSON.parse(readFileSync(join(schemaDirectory, file), "utf8")) as Record<string, unknown>;
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      assertClosedObjects(schema);
      expect(() => ajv.compile(schema)).not.toThrow();
    }
  });

  it("rejects unknown request fields and non-T0 tools", () => {
    const schema = JSON.parse(readFileSync(join(schemaDirectory, "exchange-request.schema.json"), "utf8")) as object;
    const validate = createAjv().compile(schema);
    expect(validate({
      schema_version: "2026-08-27.v1",
      requested_tool_names: ["cargo.calculate"],
    })).toBe(true);
    expect(validate({
      schema_version: "2026-08-27.v1",
      requested_tool_names: ["cargo.calculate"],
      tenant_id: "tenant_leak",
    })).toBe(false);
    expect(validate({
      schema_version: "2026-08-27.v1",
      requested_tool_names: ["quote.canada_final_mile.calculate"],
    })).toBe(false);
  });

  it("pins stable error mappings and bounded success/JWKS response shapes", () => {
    const ajv = createAjv();
    const errorSchema = JSON.parse(
      readFileSync(join(schemaDirectory, "error-envelope.schema.json"), "utf8"),
    ) as object;
    const validateError = ajv.compile(errorSchema);
    expect(validateError({
      schema_version: "2026-08-27.v1",
      status: "blocked",
      data: null,
      code: "authentication_failed",
      request_id: "req_contract_0001",
    })).toBe(true);
    expect(validateError({
      schema_version: "2026-08-27.v1",
      status: "needs_input",
      data: null,
      code: "authentication_failed",
      request_id: "req_contract_0002",
    })).toBe(false);

    const successSchema = JSON.parse(
      readFileSync(join(schemaDirectory, "exchange-response.schema.json"), "utf8"),
    ) as object;
    const validateSuccess = createAjv().compile(successSchema);
    const success = {
      schema_version: "2026-08-27.v1",
      status: "success",
      data: {
        access_token: "header.payload.signature",
        token_type: "Bearer",
        expires_in: 300,
        tool_names: ["cargo.calculate"],
        session_ref: "auth_contract_0001",
        request_id: "req_contract_0003",
      },
      warnings: [],
      blockers: [],
    };
    expect(validateSuccess(success)).toBe(true);
    expect(validateSuccess({
      ...success,
      warnings: [{ code: "unexpected", message: "not allowed on success" }],
    })).toBe(false);

    const jwksSchema = JSON.parse(
      readFileSync(join(schemaDirectory, "jwks-response.schema.json"), "utf8"),
    ) as object;
    const validateJwks = createAjv().compile(jwksSchema);
    const publicKey = {
      kty: "RSA",
      kid: "contract-key-0001",
      alg: "RS256",
      use: "sig",
      n: "A".repeat(342),
      e: "AQAB",
    };
    expect(validateJwks({ keys: [publicKey] })).toBe(true);
    expect(validateJwks({ keys: [publicKey, publicKey] })).toBe(false);
  });

  it("makes idempotency hashes independent of object insertion order", () => {
    expect(canonicalJsonHash("access-gateway/idempotency/v1", {
      action: "tenant.create",
      request: { display_name: "Demo", tenant_id: "tenant_a" },
    })).toBe(canonicalJsonHash("access-gateway/idempotency/v1", {
      request: { tenant_id: "tenant_a", display_name: "Demo" },
      action: "tenant.create",
    }));
    expect(canonicalJsonHash("access-gateway/idempotency/v1", {
      action: "tenant.create",
      request: { display_name: "Other", tenant_id: "tenant_a" },
    })).not.toBe(canonicalJsonHash("access-gateway/idempotency/v1", {
      action: "tenant.create",
      request: { display_name: "Demo", tenant_id: "tenant_a" },
    }));
  });
});
