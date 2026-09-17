import type { ApprovedTarget, TransportPolicy } from "./config";

export const COSCO_SOURCE_PERMISSION_REF =
  "cosco-elines-clause-internal-use-20260917";
export const COSCO_LIVE_POLICY_REF = "user-20260917-continue-k12";

const COSCO_LIVE_TARGETS: readonly ApprovedTarget[] = [
  {
    carrier: "COSCO",
    host: "elines.coscoshipping.com",
    port: 443,
    methods: ["GET"],
    path: "/ebbase/public/general/findCityDistrictByPrefix",
    allowedQueryKeys: ["prefix", "timestamp"],
    allowedBodyKeys: [],
    sourcePermissionRef: COSCO_SOURCE_PERMISSION_REF,
    livePolicyApprovalRef: COSCO_LIVE_POLICY_REF,
    expiresAt: "2026-12-31T23:59:59Z",
  },
  {
    carrier: "COSCO",
    host: "elines.coscoshipping.com",
    port: 443,
    methods: ["POST"],
    path: "/ebschedule/public/purpoShipmentWs",
    allowedQueryKeys: [],
    allowedBodyKeys: [
      "fromDate",
      "pickup",
      "delivery",
      "estimateDate",
      "toDate",
      "originCityUuid",
      "destinationCityUuid",
      "originCity",
      "destinationCity",
      "cargoNature",
    ],
    sourcePermissionRef: COSCO_SOURCE_PERMISSION_REF,
    livePolicyApprovalRef: COSCO_LIVE_POLICY_REF,
    expiresAt: "2026-12-31T23:59:59Z",
  },
];

export function createCoscoLiveTransportPolicy(): TransportPolicy {
  return {
    approvedTargets: COSCO_LIVE_TARGETS,
    timeoutMs: 120_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxRequestBodyBytes: 256 * 1024,
    maxRequestsPerRun: 15,
    maxRetries: 2,
  };
}

export function createTrustedTransportPolicy(): TransportPolicy {
  return {
    approvedTargets: COSCO_LIVE_TARGETS,
    timeoutMs: 120_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxRequestBodyBytes: 256 * 1024,
    maxRequestsPerRun: 15,
    maxRetries: 2,
  };
}
