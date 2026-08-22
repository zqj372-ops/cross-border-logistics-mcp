export type AgentResourceMimeType = "application/json" | "text/markdown";

export interface CanonicalAgentResource {
  readonly resource_id: string;
  readonly uri: string;
  readonly standard_ids: readonly string[];
  readonly mimeType: AgentResourceMimeType;
}

const canonicalResources = [
  {
    resource_id: "agent.bootstrap",
    uri: "logistics://agent/bootstrap",
    standard_ids: ["agent.bootstrap"],
    mimeType: "application/json",
  },
  {
    resource_id: "standards.index",
    uri: "logistics://standards/index",
    standard_ids: ["agent.bootstrap", "platform.contracts", "module-runtime.v0", "agent-access.v0"],
    mimeType: "application/json",
  },
  {
    resource_id: "contracts.envelope.current",
    uri: "logistics://contracts/envelope/current",
    standard_ids: ["platform.contracts"],
    mimeType: "text/markdown",
  },
  {
    resource_id: "modules.catalog",
    uri: "logistics://modules/catalog",
    standard_ids: ["module-runtime.v0"],
    mimeType: "application/json",
  },
  {
    resource_id: "agent.profiles",
    uri: "logistics://agent/profiles",
    standard_ids: ["agent-access.v0"],
    mimeType: "application/json",
  },
] as const satisfies readonly CanonicalAgentResource[];

export const CANONICAL_AGENT_RESOURCES: readonly CanonicalAgentResource[] =
  Object.freeze(
    canonicalResources.map((resource) =>
      Object.freeze({
        ...resource,
        standard_ids: Object.freeze([...resource.standard_ids]),
      }),
    ),
  );

export function canonicalAgentResource(resourceId: string): CanonicalAgentResource | undefined {
  return CANONICAL_AGENT_RESOURCES.find((resource) => resource.resource_id === resourceId);
}
