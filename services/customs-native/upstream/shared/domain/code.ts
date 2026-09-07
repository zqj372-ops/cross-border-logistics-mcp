export type QueryKind = "code" | "name";

const CODE_ERROR = "Customs code must contain 4 to 10 digits after removing '.', spaces, and '-'.";

/**
 * Normalize a national tariff code to its digit-only representation.
 * Punctuation used by published displays is ignored, but leading zeroes are
 * intentionally preserved because they are significant in nomenclature.
 */
export function normalizeCode(input: string): string {
  const normalizedInput = input.normalize("NFKC");
  const digits = normalizedInput.replace(/[.\s-]/gu, "");

  if (!/^\d{4,10}$/u.test(digits)) {
    throw new Error(CODE_ERROR);
  }

  return digits;
}

/**
 * A query is a code only when it can be normalized to a valid 4–10 digit
 * code. Everything else is treated as a name search so free-form text is not
 * accidentally sent to an exact-code lookup.
 */
export function detectQueryKind(input: string): QueryKind {
  try {
    normalizeCode(input);
    return "code";
  } catch {
    return "name";
  }
}
