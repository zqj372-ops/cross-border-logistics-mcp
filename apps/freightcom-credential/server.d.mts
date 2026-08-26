import type { Server } from "node:http";

export interface FreightcomCredentialOptions {
  readonly port?: number;
  readonly account?: string;
  readonly service?: string;
  readonly timeoutMs?: number;
  readonly storeCredential?: (token: string) => Promise<void>;
}

export function storeKeychainCredential(
  token: string,
  options?: FreightcomCredentialOptions,
): Promise<void>;

export function createCredentialServer(options?: FreightcomCredentialOptions): {
  readonly server: Server;
  readonly port: number;
  readonly origin: string;
};
