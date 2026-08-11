export interface ContractIssue {
  readonly path: string;
  readonly code: string;
}

export class ContractValidationError extends Error {
  readonly code = "contract_validation";

  constructor(
    message: string,
    readonly issues: readonly ContractIssue[] = [],
  ) {
    super(message);
    this.name = "ContractValidationError";
  }
}

export class ForbiddenError extends Error {
  readonly code: string = "forbidden";

  constructor(message = "The requested operation is not permitted.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class CrossTenantAccessError extends ForbiddenError {
  override readonly code: string = "cross_tenant_denied";

  constructor() {
    super("The requested tenant is outside the authenticated tenant scope.");
    this.name = "CrossTenantAccessError";
  }
}
