import { describe, expect, it } from "vitest";

import { AccessGatewayError } from "../../services/access-gateway/errors";
import {
  createProductionAccessGateway,
  createSyntheticAccessGatewayFixture,
} from "../../services/access-gateway/index";

describe("Access Gateway assembly", () => {
  it("fails closed when production providers are missing", () => {
    expect(() => createProductionAccessGateway({})).toThrowError(AccessGatewayError);
    expect(() => createProductionAccessGateway({})).toThrow(/credentialRepository/);
  });

  it("does not accept synthetic providers in production assembly", () => {
    const fixture = createSyntheticAccessGatewayFixture();
    expect(() => createProductionAccessGateway(fixture.providers)).toThrow(/production provider/);
  });

  it("rejects providers that only claim the production kind without implementing ports", () => {
    const pretend = Object.fromEntries([
      "adminIdentityProvider",
      "auditRepository",
      "clock",
      "credentialRepository",
      "jwtSigningProvider",
      "randomSource",
      "rateLimitRepository",
      "revocationRepository",
      "secretPepperProvider",
    ].map((name) => [name, { kind: "production" }])) as never;
    expect(() => createProductionAccessGateway(pretend)).toThrow(/provider contract/);
  });

  it("names the local fixture explicitly and exposes every required port", () => {
    const fixture = createSyntheticAccessGatewayFixture();
    expect(fixture.profile).toBe("synthetic-local-test");
    expect(Object.keys(fixture.providers).sort()).toEqual([
      "adminIdentityProvider",
      "auditRepository",
      "clock",
      "credentialRepository",
      "jwtSigningProvider",
      "randomSource",
      "rateLimitRepository",
      "revocationRepository",
      "secretPepperProvider",
    ]);
  });
});
