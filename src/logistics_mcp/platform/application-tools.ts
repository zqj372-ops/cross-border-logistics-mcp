export const APPLICATION_MCP_PROFILE = "business-v1" as const;
export const BUSINESS_MCP_TOOLS = Object.freeze([
  "customs.query", "customs.tax.estimate", "quote.zone_preview", "quote.ai_extract_preview", "quote.freightcom_ltl.preview",
] as const);
export const APPLICATION_MCP_TOOLS = Object.freeze([
  "cargo.calculate", "container.plan_summary", "system.agent_context.get", ...BUSINESS_MCP_TOOLS,
] as const);
export type BusinessMcpTool = typeof BUSINESS_MCP_TOOLS[number];
export type ApplicationMcpTool = typeof APPLICATION_MCP_TOOLS[number];

export function isApplicationMcpIdentity(input: { role: unknown; roles: unknown; scopes: unknown; profile?: unknown }): boolean {
  return input.profile === APPLICATION_MCP_PROFILE && input.role === "service"
    && Array.isArray(input.roles) && input.roles.length === 1 && input.roles[0] === "service"
    && Array.isArray(input.scopes) && input.scopes.length > 0 && input.scopes.length <= APPLICATION_MCP_TOOLS.length
    && new Set(input.scopes).size === input.scopes.length
    && input.scopes.every(scope => typeof scope === "string" && APPLICATION_MCP_TOOLS.some(tool => scope === `tool:${tool}`));
}
