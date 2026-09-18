import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";

import type {
  EvidenceReference,
  EvidenceStore,
  EvidenceWriteInput,
} from "./ports";
import { throwIfAborted } from "./errors";

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const EVIDENCE_REF =
  /^evidence:([A-Za-z0-9][A-Za-z0-9._:/-]*):([A-Za-z0-9][A-Za-z0-9._:/-]*):sha256:([a-f0-9]{64})$/u;
const SENSITIVE_KEY =
  /(?:authorization|cookie|set-cookie|captcha|csrf|session|token|secret|password|api[_-]?key)/iu;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return redactText(url.toString());
  } catch {
    return value;
  }
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value === null || typeof value !== "object") {
  if (typeof value !== "string") return value;
  const trimmed = value.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return redactJson(JSON.parse(value));
      } catch {
        return redactText(redactUrl(value));
      }
    }
    return redactUrl(value);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[redacted]" : redactJson(entry),
    ]),
  );
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /^(\s*(?:authorization|cookie|set-cookie|csrf|session|token|secret|password|api[-_]?key)\s*[:=]\s*).*$/gimu,
      "$1[redacted]",
    )
    .replace(
      /(["']?(?:captchaToken|captcha_token|csrfToken|csrf_token|access_token|refresh_token|sessionId|session_id)["']?\s*:\s*)("[^"]*"|'[^']*'|[^,\s}]+)/giu,
      '$1"[redacted]"',
    )
    .replace(
      /([?&](?:token|access_token|session|session_id|captcha|csrf|api_key|apikey)=)[^&\s"'<>]+/giu,
      "$1[redacted]",
    );
}

export function redactEvidence(
  bytes: Uint8Array,
  mediaType: string,
): Uint8Array {
  const normalizedMediaType = mediaType.toLowerCase();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = decoder.decode(bytes);
  if (normalizedMediaType.includes("json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("evidence_json_invalid");
    }
    return new TextEncoder().encode(JSON.stringify(redactJson(parsed)));
  }
  throw new Error("evidence_media_type_unsupported");
}

function safeSegment(value: string, label: string): string {
  const containsControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32;
  });
  if (
    value.length === 0 ||
    value.length > 128 ||
    value === "." ||
    value === ".." ||
    containsControlCharacter ||
    /[/\\]/u.test(value)
  ) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function extensionForMediaType(mediaType: string): string {
  const normalized = mediaType.toLowerCase();
  if (normalized.includes("json")) return ".json";
  if (normalized.startsWith("text/plain")) return ".txt";
  if (normalized.startsWith("text/csv")) return ".csv";
  return extname(new URL(`https://example.invalid/file.${normalized}`).pathname) ||
    ".bin";
}

function parseReference(reference: string): {
  readonly requestId: string;
  readonly carrier: string;
  readonly digest: string;
} {
  const match = EVIDENCE_REF.exec(reference);
  if (match === null) throw new Error("evidence_reference_invalid");
  return {
    requestId: safeSegment(match[1] ?? "", "request_id"),
    carrier: safeSegment(match[2] ?? "", "carrier"),
    digest: match[3] ?? "",
  };
}

export class FileEvidenceStore implements EvidenceStore {
  readonly #root: string;
  readonly #maxBytes: number;

  constructor(options: { readonly root: string; readonly maxBytes?: number }) {
    if (!isAbsolute(options.root)) throw new Error("evidence_root_must_be_absolute");
    this.#root = resolve(options.root);
    this.#maxBytes = options.maxBytes ?? MAX_EVIDENCE_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw new Error("evidence_limit_invalid");
    }
  }

  async write(input: EvidenceWriteInput): Promise<EvidenceReference> {
    throwIfAborted(input.signal);
    const requestId = safeSegment(input.requestId, "request_id");
    const carrier = safeSegment(input.carrier, "carrier");
    if (input.bytes.byteLength > this.#maxBytes) {
      throw new Error("evidence_too_large");
    }
    const sanitized = redactEvidence(input.bytes, input.mediaType);
    throwIfAborted(input.signal);
    if (sanitized.byteLength > this.#maxBytes) {
      throw new Error("evidence_too_large");
    }
    const digest = sha256(sanitized);
    const extension = extensionForMediaType(input.mediaType);
    const directory = join(this.#root, requestId, carrier);
    const path = join(directory, `${digest}${extension}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    throwIfAborted(input.signal);
    try {
      await writeFile(path, sanitized, {
        flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        mode: 0o600,
      });
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      const existing = await readFile(path);
      if (sha256(existing) !== digest) {
        throw new Error("evidence_collision", { cause: error });
      }
    }
    throwIfAborted(input.signal);
    const readback = await readFile(path);
    if (sha256(readback) !== digest) throw new Error("evidence_readback_failed");
    return {
      ref: `evidence:${requestId}:${carrier}:sha256:${digest}`,
      sha256: digest,
      byteLength: sanitized.byteLength,
      storedAt: new Date().toISOString(),
    };
  }

  async read(reference: string): Promise<Uint8Array> {
    const { requestId, carrier, digest } = parseReference(reference);
    const directory = join(this.#root, requestId, carrier);
    const candidates = [
      join(directory, `${digest}.json`),
      join(directory, `${digest}.txt`),
      join(directory, `${digest}.csv`),
      join(directory, `${digest}.bin`),
    ];
    for (const path of candidates) {
      try {
        const bytes = await readFile(path);
        if (sha256(bytes) !== digest) throw new Error("evidence_readback_failed");
        return bytes;
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("evidence_not_found");
  }
}

export class InMemoryEvidenceStore implements EvidenceStore {
  readonly #values = new Map<string, Uint8Array>();

  write(input: EvidenceWriteInput): Promise<EvidenceReference> {
    throwIfAborted(input.signal);
    if (input.bytes.byteLength > MAX_EVIDENCE_BYTES) {
      throw new Error("evidence_too_large");
    }
    const sanitized = redactEvidence(input.bytes, input.mediaType);
    throwIfAborted(input.signal);
    const digest = sha256(sanitized);
    const ref = `evidence:${safeSegment(input.requestId, "request_id")}:${safeSegment(input.carrier, "carrier")}:sha256:${digest}`;
    this.#values.set(ref, Uint8Array.from(sanitized));
    return Promise.resolve({
      ref,
      sha256: digest,
      byteLength: sanitized.byteLength,
      storedAt: new Date().toISOString(),
    });
  }

  read(reference: string): Promise<Uint8Array> {
    const value = this.#values.get(reference);
    if (value === undefined) return Promise.reject(new Error("evidence_not_found"));
    return Promise.resolve(Uint8Array.from(value));
  }
}
