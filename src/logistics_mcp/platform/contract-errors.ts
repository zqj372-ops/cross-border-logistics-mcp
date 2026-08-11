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
