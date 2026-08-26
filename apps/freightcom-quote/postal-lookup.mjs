import {
  createFetchJsonClient,
  HttpAdapterError,
} from "../../src/logistics_mcp/adapters/http-client.ts";

const CANADIAN_POSTAL_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/u;
const US_ZIP_RE = /^\d{5}(?:-\d{4})?$/u;
const LOOKUP_BASE_URL = "https://api.zippopotam.us";
const LOOKUP_ALLOWED_HOSTS = ["api.zippopotam.us"];
const LOOKUP_MAX_RESPONSE_BYTES = 64 * 1024;

export class PostalLookupError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "PostalLookupError";
    this.code = code;
    this.status = status;
  }
}

export function parseNorthAmericanPostal(value) {
  const compact = String(value ?? "").trim().toUpperCase().replaceAll(" ", "");
  if (CANADIAN_POSTAL_RE.test(compact)) {
    return {
      country: "CA",
      normalizedPostalCode: `${compact.slice(0, 3)} ${compact.slice(3)}`,
      lookupPostalCode: compact.slice(0, 3),
      approximate: true,
    };
  }
  if (US_ZIP_RE.test(compact)) {
    return {
      country: "US",
      normalizedPostalCode: compact,
      lookupPostalCode: compact.slice(0, 5),
      approximate: false,
    };
  }
  return null;
}

function locationFromResponse(parsedPostal, payload) {
  const place = Array.isArray(payload?.places) ? payload.places[0] : undefined;
  const city = typeof place?.["place name"] === "string" ? place["place name"].trim() : "";
  const region = typeof place?.["state abbreviation"] === "string" ? place["state abbreviation"].trim().toUpperCase() : "";
  if (city === "" || !/^[A-Z]{2}$/u.test(region)) {
    throw new PostalLookupError("POSTAL_LOOKUP_RESPONSE_INVALID", "邮编服务返回的数据不完整。", 503);
  }
  return {
    postal_code: parsedPostal.normalizedPostalCode,
    city,
    region,
    country: parsedPostal.country,
    approximate: parsedPostal.approximate,
    source: "Zippopotam.us / GeoNames",
  };
}

export function createPostalLookup(options = {}) {
  const timeoutMs = options.timeoutMs ?? 6000;
  const client = createFetchJsonClient({
    baseUrl: LOOKUP_BASE_URL,
    allowedHosts: LOOKUP_ALLOWED_HOSTS,
    enabled: true,
    timeoutMs,
    maxResponseBytes: LOOKUP_MAX_RESPONSE_BYTES,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return async function lookupPostal(value) {
    const parsedPostal = parseNorthAmericanPostal(value);
    if (parsedPostal === null) {
      throw new PostalLookupError(
        "POSTAL_LOOKUP_INPUT_INVALID",
        "请输入有效的加拿大邮编或美国 5 位 ZIP Code。",
        422,
      );
    }
    let result;
    try {
      result = await client.get(
        `/${parsedPostal.country.toLowerCase()}/${encodeURIComponent(parsedPostal.lookupPostalCode)}`,
        { accept: "application/json" },
      );
    } catch (error) {
      if (
        error instanceof HttpAdapterError
        && error.code === "upstream_http_error"
        && error.status === 404
      ) {
        throw new PostalLookupError("POSTAL_LOOKUP_NOT_FOUND", "未找到该邮编对应的城市信息。", 404);
      }
      if (
        error instanceof HttpAdapterError
        && (error.code === "upstream_invalid_json"
          || error.code === "upstream_response_too_large")
      ) {
        throw new PostalLookupError(
          "POSTAL_LOOKUP_RESPONSE_INVALID",
          "邮编服务返回了无法读取的数据。",
          503,
        );
      }
      throw new PostalLookupError("POSTAL_LOOKUP_UNAVAILABLE", "邮编自动识别服务暂时不可用。", 503);
    }
    return locationFromResponse(parsedPostal, result);
  };
}
