const T1_WORKER_ENVIRONMENT_KEYS = Object.freeze([
  "MCP_ALLOWED_OUTBOUND_HOSTS",
  "MCP_QUOTE_PREVIEW_ENABLED",
  "MCP_QUOTE_PREVIEW_BASE_URL",
  "MCP_QUOTE_PREVIEW_ALLOWED_HOSTS",
  "MCP_QUOTE_PREVIEW_API_KEY_SECRET_FILE",
  "MCP_QUOTE_PREVIEW_ORIGIN_MAP_FILE",
  "MCP_RISK_CUSTOMS_ENABLED",
  "MCP_RISK_CUSTOMS_BASE_URL",
  "MCP_RISK_CUSTOMS_ALLOWED_HOSTS",
  "MCP_RISK_CUSTOMS_ALLOWED_TENANTS",
  "MCP_RISK_CUSTOMS_AUTH_SECRET_FILE",
  "MCP_FREIGHTCOM_TEST_ENABLED",
  "MCP_FREIGHTCOM_TEST_AUTH_SECRET_FILE",
  "MCP_FREIGHTCOM_TEST_ALLOWED_TENANTS",
] as const);

/**
 * Builds the complete child environment instead of extending process.env.
 * Credentials remain file references and unrelated parent settings are not
 * inherited by the T1 process.
 */
export function buildT1WorkerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of T1_WORKER_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return Object.freeze(environment);
}
