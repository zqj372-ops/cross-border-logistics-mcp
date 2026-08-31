import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURE_INSTANCE_ID = "instance_fixture_001";
const FIXTURE_MANAGEMENT_TENANT_ID = "tenant_fixture";
const BUILT_START_ENTRY = "dist/src/logistics_mcp/server/start.mjs";
const INITIALIZER_EXPORT = "initializeSqlitePluginConfigState";

export function applicationRoot() {
  const wrapperPath = realpathSync(fileURLToPath(import.meta.url));
  return realpathSync(resolve(dirname(wrapperPath), "../.."));
}

export function assertNoArguments(args) {
  if (!Array.isArray(args) || args.length !== 0) {
    throw new Error("init-plugin-config-fixture does not accept command-line arguments");
  }
}

async function loadOfficialInitializer(root) {
  const builtEntryUrl = pathToFileURL(resolve(root, BUILT_START_ENTRY)).href;
  let builtEntry;
  try {
    builtEntry = await import(builtEntryUrl);
  } catch {
    throw new Error(
      "The built start entry is unavailable; run npm run build before initializing Plugin Config.",
    );
  }
  const initializer = builtEntry[INITIALIZER_EXPORT];
  if (typeof initializer !== "function") {
    throw new Error("The built start entry must export initializeSqlitePluginConfigState.");
  }
  return initializer;
}

export async function initializeFixturePluginConfigState() {
  const root = applicationRoot();
  const initializeSqlitePluginConfigState = await loadOfficialInitializer(root);
  await initializeSqlitePluginConfigState({
    applicationRoot: root,
    instanceId: FIXTURE_INSTANCE_ID,
    managementTenantId: FIXTURE_MANAGEMENT_TENANT_ID,
  });
}

function isMainModule() {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && invokedPath === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    assertNoArguments(process.argv.slice(2));
    await initializeFixturePluginConfigState();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Plugin Config initialization failed.");
    process.exitCode = 1;
  }
}
