import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalControlHash,
  CanonicalControlHashError,
  type ControlHashPayload,
} from "../../src/logistics_mcp/control-plane/canonical-control-hash";

const digestA = `sha256:${"1".repeat(64)}` as const;
const digestB = `sha256:${"2".repeat(64)}` as const;

const registerPayload = {
  action: "packages.register",
  actor_ref: "actor_operator",
  management_tenant_id: "tenant_demo",
  request: {
    descriptor_digest: digestA,
    module_id: "cargo",
    schema_version: "2026-08-22.v1",
    version: "1.0.0",
  },
} as const satisfies ControlHashPayload;

const previewPayload = {
  action: "deployments.preview",
  base_release_revision: 0,
  creator_actor_ref: "actor_operator",
  desired_modules: [
    {
      descriptor_digest: digestA,
      module_id: "cargo",
      version: "1.0.0",
    },
  ],
  intent: "change",
  inventory_refs: [
    {
      descriptor_digest: digestA,
      module_id: "cargo",
      version: "1.0.0",
    },
  ],
  management_tenant_id: "tenant_demo",
  policy_version: "writable-module-control-plane-v1",
  preview_ttl_seconds: 900,
  schema_version: "2026-08-22.v1",
  validation: {
    base_matches: true,
    desired_modules_valid: true,
    inventory_matches: true,
    minimum_active_modules: true,
    reason_codes: [],
  },
} as const satisfies ControlHashPayload;

function expectHashError(candidate: unknown, code: string): void {
  let thrown: unknown;
  try {
    canonicalControlHash(candidate as Parameters<typeof canonicalControlHash>[0]);
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CanonicalControlHashError);
  expect(thrown).toMatchObject({ code });
}

function expectPayloadError(
  payload: unknown,
  code: string,
  domain: "request" | "preview" = "request",
): void {
  expectHashError(
    { domain, schemaVersion: "2026-08-22.v1", payload },
    code,
  );
}

