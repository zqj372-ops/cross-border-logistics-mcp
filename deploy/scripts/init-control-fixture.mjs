import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURE_INSTANCE_ID = "instance_fixture_001";
const FIXTURE_MANAGEMENT_TENANT_ID = "tenant_fixture";
const BUILT_START_ENTRY = "dist/src/logistics_mcp/server/start.mjs";
const INITIALIZER_EXPORT = "initializeSqliteControlState";

/**
 * Derive the application root from this checked-in file only. In particular,
 * this intentionally does not use the caller's working directory or a
 * path-bearing setting.
 */
export function applicationRoot() {
  const wrapperPath = realpathSync(fileURLToPath(import.meta.url));
  return realpathSync(resolve(dirname(wrapperPath), "../.."));
}

/**
 * Initialization is deliberately argument-free. Rejecting every argument
 * also rejects path-like values and flags before any built module is loaded.
 */
export function assertNoArguments(args) {
  if (!Array.isArray(args) || args.length !== 0) {
    throw new Error("init-control-fixture does not accept command-line arguments");
  }
}

async function loadOfficialInitializer(root) {
  const builtEntryUrl = pathToFileURL(resolve(root, BUILT_START_ENTRY)).href;
  let builtEntry;
  try {
    builtEntry = await import(builtEntryUrl);
  } catch {
    throw new Error(
      "The built start entry is unavailable; run npm run build before initializing the fixture.",
    );
  }
  const initializer = builtEntry[INITIALIZER_EXPORT];
  if (typeof initializer !== "function") {
    throw new Error(
      "The built start entry must export initializeSqliteControlState for fixture initialization.",
    );
  }
  return initializer;
}

export async function initializeFixtureControlState() {
  const root = applicationRoot();
  const initializeSqliteControlState = await loadOfficialInitializer(root);

  // The official initializer owns the fixed paths, permissions, schema, and
  // cryptographically random control_db_id. This wrapper only supplies the
  // explicit fixture identity and application root.
  await initializeSqliteControlState({
    applicationRoot: root,
    instanceId: FIXTURE_INSTANCE_ID,
    managementTenantId: FIXTURE_MANAGEMENT_TENANT_ID,
  });
}

function isMainModule() {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) return false;
  return invokedPath === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    assertNoArguments(process.argv.slice(2));
    await initializeFixtureControlState();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Fixture initialization failed.");
    process.exitCode = 1;
  }
}
