import {
  ResolvedLocationSchema,
  type ResolvedLocation,
} from "./contracts";
import { CollectorRuntimeError } from "./errors";
import { portLookup } from "./port-names";

export interface LocationCandidate {
  readonly name: string;
  readonly country_code: string | null;
  readonly type: "city" | "port" | "terminal" | "inland" | "unknown";
  readonly carrier_location_id: string;
  readonly mapping_source: string;
  readonly source_full_name: string | null;
  readonly unlocode: string | null;
}

export interface ResolveLocationInput {
  readonly text: string;
  readonly country_code: string | null;
  readonly carrier_location_id: string | null;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function candidateMatchesQuery(
  candidate: LocationCandidate,
  input: ResolveLocationInput,
): boolean {
  const lookup = portLookup(input.text, input.country_code);
  if (
    lookup.countryCode !== null &&
    candidate.country_code !== lookup.countryCode
  ) {
    return false;
  }
  if (input.carrier_location_id !== null) {
    return candidate.carrier_location_id === input.carrier_location_id;
  }
  const candidateName = normalized(candidate.name);
  const queryText = normalized(lookup.text);
  return (
    candidateName === queryText ||
    candidateName.includes(queryText) ||
    queryText.includes(candidateName)
  );
}

export function resolveLocationCandidates(
  input: ResolveLocationInput,
  candidates: readonly LocationCandidate[],
): ResolvedLocation {
  const matches = findLocationCandidates(input, candidates);
  if (matches.length === 0) {
    throw new CollectorRuntimeError(
      "location_not_found",
      "needs_input",
      "collector_location_not_found",
    );
  }
  if (matches.length > 1) {
    throw new CollectorRuntimeError(
      "ambiguous_location",
      "needs_input",
      "collector_location_ambiguous",
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new CollectorRuntimeError(
      "location_not_found",
      "needs_input",
      "collector_location_not_found",
    );
  }
  return ResolvedLocationSchema.parse({
    input_text: input.text,
    name: match.name,
    country_code: match.country_code,
    type: match.type,
    carrier_location_id: match.carrier_location_id,
    mapping_source: match.mapping_source,
    source_full_name: match.source_full_name,
    unlocode: match.unlocode,
  });
}

export function findLocationCandidates(
  input: ResolveLocationInput,
  candidates: readonly LocationCandidate[],
): readonly LocationCandidate[] {
  return candidates.filter((candidate) =>
    candidateMatchesQuery(candidate, input),
  );
}
