export type ModuleControlServiceErrorCode =
  | "execution_context_untrusted"
  | "admin_role_required"
  | "admin_role_missing"
  | "platform_admin_scope_required"
  | "management_tenant_mismatch"
  | "management_tenant_state_mismatch"
  | "runtime_fatal"
  | "module_not_active"
  | "state_unavailable"
  | "state_output_invalid"
  | "write_meta_invalid";

const ERROR_MESSAGES: Readonly<
  Record<ModuleControlServiceErrorCode, string>
> = {
  execution_context_untrusted: "The execution context is not trusted.",
  admin_role_required: "An admin actor role is required.",
  admin_role_missing: "The admin role is missing from the actor roles.",
  platform_admin_scope_required: "The platform admin scope is required.",
  management_tenant_mismatch: "The execution tenant is not authorized.",
  management_tenant_state_mismatch: "The control state tenant is not authorized.",
  runtime_fatal: "The runtime is in a fatal state.",
  module_not_active: "The requested module identity is not active.",
  state_unavailable: "The control state is unavailable.",
  state_output_invalid: "The control state output is invalid.",
  write_meta_invalid: "The server write metadata is invalid.",
};

export class ModuleControlServiceError extends Error {
  readonly code: ModuleControlServiceErrorCode;

  constructor(code: ModuleControlServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ModuleControlServiceError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
