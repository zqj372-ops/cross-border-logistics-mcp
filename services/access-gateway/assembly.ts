import type { GatewayOptions } from "./contracts";
import { AccessGatewayError } from "./errors";
import type { GatewayProviders } from "./ports";
import { createAccessGateway } from "./service";

const PROVIDER_NAMES = Object.freeze([
  "adminIdentityProvider",
  "auditRepository",
  "clock",
  "credentialRepository",
  "jwtSigningProvider",
  "randomSource",
  "rateLimitRepository",
  "revocationRepository",
  "secretPepperProvider",
] as const satisfies readonly (keyof GatewayProviders)[]);

const PROVIDER_METHODS: Readonly<Record<keyof GatewayProviders, readonly string[]>> = Object.freeze({
  adminIdentityProvider: ["authenticateAdmin"],
  auditRepository: ["append"],
  clock: ["nowSeconds"],
  credentialRepository: ["findForExchange", "listState", "markUsed"],
  jwtSigningProvider: ["sign", "getJwks"],
  randomSource: ["opaque", "bytes"],
  rateLimitRepository: ["reserve"],
  revocationRepository: ["isRevoked"],
  secretPepperProvider: ["hashCredentialSecret", "verifyCredentialSecret"],
});

export function createProductionAccessGateway(
  providers: Partial<GatewayProviders>,
  options: GatewayOptions = {},
) {
  const missing = PROVIDER_NAMES.filter((name) => providers[name] === undefined);
  if (missing.length > 0) {
    throw new AccessGatewayError(
      "access_gateway_unavailable",
      `Production Access Gateway requires ${missing.join(", ")}.`,
    );
  }
  for (const name of PROVIDER_NAMES) {
    const provider = providers[name];
    if (provider === undefined) throw new AccessGatewayError("access_gateway_unavailable");
    if (provider.kind !== "production") {
      throw new AccessGatewayError(
        "access_gateway_unavailable",
        `${name} must be a production provider.`,
      );
    }
    const providerRecord = provider as unknown as Record<string, unknown>;
    if (PROVIDER_METHODS[name].some((method) => typeof providerRecord[method] !== "function")) {
      throw new AccessGatewayError(
        "access_gateway_unavailable",
        `${name} does not implement the production provider contract.`,
      );
    }
  }
  return createAccessGateway(providers as GatewayProviders, options);
}
