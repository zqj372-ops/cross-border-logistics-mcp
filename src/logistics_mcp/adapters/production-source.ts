import type { QuotePdfPort } from "../domains/quote/create-pdf";
import { unavailableQuotePdfPort } from "./fixture-client";
import type { FixtureAdapters } from "./ports";

export interface ProductionAdapterSourceLike {
  readonly kind: "adapter_source";
  readonly adapters: FixtureAdapters;
  readonly health: () => Promise<{ readonly ready: boolean }>;
  readonly close: () => Promise<void>;
}

export interface QuotePdfProductionSourceOptions {
  readonly quotePdf?: QuotePdfPort;
}

export type QuotePdfProductionSourceResult =
  | { readonly ok: true; readonly source: ProductionAdapterSourceLike }
  | { readonly ok: false; readonly code: "production_quote_pdf_source_invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isQuotePdfPort(value: unknown): value is QuotePdfPort {
  return isRecord(value) &&
    typeof value.post === "function" &&
    typeof value.get === "function";
}

function isProductionAdapterSource(value: unknown): value is ProductionAdapterSourceLike {
  if (!isRecord(value) || value.kind !== "adapter_source") return false;
  return isRecord(value.adapters) &&
    typeof value.health === "function" &&
    typeof value.close === "function";
}

export function createQuotePdfProductionSource(
  baseSource: ProductionAdapterSourceLike,
  options: QuotePdfProductionSourceOptions = {},
): QuotePdfProductionSourceResult {
  if (!isProductionAdapterSource(baseSource)) {
    return { ok: false, code: "production_quote_pdf_source_invalid" };
  }

  const candidate = Object.hasOwn(options, "quotePdf")
    ? options.quotePdf
    : baseSource.adapters.quotePdf;
  if (candidate !== undefined && !isQuotePdfPort(candidate)) {
    return { ok: false, code: "production_quote_pdf_source_invalid" };
  }

  return {
    ok: true,
    source: {
      ...baseSource,
      adapters: {
        ...baseSource.adapters,
        quotePdf: candidate ?? unavailableQuotePdfPort,
      },
    },
  };
}
