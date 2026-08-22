import {
  CrossTenantAccessError,
  ForbiddenError,
} from "./contract-errors";
import type { ActorRole, ExecutionContext } from "./context";

export { CrossTenantAccessError, ForbiddenError } from "./contract-errors";

export const phaseOneToolNames = Object.freeze([
  "knowledge.search_curated",
  "system.get_data_status",
  "cargo.calculate",
  "container.plan_summary",
  "quote.canada_final_mile.calculate",
  "customs.ca.search",
  "customs.ca.estimate",
  "quote.save_draft",
  "review.create_task",
] as const);

export type PhaseOneToolName = (typeof phaseOneToolNames)[number];
export const agentContextToolName = "system.agent_context.get" as const;
type KnownToolName = PhaseOneToolName | typeof agentContextToolName;

type ToolPolicy = {
  readonly permission: string;
  readonly kind: "read" | "write";
  readonly roles: readonly ActorRole[];
};

const readRoles = Object.freeze([
  "admin",
  "sales",
  "operator",
  "customs_reviewer",
  "finance",
  "viewer",
  "service",
] as const satisfies readonly ActorRole[]);

const taskRoles = Object.freeze([
  "admin",
  "sales",
  "operator",
  "customs_reviewer",
  "finance",
] as const satisfies readonly ActorRole[]);

const draftRoles = Object.freeze([
  "admin",
  "sales",
  "operator",
] as const satisfies readonly ActorRole[]);

function freezePolicy(
  permission: string,
  kind: ToolPolicy["kind"],
  roles: readonly ActorRole[],
): ToolPolicy {
  return Object.freeze({
    permission,
    kind,
    roles: Object.freeze(roles),
  });
}

const toolPolicies: Readonly<Record<KnownToolName, ToolPolicy>> = Object.freeze({
  "knowledge.search_curated": freezePolicy("knowledge:read", "read", readRoles),
  "system.get_data_status": freezePolicy("system:read", "read", readRoles),
  "cargo.calculate": freezePolicy("quote:calculate", "read", readRoles),
  "container.plan_summary": freezePolicy("container:calculate", "read", readRoles),
  "quote.canada_final_mile.calculate": freezePolicy("quote:calculate", "read", readRoles),
  "customs.ca.search": freezePolicy("tariff:read", "read", readRoles),
  "customs.ca.estimate": freezePolicy("tariff:estimate", "read", readRoles),
  "quote.save_draft": freezePolicy("quote:draft_write", "write", draftRoles),
  "review.create_task": freezePolicy("review:create_task", "write", taskRoles),
  [agentContextToolName]: freezePolicy("system:agent_context", "read", readRoles),
});

function hasScope(context: ExecutionContext, permission: string): boolean {
  return (
    context.scopes.includes(permission) ||
    context.scopes.includes(`${permission}:*`) ||
    context.scopes.includes("platform:admin")
  );
}

export function assertTenantScope(
  context: ExecutionContext,
  targetTenantId = context.tenantId,
): void {
  if (targetTenantId !== context.tenantId) {
    throw new CrossTenantAccessError();
  }
}

export function authorizeTool(
  context: ExecutionContext,
  toolName: string,
  targetTenantId = context.tenantId,
): true {
  assertTenantScope(context, targetTenantId);

  if (!Object.hasOwn(toolPolicies, toolName)) {
    throw new ForbiddenError("The requested MCP tool is not allowlisted.");
  }
  const policy = toolPolicies[toolName as KnownToolName];
  if (!context.roles.some((role) => policy.roles.includes(role))) {
    throw new ForbiddenError("The authenticated role cannot use this tool.");
  }
  if (!hasScope(context, policy.permission)) {
    throw new ForbiddenError("The authenticated scope cannot use this tool.");
  }

  return true;
}

export function getToolPolicy(toolName: string): ToolPolicy {
  if (!Object.hasOwn(toolPolicies, toolName)) {
    throw new ForbiddenError("The requested MCP tool is not allowlisted.");
  }
  const policy = toolPolicies[toolName as KnownToolName];
  return policy;
}
