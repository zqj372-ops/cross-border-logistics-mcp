export const BUSINESS_ENTRYPOINTS_SCHEMA_VERSION = "business-entrypoints@2026-09-05.v1" as const;

type RuntimeMode = "fixtures" | "production";
type Environment = Readonly<Record<string, string | undefined>>;

export interface BusinessEntrypointsMetadata {
  readonly schema_version: typeof BUSINESS_ENTRYPOINTS_SCHEMA_VERSION;
  readonly status: "success";
  readonly data: {
    readonly quote: {
      readonly configured: boolean;
      readonly sales: string | null;
      readonly ai_quote: string | null;
      readonly operations: string | null;
    };
    readonly customs: {
      readonly configured: boolean;
      readonly search: string | null;
      readonly calculator: string | null;
    };
  };
  readonly reason_codes: readonly string[];
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function configuredOrigin(value: string | undefined, mode: RuntimeMode): string | null {
  if (value === undefined || value === "") return null;
  if (value !== value.trim() || value.length > 2048 || [...value].some((character) => { const code=character.charCodeAt(0); return code<=31||code===127; })) return "invalid";
  if (/%[0-9a-f]{2}/iu.test(value)) return "invalid";
  try {
    const parsed = new URL(value);
    if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return "invalid";
    if (parsed.pathname !== "/" || parsed.hostname === "") return "invalid";
    if (value !== parsed.origin && value !== `${parsed.origin}/`) return "invalid";
    if (parsed.protocol === "https:") return parsed.origin;
    if (mode === "fixtures" && parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return parsed.origin;
    return "invalid";
  } catch {
    return "invalid";
  }
}

function fixedUrl(origin: string, path: string): string {
  return new URL(path, `${origin}/`).href;
}

export function businessEntrypointsFromEnvironment(
  environment: Environment,
  mode: RuntimeMode,
): BusinessEntrypointsMetadata {
  const quoteOrigin = configuredOrigin(environment.MCP_QUOTE_UI_ORIGIN, mode);
  const customsOrigin = configuredOrigin(environment.MCP_CUSTOMS_UI_ORIGIN, mode);
  const reasons: string[] = [];
  if (quoteOrigin === null) reasons.push("quote_entrypoint_unconfigured");
  else if (quoteOrigin === "invalid") reasons.push("quote_entrypoint_invalid");
  if (customsOrigin === null) reasons.push("customs_entrypoint_unconfigured");
  else if (customsOrigin === "invalid") reasons.push("customs_entrypoint_invalid");

  return Object.freeze({
    schema_version: BUSINESS_ENTRYPOINTS_SCHEMA_VERSION,
    status: "success",
    data: Object.freeze({
      quote: quoteOrigin === null || quoteOrigin === "invalid"
        ? Object.freeze({ configured: false, sales: null, ai_quote: null, operations: null })
        : Object.freeze({
            configured: true,
            sales: fixedUrl(quoteOrigin, "/quote"),
            ai_quote: fixedUrl(quoteOrigin, "/ai-quote"),
            operations: fixedUrl(quoteOrigin, "/ops"),
          }),
      customs: customsOrigin === null || customsOrigin === "invalid"
        ? Object.freeze({ configured: false, search: null, calculator: null })
        : Object.freeze({
            configured: true,
            search: fixedUrl(customsOrigin, "/"),
            calculator: fixedUrl(customsOrigin, "/calculator"),
          }),
    }),
    reason_codes: Object.freeze(reasons),
  });
}
