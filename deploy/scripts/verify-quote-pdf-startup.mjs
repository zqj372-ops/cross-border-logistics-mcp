import assert from "node:assert/strict";

const { createQuotePdfStartupOptions } = await import(
  new URL("../../dist/src/logistics_mcp/server/start.mjs", import.meta.url).href,
);

const baseSource = {};
const secret = "built-probe-secret";
const url = "https://built-pdf.example.invalid";
const host = "built-pdf.example.invalid";
const tenant = "built-probe-tenant";

function assertSafe(result) {
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(url), false);
  assert.equal(JSON.stringify(result).includes(host), false);
  assert.equal(JSON.stringify(result).includes(tenant), false);
}

for (const enabled of [undefined, "false"]) {
  const environment = new Proxy(
    enabled === undefined ? {} : { MCP_QUOTE_PDF_ENABLED: enabled },
    {
      get(target, property) {
        if (property !== "MCP_QUOTE_PDF_ENABLED") {
          throw new Error("disabled startup read an optional PDF setting");
        }
        return target[property];
      },
    },
  );
  const result = createQuotePdfStartupOptions(baseSource, { env: environment });
  assert.deepEqual(result, {});
  assertSafe(result);
}

const complete = {
  MCP_QUOTE_PDF_ENABLED: "true",
  MCP_QUOTE_PDF_BASE_URL: url,
  MCP_QUOTE_PDF_ALLOWED_HOSTS: host,
  MCP_QUOTE_PDF_TENANT_ID: tenant,
  MCP_QUOTE_PDF_BEARER_TOKEN: secret,
};
for (const name of Object.keys(complete).filter((key) => key !== "MCP_QUOTE_PDF_ENABLED")) {
  const environment = { ...complete };
  delete environment[name];
  const result = createQuotePdfStartupOptions(baseSource, { env: environment });
  assert.deepEqual(result, { quotePdfStartupFailure: "configuration_invalid" });
  assert.equal(Object.hasOwn(result, "adapterSource"), false);
  assert.equal(Object.hasOwn(result, "quotePdfEnabled"), false);
  assertSafe(result);
}

console.log("built quote PDF startup probe: PASS");
