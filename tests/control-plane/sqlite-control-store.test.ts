import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  initializeSqliteControlState,
  openSqliteControlStore,
} from "../../src/logistics_mcp/control-plane/sqlite-control-store";
import {
  CONTROL_SCHEMA_FINGERPRINT,
  CONTROL_SCHEMA_STATEMENTS,
  fingerprintControlSchema,
  normalizeControlSchema,
} from "../../src/logistics_mcp/control-plane/readback-attempt-schema";

type ControlStore = {
  health(): Promise<{ readonly ready: boolean }>;
  close(): Promise<void>;
};

type ControlIdentityMarker = {
  readonly control_db_id: string;
  readonly control_db_path: string;
  readonly instance_id: string;
  readonly management_tenant_id: string;
  readonly marker_format: "mcp-control-identity/v1";
  readonly schema_version: 1;
};

const temporaryRoots: string[] = [];
const temporarySymlinks: string[] = [];
const openStores: ControlStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    try {
      await store.close();
    } catch {
      // Cleanup must not replace the assertion that caused the test to fail.
    }
  }

  for (const symlinkPath of temporarySymlinks.splice(0)) {
    unlinkSync(symlinkPath);
  }

  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function makeApplicationRoot(): string {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "logistics-mcp-control-"));
  const applicationRoot = realpathSync(temporaryRoot);
  temporaryRoots.push(applicationRoot);
  return applicationRoot;
}

function fixedPaths(applicationRoot: string): {
  readonly runtimeDir: string;
  readonly stateDir: string;
  readonly controlDbPath: string;
  readonly markerPath: string;
} {
  const runtimeDir = join(applicationRoot, ".runtime");
  const stateDir = join(runtimeDir, "mcp-instance-state");
  return {
    runtimeDir,
    stateDir,
    controlDbPath: join(stateDir, "control.sqlite"),
    markerPath: join(stateDir, "control-identity.json"),
  };
}

function initializeOptions(
  applicationRoot: string,
  managementTenantId = "tenant_control",
) {
  return {
    applicationRoot,
    instanceId: "instance_fixture_001",
    managementTenantId,
  } as const;
}

function openOptions(
  applicationRoot: string,
  overrides: Partial<{
    readonly instanceId: string;
    readonly managementTenantId: string;
    readonly adminControlEnabled: boolean;
  }> = {},
) {
  return {
    applicationRoot,
    instanceId: overrides.instanceId ?? "instance_fixture_001",
    managementTenantId: overrides.managementTenantId ?? "tenant_control",
    adminControlEnabled: overrides.adminControlEnabled ?? true,
  } as const;
}

