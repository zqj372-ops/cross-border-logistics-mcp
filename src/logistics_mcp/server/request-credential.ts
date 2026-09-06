import { AsyncLocalStorage } from "node:async_hooks";

// A per-request bearer handoff to trusted private providers. It never enters
// domain input, persisted context, module metadata, or audit payloads.
const requestCredential = new AsyncLocalStorage<string>();
export const withRequestCredential = <T>(token: string, run: () => T): T => requestCredential.run(token, run);
export function requireRequestCredential(): string {
  const value = requestCredential.getStore();
  if (!value) throw new Error("provider_request_credential_unavailable");
  return value;
}
