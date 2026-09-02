import { randomUUID } from "node:crypto";

import {
  createOciSdkGatewayCryptoProviders,
  ociCryptoConfigurationFromEnvironment,
} from "../../services/access-gateway/oci-crypto.ts";

const T0_TOOLS = Object.freeze([
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
]);
const READ_PREVIEW_TOOLS = Object.freeze([
  ...T0_TOOLS,
  "quote.canada_final_mile.calculate",
  "customs.ca.search",
  "customs.ca.estimate",
  "quote.freightcom_ltl.preview",
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function identifier(name) {
  const value = required(name);
  if (!IDENTIFIER.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

if (required("READ_PREVIEW_JWT_ENVIRONMENT") !== "staging") {
  throw new Error("READ_PREVIEW_JWT_ENVIRONMENT must equal staging.");
}
if (required("READ_PREVIEW_JWT_CONFIRM") !== "issue-ephemeral-read-preview-jwt") {
  throw new Error("READ_PREVIEW_JWT_CONFIRM is invalid.");
}

const profile = required("READ_PREVIEW_JWT_PROFILE");
if (profile !== "t0-v1" && profile !== "read-preview-staging") {
  throw new Error("READ_PREVIEW_JWT_PROFILE must be t0-v1 or read-preview-staging.");
}
const ttlSeconds = Number(required("READ_PREVIEW_JWT_TTL_SECONDS"));
if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 300) {
  throw new Error("READ_PREVIEW_JWT_TTL_SECONDS must be between 60 and 300.");
}
const issuer = required("READ_PREVIEW_JWT_ISSUER");
const audience = required("READ_PREVIEW_JWT_AUDIENCE");
const issuerUrl = new URL(issuer);
if (issuerUrl.protocol !== "https:" || issuerUrl.username || issuerUrl.password) {
  throw new Error("READ_PREVIEW_JWT_ISSUER must be an HTTPS issuer without credentials.");
}

const configuration = ociCryptoConfigurationFromEnvironment(process.env);
if (configuration.backend !== "oci-vault") {
  throw new Error("Ephemeral staging JWTs require the OCI Vault crypto backend.");
}
const pepperVersion = required("ACCESS_GATEWAY_PEPPER_VERSION");
const providers = await createOciSdkGatewayCryptoProviders({
  configuration,
  activePepperVersion: pepperVersion,
  requiredPepperVersions: [pepperVersion],
});

try {
  const now = Math.floor(Date.now() / 1000);
  const tools = profile === "t0-v1" ? T0_TOOLS : READ_PREVIEW_TOOLS;
  const signed = await providers.signer.sign({
    iss: issuer,
    aud: audience,
    sub: identifier("READ_PREVIEW_JWT_ACTOR_ID"),
    iat: now,
    exp: now + ttlSeconds,
    jti: randomUUID(),
    tenant_id: identifier("READ_PREVIEW_JWT_TENANT_ID"),
    actor_id: identifier("READ_PREVIEW_JWT_ACTOR_ID"),
    actor_role: "service",
    roles: ["service"],
    scopes: tools.map((tool) => `tool:${tool}`),
    client_id: identifier("READ_PREVIEW_JWT_CLIENT_ID"),
    session_id: `staging:${randomUUID()}`,
  });
  process.stdout.write(signed.token);
} finally {
  await providers.close();
}
