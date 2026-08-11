export const CARGO_DIAGNOSTIC_STATUSES = [
  "needs_input",
  "manual_review",
  "blocked",
] as const;

export type CargoDiagnosticStatus =
  (typeof CARGO_DIAGNOSTIC_STATUSES)[number];

export interface CargoDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: CargoDiagnosticStatus;
  readonly field?: string;
}

export interface CargoValidationFailure {
  readonly ok: false;
  readonly code: string;
  readonly status: CargoDiagnosticStatus;
  readonly diagnostic: CargoDiagnostic;
}

export function cargoDiagnostic(
  code: string,
  status: CargoDiagnosticStatus,
  message: string,
  field?: string,
): CargoValidationFailure {
  const diagnostic = {
    code,
    message,
    status,
    ...(field === undefined ? {} : { field }),
  } satisfies CargoDiagnostic;

  return {
    ok: false,
    code,
    status,
    diagnostic,
  };
}
