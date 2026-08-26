import { describe, expect, it } from "vitest";

import {
  findAgentArtifactSafetyIssues,
  findCredentialMaterial,
  findLocalPathLeakage,
} from "./safety-assertions";

describe("Agent artifact safety assertions", () => {
  it("detects high-confidence credential material without returning the credential value", () => {
    const examples = [
      "Authorization: Bearer 0123456789abcdef",
      "Authorization: Bearer a.b+c/==",
      "password = hunter2",
      "secret: q7.r+==",
      "api-key='live-key-123'",
      "token=mini.+=",
      "-----BEGIN PRIVATE KEY-----\nsynthetic-test-material\n-----END PRIVATE KEY-----",
      "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_abcdefghijklmnopqrstuvwxyz0123456789",
      "AIzaSyDabcdefghijklmnopqrstuvwxyz012345",
      '{"Authorization":"Bearer short.value+=="}',
      '{"accessToken":"access.value+=="}',
      '{"clientSecret":"client-secret-value"}',
      '{"refreshToken":"refresh.value+=="}',
      '{"apiKey":"api-key-value"}',
      '{"secretKey":"secret-key-value"}',
      '{"secret_key":"secret-key-value"}',
      '{"secretAccessKey":"secret-access-key-value"}',
      '{"accessKey":"access-key-value"}',
      "Authorization=Bearer equals-header-token",
    ];

    for (const example of examples) {
      const findings = findCredentialMaterial(example);
      expect(findings.length).toBeGreaterThan(0);
      expect(JSON.stringify(findings)).not.toContain(example);
    }
  });

  it("allows ordinary security words and abstract credential placeholders", () => {
    const examples = [
      "Bearer authentication is injected by the server.",
      "Never persist a secret in the generated pack.",
      "Use an api-key reference and rotate the token.",
      "Authorization: Bearer <TOKEN>",
      "Authorization: Bearer ${MCP_BEARER_TOKEN}",
      "password = <PASSWORD>",
      "secret: {{SECRET_REFERENCE}}",
      "api-key = [REDACTED]",
      "token = YOUR_RUNTIME_TOKEN",
      "token = ***",
      '{"Authorization":"Bearer <TOKEN>"}',
      '{"accessToken":"${ACCESS_TOKEN}"}',
      "The accessToken field is populated by the server.",
      "The secretKey field is populated by the server.",
      "Use an accessKey reference supplied by the server.",
      "Authorization = Bearer <TOKEN>",
      "secretKey: value",
      "secret_key = example-value",
      "secretAccessKey: server-provided",
      "accessKey = reference",
      "Authorization: Bearer token",
    ];

    for (const example of examples) {
      expect(findCredentialMaterial(example)).toEqual([]);
    }
  });

  it("detects concrete local user and generated temporary paths", () => {
    const examples = [
      "/Users/alice/project/index.json",
      "/home/runner/build/pack.json",
      "/private/var/folders/ab/cd/T/generated-pack.json",
      "/var/folders/ab/cd/T/generated-pack.json",
      "/tmp/generated/report.json",
      String.raw`C:\Users\alice\project\index.json`,
      "C:/Users/alice/project/index.json",
    ];

    for (const example of examples) {
      expect(findLocalPathLeakage(example).length).toBeGreaterThan(0);
    }
  });

  it("detects credential material in serialized objects without echoing values", () => {
    const credentialValue = "object.value+==";
    const findings = findAgentArtifactSafetyIssues({
      Authorization: `Bearer ${credentialValue}`,
      clientSecret: credentialValue,
    });

    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain(credentialValue);
  });

  it("deduplicates repeated macOS temp paths into one path classification", () => {
    const findings = findLocalPathLeakage(
      "/private/var/folders/ab/one /var/folders/cd/two /private/var/folders/ef/three",
    );

    expect(findings).toEqual([
      { kind: "local_path", reason: "macos_user_temp" },
    ]);
  });

  it("allows contract placeholders and non-user system paths", () => {
    const examples = [
      "/absolute/path/to/application-root/.runtime/mcp-instance-state/control.sqlite",
      "/Users/<name>/repository",
      "/home/<user>/repository",
      "/var/lib/logistics-mcp/pack.json",
      "/tmp/template/report.json",
      String.raw`C:\ProgramData\logistics-mcp\pack.json`,
      "docs/agent/index.json",
    ];

    for (const example of examples) {
      expect(findLocalPathLeakage(example)).toEqual([]);
    }
  });

  it("rejects unsafe graphs before JSON serialization with a fixed sanitized error", () => {
    const proxied = new Proxy({ value: "secret" }, {
      get() {
        throw new Error("proxy getter must not run");
      },
      ownKeys() {
        throw new Error("proxy ownKeys trap must not run");
      },
    });
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "value", {
      configurable: true,
      get() {
        throw new Error("accessor must not run");
      },
    });
    const customPrototype: Record<string, unknown> = Object.create({ value: "secret" }) as Record<string, unknown>;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    for (const unsafe of [proxied, accessor, customPrototype, cyclic, 123n, Symbol("secret")]) {
      expect(() => findAgentArtifactSafetyIssues(unsafe)).toThrow(
        "Agent artifact input is invalid.",
      );
    }
  });

  it("accepts repeated references when the object graph is acyclic", () => {
    const shared = { value: "ordinary" };
    expect(findAgentArtifactSafetyIssues({ left: shared, right: shared })).toEqual([]);
  });

  it("rejects non-string direct scanner input without coercing a proxy", () => {
    let trapTriggered = false;
    const proxied = new Proxy({ value: "secret" }, {
      get() {
        trapTriggered = true;
        throw new Error("scanner coercion must not run");
      },
      ownKeys() {
        trapTriggered = true;
        throw new Error("scanner reflection must not run");
      },
    });

    for (const scanner of [findCredentialMaterial, findLocalPathLeakage]) {
      expect(() => scanner(proxied as unknown as string)).toThrow(
        "Agent artifact input is invalid.",
      );
    }
    expect(trapTriggered).toBe(false);
  });
});
