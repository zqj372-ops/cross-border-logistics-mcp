import type { CarrierBrowserPort } from "../ports";
import { CollectorRuntimeError } from "../errors";
import type { CarrierAdapter, CarrierMetadata } from "./types";
import { normalizeCarrierId } from "./aliases";
import { createCoscoAdapter, COSCO_ADAPTER_METADATA } from "./cosco";
import { createHmmAdapter, HMM_ADAPTER_METADATA } from "./hmm";
import { createOneAdapter, ONE_ADAPTER_METADATA } from "./one";
import { createOoclParserAdapter, OOCL_ADAPTER_METADATA } from "./oocl";
import { createSmlAdapter, SML_METADATA } from "./sml";
import { createEvergreenAdapter, EVERGREEN_METADATA } from "./evergreen";
import { createYmlAdapter, YML_METADATA } from "./yml";
import { createMaerskAdapter, MAERSK_METADATA } from "./maersk";

const CARRIER_METADATA: readonly CarrierMetadata[] = [
  COSCO_ADAPTER_METADATA,
  {
    ...OOCL_ADAPTER_METADATA,
    lastLiveVerifiedAt: null,
  },
  EVERGREEN_METADATA,
  HMM_ADAPTER_METADATA,
  {
    id: "WHL",
    displayName: "Wan Hai Lines",
    adapterVersion: "whl-adapter@0",
    capabilityStatus: "probed",
    provenanceKind: "live",
    lastLiveVerifiedAt: null,
  },
  YML_METADATA,
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
  MAERSK_METADATA,
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
  SML_METADATA,
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
  browser?: CarrierBrowserPort,
): ReadonlyMap<string, CarrierAdapter> {
  const registry = new Map<string, CarrierAdapter>();
  for (const metadata of CARRIER_METADATA) {
    registry.set(
      metadata.id,
      metadata.id === "OOCL"
        ? createOoclParserAdapter(browser)
        : metadata.id === "SML"
          ? createSmlAdapter()
        : metadata.id === "EVERGREEN"
          ? createEvergreenAdapter()
        : metadata.id === "YML"
          ? createYmlAdapter()
        : metadata.id === "MAERSK"
          ? createMaerskAdapter(browser)
        : metadata.id === "HMM"
          ? createHmmAdapter(browser)
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
