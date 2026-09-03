export const FREIGHTCLAW_SCHEMA_VERSION: "2026-08-27.v1";
export const FREIGHTCLAW_EXCHANGE_URL: "https://www.freightclaw.net/access/v1/token/exchange";
export const FREIGHTCLAW_ORIGIN: "https://www.freightclaw.net";
export const FREIGHTCLAW_T0_TOOLS: readonly [
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
];

export class FreightClawAuthorizationError extends Error {
  readonly code: string;
  constructor(code: string);
}

export interface ExchangeCredentialOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestIdFactory?: () => string;
  readonly timeoutMs?: number;
}

export interface AuthorizationHeaderOptions {
  readonly readCredential?: () => Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly requestIdFactory?: () => string;
  readonly timeoutMs?: number;
}

export function readKeychainCredential(options?: {
  readonly helperPath?: string;
  readonly account?: string;
  readonly service?: string;
  readonly timeoutMs?: number;
}): Promise<string>;

export function exchangeCredential(options: ExchangeCredentialOptions): Promise<{
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly requestId: string;
  readonly sessionRef: string;
  readonly toolNames: readonly string[];
}>;

export function createCodexAuthorizationHeaders(options?: AuthorizationHeaderOptions): Promise<{
  readonly Authorization: string;
}>;
