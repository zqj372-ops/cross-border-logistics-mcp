const CANADIAN_POSTAL_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/u;
const US_ZIP_RE = /^\d{5}(?:-\d{4})?$/u;
const LOOKUP_BASE_URL = "https://api.zippopotam.us";

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
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 6000;
  return async function lookupPostal(value) {
    const parsedPostal = parseNorthAmericanPostal(value);
    if (parsedPostal === null) {
      throw new PostalLookupError(
        "POSTAL_LOOKUP_INPUT_INVALID",
        "请输入有效的加拿大邮编或美国 5 位 ZIP Code。",
        422,
      );
    }
    let response;
    try {
      response = await fetchImpl(
        `${LOOKUP_BASE_URL}/${parsedPostal.country.toLowerCase()}/${encodeURIComponent(parsedPostal.lookupPostalCode)}`,
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch {
      throw new PostalLookupError("POSTAL_LOOKUP_UNAVAILABLE", "邮编自动识别服务暂时不可用。", 503);
    }
    if (response.status === 404) {
      throw new PostalLookupError("POSTAL_LOOKUP_NOT_FOUND", "未找到该邮编对应的城市信息。", 404);
    }
    if (!response.ok) {
      throw new PostalLookupError("POSTAL_LOOKUP_UNAVAILABLE", "邮编自动识别服务暂时不可用。", 503);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new PostalLookupError("POSTAL_LOOKUP_RESPONSE_INVALID", "邮编服务返回了无法读取的数据。", 503);
    }
    return locationFromResponse(parsedPostal, payload);
  };
}
