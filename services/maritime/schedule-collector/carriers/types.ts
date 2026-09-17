import type {
  CollectorResultData,
  NormalizedCollectorQuery,
  ResolvedLocation,
} from "../contracts";
import type { LocationCandidate } from "../locations";
import type {
  CarrierHttpPort,
  EvidenceStore,
} from "../ports";

export interface CarrierMetadata {
  readonly id: string;
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly capabilityStatus:
    | "not_probed"
    | "probed"
    | "implemented_unverified"
    | "synthetic_only"
    | "live_verified"
    | "blocked"
    | "unsupported";
  readonly provenanceKind: "live" | "synthetic" | "replay";
  readonly lastLiveVerifiedAt: string | null;
}

export interface CarrierParserContext {
  readonly requestId: string;
  readonly normalizedQuery: NormalizedCollectorQuery;
  readonly origin: ResolvedLocation;
  readonly destination: ResolvedLocation;
  readonly evidenceRef: string;
  readonly observedAt: string;
}

export interface CarrierParserResult {
  readonly records: CollectorResultData["records"];
  readonly coverage: CollectorResultData["coverage"];
  readonly quality: CollectorResultData["quality"];
  readonly evidenceRef: string | null;
  readonly evidenceRefs?: readonly string[];
}

export interface CarrierAdapter {
  readonly metadata: CarrierMetadata;
  resolveLocations(
    input: {
      readonly text: string;
      readonly countryCode: string | null;
      readonly carrierLocationId?: string | null;
    },
    http: CarrierHttpPort,
  ): Promise<readonly LocationCandidate[]>;
  query(
    context: CarrierParserContext,
    http: CarrierHttpPort,
    evidence: EvidenceStore,
  ): Promise<CarrierParserResult>;
}
