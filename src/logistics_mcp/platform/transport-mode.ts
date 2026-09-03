export const MCP_TRANSPORT_MODES = Object.freeze([
  "stateless",
  "stateful",
] as const);

export type McpTransportMode = (typeof MCP_TRANSPORT_MODES)[number];

export function parseMcpTransportMode(value: unknown): McpTransportMode {
  if (value === "stateless" || value === "stateful") return value;
  throw new Error("MCP transport mode must be stateless or stateful.");
}