describe("canonical control hash", () => {
  it("matches the locked request and preview golden vectors", () => {
    expect(
      canonicalControlHash({
        domain: "request",
        schemaVersion: "2026-08-22.v1",
        payload: registerPayload,
      }).hash,
    ).toBe(
      "mcp-control-hash/v1/request/sha256:1dc6b77eedfc0639d6fb264c4e0557bdeb39a46bbabb968db13a6be7ee8c86da",
    );

    expect(
      canonicalControlHash({
        domain: "preview",
        schemaVersion: "2026-08-22.v1",
        payload: previewPayload,
      }).hash,
    ).toBe(
      "mcp-control-hash/v1/preview/sha256:13348c6594c3d24cc30aeb62f839e6b6fd1fe133830a2fdad11b8d4b59b6e503",
    );

    expect(
      canonicalControlHash({
        domain: "preview",
        schemaVersion: "2026-08-22.v1",
        payload: registerPayload,
      }).hash,
    ).toBe(
      "mcp-control-hash/v1/preview/sha256:7f756bdf267eb3ef54b6ee5a3211a947255f491072f72f92dc7f844e6024c04b",
    );
  });

  it("uses literal NUL frame bytes and RFC 8785 object-key ordering", () => {
    const result = canonicalControlHash({
      domain: "request",
      schemaVersion: "2026-08-22.v1",
      payload: registerPayload,
    });
    const frame = Buffer.from(result.frameHex, "hex");
    const separators = [...frame.entries()]
      .filter(([, value]) => value === 0)
      .map(([index]) => index);

    expect(separators).toHaveLength(4);
    expect(frame.subarray(0, separators[0]).toString("ascii")).toBe(
      "MCP-CONTROL-HASH",
    );
    expect(
      frame.subarray(separators[0]! + 1, separators[1]).toString("ascii"),
    ).toBe("v1");
    expect(
      frame.subarray(separators[1]! + 1, separators[2]).toString("ascii"),
    ).toBe("request");
    expect(
      frame.subarray(separators[2]! + 1, separators[3]).toString("ascii"),
    ).toBe("2026-08-22.v1");
    expect(frame.subarray(separators[3]! + 1).toString("utf8")).toBe(
      result.canonicalJson,
    );
    expect(result.canonicalJson.startsWith('{"action":')).toBe(true);
    expect(result.canonicalJson.indexOf('"actor_ref"')).toBeLessThan(
      result.canonicalJson.indexOf('"management_tenant_id"'),
    );
  });

  it("normalizes object and set order without mutating caller input", () => {
    const first = {
      ...previewPayload,
      desired_modules: [
        ...previewPayload.desired_modules,
        {
          descriptor_digest: digestB,
          module_id: "container",
          version: "2.0.0",
        },
      ],
      inventory_refs: [
        ...previewPayload.inventory_refs,
        {
          descriptor_digest: digestB,
          module_id: "container",
          version: "2.0.0",
        },
      ],
      validation: {
        ...previewPayload.validation,
        reason_codes: ["validation.zeta", "validation.alpha"],
      },
    } satisfies ControlHashPayload;
    const reordered = {
      validation: {
        reason_codes: ["validation.alpha", "validation.zeta"],
        minimum_active_modules: true,
        inventory_matches: true,
        desired_modules_valid: true,
        base_matches: true,
      },
      schema_version: first.schema_version,
      preview_ttl_seconds: first.preview_ttl_seconds,
      policy_version: first.policy_version,
      management_tenant_id: first.management_tenant_id,
      inventory_refs: [...first.inventory_refs].reverse(),
      intent: first.intent,
      desired_modules: [...first.desired_modules].reverse(),
      creator_actor_ref: first.creator_actor_ref,
      base_release_revision: first.base_release_revision,
      action: first.action,
    } satisfies ControlHashPayload;
    const before = structuredClone(first);

    const firstResult = canonicalControlHash({
      domain: "preview",
      schemaVersion: first.schema_version,
      payload: first,
    });
    const secondResult = canonicalControlHash({
      domain: "preview",
      schemaVersion: reordered.schema_version,
      payload: reordered,
    });

    expect(secondResult.hash).toBe(firstResult.hash);
    expect(secondResult.canonicalJson).toBe(firstResult.canonicalJson);
    expect(first).toEqual(before);
    expect(Object.isFrozen(firstResult)).toBe(true);
  });

  it("separates domains and matching future schema versions", () => {
    const request = canonicalControlHash({
      domain: "request",
      schemaVersion: "2026-08-22.v1",
      payload: registerPayload,
    });
    const previewDomain = canonicalControlHash({
      domain: "preview",
      schemaVersion: "2026-08-22.v1",
      payload: registerPayload,
    });
    const futurePayload = {
      ...registerPayload,
      request: { ...registerPayload.request, schema_version: "2026-08-22.v2" },
    } satisfies ControlHashPayload;
    const future = canonicalControlHash({
      domain: "request",
      schemaVersion: "2026-08-22.v2",
      payload: futurePayload,
    });

    expect(previewDomain.hash).not.toBe(request.hash);
    expect(future.hash).not.toBe(request.hash);
    expectHashError(
      {
        domain: "request",
        schemaVersion: "2026-08-22.v2",
        payload: registerPayload,
      },
      "schema_version_mismatch",
    );
  });

  it("keeps preview change and rollback payloads as a closed union", () => {
    const rollback = {
      ...previewPayload,
      intent: "rollback",
      target_release_id: "release_001",
    } as const satisfies ControlHashPayload;

    expect(() =>
      canonicalControlHash({
        domain: "preview",
        schemaVersion: rollback.schema_version,
        payload: rollback,
      }),
    ).not.toThrow();
    expectPayloadError(
      { ...previewPayload, target_release_id: null },
      "payload_fields_invalid",
      "preview",
    );
    expectPayloadError(
      { ...previewPayload, intent: "rollback" },
      "payload_fields_invalid",
      "preview",
    );
  });

  it("rejects inherited, symbol, extra, unsafe, and malformed values", () => {
    const inherited = Object.create(registerPayload) as ControlHashPayload;
    const symbolPayload = { ...registerPayload } as ControlHashPayload & {
      [key: symbol]: string;
    };
    symbolPayload[Symbol("secret")] = "hidden";

    expectHashError(
      { domain: "request", schemaVersion: "2026-08-22.v1", payload: inherited },
      "payload_fields_invalid",
    );
    expectHashError(
      {
        domain: "request",
        schemaVersion: "2026-08-22.v1",
        payload: symbolPayload,
      },
      "payload_fields_invalid",
    );
    expectPayloadError(
      { ...registerPayload, unexpected: "value" },
      "payload_fields_invalid",
    );
    expectPayloadError(
      { ...registerPayload, actor_ref: "actor_\ud800" },
      "text_invalid",
    );
    expectPayloadError(
      { ...previewPayload, base_release_revision: Number.NaN },
      "integer_invalid",
      "preview",
    );
    expectPayloadError(
      { ...previewPayload, preview_ttl_seconds: Number.MAX_SAFE_INTEGER + 1 },
      "integer_invalid",
      "preview",
    );
    expectPayloadError(
      {
        ...registerPayload,
        request: { ...registerPayload.request, module_id: undefined },
      },
      "identifier_invalid",
    );
  });

  it("rejects sparse or decorated collection arrays", () => {
    const extraKeyModules = [...previewPayload.desired_modules] as unknown[] & {
      unexpected?: string;
    };
    extraKeyModules.unexpected = "hidden-from-map";

    const symbolModules = [...previewPayload.desired_modules] as unknown[] & {
      [key: symbol]: string;
    };
    symbolModules[Symbol("hidden")] = "hidden-from-map";

    expectPayloadError(
      { ...previewPayload, desired_modules: extraKeyModules },
      "array_invalid",
      "preview",
    );
    expectPayloadError(
      { ...previewPayload, desired_modules: symbolModules },
      "array_invalid",
      "preview",
    );
    expectPayloadError(
      { ...previewPayload, desired_modules: new Array(1) },
      "array_invalid",
      "preview",
    );
  });

  it("rejects accessors without evaluating them", () => {
    const accessorPayload = { ...registerPayload } as Record<string, unknown>;
    let accessorReads = 0;
    Object.defineProperty(accessorPayload, "actor_ref", {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error("must not run");
      },
    });

    expectPayloadError(accessorPayload, "payload_fields_invalid");

    const accessorModules = [...previewPayload.desired_modules] as unknown[];
    Object.defineProperty(accessorModules, "0", {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error("must not run");
      },
    });
    expectPayloadError(
      { ...previewPayload, desired_modules: accessorModules },
      "array_invalid",
      "preview",
    );

    const nestedRequest = {
      schema_version: "2026-08-22.v1",
      intent: "change",
      desired_modules: previewPayload.desired_modules,
    } as Record<string, unknown>;
    Object.defineProperty(nestedRequest, "intent", {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error("must not run");
      },
    });
    expectPayloadError(
      {
        action: "deployments.preview",
        actor_ref: "actor_operator",
        management_tenant_id: "tenant_demo",
        request: nestedRequest,
      },
      "payload_fields_invalid",
    );
    expect(accessorReads).toBe(0);
  });

  it("normalizes hostile proxy trap failures to typed errors", () => {
    const getPrototypeProxy = new Proxy(registerPayload, {
      getPrototypeOf() {
        throw new Error("proxy prototype trap");
      },
    });
    const ownKeysProxy = new Proxy(registerPayload, {
      ownKeys() {
        throw new Error("proxy ownKeys trap");
      },
    });

    expectPayloadError(getPrototypeProxy, "payload_fields_invalid");
    expectPayloadError(ownKeysProxy, "payload_fields_invalid");
  });

  it("returns a digest distinct from descriptor digests", () => {
    const result = canonicalControlHash({
      domain: "request",
      schemaVersion: "2026-08-22.v1",
      payload: registerPayload,
    });
    expect(result.hash).toMatch(
      /^mcp-control-hash\/v1\/request\/sha256:[a-f0-9]{64}$/,
    );
    expect(result.hash).not.toBe(digestA);
    expect(createHash("sha256").update(result.canonicalJson).digest("hex")).not.toBe(
      result.hash.slice(-64),
    );
  });
});
