import { z } from "zod";

import {
  getToolPolicy,
  tenantApiKeyScopeForToolName,
  tenantApiKeyToolNameFromScope,
  tenantApiKeyToolNames,
  type TenantApiKeyToolName,
  type TenantApiKeyToolScope,
} from "../platform/rbac";
import { IDENTIFIER_PATTERN } from "./lexical-contracts";

export const TENANT_ACCESS_SCHEMA_VERSION = "2026-08-27.v1" as const;
export const TENANT_ACCESS_MAX_CREDENTIAL_SECONDS = 30 * 24 * 60 * 60;
export const TENANT_ACCESS_MIN_CREDENTIAL_SECONDS = 15 * 60;

export const TENANT_API_KEY_TOOL_NAMES = tenantApiKeyToolNames;
export type { TenantApiKeyToolName } from "../platform/rbac";
export type TenantApiKeyScope = TenantApiKeyToolScope;

export const TENANT_API_KEY_ALLOWED_SCOPES: readonly TenantApiKeyScope[] = Object.freeze(
  TENANT_API_KEY_TOOL_NAMES.map(tenantApiKeyScopeForToolName),
);

export const TENANT_API_KEY_TOOL_CATALOG = Object.freeze(
  TENANT_API_KEY_TOOL_NAMES.map((toolName) => {
    const policy = getToolPolicy(toolName);
    return Object.freeze({
      tool_name: toolName,
      kind: policy.kind,
    });
  }),
);

const LEGACY_SCOPE_TO_TOOL_NAMES: Readonly<Record<string, readonly TenantApiKeyToolName[]>> =
  Object.freeze({});

export function tenantApiKeyScopesForToolNames(
  toolNames: readonly TenantApiKeyToolName[],
): readonly TenantApiKeyScope[] {
  return Object.freeze(
    [...toolNames].sort().map(tenantApiKeyScopeForToolName),
  );
}

export function tenantApiKeyToolNamesForScopes(
  scopes: readonly TenantApiKeyScope[],
): readonly TenantApiKeyToolName[] {
  return Object.freeze(scopes.map((scope) => {
    const toolName = tenantApiKeyToolNameFromScope(scope);
    if (toolName === null) throw new TypeError("Tenant API-key scope is invalid.");
    return toolName;
  }).sort());
}

export function normalizeStoredTenantApiKeyScopes(
  values: readonly unknown[],
): readonly TenantApiKeyScope[] | null {
  if (values.length === 0 || new Set(values).size !== values.length) return null;
  if (values.every((value) => (
    typeof value === "string" && tenantApiKeyToolNameFromScope(value) !== null
  ))) {
    return Object.freeze([...values].sort()) as readonly TenantApiKeyScope[];
  }
  if (values.every((value) => typeof value === "string" && Object.hasOwn(LEGACY_SCOPE_TO_TOOL_NAMES, value))) {
    const names = new Set<TenantApiKeyToolName>();
    for (const value of values) {
      for (const toolName of LEGACY_SCOPE_TO_TOOL_NAMES[value as string] ?? []) names.add(toolName);
    }
    return tenantApiKeyScopesForToolNames([...names]);
  }
  return null;
}

export const TENANT_ACCESS_TENANT_ACTIONS = Object.freeze([
  "activate",
  "suspend",
] as const);

export const TENANT_ACCESS_CREDENTIAL_ACTIONS = Object.freeze([
  "acknowledge_delivery",
  "rotate",
  "revoke",
] as const);

export const TENANT_ACCESS_OPERATION_ACTIONS = Object.freeze([
  "tenant.create",
  "tenant.activate",
  "tenant.suspend",
  "credential.issue",
  "credential.delivery_acknowledge",
  "credential.rotate",
  "credential.revoke",
] as const);

export const TENANT_ACCESS_OPERATION_STATES = Object.freeze([
  "absent",
  "active",
  "suspended",
  "pending_delivery",
  "tenant_suspended",
  "expired",
  "revoked",
] as const);

export type TenantAccessTenantAction = (typeof TENANT_ACCESS_TENANT_ACTIONS)[number];
export type TenantAccessCredentialAction = (typeof TENANT_ACCESS_CREDENTIAL_ACTIONS)[number];
export type TenantAccessOperationAction = (typeof TENANT_ACCESS_OPERATION_ACTIONS)[number];
export type TenantAccessOperationState = (typeof TENANT_ACCESS_OPERATION_STATES)[number];

const identifierSchema = z.string().regex(IDENTIFIER_PATTERN);
const schemaVersionSchema = z.literal(TENANT_ACCESS_SCHEMA_VERSION);
const reasonCodeSchema = identifierSchema;
const displayNameSchema = z.string().trim().min(1).max(120);
const credentialLifetimeSchema = z
  .number()
  .int()
  .min(TENANT_ACCESS_MIN_CREDENTIAL_SECONDS)
  .max(TENANT_ACCESS_MAX_CREDENTIAL_SECONDS);

const toolNamesSchema = z
  .array(z.enum(TENANT_API_KEY_TOOL_NAMES))
  .min(1)
  .max(TENANT_API_KEY_TOOL_NAMES.length)
  .superRefine((toolNames, context) => {
    const seen = new Set<string>();
    for (const [index, toolName] of toolNames.entries()) {
      if (seen.has(toolName)) {
        context.addIssue({
          code: "custom",
          message: "duplicate_tool_name",
          path: [index],
        });
      }
      seen.add(toolName);
    }
  });

export const createTenantRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    tenant_id: identifierSchema,
    display_name: displayNameSchema,
  })
  .strict();

export const setTenantStatusRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    status: z.enum(["active", "suspended"]),
    reason_code: reasonCodeSchema,
  })
  .strict();

export const issueCredentialRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    tenant_id: identifierSchema,
    client_id: identifierSchema,
    label: displayNameSchema,
    tool_names: toolNamesSchema,
    expires_in_seconds: credentialLifetimeSchema,
  })
  .strict();

export const rotateCredentialRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    tool_names: toolNamesSchema,
    expires_in_seconds: credentialLifetimeSchema,
    reason_code: reasonCodeSchema,
  })
  .strict();

export const revokeCredentialRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    reason_code: reasonCodeSchema,
  })
  .strict();

export const acknowledgeCredentialDeliveryRequestSchema = z
  .object({
    schema_version: schemaVersionSchema,
    reason_code: reasonCodeSchema,
  })
  .strict();

export type CreateTenantRequest = z.infer<typeof createTenantRequestSchema>;
export type SetTenantStatusRequest = z.infer<typeof setTenantStatusRequestSchema>;
export type IssueCredentialRequest = z.infer<typeof issueCredentialRequestSchema>;
export type RotateCredentialRequest = z.infer<typeof rotateCredentialRequestSchema>;
export type RevokeCredentialRequest = z.infer<typeof revokeCredentialRequestSchema>;
export type AcknowledgeCredentialDeliveryRequest = z.infer<
  typeof acknowledgeCredentialDeliveryRequestSchema
>;
