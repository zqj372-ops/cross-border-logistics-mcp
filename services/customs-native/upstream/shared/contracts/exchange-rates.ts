import Decimal from "decimal.js";
import { z } from "zod";

export const SupportedCurrencySchema = z.enum(["USD", "CAD", "CNY"]);
export type SupportedCurrency = z.infer<typeof SupportedCurrencySchema>;

export const ExchangeRateStatusSchema = z.enum(["live", "cached", "unavailable"]);
export type ExchangeRateStatus = z.infer<typeof ExchangeRateStatusSchema>;

export const ExchangeRateSelectionSchema = z.enum(["same_day", "latest_business_day", "cached"]);
export type ExchangeRateSelection = z.infer<typeof ExchangeRateSelectionSchema>;

export const ExchangeRateQuoteSchema = z.object({
  currency: SupportedCurrencySchema,
  rateToCad: z.string().regex(/^\d+(?:\.\d+)?$/u),
  source: z.enum(["CBSA", "BoC"]),
  effectiveAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type ExchangeRateQuote = z.infer<typeof ExchangeRateQuoteSchema>;

const CalculatorRatesSchema = z.object({
  /** CNY units for one USD, matching the existing calculator contract. */
  usdCny: z.string().regex(/^\d+(?:\.\d+)?$/u),
  /** CNY units for one CAD, matching the existing calculator contract. */
  cadCny: z.string().regex(/^\d+(?:\.\d+)?$/u),
});

export const ExchangeRateSnapshotSchema = z.object({
  status: ExchangeRateStatusSchema,
  fetchedAt: z.string().datetime(),
  effectiveDate: z.string().date(),
  selection: ExchangeRateSelectionSchema,
  sourceUrl: z.string().url(),
  rates: z.object({
    USD: ExchangeRateQuoteSchema,
    CAD: ExchangeRateQuoteSchema,
    CNY: ExchangeRateQuoteSchema,
  }),
  calculatorRates: CalculatorRatesSchema,
});

export type CalculatorRates = z.infer<typeof CalculatorRatesSchema>;
export type ExchangeRateSnapshot = z.infer<typeof ExchangeRateSnapshotSchema>;

export interface CbsaExchangeRatePayload {
  readonly ForeignExchangeRates?: readonly CbsaExchangeRateRow[];
}

export interface CbsaExchangeRateRow {
  readonly Rate?: unknown;
  readonly ExchangeRateEffectiveTimestamp?: unknown;
  readonly ExchangeRateExpiryTimestamp?: unknown;
  readonly ExchangeRateSource?: unknown;
  readonly FromCurrency?: { readonly Value?: unknown };
  readonly ToCurrency?: { readonly Value?: unknown };
}

export interface BocValetPayload {
  readonly observations?: readonly BocValetObservation[];
}

export interface BocValetObservation {
  readonly d?: unknown;
  readonly FXUSDCAD?: { readonly v?: unknown };
  readonly FXCNYCAD?: { readonly v?: unknown };
}

const SOURCE_URL = "https://bcd-api-dca-ipa.cbsa-asfc.cloud-nuage.canada.ca/exchange-rate-lambda/exchange-rates";
const BOC_SOURCE_URL = "https://www.bankofcanada.ca/valet/observations/FXUSDCAD,FXCNYCAD/json?recent=10";
const REQUIRED_CURRENCIES: readonly SupportedCurrency[] = ["USD", "CAD", "CNY"];

function validIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && z.string().date().safeParse(value).success;
}

function positiveRate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return null;
  try {
    const decimal = new Decimal(text);
    return decimal.gt(0) ? decimal.toString() : null;
  } catch {
    return null;
  }
}

function sourceValue(value: unknown): "CBSA" | "BoC" | null {
  if (value === "CBSA" || value === "BoC") return value;
  return null;
}

function normalizeCurrency(value: unknown): SupportedCurrency | null {
  return SupportedCurrencySchema.safeParse(value).success ? value as SupportedCurrency : null;
}

