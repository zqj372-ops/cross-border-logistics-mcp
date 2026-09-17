import type { ApprovedTarget, TransportPolicy } from "./config";

export const HMM_SOURCE_PERMISSION_REF =
  "hmm-public-schedule-20260917";
export const HMM_LIVE_POLICY_REF = "user-20260917-expand-carriers";

const HMM_LIVE_TARGETS: readonly ApprovedTarget[] = [
  {
    carrier: "HMM",
    host: "www.hmm21.com",
    port: 443,
    methods: ["GET"],
    path: "/e-service/general/schedule/ScheduleMain.do",
    allowedQueryKeys: [],
    allowedBodyKeys: [],
    sessionCookieHost: "www.hmm21.com",
    sourcePermissionRef: HMM_SOURCE_PERMISSION_REF,
    livePolicyApprovalRef: HMM_LIVE_POLICY_REF,
    expiresAt: "2026-12-31T23:59:59Z",
  },
  {
    carrier: "HMM",
    host: "www.hmm21.com",
    port: 443,
    methods: ["GET"],
    path: "/data_files/ebiz/locationJS/CitiesList.js",
    allowedQueryKeys: [],
    allowedBodyKeys: [],
    sessionCookieHost: "www.hmm21.com",
    sourcePermissionRef: HMM_SOURCE_PERMISSION_REF,
    livePolicyApprovalRef: HMM_LIVE_POLICY_REF,
    expiresAt: "2026-12-31T23:59:59Z",
  },
  {
    carrier: "HMM",
    host: "www.hmm21.com",
    port: 443,
    methods: ["POST"],
    path: "/e-service/general/schedule/apiPointToPointList.do",
    allowedQueryKeys: [],
    allowedBodyKeys: [
      "srchPointFromCd",
      "srchCityFrom",
      "srchPointToCd",
      "srchCityTo",
      "srchSelPriority",
      "srchPorFcltyCd",
      "srchPvyFcltyCd",
      "paramToday",
      "srchViewType",
      "srchSailDate",
      "srchSelWeeks",
      "srchSelSortBy",
      "itemPolCd",
      "itemPodCd",
    ],
    allowedRequestHeaders: [
      "content-type",
      "x-csrf-token",
      "origin",
      "referer",
    ],
    allowedRequestHeaderValues: {
      origin: "https://www.hmm21.com",
      referer:
        "https://www.hmm21.com/e-service/general/schedule/ScheduleMain.do",
    },
    sessionCookieHost: "www.hmm21.com",
    sourcePermissionRef: HMM_SOURCE_PERMISSION_REF,
    livePolicyApprovalRef: HMM_LIVE_POLICY_REF,
    expiresAt: "2026-12-31T23:59:59Z",
  },
  {
    carrier: "HMM",
    host: "www.hmm21.com",
    port: 443,
    methods: ["POST"],
    path: "/e-service/general/schedule/selectPointToPointList.do",
    allowedQueryKeys: [],
    allowedBodyKeys: [
      "srchViewType",
      "srchGrmNo",
      "isNew",
      "srchSelPriority",
      "srchSelSortBy",
    ],
    allowedRequestHeaders: [
      "content-type",
      "x-csrf-token",
      "origin",
      "referer",
    ],
    allowedRequestHeaderValues: {
      origin: "https://www.hmm21.com",
      referer:
        "https://www.hmm21.com/e-service/general/schedule/ScheduleMain.do",
    },
    sessionCookieHost: "www.hmm21.com",
    sourcePermissionRef: HMM_SOURCE_PERMISSION_REF,
    livePolicyApprovalRef: HMM_LIVE_POLICY_REF,
    expiresAt: "2026-12-31T23:59:59Z",
  },
];

export function createHmmLiveTransportPolicy(): TransportPolicy {
  return {
    approvedTargets: HMM_LIVE_TARGETS,
    timeoutMs: 120_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxRequestBodyBytes: 256 * 1024,
    maxRequestsPerRun: 15,
    maxRetries: 2,
  };
}
