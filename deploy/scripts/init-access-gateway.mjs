import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv.slice(2).length !== 0) {
  throw new Error("init-access-gateway does not accept command-line arguments.");
}

const builtEntry = await import(pathToFileURL(
  resolve("dist/services/access-gateway/start.mjs"),
).href);
if (typeof builtEntry.initializeAccessGatewayState !== "function") {
  throw new Error("Built Access Gateway initializer is unavailable.");
}

const result = await builtEntry.initializeAccessGatewayState({
  applicationRoot: required("ACCESS_GATEWAY_APPLICATION_ROOT"),
  instanceId: required("ACCESS_GATEWAY_INSTANCE_ID"),
  managementTenantId: required("ACCESS_GATEWAY_MANAGEMENT_TENANT_ID"),
});

console.log(`Access Gateway state initialized; JWT public key SHA-256 ${result.jwtPublicKeySha256}.`);