function quoteCandidates(rows: readonly CbsaExchangeRateRow[], currency: SupportedCurrency, asOfDate?: string): ExchangeRateQuote[] {
  const candidates = rows
    .filter((row) => normalizeCurrency(row.FromCurrency?.Value) === currency)
    .filter((row) => row.ToCurrency?.Value === "CAD")
    .map((row) => {
      const rateToCad = positiveRate(row.Rate);
      const source = sourceValue(row.ExchangeRateSource);
      const effectiveAt = validIso(row.ExchangeRateEffectiveTimestamp) ? row.ExchangeRateEffectiveTimestamp : null;
      const expiresAt = validIso(row.ExchangeRateExpiryTimestamp) ? row.ExchangeRateExpiryTimestamp : null;
      return rateToCad && source && effectiveAt && expiresAt
        ? { currency, rateToCad, source, effectiveAt, expiresAt }
        : null;
    })
    .filter((row): row is ExchangeRateQuote => row !== null)
    .filter((row) => !asOfDate || row.effectiveAt.slice(0, 10) <= asOfDate)
    .sort((left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt));
  return candidates;
}

function selectCommonQuotes(
  candidatesByCurrency: Record<SupportedCurrency, readonly ExchangeRateQuote[]>,
  asOfDate?: string,
): { readonly effectiveDate: string; readonly rates: Record<SupportedCurrency, ExchangeRateQuote> } {
  for (const currency of REQUIRED_CURRENCIES) {
    if (candidatesByCurrency[currency].length === 0) {
      throw new Error(`No usable ${currency} to CAD exchange-rate quote was returned.`);
    }
  }
  if (!asOfDate) {
    const rates = {
      USD: candidatesByCurrency.USD[0]!,
      CAD: candidatesByCurrency.CAD[0]!,
      CNY: candidatesByCurrency.CNY[0]!,
    } satisfies Record<SupportedCurrency, ExchangeRateQuote>;
    return { effectiveDate: rates.USD.effectiveAt.slice(0, 10), rates };
  }
  const commonDates = [...new Set(candidatesByCurrency.USD.map((quote) => quote.effectiveAt.slice(0, 10)))].filter((date) =>
    candidatesByCurrency.CAD.some((quote) => quote.effectiveAt.slice(0, 10) === date) &&
    candidatesByCurrency.CNY.some((quote) => quote.effectiveAt.slice(0, 10) === date),
  ).sort((left, right) => right.localeCompare(left));
  const effectiveDate = commonDates[0];
  if (!effectiveDate) throw new Error("No common effective date for USD, CAD and CNY exchange-rate quotes was returned.");
  if (asOfDate && effectiveDate > asOfDate) throw new Error("Exchange-rate quote is later than the requested date.");
  const rates = {
    USD: candidatesByCurrency.USD.find((quote) => quote.effectiveAt.slice(0, 10) === effectiveDate)!,
    CAD: candidatesByCurrency.CAD.find((quote) => quote.effectiveAt.slice(0, 10) === effectiveDate)!,
    CNY: candidatesByCurrency.CNY.find((quote) => quote.effectiveAt.slice(0, 10) === effectiveDate)!,
  } satisfies Record<SupportedCurrency, ExchangeRateQuote>;
  return { effectiveDate, rates };
}

function decimalRate(quote: ExchangeRateQuote): Decimal {
  return new Decimal(quote.rateToCad);
}

function fixedPositive(value: Decimal): string {
  if (!value.gt(0)) throw new Error("Derived exchange-rate value must be positive.");
  return value.toFixed(8);
}

export function deriveCalculatorRates(rates: Pick<Record<SupportedCurrency, ExchangeRateQuote>, "USD" | "CAD" | "CNY">): CalculatorRates {
  const usdToCad = decimalRate(rates.USD);
  const cadToCad = decimalRate(rates.CAD);
  const cnyToCad = decimalRate(rates.CNY);
  return {
    usdCny: fixedPositive(usdToCad.div(cnyToCad)),
    cadCny: fixedPositive(cadToCad.div(cnyToCad)),
  };
}

