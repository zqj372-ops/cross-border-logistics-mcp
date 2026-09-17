import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileEvidenceStore,
  InMemoryEvidenceStore,
  redactEvidence,
} from "../../../services/maritime/schedule-collector/evidence";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("schedule evidence store", () => {
  it("redacts structured JSON and verifies the stored bytes by hash", async () => {
    const store = new InMemoryEvidenceStore();
    const reference = await store.write({
      requestId: "request_123",
      carrier: "OOCL",
      kind: "http_response",
      mediaType: "application/json",
      bytes: new TextEncoder().encode(
        JSON.stringify({
          data: { route: "ok" },
          captchaToken: "secret-token",
          nested: { cookie: "secret-cookie" },
        }),
      ),
      redactions: ["captchaToken", "cookie"],
    });
    const stored = await store.read(reference.ref);
    const text = new TextDecoder().decode(stored);
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("secret-cookie");
    expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed for unsupported HTML evidence", () => {
    expect(() =>
      redactEvidence(
        new TextEncoder().encode(
          "<input name='csrfToken' value='secret'>",
        ),
        "text/html",
      ),
    ).toThrow("evidence_media_type_unsupported");
  });

  it("writes and reads back bounded file evidence with private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "schedule-evidence-"));
    roots.push(root);
    const store = new FileEvidenceStore({ root, maxBytes: 1024 });
    const reference = await store.write({
      requestId: "request_123",
      carrier: "OOCL",
      kind: "http_response",
      mediaType: "application/json",
      bytes: new TextEncoder().encode('{"token":"secret","value":1}'),
      redactions: ["token"],
    });
    const readback = await store.read(reference.ref);
    expect(new TextDecoder().decode(readback)).toBe('{"token":"[redacted]","value":1}');
  });
});
