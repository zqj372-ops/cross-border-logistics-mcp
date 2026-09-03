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
export const freightcomLtlToolName = "quote.freightcom_ltl.preview" as const;
type KnownToolName = PhaseOneToolName | typeof agentContextToolName | typeof freightcomLtlToolName;

export const tenantApiKeyToolNames = Object.freeze([
  "cargo.calculate",
  "container.plan_summary",
  agentContextToolName,
] as const);

export type TenantApiKeyToolName = (typeof tenantApiKeyToolNames)[number];
export type TenantApiKeyToolScope = `tool:${TenantApiKeyToolName}`;

const tenantApiKeyToolNameSet = new Set<string>(tenantApiKeyToolNames);

export const readPreviewToolNames = Object.freeze([
  ...tenantApiKeyToolNames,
  "quote.canada_final_mile.calculate",
  "customs.ca.search",
  "customs.ca.estimate",
  freightcomLtlToolName,
] as const);

export type ReadPreviewToolName = (typeof readPreviewToolNames)[number];
const readPreviewToolNameSet = new Set<string>(readPreviewToolNames);

export function tenantApiKeyScopeForToolName(
  toolName: TenantApiKeyToolName,
): TenantApiKeyToolScope {
  return `tool:${toolName}`;
}

export function tenantApiKeyToolNameFromScope(
  scope: string,
): TenantApiKeyToolName | null {
  if (!scope.startsWith("tool:")) return null;
  const toolName = scope.slice("tool:".length);
  return tenantApiKeyToolNameSet.has(toolName)
    ? toolName as TenantApiKeyToolName
    : null;
}

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
  [freightcomLtlToolName]: freezePolicy("quote:calculate", "read", readRoles),
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

function usesExactToolEntitlements(context: ExecutionContext): boolean {
  return context.scopes.some((scope) => scope.startsWith("tool:"));
}

function hasExactToolEntitlement(context: ExecutionContext, toolName: string): boolean {
  return readPreviewToolNameSet.has(toolName)
    && context.scopes.includes(`tool:${toolName}`);
}

function hasExactServiceIdentityShape(input: Readonly<{
  readonly role: unknown;
  readonly roles: unknown;
  readonly scopes: unknown;
}>): input is Readonly<{
  readonly role: "service";
  readonly roles: readonly ["service"];
  readonly scopes: readonly string[];
}> {
  return input.role === "service"
    && Array.isArray(input.roles)
    && input.roles.length === 1
    && input.roles[0] === "service"
    && Array.isArray(input.scopes)
    && input.scopes.length > 0
    && input.scopes.every((scope): scope is string => typeof scope === "string")
    && new Set(input.scopes).size === input.scopes.length;
}

export function isExactT0ServiceIdentity(input: Readonly<{
  readonly role: unknown;
  readonly roles: unknown;
  readonly scopes: unknown;
}>): boolean {
  return hasExactServiceIdentityShape(input)
    && input.scopes.every((scope) => tenantApiKeyToolNameFromScope(scope) !== null);
}

export function isExactReadPreviewServiceIdentity(input: Readonly<{
  readonly role: unknown;
  readonly roles: unknown;
  readonly scopes: unknown;
}>): boolean {
  return hasExactServiceIdentityShape(input)
    && input.scopes.every((scope) => {
      if (!scope.startsWith("tool:")) return false;
      return readPreviewToolNameSet.has(scope.slice("tool:".length));
    });
}

function assertExactServiceScopeBoundary(context: ExecutionContext): void {
  // A tool:* entitlement marks a service context as an exact production
  // identity. The shared RBAC layer accepts only the union of reviewed T0 and
  // read-preview names; each production composition separately constrains the
  // same identity to its own exact profile before this authorization runs.
  // Legacy service contexts without tool entitlements keep their business
  // scope behavior.
  if (context.role !== "service" || !usesExactToolEntitlements(context)) return;
  if (!isExactReadPreviewServiceIdentity(context)) {
    throw new ForbiddenError("The authenticated scope cannot be used for a reviewed production profile.");
  }
}

export function toolVisibleForContext(
  context: ExecutionContext,
  toolName: string,
): boolean {
  assertExactServiceScopeBoundary(context);
  return !usesExactToolEntitlements(context) || hasExactToolEntitlement(context, toolName);
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
  assertExactServiceScopeBoundary(context);

  if (!Object.hasOwn(toolPolicies, toolName)) {
    throw new ForbiddenError("The requested MCP tool is not allowlisted.");
  }
  const policy = toolPolicies[toolName as KnownToolName];
  if (!context.roles.some((role) => policy.roles.includes(role))) {
    throw new ForbiddenError("The authenticated role cannot use this tool.");
  }
  if (
    usesExactToolEntitlements(context)
      ? !hasExactToolEntitlement(context, toolName)
      : !hasScope(context, policy.permission)
  ) {
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