export function parseCbsaExchangeRates(payload: CbsaExchangeRatePayload, fetchedAt = new Date().toISOString(), asOfDate?: string): ExchangeRateSnapshot {
  if (!validIso(fetchedAt)) throw new Error("Exchange-rate fetchedAt must be an ISO timestamp.");
  if (asOfDate !== undefined && !validDate(asOfDate)) throw new Error("Exchange-rate asOfDate must be an ISO calendar date.");
  const rows = Array.isArray(payload.ForeignExchangeRates) ? payload.ForeignExchangeRates : [];
  const selected = selectCommonQuotes({
    USD: quoteCandidates(rows, "USD", asOfDate),
    CAD: quoteCandidates(rows, "CAD", asOfDate),
    CNY: quoteCandidates(rows, "CNY", asOfDate),
  }, asOfDate);
  const rates = selected.rates;
  for (const currency of REQUIRED_CURRENCIES) {
    if (rates[currency].currency !== currency) throw new Error(`Exchange-rate currency mismatch for ${currency}.`);
  }
  const selection: ExchangeRateSelection = asOfDate && selected.effectiveDate !== asOfDate ? "latest_business_day" : "same_day";
  return ExchangeRateSnapshotSchema.parse({
    status: "live",
    fetchedAt,
    effectiveDate: selected.effectiveDate,
    selection,
    sourceUrl: SOURCE_URL,
    rates,
    calculatorRates: deriveCalculatorRates(rates),
  });
}

function bocRate(value: unknown, series: string): string {
  const rate = positiveRate(value);
  if (!rate) throw new Error(`No usable ${series} observation was returned.`);
  return rate;
}

function nextDate(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function parseBocValetRates(payload: BocValetPayload, asOfDate: string, fetchedAt = new Date().toISOString()): ExchangeRateSnapshot {
  if (!validDate(asOfDate)) throw new Error("Exchange-rate asOfDate must be an ISO calendar date.");
  if (!validIso(fetchedAt)) throw new Error("Exchange-rate fetchedAt must be an ISO timestamp.");
  const observations:readonly BocValetObservation[] = Array.isArray(payload.observations) ? payload.observations : [];
  const candidates = observations
    .filter((observation) => validDate(observation.d) && observation.d <= asOfDate)
    .map((observation) => ({
      date: observation.d as string,
      usd: positiveRate(observation.FXUSDCAD?.v),
      cny: positiveRate(observation.FXCNYCAD?.v),
    }))
    .filter((observation): observation is { readonly date: string; readonly usd: string; readonly cny: string } => observation.usd !== null && observation.cny !== null)
    .sort((left, right) => right.date.localeCompare(left.date));
  const selected = candidates[0];
  if (!selected) throw new Error("No complete FXUSDCAD/FXCNYCAD observation was returned.");
  const effectiveAt = `${selected.date}T00:00:00.000Z`;
  const expiresAt = `${nextDate(selected.date)}T00:00:00.000Z`;
  const rates = {
    USD: { currency: "USD", rateToCad: bocRate(selected.usd, "FXUSDCAD"), source: "BoC", effectiveAt, expiresAt },
    CAD: { currency: "CAD", rateToCad: "1", source: "BoC", effectiveAt, expiresAt },
    CNY: { currency: "CNY", rateToCad: bocRate(selected.cny, "FXCNYCAD"), source: "BoC", effectiveAt, expiresAt },
  } satisfies Record<SupportedCurrency, ExchangeRateQuote>;
  return ExchangeRateSnapshotSchema.parse({
    status: "live",
    fetchedAt,
    effectiveDate: selected.date,
    selection: selected.date === asOfDate ? "same_day" : "latest_business_day",
    sourceUrl: BOC_SOURCE_URL,
    rates,
    calculatorRates: deriveCalculatorRates(rates),
  });
}

export { SOURCE_URL as CBSA_EXCHANGE_RATE_URL, BOC_SOURCE_URL as BOC_EXCHANGE_RATE_URL };
