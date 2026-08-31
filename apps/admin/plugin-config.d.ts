export const CONFIG_SCHEMA_VERSION: "2026-08-31.v1";
export const CONFIG_API_ROOT: "/admin/api/v1/config";
export const CONFIG_FIELD_KINDS: readonly ["integer", "boolean", "enum", "secret_slot"];

export function validateConfigSpec<T>(value: T): T;
export function validateConfigValues<T>(values: T, spec: unknown, label?: string): T;
export function validateConfigState<T>(value: T): T;
export function validateConfigDraftRequest<T>(value: T): T;
export function hasExactConfigReadback(expected: unknown, observed: unknown): boolean;

export interface PluginConfigClient {
  setToken(token: string): void;
  clearToken(): void;
  getState(moduleId?: string): Promise<unknown>;
  validateDraft(payload: unknown, idempotencyKey?: string): Promise<unknown>;
  createPreview(payload: unknown, idempotencyKey?: string): Promise<unknown>;
  decideApproval(payload: unknown, idempotencyKey?: string): Promise<unknown>;
  publish(payload: unknown, idempotencyKey?: string): Promise<unknown>;
  reconcile(payload: unknown, idempotencyKey?: string): Promise<unknown>;
}

export function createPluginConfigClient(options?: Readonly<{
  fetchImpl?: typeof fetch;
  basePath?: string;
}>): PluginConfigClient;

export class ConfigPlaneError extends Error {
  readonly status: string;
  readonly reasonCodes: readonly string[];
  readonly data: unknown;
}
