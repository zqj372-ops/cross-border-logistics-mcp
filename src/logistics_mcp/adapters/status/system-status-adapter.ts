import type { SourceRef } from "../../platform/envelope";
import type { AdapterResult, StatusAdapter } from "../ports";

export interface SystemStatusRecord {
  readonly version: string;
  readonly system: string;
  readonly ready: boolean;
  readonly test_data: boolean;
  readonly evaluated_at: string;
  readonly last_source_check_at: string | null;
  readonly reasons: readonly string[];
  readonly release_ids: readonly string[];
  readonly source_ref: SourceRef;
}
export interface SystemStatusSource {
  getStatus(input: Record<string, unknown>): Promise<SystemStatusRecord>;
}

export interface SystemStatusAdapterOptions {
  readonly source?: SystemStatusSource;
}

function notice(
  code: string,
  message: string,
  severity: "info" | "warning" | "error" = "error",
  field: string | null = null,
) {
  return { code, message, severity, field } as const;
}

function dataStatus(record: SystemStatusRecord): Record<string, unknown> {
  return {
    version: record.version,
    system: record.system,
    ready: record.ready,
    test_data: record.test_data,
    evaluated_at: record.evaluated_at,
    last_source_check_at: record.last_source_check_at,
    reasons: [...record.reasons],
    release_ids: [...record.release_ids],
  };
}

export class SystemStatusAdapter implements StatusAdapter {
  private readonly source: SystemStatusSource | undefined;

  constructor(options: SystemStatusAdapterOptions = {}) {
    this.source = options.source;
  }

  async getDataStatus(input: Record<string, unknown>): Promise<AdapterResult> {
    if (this.source === undefined) {
      return {
        status: "unavailable",
        data: null,
        sourceRefs: [],
        blockers: [
          notice(
            "status.adapter_disabled",
            "The system status source is disabled until its route and verification contract are confirmed.",
          ),
        ],
        reviewStatus: "manual_review",
      };
    }
    const record = await this.source.getStatus(input);
    return {
      status: "success",
      data: dataStatus(record),
      sourceRefs: [record.source_ref],
      warnings: record.ready
        ? []
        : [
            notice(
              "status.not_ready",
              "The status endpoint was read successfully but the source is not ready.",
              "warning",
              "ready",
            ),
          ],
    };
  }
}
