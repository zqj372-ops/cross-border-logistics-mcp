export interface QuoteFormValues {
  readonly services: string;
  readonly excludedServices: string;
  readonly expectedShipDate: string;
  readonly origin: Record<string, unknown>;
  readonly destination: Record<string, unknown>;
  readonly pallet: Record<string, unknown>;
  readonly advanced: Record<string, unknown>;
}

export interface QuoteFormError {
  readonly field: string;
  readonly message: string;
}

export interface BuiltQuoteRequest {
  readonly request: Record<string, unknown> | null;
  readonly errors: readonly QuoteFormError[];
}

export function buildFreightcomRequest(values: QuoteFormValues): BuiltQuoteRequest;

export function formatDisplayMoney(money: {
  readonly value: string;
  readonly currency: string;
}): {
  readonly amount: string;
  readonly displayCurrency: "USD";
  readonly sourceCurrency: string;
  readonly conversionApplied: false;
  readonly relabelApplied: boolean;
  readonly available: boolean;
};
