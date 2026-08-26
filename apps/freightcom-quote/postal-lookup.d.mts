export interface ParsedNorthAmericanPostal {
  readonly country: "CA" | "US";
  readonly normalizedPostalCode: string;
  readonly lookupPostalCode: string;
  readonly approximate: boolean;
}

export interface PostalLocation {
  readonly postal_code: string;
  readonly city: string;
  readonly region: string;
  readonly country: "CA" | "US";
  readonly approximate: boolean;
  readonly source: "Zippopotam.us / GeoNames";
}

export class PostalLookupError extends Error {
  readonly code: string;
  readonly status: number;
}

export function parseNorthAmericanPostal(value: unknown): ParsedNorthAmericanPostal | null;

export function createPostalLookup(options?: {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): (value: unknown) => Promise<PostalLocation>;
