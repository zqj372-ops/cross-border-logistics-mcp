import type { ApprovedTarget, TransportPolicy } from "./config";

export const OOCL_SOURCE_PERMISSION_REF =
  "oocl-terms-section-1.05-b-i-and-2.03";
export const OOCL_LIVE_POLICY_REF = "user-20260917-continue-k12";

const OOCL_LIVE_TARGETS: readonly ApprovedTarget[] = [
  {
    carrier: "OOCL",
    host: "moc.oocl.com",
    port: 443,
    methods: ["GET"],
    path: "/nj_prs_wss/mocss/secured/supportData/gsp/locationDetails",
    allowedQueryKeys: ["id", "bound"],
    allowedBodyKeys: [],
    sourcePermissionRef: OOCL_SOURCE_PERMISSION_REF,
    livePolicyApprovalRef: OOCL_LIVE_POLICY_REF,
    expiresAt: "2026-12-31T23:59:59Z",
  },
  {
    carrier: "OOCL",
    host: "moc.oocl.com",
    port: 443,
    methods: ["POST"],
    path: "/nj_prs_wss/mocss/secured/supportData/nsso/searchHubToHubRoute",
    allowedQueryKeys: [],
    allowedBodyKeys: [
      "date",
      "weeks",
      "weeksSymbol",
      "sailing",
      "origin_Haulage",
      "destination_Haulage",
      "cargo_Nature",
      "originId",
      "destinationId",
      "originCountryCode",
      "destinationCountryCode",
      "originCityTimeZone",
      "destinationCityTimeZone",
      "transitPort",
      "service",
      "captchaToken",
    ],
    sourcePermissionRef: OOCL_SOURCE_PERMISSION_REF,
    livePolicyApprovalRef: OOCL_LIVE_POLICY_REF,
    expiresAt: "2026-12-31T23:59:59Z",
  },
];

export function createOoclLiveTransportPolicy(): TransportPolicy {
  return {
    approvedTargets: OOCL_LIVE_TARGETS,
    timeoutMs: 120_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxRequestBodyBytes: 256 * 1024,
    maxRequestsPerRun: 15,
    maxRetries: 2,
  };
}
