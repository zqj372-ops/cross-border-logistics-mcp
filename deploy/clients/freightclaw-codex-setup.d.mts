import type { Server } from "node:http";

export class FreightClawSetupError extends Error {
  readonly code: string;
  constructor(code: string);
}

export interface SetupReadback {
  readonly toolCount: number;
  readonly resourceCount: number;
  readonly transportMode: "stateless" | "stateful";
}

export function renderManagedCodexBlock(helperPath: string): string;
export function upsertManagedCodexConfig(content: string, helperPath: string): string;
export function verifyFreightClawReadback(
  apiKey: string,
  options?: {
    readonly fetchImpl?: typeof fetch;
    readonly requestIdFactory?: () => string;
    readonly timeoutMs?: number;
  },
): Promise<SetupReadback>;
export function completeCodexSetup(apiKey: string, options?: Record<string, unknown>): Promise<SetupReadback>;
export function createCredentialSetupServer(options?: {
  readonly port?: number;
  readonly completeSetup?: (apiKey: string) => Promise<SetupReadback>;
  readonly closeOnSuccess?: boolean;
}): {
  readonly server: Server;
  readonly port: number;
  readonly origin: string;
};
