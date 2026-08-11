import {
  CrossTenantAccessError,
  ForbiddenError,
} from "./contract-errors";
import type { ActorRole, ExecutionContext } from "./context";

export { CrossTenantAccessError, ForbiddenError } from "./contract-errors";

export const phaseOneToolNames = [
  "knowledge.search_curated",
  "system.get_data_status",
  "cargo.calculate",
  "container.plan_summary",
  "quote.canada_final_mile.calculate",
  "customs.ca.search",
  "customs.ca.estimate",
  "quote.save_draft",
  "review.create_task",
] as const;

export type PhaseOneToolName = (typeof phaseOneToolNames)[number];

type ToolPolicy = {
  readonly permission: string;
  readonly kind: "read" | "write";
  readonly roles: readonly ActorRole[];
};

const readRoles = [
  "admin",
  "sales",
  "operator",
  "customs_reviewer",
  "finance",
  "viewer",
  "service",
] as const satisfies readonly ActorRole[];

const taskRoles = [
  "admin",
  "sales",
  "operator",
  "customs_reviewer",
  "finance",
] as const satisfies readonly ActorRole[];

const toolPolicies: Record<PhaseOneToolName, ToolPolicy> = {
  "knowledge.search_curated": {
    permission: "knowledge:read",
    kind: "read",
    roles: readRoles,
  },
  "system.get_data_status": {
    permission: "system:read",
    kind: "read",
    roles: readRoles,
  },
  "cargo.calculate": {
    permission: "quote:calculate",
    kind: "read",
    roles: readRoles,
  },
  "container.plan_summary": {
    permission: "container:calculate",
    kind: "read",
    roles: readRoles,
  },
  "quote.canada_final_mile.calculate": {
    permission: "quote:calculate",
    kind: "read",
    roles: readRoles,
  },
  "customs.ca.search": {
    permission: "tariff:read",
    kind: "read",
    roles: readRoles,
  },
  "customs.ca.estimate": {
    permission: "tariff:estimate",
    kind: "read",
    roles: readRoles,
  },
  "quote.save_draft": {
    permission: "quote:draft_write",
    kind: "write",
    roles: ["admin", "sales", "operator"],
  },
  "review.create_task": {
    permission: "review:create_task",
    kind: "write",
    roles: taskRoles,
  },
};

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

  const policy = (toolPolicies as Partial<Record<string, ToolPolicy>>)[toolName];
  if (policy === undefined) {
    throw new ForbiddenError("The requested MCP tool is not allowlisted.");
  }
  if (!context.roles.some((role) => policy.roles.includes(role))) {
    throw new ForbiddenError("The authenticated role cannot use this tool.");
  }
  if (!hasScope(context, policy.permission)) {
    throw new ForbiddenError("The authenticated scope cannot use this tool.");
  }

  return true;
}

export function getToolPolicy(toolName: PhaseOneToolName): ToolPolicy {
  return toolPolicies[toolName];
}
