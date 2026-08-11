import type { AuditEvent, AuditRepository } from "./repositories";

export type { AuditEvent, AuditRepository } from "./repositories";

type RedactedRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RedactedRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function replacementForKey(key: string): "[opaque]" | "[redacted]" | null {
  const normalized = normalizedKey(key);

  if (
    /(password|secret|token|credential|authorization|bearer|cookie|api_key|apikey|private_key)/.test(
      normalized,
    )
  ) {
    return "[redacted]";
  }
  if (
    /(address|street|raw|tax_document|full_text|conversation|chat|attachment|document_text|quote_details)/.test(
      normalized,
    )
  ) {
    return "[opaque]";
  }
  if (/(quote_amount|amount|price|fee|tax|rate|total)/.test(normalized)) {
    return "[redacted]";
  }

  return null;
}

function redactString(value: string): string {
  if (/\bBearer\s+\S+/i.test(value)) {
    return "[redacted]";
  }
  if (/(?:api[_ -]?key|cookie)\s*[:=]/i.test(value)) {
    return "[redacted]";
  }
  return value;
}

export function redactAuditInput(input: unknown): unknown {
  if (typeof input === "string") {
    return redactString(input);
  }
  if (Array.isArray(input)) {
    return input.map((value) => redactAuditInput(value));
  }
  if (!isRecord(input)) {
    return input;
  }

  const redacted: RedactedRecord = {};
  for (const [key, value] of Object.entries(input)) {
    const replacement = replacementForKey(key);
    redacted[key] = replacement ?? redactAuditInput(value);
  }
  return redacted;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryAuditRepository implements AuditRepository {
  readonly durability = "memory" as const;

  private readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    await Promise.resolve();
    const redactedMetadata =
      event.metadata === undefined
        ? undefined
        : redactAuditInput(event.metadata);
    const metadata =
      redactedMetadata === undefined
        ? undefined
        : isRecord(redactedMetadata)
          ? redactedMetadata
          : { value: redactedMetadata };

    const stored: AuditEvent = {
      ...event,
      source_ids: [...event.source_ids],
      versions: [...event.versions],
      reason_codes: [...event.reason_codes],
      ...(metadata === undefined ? {} : { metadata }),
    };
    this.events.push(clone(stored));
  }

  async list(): Promise<readonly AuditEvent[]> {
    await Promise.resolve();
    return clone(this.events);
  }
}
