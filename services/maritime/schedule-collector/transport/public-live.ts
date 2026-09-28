import type { TransportPolicy } from "./config";

/** Anonymous, read-only forms observed on the carriers' official public sites. */
export function createPublicSchedulePolicy(carrier: "SML" | "EVERGREEN" | "YML"): TransportPolicy {
  const shared = { carrier, port: 443 as const, sourcePermissionRef: "public-on-demand-schedules-20260927", livePolicyApprovalRef: "user-20260927-carrier-expansion", expiresAt: "2026-12-31T23:59:59Z" };
  return {
    timeoutMs: 30_000, maxResponseBytes: 2 * 1024 * 1024, maxRequestBodyBytes: 16 * 1024, maxRequestsPerRun: 15, maxRetries: 0,
    approvedTargets: carrier === "SML" ? [
      { ...shared, host: "esvc.smlines.com", methods: ["GET"], path: "/smline/CommonCodeGS.do", allowedQueryKeys: ["f_cmd", "loc_nm"], allowedBodyKeys: [] },
      { ...shared, host: "esvc.smlines.com", methods: ["POST"], path: "/smline/CUP_HOM_3001GS.do", allowedQueryKeys: [], allowedBodyKeys: ["f_cmd", "por_cd", "del_cd", "frm_dt", "to_dt", "ts_ind"] },
    ] : carrier === "YML" ? [
      { ...shared, host: "www.yangming.com", methods: ["GET"], path: "/api/P2P/GetLocations", allowedQueryKeys: ["queryType", "searchByCode", "locationName"], allowedBodyKeys: [] },
      { ...shared, host: "www.yangming.com", methods: ["GET"], path: "/api/P2P/GetP2PRoutes", allowedQueryKeys: ["locationCodeFrom", "serviceTermFrom", "locationCodeTo", "serviceTermTo", "priorityWay", "dateDefinition", "startDate", "endDate"], allowedBodyKeys: [] },
    ] : [
      { ...shared, host: "ss.shipmentlink.com", methods: ["GET"], path: "/servlet/TUF1_AutoCompleteServlet", allowedQueryKeys: ["scope", "search", "action", "switchSql", "datasource", "fromFirst"], allowedBodyKeys: [] },
      { ...shared, host: "ss.shipmentlink.com", methods: ["POST"], path: "/tvs2/jsp/TVS2_InteractiveScheduleRouting.jsp", allowedQueryKeys: [], allowedBodyKeys: ["oriLocation", "oriLocationName", "desLocation", "desLocationName", "carrier", "serviceMode", "isReefer", "func", "oriUSCA", "desUSCA", "oriEastWest", "desEastWest", "oriUseMode", "desUseMode", "departureDate", "departureDateShow", "departureYear", "departureMonth", "departureDay", "arrivalYear", "arrivalMonth", "arrivalDay", "durationWeek", "reeferCargo"] },
    ],
  };
}
