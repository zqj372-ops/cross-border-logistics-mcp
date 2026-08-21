export class ModuleRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ModuleRuntimeError";
    this.code = code;
  }
}
