import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createOutreachRuntimeFromEnvironment, type OutreachRuntimeDependencies } from "../../services/logistics-outreach/runtime.js";
import { OUTREACH_CAPTURE_SCHEMA_VERSION } from "../../services/logistics-outreach/providers/http-capture.js";
import { OUTREACH_MAIL_INBOX_SCHEMA_VERSION } from "../../services/logistics-outreach/providers/http-mail.js";

const actor = { tenantId: "tenant_fixture", actorId: "sales_fixture" };

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function dependencies(fetchImpl: OutreachRuntimeDependencies["fetchImpl"]): OutreachRuntimeDependencies {
  return {
    sender: () => ({
      company: "Fixture Logistics",
      name: "Fixture Sales Team",
      email: "outreach@example.invalid",
      mailing_address: "1 Fixture Road, Toronto, ON, Canada",
      service_description: "We coordinate China–Toronto freight.",
    }),
    sendEnabled: () => false,
    mayDispatch: () => Promise.resolve(true),
    contactReview: (_tenant, lead) => Promise.resolve({
      approved: true,
      evidence_ref: lead.evidence_ref,
      evidence_digest: lead.evidence_digest,
      valid_until: "2026-09-12T08:00:00.000Z",
    }),
    draftApproval: (_tenant, draft) => Promise.resolve({
      approved: true,
      draft_ref: draft.draft_ref,
      digest: draft.digest,
      reviewer_id: "reviewer_fixture",
      valid_until: "2026-09-12T08:00:00.000Z",
    }),
    now: () => Date.parse("2026-09-11T08:00:00.000Z"),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  };
}

function environment(directory: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const previewKey = join(directory, "preview.key");
  const captureToken = join(directory, "capture.token");
  const modelToken = join(directory, "model.token");
  const mailToken = join(directory, "mail.token");
  for (const [path, value] of [
    [previewKey, "p".repeat(64)],
    [captureToken, "c".repeat(32)],
    [modelToken, "m".repeat(32)],
    [mailToken, "n".repeat(32)],
  ] as const) writeFileSync(path, value, { mode: 0o600 });
  return {
    MCP_OUTREACH_ENABLED: "true",
    MCP_OUTREACH_STATE_DB_PATH: join(directory, "outreach.sqlite"),
    MCP_OUTREACH_PREVIEW_KEY_FILE: previewKey,
    MCP_OUTREACH_CAPTURE_BASE_URL: "https://capture.provider.example",
    MCP_OUTREACH_CAPTURE_ALLOWED_HOST: "capture.provider.example",
    MCP_OUTREACH_CAPTURE_TOKEN_FILE: captureToken,
    MCP_OUTREACH_MODEL_BASE_URL: "https://model.provider.example",
    MCP_OUTREACH_MODEL_ALLOWED_HOST: "model.provider.example",
    MCP_OUTREACH_MODEL_API_KEY_FILE: modelToken,
    MCP_OUTREACH_MODEL_NAME: "deepseek-chat",
    MCP_OUTREACH_MAIL_BASE_URL: "https://mail.provider.example",
    MCP_OUTREACH_MAIL_ALLOWED_HOST: "mail.provider.example",
    MCP_OUTREACH_MAIL_TOKEN_FILE: mailToken,
    ...overrides,
  };
}

test("outreach runtime is disabled by default and does not touch provider configuration", () => {
  expect(createOutreachRuntimeFromEnvironment({}, dependencies(undefined))).toBeUndefined();
});

test("outreach runtime fails closed when enabled without complete provider configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "outreach-runtime-"));
  try {
    expect(() => createOutreachRuntimeFromEnvironment({ MCP_OUTREACH_ENABLED: "true" }, dependencies(undefined)))
      .toThrowError(expect.objectContaining({ code: "runtime_config_invalid" }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("outreach runtime composes capture, model and mail adapters without opening a connection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "outreach-runtime-"));
  const calls: string[] = [];
  const fetchImpl: OutreachRuntimeDependencies["fetchImpl"] = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.includes("/v1/captures/capture_authorized_1")) {
      return Promise.resolve(jsonResponse({
        schema_version: OUTREACH_CAPTURE_SCHEMA_VERSION,
        capture_ref: "capture_authorized_1",
        company: "Fixture Furniture",
        city: "Toronto",
        url: "https://example.invalid/contact",
        captured_at: "2026-09-11T07:00:00.000Z",
        html: "<main>Fixture Furniture</main>",
        test_data: true,
      }));
    }
    if (url.includes("/v1/inbox")) {
      return Promise.resolve(jsonResponse({ schema_version: OUTREACH_MAIL_INBOX_SCHEMA_VERSION, messages: [] }));
    }
    return Promise.resolve(jsonResponse({ choices: [{ message: { content: JSON.stringify({ subject: "Fixture", body: "Reviewed draft." }) } }] }));
  };
  const runtime = createOutreachRuntimeFromEnvironment(environment(directory), dependencies(fetchImpl));
  try {
    expect(runtime).toBeDefined();
    if (runtime === undefined) throw new Error("runtime_missing");
    expect(calls).toEqual([]);
    const capture = await runtime.service.research(actor, "capture_authorized_1");
    expect(capture.company).toBe("Fixture Furniture");
    expect(calls).toEqual(["https://capture.provider.example/v1/captures/capture_authorized_1"]);
  } finally {
    runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("outreach runtime rejects insecure secret files", () => {
  const directory = mkdtempSync(join(tmpdir(), "outreach-runtime-"));
  try {
    const env = environment(directory);
    const previewKey = env.MCP_OUTREACH_PREVIEW_KEY_FILE;
    if (previewKey === undefined) throw new Error("preview_key_missing");
    writeFileSync(previewKey, "p".repeat(64));
    chmodSync(previewKey, 0o644);
    expect(() => createOutreachRuntimeFromEnvironment(env, dependencies(undefined)))
      .toThrowError(expect.objectContaining({ code: "runtime_secret_invalid" }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
