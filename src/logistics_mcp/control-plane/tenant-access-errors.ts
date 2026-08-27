export type TenantAccessErrorCode =
  | "admin_role_required"
  | "authentication_failed"
  | "closed"
  | "credential_delivery_acknowledged"
  | "credential_delivery_pending"
  | "credential_expired"
  | "credential_not_active"
  | "credential_not_found"
  | "database_open_failed"
  | "idempotency_conflict"
  | "identity_mismatch"
  | "invalid_options"
  | "invalid_request"
  | "management_tenant_forbidden"
  | "management_tenant_mismatch"
  | "permission_mismatch"
  | "platform_admin_scope_required"
  | "schema_mismatch"
  | "scope_not_allowed"
  | "state_exists"
  | "state_missing"
  | "tenant_admin_scope_required"
  | "tenant_already_exists"
  | "tenant_not_active"
  | "tenant_not_found"
  | "tenant_status_unchanged";

const ERROR_MESSAGES: Readonly<Record<TenantAccessErrorCode, string>> = {
  admin_role_required: "Tenant administration requires the admin role.",
  authentication_failed: "Authentication failed.",
  closed: "Tenant access store is closed.",
  credential_delivery_acknowledged: "Credential delivery was already acknowledged.",
  credential_delivery_pending: "Credential delivery must be acknowledged first.",
  credential_expired: "Credential has expired.",
  credential_not_active: "Credential is not active.",
  credential_not_found: "Credential was not found.",
  database_open_failed: "Tenant access database could not be opened safely.",
  idempotency_conflict: "Idempotency key was already used for another request.",
  identity_mismatch: "Tenant access store identity does not match this runtime.",
  invalid_options: "Tenant access options are invalid.",
  invalid_request: "Tenant access request is invalid.",
  management_tenant_forbidden: "Management tenant credentials cannot be issued.",
  management_tenant_mismatch: "Tenant administration must use the management tenant.",
  permission_mismatch: "Tenant access state permissions are invalid.",
  platform_admin_scope_required: "Tenant administration requires platform:admin.",
  schema_mismatch: "Tenant access database schema is unsupported.",
  scope_not_allowed: "Credential tool entitlement is not allowed.",
  state_exists: "Tenant access state already exists.",
  state_missing: "Tenant access state has not been initialized.",
  tenant_admin_scope_required: "Tenant administration requires tenant:admin.",
  tenant_already_exists: "Tenant already exists.",
  tenant_not_active: "Tenant is not active.",
  tenant_not_found: "Tenant was not found.",
  tenant_status_unchanged: "Tenant is already in the requested status.",
};

export class TenantAccessError extends Error {
  constructor(
    readonly code: TenantAccessErrorCode,
    options?: ErrorOptions,
  ) {
    super(ERROR_MESSAGES[code], options);
    this.name = "TenantAccessError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
