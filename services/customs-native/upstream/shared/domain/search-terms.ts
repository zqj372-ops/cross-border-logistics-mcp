const HAN_RUN_RE = /\p{Script=Han}+/gu;

function normalizePhrase(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    // Keep letters, numbers, and Han characters. All punctuation and symbols
    // become separators so the generated term string is safe for FTS MATCH.
    .replace(/[^\p{L}\p{N}\p{Script=Han}]+/gu, " ")
    .trim();
}

function addTerms(value: string, terms: Set<string>): void {
  const normalized = normalizePhrase(value);
  if (normalized.length === 0) return;

  for (const token of normalized.split(/\s+/u)) {
    terms.add(token);

    // Generate adjacent bigrams for every contiguous Han run. For mixed
    // tokens, Latin/digit content remains searchable as the original token.
    for (const match of token.matchAll(HAN_RUN_RE)) {
      const run = match[0];
      if (run.length < 2) continue;
      for (let index = 0; index < run.length - 1; index += 1) {
        terms.add(run.slice(index, index + 2));
      }
    }
  }
}

/**
 * Build a stable, de-duplicated search-term string. Optional aliases are
 * accepted explicitly by callers; this helper does not infer or label them
 * as reviewed on its own.
 */
export function toSearchTerms(input: string, aliases: readonly string[] = []): string {
  const terms = new Set<string>();
  addTerms(input, terms);
  for (const alias of aliases) addTerms(alias, terms);

  return [...terms].sort().join(" ");
}
