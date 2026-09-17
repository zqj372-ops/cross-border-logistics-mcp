import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { throwIfAborted } from "../schedule-collector/errors";
import type {
  ScheduleLiveAuditEntry,
  ScheduleLiveAuditSink,
} from "./service";

/**
 * Append-only JSONL audit sink. One line per event, opened with 0600 and a
 * private parent directory. It never rewrites or truncates prior entries, so
 * rollback can stop new queries without deleting history.
 */
export class JsonlScheduleLiveAuditSink implements ScheduleLiveAuditSink {
  readonly #path: string;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error("schedule_live_audit_path_invalid");
    this.#path = resolve(path);
  }

  async record(
    entry: ScheduleLiveAuditEntry,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    const signal = options?.signal;
    throwIfAborted(signal);
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    throwIfAborted(signal);
    await appendFile(this.#path, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    throwIfAborted(signal);
  }
}

export class InMemoryScheduleLiveAuditSink implements ScheduleLiveAuditSink {
  readonly entries: ScheduleLiveAuditEntry[] = [];

  record(
    entry: ScheduleLiveAuditEntry,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    throwIfAborted(options?.signal);
    this.entries.push(entry);
    return Promise.resolve();
  }
}
