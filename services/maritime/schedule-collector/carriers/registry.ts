import { CollectorRuntimeError } from "../errors";
import type { CarrierAdapter, CarrierMetadata } from "./types";
import { normalizeCarrierId } from "./aliases";
import { createCoscoAdapter, COSCO_ADAPTER_METADATA } from "./cosco";
import { createHmmAdapter, HMM_ADAPTER_METADATA } from "./hmm";
import { createOneAdapter, ONE_ADAPTER_METADATA } from "./one";
import { createOoclParserAdapter, OOCL_ADAPTER_METADATA } from "./oocl";

const CARRIER_METADATA: readonly CarrierMetadata[] = [
  COSCO_ADAPTER_METADATA,
  {
    ...OOCL_ADAPTER_METADATA,
    lastLiveVerifiedAt: null,
  },
  {
    id: "EVERGREEN",
    displayName: "Evergreen Line",
    adapterVersion: "evergreen-adapter@0",
    capabilityStatus: "probed",
    provenanceKind: "live",
    lastLiveVerifiedAt: null,
  },
  HMM_ADAPTER_METADATA,
  {
    id: "WHL",
    displayName: "Wan Hai Lines",
    adapterVersion: "whl-adapter@0",
    capabilityStatus: "probed",
    provenanceKind: "live",
    lastLiveVerifiedAt: null,
  },
  {
    id: "YML",
    displayName: "Yang Ming Marine Transport",
    adapterVersion: "yml-adapter@0",
    capabilityStatus: "probed",
    provenanceKind: "live",
    lastLiveVerifiedAt: null,
  },
  {
    id: "ZIM",
    displayName: "ZIM",
    adapterVersion: "zim-adapter@0",
    capabilityStatus: "probed",
    provenanceKind: "live",
    lastLiveVerifiedAt: null,
  },
  {
    id: "HAPAG_LLOYD",
    displayName: "Hapag-Lloyd",
    adapterVersion: "hapag-lloyd-adapter@0",
    capabilityStatus: "probed",
    provenanceKind: "live",
    lastLiveVerifiedAt: null,
  },
  ONE_ADAPTER_METADATA,
  {
    id: "MAERSK",
    displayName: "Maersk",
    adapterVersion: "maersk-adapter@0",
    capabilityStatus: "probed",
    provenanceKind: "live",
    lastLiveVerifiedAt: null,
  },
  {
    id: "MSC",
    displayName: "MSC",
    adapterVersion: "msc-adapter@0",
    capabilityStatus: "probed",
    provenanceKind: "live",
    lastLiveVerifiedAt: null,
  },
  {
    id: "MATSON",
    displayName: "Matson",
    adapterVersion: "matson-adapter@0",
    capabilityStatus: "probed",
    provenanceKind: "live",
    lastLiveVerifiedAt: null,
  },
];

function notImplementedAdapter(metadata: CarrierMetadata): CarrierAdapter {
  return {
    metadata,
    resolveLocations() {
      return Promise.reject(
        new CollectorRuntimeError(
          "not_implemented",
          "unavailable",
          "collector_carrier_not_implemented",
        ),
      );
    },
    query() {
      return Promise.reject(
        new CollectorRuntimeError(
          "not_implemented",
          "unavailable",
          "collector_carrier_not_implemented",
        ),
      );
    },
  };
}

export function listCarrierMetadata(): readonly CarrierMetadata[] {
  return CARRIER_METADATA;
}

export function createCarrierRegistry(
  overrides: readonly CarrierAdapter[] = [],
): ReadonlyMap<string, CarrierAdapter> {
  const registry = new Map<string, CarrierAdapter>();
  for (const metadata of CARRIER_METADATA) {
    registry.set(
      metadata.id,
      metadata.id === "OOCL"
        ? createOoclParserAdapter()
        : metadata.id === "HMM"
          ? createHmmAdapter()
          : metadata.id === "ONE"
            ? createOneAdapter()
            : metadata.id === "COSCO"
              ? createCoscoAdapter()
              : notImplementedAdapter(metadata),
    );
  }
  for (const adapter of overrides) {
    const id = normalizeCarrierId(adapter.metadata.id) ?? adapter.metadata.id;
    registry.set(id, adapter);
  }
  return registry;
}