function parseMarker(
  markerPath: string,
  applicationRoot: string,
  instanceId: string,
  managementTenantId: string,
): ControlIdentityMarker {
  const markerBytes = readFileSync(markerPath);
  expect(markerBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(
    false,
  );
  expect(markerBytes.at(-1)).toBe(0x0a);
  expect(markerBytes.subarray(0, -1).includes(0x0a)).toBe(false);

  const markerText = markerBytes.toString("utf8");
  const parsed = JSON.parse(markerText) as Record<string, unknown>;
  const paths = fixedPaths(applicationRoot);
  const expectedKeys = [
    "control_db_id",
    "control_db_path",
    "instance_id",
    "management_tenant_id",
    "marker_format",
    "schema_version",
  ];

  expect(Object.keys(parsed).sort()).toEqual(expectedKeys);
  expect(parsed).toMatchObject({
    control_db_path: paths.controlDbPath,
    instance_id: instanceId,
    management_tenant_id: managementTenantId,
    marker_format: "mcp-control-identity/v1",
    schema_version: 1,
  });
  expect(parsed.control_db_id).toMatch(/^db_[0-9a-f]{32}$/);
  expect(isAbsolute(String(parsed.control_db_path))).toBe(true);
  expect(markerText).toBe(`${JSON.stringify({
    control_db_id: parsed.control_db_id,
    control_db_path: paths.controlDbPath,
    instance_id: instanceId,
    management_tenant_id: managementTenantId,
    marker_format: "mcp-control-identity/v1",
    schema_version: 1,
  })}\n`);

  return parsed as unknown as ControlIdentityMarker;
}

function trackStore(store: ControlStore): ControlStore {
  openStores.push(store);
  return store;
}

function stateSnapshot(applicationRoot: string): {
  readonly runtimeEntries: readonly string[];
  readonly stateEntries: readonly string[];
  readonly markerBytes: Buffer;
} {
  const paths = fixedPaths(applicationRoot);
  return {
    runtimeEntries: existsSync(paths.runtimeDir)
      ? readdirSync(paths.runtimeDir).sort()
      : [],
    stateEntries: existsSync(paths.stateDir)
      ? readdirSync(paths.stateDir).sort()
      : [],
    markerBytes: existsSync(paths.markerPath)
      ? readFileSync(paths.markerPath)
      : Buffer.alloc(0),
  };
}

describe("SQLite control store", () => {
  it("atomically installs the fixed state directory and exact identity marker", async () => {
    const applicationRoot = makeApplicationRoot();
    const options = initializeOptions(applicationRoot);
    const paths = fixedPaths(applicationRoot);

    await initializeSqliteControlState(options);

    expect(readdirSync(paths.runtimeDir).sort()).toEqual([
      "mcp-instance-state",
    ]);
    expect(readdirSync(paths.stateDir).sort()).toEqual([
      "control-identity.json",
      "control.sqlite",
    ]);
    expect(lstatSync(paths.stateDir).isSymbolicLink()).toBe(false);
    expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.controlDbPath).isFile()).toBe(true);
    expect(lstatSync(paths.controlDbPath).isSymbolicLink()).toBe(false);
    expect(statSync(paths.controlDbPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(paths.markerPath).isFile()).toBe(true);
    expect(lstatSync(paths.markerPath).isSymbolicLink()).toBe(false);
    expect(statSync(paths.markerPath).mode & 0o777).toBe(0o400);

    parseMarker(
      paths.markerPath,
      applicationRoot,
      options.instanceId,
      options.managementTenantId,
    );
  });

  it("initializes user_version 1 and exactly the compiled strict nine-table identity schema", async () => {
    const applicationRoot = makeApplicationRoot();
    const options = initializeOptions(applicationRoot);
    const paths = fixedPaths(applicationRoot);

    await initializeSqliteControlState(options);
    const marker = parseMarker(
      paths.markerPath,
      applicationRoot,
      options.instanceId,
      options.managementTenantId,
    );
    const database = new DatabaseSync(paths.controlDbPath);

    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });

      const expectedTables = [
        "control_identity",
        "module_approvals",
        "module_control_events",
        "module_control_idempotency",
        "module_previews",
        "module_readback_attempts",
        "module_readbacks",
        "module_registrations",
        "module_releases",
      ];
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
      expect(tables).toEqual(expectedTables);

      const tableList = database
        .prepare("PRAGMA table_list")
        .all()
        .filter((row) => !String(row.name).startsWith("sqlite_"));
      expect(tableList).toHaveLength(9);
      expect(tableList.map((row) => Number(row.strict))).toEqual(
        Array.from({ length: 9 }, () => 1),
      );

      const schemaStatements = database
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name",
        )
        .all()
        .map((row) => ({ name: String(row.name), sql: String(row.sql) }))
        .filter((row) => row.sql.length > 0);
      const actualByName = new Map(
        schemaStatements.map((row) => [row.name, normalizeControlSchema(row.sql)[0]]),
      );
      const orderedActualStatements = CONTROL_SCHEMA_STATEMENTS.map((statement) => {
        const name = /^CREATE (?:TABLE|(?:UNIQUE )?INDEX) ([A-Za-z_][A-Za-z0-9_]*) /iu.exec(
          statement,
        )?.[1];
        expect(name).toBeDefined();
        const actual = actualByName.get(name!);
        expect(actual).toBeDefined();
        return actual!;
      });
      expect(fingerprintControlSchema(orderedActualStatements)).toBe(
        CONTROL_SCHEMA_FINGERPRINT,
      );
      expect(new Set(actualByName.keys())).toEqual(
        new Set(
          CONTROL_SCHEMA_STATEMENTS.map(
            (statement) =>
              /^CREATE (?:TABLE|(?:UNIQUE )?INDEX) ([A-Za-z_][A-Za-z0-9_]*) /iu.exec(
                statement,
              )?.[1],
          ),
        ),
      );

      const indexes = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
      expect(indexes).toEqual([
        "idx_module_control_events_tenant_sequence",
        "idx_module_control_idempotency_tenant_action_key_hash",
        "idx_module_control_idempotency_tenant_expires_at",
        "idx_module_previews_tenant_expires_at",
        "idx_module_readback_attempts_release_history",
        "idx_module_readback_attempts_unfinished",
        "idx_module_readbacks_tenant_readback_ref",
        "idx_module_releases_tenant_status_revision",
        "uq_module_readback_attempts_claimed_release",
      ]);

      const identityRows = database
        .prepare(
          "SELECT control_db_id, control_db_path, instance_id, management_tenant_id, schema_version FROM control_identity",
        )
        .all();
      expect(identityRows).toHaveLength(1);
      expect(identityRows[0]).toEqual({
        control_db_id: marker.control_db_id,
        control_db_path: paths.controlDbPath,
        instance_id: options.instanceId,
        management_tenant_id: options.managementTenantId,
        schema_version: 1,
      });
    } finally {
      database.close();
    }
  });

  it("reopens healthy state and fails closed without creating state for invalid open inputs", async () => {
    const initializedRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(initializedRoot));

    const first = trackStore(
      openSqliteControlStore(openOptions(initializedRoot)),
    );
    await expect(first.health()).resolves.toEqual({ ready: true });
    await first.close();

    const reopened = trackStore(
      openSqliteControlStore(openOptions(initializedRoot)),
    );
    await expect(reopened.health()).resolves.toEqual({ ready: true });
    await reopened.close();

    const missingStateRoot = makeApplicationRoot();
    const missingStateBefore = readdirSync(missingStateRoot);
    expect(() =>
      openSqliteControlStore(openOptions(missingStateRoot)),
    ).toThrow();
    expect(readdirSync(missingStateRoot)).toEqual(missingStateBefore);
    expect(existsSync(fixedPaths(missingStateRoot).runtimeDir)).toBe(false);

    const changedTenantRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(changedTenantRoot));
    const changedTenantBefore = stateSnapshot(changedTenantRoot);
    expect(() =>
      openSqliteControlStore(
        openOptions(changedTenantRoot, {
          managementTenantId: "tenant_changed",
        }),
      ),
    ).toThrow();
    expect(stateSnapshot(changedTenantRoot)).toEqual(changedTenantBefore);

    const disabledRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(disabledRoot));
    const disabledBefore = stateSnapshot(disabledRoot);
    expect(() =>
      openSqliteControlStore(
        openOptions(disabledRoot, { adminControlEnabled: false }),
      ),
    ).toThrow();
    expect(stateSnapshot(disabledRoot)).toEqual(disabledBefore);

    const symlinkTargetRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(symlinkTargetRoot));
    const symlinkParentRoot = makeApplicationRoot();
    const symlinkRoot = join(symlinkParentRoot, "application-root-link");
    symlinkSync(symlinkTargetRoot, symlinkRoot, "dir");
    temporarySymlinks.push(symlinkRoot);
    const symlinkTargetBefore = stateSnapshot(symlinkTargetRoot);

    expect(lstatSync(symlinkRoot).isSymbolicLink()).toBe(true);
    expect(() => openSqliteControlStore(openOptions(symlinkRoot))).toThrow();
    expect(stateSnapshot(symlinkTargetRoot)).toEqual(symlinkTargetBefore);
  });

  it("rejects an old eight-table database without silently migrating it", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const paths = fixedPaths(applicationRoot);
    const database = new DatabaseSync(paths.controlDbPath);
    try {
      database.exec("DROP TABLE module_readback_attempts");
    } finally {
      database.close();
    }

    expect(() => openSqliteControlStore(openOptions(applicationRoot))).toThrow(
      /schema/i,
    );

    const reopenedDatabase = new DatabaseSync(paths.controlDbPath);
    try {
      expect(
        reopenedDatabase
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'module_readback_attempts'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      reopenedDatabase.close();
    }
  });

  it("exposes the readback-attempt companion without exposing a recovery finalizer", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));

    const store = trackStore(openSqliteControlStore(openOptions(applicationRoot)));
    const exposed = store as unknown as Record<string, unknown>;

    expect(typeof exposed.claimReadbackAttempt).toBe("function");
    expect(typeof exposed.finalizeReadbackAndComplete).toBe("function");
    expect(typeof exposed.getUnfinishedReadbackAttempt).toBe("function");
    expect(typeof exposed.listUnfinishedReadbackAttempts).toBe("function");
    expect(typeof exposed.getReadbackAttemptHistory).toBe("function");
    expect("recoveryDriver" in exposed).toBe(false);
  });
});
