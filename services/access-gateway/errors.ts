import type { ErrorResponse } from "./contracts";

export type AccessGatewayErrorCode = ErrorResponse["code"];

const ERROR_METADATA: Readonly<Record<AccessGatewayErrorCode, {
  readonly httpStatus: 400 | 401 | 403 | 429 | 503;
  readonly status: ErrorResponse["status"];
}>> = Object.freeze({
  invalid_request: { httpStatus: 400, status: "needs_input" },
  authentication_failed: { httpStatus: 401, status: "blocked" },
  tool_entitlement_denied: { httpStatus: 403, status: "blocked" },
  rate_limited: { httpStatus: 429, status: "blocked" },
  access_gateway_unavailable: { httpStatus: 503, status: "unavailable" },
});

export class AccessGatewayError extends Error {
  readonly code: AccessGatewayErrorCode;
  readonly httpStatus: 400 | 401 | 403 | 429 | 503;
  readonly responseStatus: ErrorResponse["status"];

  constructor(code: AccessGatewayErrorCode, message = "Access Gateway request failed.") {
    super(message);
    this.name = "AccessGatewayError";
    this.code = code;
    this.httpStatus = ERROR_METADATA[code].httpStatus;
    this.responseStatus = ERROR_METADATA[code].status;
  }
}

export function asUnavailableError(error: unknown): AccessGatewayError {
  return error instanceof AccessGatewayError
    ? error
    : new AccessGatewayError("access_gateway_unavailable");
}
