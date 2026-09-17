import type { ApprovedTarget, TransportPolicy } from "./config";

export const ONE_SOURCE_PERMISSION_REF = "one-public-schedule-20260917";
export const ONE_LIVE_POLICY_REF = "user-20260917-continue-k12";

const ONE_LIVE_TARGETS: readonly ApprovedTarget[] = [
  {
    carrier: "ONE",
    host: "ecomm.one-line.com",
    port: 443,
    methods: ["GET"],
    path: "/api/v1/schedule/point-to-point/search",
    allowedQueryKeys: ["pointName", "userCountryCode", "sortType"],
    allowedBodyKeys: [],
    sourcePermissionRef: ONE_SOURCE_PERMISSION_REF,
    livePolicyApprovalRef: ONE_LIVE_POLICY_REF,
    expiresAt: "2026-12-31T23:59:59Z",
  },
  {
    carrier: "ONE",
    host: "ecomm.one-line.com",
    port: 443,
    methods: ["GET"],
    path: "/api/v1/schedule/point-to-point",
    allowedQueryKeys: [
      "porCode",
      "delCode",
      "rcvTermCode",
      "deTermCode",
      "tsFlag",
      "fromDate",
      "toDate",
      "cargoNature",
      "searchType",
    ],
    allowedBodyKeys: [],
    sourcePermissionRef: ONE_SOURCE_PERMISSION_REF,
    livePolicyApprovalRef: ONE_LIVE_POLICY_REF,
    expiresAt: "2026-12-31T23:59:59Z",
  },
];

export function createOneLiveTransportPolicy(): TransportPolicy {
  return {
    approvedTargets: ONE_LIVE_TARGETS,
    timeoutMs: 120_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxRequestBodyBytes: 256 * 1024,
    maxRequestsPerRun: 15,
    maxRetries: 2,
  };
}
