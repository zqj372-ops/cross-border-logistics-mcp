import { execFile } from "node:child_process";
import {
  chmodSync,
  type closeSync,
  existsSync,
  type fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  type openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  type writeSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementResultingChanges,
} from "node:sqlite";
import { promisify } from "node:util";
import { type fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RegisterModuleRecordRequest } from "../../src/logistics_mcp/control-plane/repository";

const injectedFaults = vi.hoisted(() => ({
  runtimeMkdirRace: null as null | {
    readonly runtimeDir: string;
    readonly escapeDir: string;
  },
  runtimeBeforeStagingRace: null as null | {
    readonly runtimeDir: string;
    readonly escapeDir: string;
  },
  runtimeMutationBeforeCommitMarkerSwap: null as null | {
    readonly markerPath: string;
    readonly backupPath: string;
    readonly markerBytes: Buffer;
  },
  runtimeMutationAfterCommitMarkerSwap: null as null | {
    readonly markerPath: string;
    readonly backupPath: string;
    readonly markerBytes: Buffer;
  },
  initializerLockWriteFailure: false,
  initializerMarkerSwapBeforeFsync: false,
  initializerDatabaseSwapBeforeFsync: false,
  initializerDatabaseReadyForFsync: null as string | null,
  initializerStagingSwapBeforeRename: null as null | {
    readonly unrelatedDir: string;
  },
  initializerCleanupSwap: null as null | {
    readonly unrelatedDir: string;
  },
  initializerFsFault: null as null | {
    readonly boundary: "marker_fsync" | "staging_dir_fsync" | "parent_fsync" | "rename";
    readonly runtimeDir: string;
  },
  initializerSqliteFault: null as null | "schema_commit" | "wal_checkpoint" | "close",
  openFilePaths: new Map<number, string>(),
  replaceStagingDatabaseBeforeOpen: false,
  closeFailuresRemaining: 0,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  const actualChmodSync = actual.chmodSync as typeof chmodSync;
  const actualCloseSync = actual.closeSync as typeof closeSync;
  const actualExistsSync = actual.existsSync as typeof existsSync;
  const actualFsyncSync = actual.fsyncSync as typeof fsyncSync;
  const actualMkdirSync = actual.mkdirSync as typeof mkdirSync;
  const actualMkdtempSync = actual.mkdtempSync as typeof mkdtempSync;
  const actualOpenSync = actual.openSync as typeof openSync;
  const actualReadFileSync = actual.readFileSync as typeof readFileSync;
  const actualReaddirSync = actual.readdirSync as typeof readdirSync;
  const actualRenameSync = actual.renameSync as typeof renameSync;
  const actualSymlinkSync = actual.symlinkSync as typeof symlinkSync;
  const actualWriteFileSync = actual.writeFileSync as typeof writeFileSync;
  const actualWriteSync = actual.writeSync as typeof writeSync;
  const interceptedMkdirSync = ((...args: Parameters<typeof actualMkdirSync>) => {
    const pathValue = args[0];
    const race = injectedFaults.runtimeMkdirRace;
    if (race !== null && typeof pathValue === "string" && pathValue === race.runtimeDir) {
      injectedFaults.runtimeMkdirRace = null;
      actualSymlinkSync(race.escapeDir, race.runtimeDir, "dir");
    }
    return Reflect.apply(actualMkdirSync, undefined, args);
  }) as typeof actualMkdirSync;
  const interceptedMkdtempSync = ((...args: Parameters<typeof actualMkdtempSync>) => {
    const prefix = args[0];
    const race = injectedFaults.runtimeBeforeStagingRace;
    if (
      race !== null &&
      typeof prefix === "string" &&
      prefix.startsWith(`${race.runtimeDir}/.mcp-instance-state-staging-`)
    ) {
      injectedFaults.runtimeBeforeStagingRace = null;
      actualRenameSync(race.runtimeDir, `${race.runtimeDir}.raced-backup`);
      actualSymlinkSync(race.escapeDir, race.runtimeDir, "dir");
    }
    return Reflect.apply(actualMkdtempSync, undefined, args);
  }) as typeof actualMkdtempSync;
  const interceptedOpenSync = ((...args: Parameters<typeof actualOpenSync>) => {
    const pathValue = args[0];
    if (
      typeof pathValue === "string" &&
      pathValue === injectedFaults.initializerDatabaseReadyForFsync
    ) {
      injectedFaults.initializerDatabaseReadyForFsync = null;
      actualRenameSync(pathValue, `${pathValue}.before-fsync-backup`);
      actualWriteFileSync(pathValue, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
      actualChmodSync(pathValue, 0o600);
    }
    const fileDescriptor = Reflect.apply(actualOpenSync, undefined, args);
    if (typeof pathValue === "string") {
      injectedFaults.openFilePaths.set(fileDescriptor, pathValue);
    }
    return fileDescriptor;
  }) as typeof actualOpenSync;
  const interceptedCloseSync = ((...args: Parameters<typeof actualCloseSync>) => {
    try {
      return Reflect.apply(actualCloseSync, undefined, args);
    } finally {
      injectedFaults.openFilePaths.delete(args[0]);
    }
  }) as typeof actualCloseSync;
  const interceptedWriteSync = ((...args: Parameters<typeof actualWriteSync>) => {
    const pathValue = injectedFaults.openFilePaths.get(args[0]);
    if (
      injectedFaults.initializerLockWriteFailure &&
      pathValue?.includes(".mcp-instance-state-initialize.lock") === true
    ) {
      injectedFaults.initializerLockWriteFailure = false;
      throw new Error("injected initializer lock write failure");
    }
    return Reflect.apply(actualWriteSync, undefined, args);
  }) as typeof actualWriteSync;
  const interceptedFsyncSync = ((...args: Parameters<typeof actualFsyncSync>) => {
    const pathValue = injectedFaults.openFilePaths.get(args[0]);
    if (
      injectedFaults.initializerDatabaseSwapBeforeFsync &&
      pathValue?.includes("/.mcp-instance-state-staging-") === true &&
      pathValue.endsWith("/control.sqlite")
    ) {
      injectedFaults.initializerDatabaseSwapBeforeFsync = false;
      actualRenameSync(pathValue, `${pathValue}.before-fsync-backup`);
      actualWriteFileSync(pathValue, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
      actualChmodSync(pathValue, 0o600);
    }
    if (
      injectedFaults.initializerMarkerSwapBeforeFsync &&
      pathValue?.includes("/.mcp-instance-state-staging-") === true &&
      pathValue.endsWith("/control-identity.json")
    ) {
      injectedFaults.initializerMarkerSwapBeforeFsync = false;
      const bytes = actualReadFileSync(pathValue);
      actualRenameSync(pathValue, `${pathValue}.before-fsync-backup`);
      actualWriteFileSync(pathValue, bytes, { flag: "wx", mode: 0o400 });
      actualChmodSync(pathValue, 0o400);
    }
    const fault = injectedFaults.initializerFsFault;
    if (fault !== null && pathValue !== undefined) {
      const stateDir = join(fault.runtimeDir, "mcp-instance-state");
      const matches =
        (fault.boundary === "marker_fsync" &&
          pathValue.includes("/.mcp-instance-state-staging-") &&
          pathValue.endsWith("/control-identity.json")) ||
        (fault.boundary === "staging_dir_fsync" &&
          pathValue.includes("/.mcp-instance-state-staging-") &&
          !pathValue.endsWith("/control.sqlite") &&
          !pathValue.endsWith("/control-identity.json")) ||
        (fault.boundary === "parent_fsync" &&
          pathValue === fault.runtimeDir &&
          actualExistsSync(stateDir));
      if (matches) {
        injectedFaults.initializerFsFault = null;
        throw new Error(`injected ${fault.boundary} failure`);
      }
    }
    return Reflect.apply(actualFsyncSync, undefined, args);
  }) as typeof actualFsyncSync;
  const interceptedRenameSync = ((...args: Parameters<typeof actualRenameSync>) => {
    const [source, target] = args;
    const sourcePath = typeof source === "string" ? source : "";
    const targetPath = typeof target === "string" ? target : "";
    const swap = injectedFaults.initializerStagingSwapBeforeRename;
    if (
      swap !== null &&
      sourcePath.includes("/.mcp-instance-state-staging-") &&
      targetPath.endsWith("/mcp-instance-state")
    ) {
      injectedFaults.initializerStagingSwapBeforeRename = null;
      actualRenameSync(sourcePath, `${sourcePath}.owned-before-rename`);
      actualRenameSync(swap.unrelatedDir, sourcePath);
    }
    const fault = injectedFaults.initializerFsFault;
    if (
      fault?.boundary === "rename" &&
      sourcePath.includes("/.mcp-instance-state-staging-") &&
      targetPath === join(fault.runtimeDir, "mcp-instance-state")
    ) {
      injectedFaults.initializerFsFault = null;
      throw new Error("injected rename failure");
    }
    return Reflect.apply(actualRenameSync, undefined, args);
  }) as typeof actualRenameSync;
  const interceptedReaddirSync = ((...args: Parameters<typeof actualReaddirSync>) => {
    const pathValue = args[0];
    const swap = injectedFaults.initializerCleanupSwap;
    if (
      swap !== null &&
      typeof pathValue === "string" &&
      pathValue.includes("/.mcp-instance-state-staging-")
    ) {
      injectedFaults.initializerCleanupSwap = null;
      actualRenameSync(pathValue, `${pathValue}.owned-before-cleanup`);
      actualRenameSync(swap.unrelatedDir, pathValue);
    }
    return Reflect.apply(actualReaddirSync, undefined, args);
  }) as typeof actualReaddirSync;
  return {
    ...actual,
    closeSync: interceptedCloseSync,
    fsyncSync: interceptedFsyncSync,
    mkdirSync: interceptedMkdirSync,
    mkdtempSync: interceptedMkdtempSync,
    openSync: interceptedOpenSync,
    readdirSync: interceptedReaddirSync,
    renameSync: interceptedRenameSync,
    writeSync: interceptedWriteSync,
  };
});

vi.mock("node:sqlite", async () => {
  const actual = await vi.importActual("node:sqlite");
  const ActualDatabaseSync = actual.DatabaseSync as typeof DatabaseSync;
  const actualFs = await vi.importActual("node:fs");
  const actualChmodSync = actualFs.chmodSync as typeof chmodSync;
  const actualRenameSync = actualFs.renameSync as typeof renameSync;
  const actualUnlinkSync = actualFs.unlinkSync as typeof unlinkSync;
  const actualWriteFileSync = actualFs.writeFileSync as typeof writeFileSync;
  const actualUrl = await vi.importActual("node:url");
  const actualFileURLToPath = actualUrl.fileURLToPath as typeof fileURLToPath;

  const replaceMarker = (fault: {
    readonly markerPath: string;
    readonly backupPath: string;
    readonly markerBytes: Buffer;
  }): void => {
    actualRenameSync(fault.markerPath, fault.backupPath);
    actualWriteFileSync(fault.markerPath, fault.markerBytes, {
      flag: "wx",
      mode: 0o400,
    });
    actualChmodSync(fault.markerPath, 0o400);
  };

  class FaultInjectableDatabaseSync extends ActualDatabaseSync {
    readonly #databasePath: string;

    constructor(
      pathValue: ConstructorParameters<typeof ActualDatabaseSync>[0],
      options?: ConstructorParameters<typeof ActualDatabaseSync>[1],
    ) {
      const databasePath = pathValue instanceof URL
        ? actualFileURLToPath(pathValue)
        : Buffer.isBuffer(pathValue)
          ? pathValue.toString("utf8")
          : pathValue;
      if (
        injectedFaults.replaceStagingDatabaseBeforeOpen &&
        databasePath.includes(".mcp-instance-state-staging-") &&
        databasePath.endsWith("/control.sqlite")
      ) {
        injectedFaults.replaceStagingDatabaseBeforeOpen = false;
        actualUnlinkSync(databasePath);
        actualWriteFileSync(databasePath, Buffer.alloc(0), {
          flag: "wx",
          mode: 0o600,
        });
      }
      if (options === undefined) {
        super(pathValue);
      } else {
        super(pathValue, options);
      }
      this.#databasePath = databasePath;
    }

    override prepare(sql: string): ReturnType<DatabaseSync["prepare"]> {
      const statement = super.prepare(sql);
      if (
        this.#databasePath.includes("/.mcp-instance-state-staging-") &&
        sql.trim().toUpperCase() === "PRAGMA WAL_CHECKPOINT(TRUNCATE)"
      ) {
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property !== "all") {
              return Reflect.get(target, property, receiver) as unknown;
            }
            return (...parameters: SQLInputValue[]): Record<string, SQLOutputValue>[] => {
              if (injectedFaults.initializerSqliteFault === "wal_checkpoint") {
                injectedFaults.initializerSqliteFault = null;
                throw new Error("injected WAL checkpoint failure");
              }
              return statement.all(...parameters);
            };
          },
        });
      }
      if (
        this.#databasePath.endsWith("/mcp-instance-state/control.sqlite") &&
        sql.includes("INSERT INTO module_control_idempotency")
      ) {
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property !== "run") {
              return Reflect.get(target, property, receiver) as unknown;
            }
            return (...parameters: SQLInputValue[]): StatementResultingChanges => {
              const result = statement.run(...parameters);
              const fault = injectedFaults.runtimeMutationBeforeCommitMarkerSwap;
              if (fault !== null) {
                injectedFaults.runtimeMutationBeforeCommitMarkerSwap = null;
                replaceMarker(fault);
              }
              return result;
            };
          },
        });
      }
      return statement;
    }

    override exec(sql: string): void {
      if (
        injectedFaults.initializerSqliteFault === "schema_commit" &&
        this.#databasePath.includes("/.mcp-instance-state-staging-") &&
        sql.trim().toUpperCase() === "COMMIT"
      ) {
        injectedFaults.initializerSqliteFault = null;
        throw new Error("injected schema commit failure");
      }
      super.exec(sql);
      const fault = injectedFaults.runtimeMutationAfterCommitMarkerSwap;
      if (
        fault !== null &&
        this.#databasePath.endsWith("/mcp-instance-state/control.sqlite") &&
        sql.trim().toUpperCase() === "COMMIT"
      ) {
        injectedFaults.runtimeMutationAfterCommitMarkerSwap = null;
        replaceMarker(fault);
      }
    }

    override close(): void {
      if (
        injectedFaults.initializerSqliteFault === "close" &&
        this.#databasePath.includes("/.mcp-instance-state-staging-")
      ) {
        injectedFaults.initializerSqliteFault = null;
        throw new Error("injected initializer database close failure");
      }
      if (injectedFaults.closeFailuresRemaining > 0) {
        injectedFaults.closeFailuresRemaining -= 1;
        throw new Error("native close failed at /private/secret/control.sqlite after SELECT");
      }
      super.close();
    }
  }

  return { ...actual, DatabaseSync: FaultInjectableDatabaseSync };
});

import {
  initializeSqliteControlState,
  openSqliteControlStore,
  SqliteControlStoreError,
} from "../../src/logistics_mcp/control-plane/sqlite-control-store";

const temporaryRoots: string[] = [];
const openStores: Array<ReturnType<typeof openSqliteControlStore>> = [];
const execFileAsync = promisify(execFile);

const INSTANCE_ID = "instance_security_001";
const MANAGEMENT_TENANT_ID = "tenant_security";

type StorePaths = {
  readonly runtimeDir: string;
  readonly stateDir: string;
  readonly controlDbPath: string;
  readonly markerPath: string;
};

type StoreErrorLike = {
  readonly code?: unknown;
  readonly message?: unknown;
};

afterEach(async () => {
  injectedFaults.runtimeMkdirRace = null;
  injectedFaults.runtimeBeforeStagingRace = null;
  injectedFaults.runtimeMutationBeforeCommitMarkerSwap = null;
  injectedFaults.runtimeMutationAfterCommitMarkerSwap = null;
  injectedFaults.initializerLockWriteFailure = false;
  injectedFaults.initializerMarkerSwapBeforeFsync = false;
  injectedFaults.initializerDatabaseSwapBeforeFsync = false;
  injectedFaults.initializerDatabaseReadyForFsync = null;
  injectedFaults.initializerStagingSwapBeforeRename = null;
  injectedFaults.initializerCleanupSwap = null;
  injectedFaults.initializerFsFault = null;
  injectedFaults.initializerSqliteFault = null;
  injectedFaults.openFilePaths.clear();
  injectedFaults.replaceStagingDatabaseBeforeOpen = false;
  injectedFaults.closeFailuresRemaining = 0;
  for (const store of openStores.splice(0)) {
    try {
      await store.close();
    } catch {
      // Cleanup must not replace the assertion that caused the test to fail.
    }
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function makeApplicationRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "logistics-mcp-control-security-")),
  );
  temporaryRoots.push(root);
  return root;
}

function makeTemporaryDirectory(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

function controlDbPath(applicationRoot: string): string {
  return fixedPaths(applicationRoot).controlDbPath;
}

function fixedPaths(applicationRoot: string): StorePaths {
  const runtimeDir = join(applicationRoot, ".runtime");
  const stateDir = join(runtimeDir, "mcp-instance-state");
  return {
    runtimeDir,
    stateDir,
    controlDbPath: join(stateDir, "control.sqlite"),
    markerPath: join(stateDir, "control-identity.json"),
  };
}

function initializeOptions(applicationRoot: string) {
  return {
    applicationRoot,
    instanceId: INSTANCE_ID,
    managementTenantId: MANAGEMENT_TENANT_ID,
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
    instanceId: overrides.instanceId ?? INSTANCE_ID,
    managementTenantId: overrides.managementTenantId ?? MANAGEMENT_TENANT_ID,
    adminControlEnabled: overrides.adminControlEnabled ?? true,
  } as const;
}

function registrationRequest(): RegisterModuleRecordRequest {
  const descriptorDigest = `sha256:${"a".repeat(64)}` as const;
  const record = {
    managementTenantId: MANAGEMENT_TENANT_ID,
    moduleId: "security_module",
    version: "1.0.0",
    descriptorDigest,
    evidenceLevel: "local_build",
    productionEligible: false,
    evidenceRefs: {
      sourceShaRef: null,
      artifactDigestRef: null,
      signatureRef: null,
      sbomRef: null,
      attestationRef: null,
    },
    registeredByActorRef: "actor_security_operator",
    registeredAt: "2099-08-22T00:00:00Z",
  } as const;
  const domainRecordRef =
    `registration:${record.moduleId}:${record.version}:${record.descriptorDigest}`;
  return {
    metadata: {
      managementTenantId: MANAGEMENT_TENANT_ID,
      actorRef: record.registeredByActorRef,
      action: "packages.register",
      idempotencyKey: "idem_security_registration_001",
      requestHash: `mcp-control-hash/v1/request/sha256:${"b".repeat(64)}` as const,
      event: {
        action: "packages.register",
        objectRef: domainRecordRef,
        kind: "registration",
        status: "registered",
        reasonCodes: [],
        detail: {
          kind: "registration",
          recordRef: domainRecordRef,
          moduleId: record.moduleId,
          version: record.version,
          descriptorDigest: record.descriptorDigest,
          status: "registered",
        },
      },
    },
    record,
    finalResult: {
      domainRecordRef,
      envelope: {
        schema_version: "2026-08-22.v1",
        request_id: "request_security_registration_001",
        trace_id: "trace_security_registration_001",
        audit_id: "audit_security_registration_001",
        status: "success",
        data: {
          kind: "registration",
          module_id: record.moduleId,
          version: record.version,
          descriptor_digest: record.descriptorDigest,
        },
        reason_codes: [],
        readback: {
          status: "not_applicable",
          release_id: null,
          revision: null,
        },
      },
    },
  };
}

function trackStore(store: ReturnType<typeof openSqliteControlStore>) {
  openStores.push(store);
  return store;
}

function captureSyncError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectStoreError(
  action: () => unknown,
  code: string,
): asserts action is () => never {
  const error = captureSyncError(action);
  expect(error).toBeInstanceOf(SqliteControlStoreError);
  expect((error as StoreErrorLike).code).toBe(code);
  expect((error as StoreErrorLike).message).not.toMatch(
    /SQLITE_ERROR|sqlite_master|database disk image|NOT NULL constraint/i,
  );
}

function expectStoreErrorOneOf(action: () => unknown, codes: readonly string[]): void {
  const error = captureSyncError(action);
  expect(error).toBeInstanceOf(SqliteControlStoreError);
  expect(codes).toContain((error as StoreErrorLike).code);
  expect((error as StoreErrorLike).message).not.toMatch(
    /SQLITE_ERROR|sqlite_master|database disk image|NOT NULL constraint/i,
  );
}

function markerRecord(applicationRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fixedPaths(applicationRoot).markerPath, "utf8")) as Record<
    string,
    unknown
  >;
}

function writeCanonicalMarker(applicationRoot: string, marker: Record<string, unknown>): void {
  const ordered = Object.fromEntries(
    Object.keys(marker)
      .sort()
      .map((key) => [key, marker[key]]),
  );
  const markerPath = fixedPaths(applicationRoot).markerPath;
  chmodSync(markerPath, 0o600);
  writeFileSync(markerPath, `${JSON.stringify(ordered)}\n`, { mode: 0o400 });
  chmodSync(markerPath, 0o400);
}

function quotedPragmaIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function primaryKeyColumns(database: DatabaseSync, table: string): string[] {
  return database
    .prepare(`PRAGMA table_info(${quotedPragmaIdentifier(table)})`)
    .all()
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name));
}

function uniqueIndexColumns(database: DatabaseSync, table: string): string[][] {
  return database
    .prepare(`PRAGMA index_list(${quotedPragmaIdentifier(table)})`)
    .all()
    .filter((row) => Number(row.unique) === 1)
    .map((index) => {
      const indexName = String(index.name);
      return database
        .prepare(`PRAGMA index_info(${quotedPragmaIdentifier(indexName)})`)
        .all()
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((row) => String(row.name));
    })
    .sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}

function foreignKeyPairs(database: DatabaseSync, table: string): string[] {
  return database
    .prepare(`PRAGMA foreign_key_list(${quotedPragmaIdentifier(table)})`)
    .all()
    .sort((left, right) =>
      Number(left.id) - Number(right.id) || Number(left.seq) - Number(right.seq),
    )
    .map((row) => `${String(row.table)}:${String(row.from)}->${String(row.to)}`)
    .sort();
}

function tableSql(database: DatabaseSync, table: string): string {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql?: unknown } | undefined;
  return typeof row?.sql === "string" ? row.sql.replace(/\s+/g, " ").trim().toLowerCase() : "";
}

function rewriteTableSql(
  applicationRoot: string,
  table: string,
  mutate: (sql: string) => string,
  options: { readonly removeAutoIndexes?: boolean } = {},
): void {
  const database = new DatabaseSync(controlDbPath(applicationRoot));
  try {
    const defensiveDatabase = database as DatabaseSync & {
      enableDefensive?: (enabled: boolean) => void;
    };
    defensiveDatabase.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON");
    const row = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql?: unknown } | undefined;
    const original = typeof row?.sql === "string" ? row.sql : "";
    const mutated = mutate(original);
    expect(mutated).not.toBe(original);
    database
      .prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?")
      .run(mutated, table);
    if (options.removeAutoIndexes === true) {
      database
        .prepare(
          "DELETE FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'sqlite_autoindex_%'",
        )
        .run(table);
    }
    const versionRow = database.prepare("PRAGMA schema_version").get() as {
      schema_version: number;
    };
    database.exec(`PRAGMA schema_version = ${Number(versionRow.schema_version) + 1}`);
    database.exec("PRAGMA writable_schema = OFF");
  } finally {
    database.close();
  }
}

async function runConcurrentInitializer(
  options: ReturnType<typeof initializeOptions>,
): Promise<readonly { readonly ok: boolean; readonly output: string }[]> {
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "src/logistics_mcp/control-plane/sqlite-control-store.ts"),
  ).href;
  const script = `
    import { initializeSqliteControlState } from ${JSON.stringify(moduleUrl)};
    const options = JSON.parse(process.argv[1]);
    try {
      await initializeSqliteControlState(options);
      process.stdout.write("ok");
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error?.code ?? "unknown" }));
      process.exitCode = 1;
    }
  `;
  const results = await Promise.all(
    Array.from({ length: 4 }, async () => {
      try {
        const result = await execFileAsync(
          process.execPath,
          ["--import", "tsx/esm", "--input-type=module", "-e", script, JSON.stringify(options)],
          { cwd: process.cwd(), maxBuffer: 1024 * 1024, timeout: 15_000 },
        );
        return { ok: true, output: String(result.stdout) };
      } catch (error) {
        const result = error as { stdout?: string; stderr?: string };
        return {
          ok: false,
          output: `${String(result.stdout ?? "")} ${String(result.stderr ?? "")}`,
        };
      }
    }),
  );
  return results;
}

describe("SQLite control store security invariants", () => {
  it("persists and verifies marker_format in the control_identity singleton", async () => {
    const applicationRoot = makeApplicationRoot();

    await initializeSqliteControlState(initializeOptions(applicationRoot));

    const database = new DatabaseSync(controlDbPath(applicationRoot));
    try {
      const columns = database
        .prepare("PRAGMA table_info('control_identity')")
        .all()
        .map((row) => String(row.name));

      expect(columns).toHaveLength(7);
      expect(new Set(columns)).toEqual(
        new Set([
          "singleton_id",
          "management_tenant_id",
          "control_db_id",
          "control_db_path",
          "instance_id",
          "marker_format",
          "schema_version",
        ]),
      );

      const identity = database
        .prepare("SELECT marker_format FROM control_identity")
        .get() as { marker_format: unknown };
      expect(identity.marker_format).toBe("mcp-control-identity/v1");

      const markerText = readFileSync(fixedPaths(applicationRoot).markerPath, "utf8");
      expect(markerText).toContain('"marker_format":"mcp-control-identity/v1"');
    } finally {
      database.close();
    }
  });

  it("rejects a marker replacement with a different marker_format", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));

    const marker = markerRecord(applicationRoot);
    marker.marker_format = "mcp-control-identity/v999";
    writeCanonicalMarker(applicationRoot, marker);

    expectStoreError(
      () => openSqliteControlStore(openOptions(applicationRoot)),
      "identity_mismatch",
    );
  });

  it("records the complete fixed PK, UNIQUE, FK, CHECK, status, and index contract", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const database = new DatabaseSync(controlDbPath(applicationRoot));

    const expectedPrimaryKeys: Readonly<Record<string, readonly string[]>> = {
      control_identity: ["singleton_id"],
      module_registrations: [
        "management_tenant_id",
        "module_id",
        "version",
        "descriptor_digest",
      ],
      module_previews: ["management_tenant_id", "preview_ref"],
      module_approvals: ["management_tenant_id", "approval_id"],
      module_releases: ["management_tenant_id", "release_id"],
      module_readbacks: ["management_tenant_id", "release_id"],
      module_readback_attempts: ["management_tenant_id", "attempt_id"],
      module_control_idempotency: [
        "management_tenant_id",
        "action",
        "idempotency_key",
      ],
      module_control_events: ["sequence"],
    };
    const expectedUniqueIndexes: Readonly<Record<string, readonly string[][]>> = {
      control_identity: [["management_tenant_id", "control_db_id"]],
      module_registrations: [
        ["management_tenant_id", "module_id", "version", "descriptor_digest"],
      ],
      module_previews: [
        ["management_tenant_id", "preview_ref"],
        [
          "management_tenant_id",
          "preview_ref",
          "canonical_hash",
          "base_revision",
          "expires_at",
        ],
      ],
      module_approvals: [
        ["management_tenant_id", "approval_id"],
        ["management_tenant_id", "preview_ref"],
        ["management_tenant_id", "preview_ref", "approval_id"],
      ],
      module_releases: [
        ["management_tenant_id", "release_id"],
        ["management_tenant_id", "revision"],
        ["management_tenant_id", "release_id", "revision"],
      ],
      module_readbacks: [
        ["management_tenant_id", "release_id"],
        ["management_tenant_id", "readback_ref"],
      ],
      module_control_idempotency: [
        ["management_tenant_id", "action", "idempotency_key"],
        [
          "management_tenant_id",
          "action",
          "idempotency_key",
          "request_hash",
          "domain_record_ref",
        ],
      ],
      module_readback_attempts: [
        ["management_tenant_id", "attempt_id"],
        ["management_tenant_id", "action", "idempotency_key"],
        ["management_tenant_id", "readback_ref"],
        ["management_tenant_id", "release_id", "revision"],
        ["reconciliation_event_sequence"],
        ["completion_event_sequence"],
        [
          "management_tenant_id",
          "attempt_id",
          "release_id",
          "revision",
          "readback_ref",
        ],
      ],
      module_control_events: [["event_id"]],
    };
    const expectedForeignKeys: Readonly<Record<string, readonly string[]>> = {
      control_identity: [],
      module_registrations: [],
      module_previews: [],
      module_approvals: [
        "module_previews:management_tenant_id->management_tenant_id",
        "module_previews:preview_ref->preview_ref",
        "module_previews:preview_canonical_hash->canonical_hash",
        "module_previews:base_revision->base_revision",
        "module_previews:expires_at->expires_at",
      ],
      module_releases: [
        "module_approvals:management_tenant_id->management_tenant_id",
        "module_approvals:preview_ref->preview_ref",
        "module_approvals:approval_id->approval_id",
        "module_releases:management_tenant_id->management_tenant_id",
        "module_releases:previous_release_id->release_id",
        "module_releases:management_tenant_id->management_tenant_id",
        "module_releases:superseded_by_release_id->release_id",
      ],
      module_readbacks: [
        "module_releases:management_tenant_id->management_tenant_id",
        "module_releases:release_id->release_id",
        "module_releases:revision->revision",
        "module_readback_attempts:management_tenant_id->management_tenant_id",
        "module_readback_attempts:attempt_id->attempt_id",
        "module_readback_attempts:release_id->release_id",
        "module_readback_attempts:revision->revision",
        "module_readback_attempts:readback_ref->readback_ref",
      ],
      module_readback_attempts: [
        "module_control_idempotency:management_tenant_id->management_tenant_id",
        "module_control_idempotency:action->action",
        "module_control_idempotency:idempotency_key->idempotency_key",
        "module_control_idempotency:request_hash->request_hash",
        "module_control_idempotency:release_id->domain_record_ref",
        "module_releases:management_tenant_id->management_tenant_id",
        "module_releases:release_id->release_id",
        "module_releases:revision->revision",
        "module_control_events:reconciliation_event_sequence->sequence",
        "module_control_events:completion_event_sequence->sequence",
      ],
      module_control_idempotency: [],
      module_control_events: [],
    };

    try {
      for (const [table, expected] of Object.entries(expectedPrimaryKeys)) {
        expect(primaryKeyColumns(database, table)).toEqual(expected);
      }
      for (const [table, expected] of Object.entries(expectedUniqueIndexes)) {
        expect(uniqueIndexColumns(database, table)).toEqual(
          [...expected].map((columns) => [...columns]).sort((left, right) =>
            left.join("\0").localeCompare(right.join("\0")),
          ),
        );
      }
      for (const [table, expected] of Object.entries(expectedForeignKeys)) {
        expect(foreignKeyPairs(database, table)).toEqual([...expected].sort());
      }

      expect(tableSql(database, "control_identity")).toContain(
        "check (marker_format = 'mcp-control-identity/v1')",
      );
      expect(tableSql(database, "module_approvals")).toContain(
        "check (decision = 'approve' or consumed = 0)",
      );
      expect(tableSql(database, "module_releases")).toContain(
        "status in ('published_pending_readback', 'manual_review', 'active_verified', 'superseded')",
      );
      expect(tableSql(database, "module_readbacks")).toContain(
        "status in ('verified', 'mismatch', 'unknown')",
      );
      expect(tableSql(database, "module_readback_attempts")).toContain(
        "phase in ('claimed', 'finalized')",
      );
      expect(tableSql(database, "module_control_idempotency")).toContain(
        "status in ('reserved', 'domain_committed', 'completed')",
      );

      const fixedIndexes = database
        .prepare(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => ({
          name: String(row.name),
          table: String(row.tbl_name),
          sql: String(row.sql).replace(/\s+/g, " ").trim().toLowerCase(),
        }));
      expect(fixedIndexes).toEqual([
        {
          name: "idx_module_control_events_tenant_sequence",
          table: "module_control_events",
          sql: "create index idx_module_control_events_tenant_sequence on module_control_events (management_tenant_id, sequence)",
        },
        {
          name: "idx_module_control_idempotency_tenant_action_key_hash",
          table: "module_control_idempotency",
          sql: "create index idx_module_control_idempotency_tenant_action_key_hash on module_control_idempotency ( management_tenant_id, action, idempotency_key, request_hash )",
        },
        {
          name: "idx_module_control_idempotency_tenant_expires_at",
          table: "module_control_idempotency",
          sql: "create index idx_module_control_idempotency_tenant_expires_at on module_control_idempotency (management_tenant_id, expires_at)",
        },
        {
          name: "idx_module_previews_tenant_expires_at",
          table: "module_previews",
          sql: "create index idx_module_previews_tenant_expires_at on module_previews (management_tenant_id, expires_at)",
        },
        {
          name: "idx_module_readback_attempts_release_history",
          table: "module_readback_attempts",
          sql: "create index idx_module_readback_attempts_release_history on module_readback_attempts ( management_tenant_id, release_id, revision, reconciliation_event_sequence desc, attempt_id desc )",
        },
        {
          name: "idx_module_readback_attempts_unfinished",
          table: "module_readback_attempts",
          sql: "create index idx_module_readback_attempts_unfinished on module_readback_attempts ( management_tenant_id, claimed_at, release_id, revision ) where phase = 'claimed'",
        },
        {
          name: "idx_module_readbacks_tenant_readback_ref",
          table: "module_readbacks",
          sql: "create index idx_module_readbacks_tenant_readback_ref on module_readbacks (management_tenant_id, readback_ref)",
        },
        {
          name: "idx_module_releases_tenant_status_revision",
          table: "module_releases",
          sql: "create index idx_module_releases_tenant_status_revision on module_releases (management_tenant_id, status, revision desc)",
        },
        {
          name: "uq_module_readback_attempts_claimed_release",
          table: "module_readback_attempts",
          sql: "create unique index uq_module_readback_attempts_claimed_release on module_readback_attempts ( management_tenant_id, release_id, revision ) where phase = 'claimed'",
        },
      ]);
    } finally {
      database.close();
    }
  });

  const schemaDrifts = [
    {
      name: "primary key",
      table: "module_registrations",
      removeAutoIndexes: true,
      mutate: (sql: string) =>
        sql.replace(
          /,\s*PRIMARY KEY\s*\(\s*management_tenant_id,\s*module_id,\s*version,\s*descriptor_digest\s*\)/is,
          "",
        ),
    },
    {
      name: "foreign key",
      table: "module_approvals",
      removeAutoIndexes: false,
      mutate: (sql: string) =>
        sql.replace(
          /,\s*FOREIGN KEY\s*\(\s*management_tenant_id,\s*preview_ref,\s*preview_canonical_hash,\s*base_revision,\s*expires_at\s*\)\s*REFERENCES\s*module_previews\s*\(\s*management_tenant_id,\s*preview_ref,\s*canonical_hash,\s*base_revision,\s*expires_at\s*\)/is,
          "",
        ),
    },
    {
      name: "check constraint",
      table: "module_approvals",
      removeAutoIndexes: false,
      mutate: (sql: string) =>
        sql.replace(
          /,\s*CHECK\s*\(\s*decision\s*=\s*'approve'\s+OR\s+consumed\s*=\s*0\s*\)/is,
          "",
        ),
    },
    {
      name: "status constraint",
      table: "module_releases",
      removeAutoIndexes: false,
      mutate: (sql: string) =>
        sql.replace(/,\s*'superseded'/i, ""),
    },
    {
      name: "unique revision index",
      table: "module_releases",
      removeAutoIndexes: true,
      mutate: (sql: string) =>
        sql.replace(
          /,\s*UNIQUE\s*\(\s*management_tenant_id,\s*revision\s*\)/is,
          "",
        ),
    },
  ] as const;

  it.each(schemaDrifts)(
    "fails closed for $name schema drift",
    async ({ table, mutate, removeAutoIndexes }) => {
      const applicationRoot = makeApplicationRoot();
      await initializeSqliteControlState(initializeOptions(applicationRoot));
      rewriteTableSql(applicationRoot, table, mutate, { removeAutoIndexes });

      expectStoreErrorOneOf(
        () => openSqliteControlStore(openOptions(applicationRoot)),
        removeAutoIndexes === true
          ? ["schema_mismatch", "quick_check_failed"]
          : ["schema_mismatch"],
      );
    },
  );

  it("fails closed when an unexpected fixed index is added", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const database = new DatabaseSync(controlDbPath(applicationRoot));
    database.exec(
      "CREATE INDEX control_unexpected_index ON module_control_events (occurred_at)",
    );
    database.close();

    expectStoreError(
      () => openSqliteControlStore(openOptions(applicationRoot)),
      "schema_mismatch",
    );
  });

  it("fails closed when a required fixed index is removed", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const database = new DatabaseSync(controlDbPath(applicationRoot));
    database.exec("DROP INDEX idx_module_releases_tenant_status_revision");
    database.close();

    expectStoreError(
      () => openSqliteControlStore(openOptions(applicationRoot)),
      "schema_mismatch",
    );
  });

  it("does not create a missing control database during runtime open", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const paths = fixedPaths(applicationRoot);
    unlinkSync(paths.controlDbPath);

    expectStoreError(
      () => openSqliteControlStore(openOptions(applicationRoot)),
      "database_missing",
    );
    expect(existsSync(paths.controlDbPath)).toBe(false);
    expect(readdirSync(paths.stateDir)).toEqual(["control-identity.json"]);
  });

  it.each([
    {
      name: "database file",
      replace: (paths: StorePaths) => {
        unlinkSync(paths.controlDbPath);
        symlinkSync(paths.markerPath, paths.controlDbPath);
      },
      code: "permission_mismatch",
    },
    {
      name: "marker file",
      replace: (paths: StorePaths) => {
        unlinkSync(paths.markerPath);
        symlinkSync(paths.controlDbPath, paths.markerPath);
      },
      code: "permission_mismatch",
    },
    {
      name: "state directory",
      replace: (paths: StorePaths) => {
        const backup = `${paths.stateDir}.backup`;
        renameSync(paths.stateDir, backup);
        symlinkSync(backup, paths.stateDir, "dir");
      },
      code: "state_missing",
    },
    {
      name: "runtime directory",
      replace: (paths: StorePaths) => {
        const backup = `${paths.runtimeDir}.backup`;
        renameSync(paths.runtimeDir, backup);
        symlinkSync(backup, paths.runtimeDir, "dir");
      },
      code: "state_missing",
    },
  ] as const)("rejects $name symlink replacement", async ({ replace, code }) => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    replace(fixedPaths(applicationRoot));

    expectStoreError(
      () => openSqliteControlStore(openOptions(applicationRoot)),
      code,
    );
  });

  it("rejects a replacement database instead of opening a fresh empty file", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const paths = fixedPaths(applicationRoot);
    unlinkSync(paths.controlDbPath);
    const replacement = new DatabaseSync(paths.controlDbPath);
    replacement.close();
    chmodSync(paths.controlDbPath, 0o600);

    expectStoreError(
      () => openSqliteControlStore(openOptions(applicationRoot)),
      "schema_mismatch",
    );
    expect(statSync(paths.controlDbPath).mode & 0o777).toBe(0o600);
  });

  it("rejects a marker path replacement that points at a different absolute path", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const marker = markerRecord(applicationRoot);
    marker.control_db_path = join(applicationRoot, "other", "control.sqlite");
    writeCanonicalMarker(applicationRoot, marker);

    expectStoreError(
      () => openSqliteControlStore(openOptions(applicationRoot)),
      "identity_mismatch",
    );
  });

  it.each([
    {
      name: "control database",
      remove: (paths: StorePaths) => unlinkSync(paths.controlDbPath),
    },
    {
      name: "identity marker",
      remove: (paths: StorePaths) => unlinkSync(paths.markerPath),
    },
  ])("health is not green after the $name is deleted", async ({ remove }) => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const store = trackStore(openSqliteControlStore(openOptions(applicationRoot)));
    const paths = fixedPaths(applicationRoot);

    await expect(store.health()).resolves.toEqual({ ready: true });
    remove(paths);
    await expect(store.health()).resolves.toEqual({ ready: false });
  });

  it("rolls back every mutation row when marker identity changes inside the transaction", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const store = trackStore(openSqliteControlStore(openOptions(applicationRoot)));
    const paths = fixedPaths(applicationRoot);
    injectedFaults.runtimeMutationBeforeCommitMarkerSwap = {
      markerPath: paths.markerPath,
      backupPath: `${paths.markerPath}.before-commit-backup`,
      markerBytes: readFileSync(paths.markerPath),
    };

    // The mock swaps the marker after the first transactional INSERT. This models the
    // controllable cooperative-process window, not an unbounded same-UID attacker.
    await expect(store.registerModule(registrationRequest())).rejects.toMatchObject({
      code: "invalid_state",
    });
    await expect(store.health()).resolves.toEqual({ ready: false });
    await expect(store.getControlState()).rejects.toMatchObject({
      code: "invalid_state",
    });
    await store.close();

    const database = new DatabaseSync(paths.controlDbPath);
    try {
      for (const table of [
        "module_registrations",
        "module_control_idempotency",
        "module_control_events",
      ]) {
        expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
          count: 0,
        });
      }
    } finally {
      database.close();
    }
  });

  it("quarantines the handle when marker identity changes immediately after commit", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const store = trackStore(openSqliteControlStore(openOptions(applicationRoot)));
    const paths = fixedPaths(applicationRoot);
    injectedFaults.runtimeMutationAfterCommitMarkerSwap = {
      markerPath: paths.markerPath,
      backupPath: `${paths.markerPath}.after-commit-backup`,
      markerBytes: readFileSync(paths.markerPath),
    };

    await expect(store.registerModule(registrationRequest())).rejects.toMatchObject({
      code: "invalid_state",
    });
    await expect(store.health()).resolves.toEqual({ ready: false });
    await expect(store.getControlState()).rejects.toMatchObject({
      code: "invalid_state",
    });
    await expect(store.registerModule(registrationRequest())).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("requires the existing runtime directory mode to be exactly 0700 at open", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const paths = fixedPaths(applicationRoot);
    chmodSync(paths.runtimeDir, 0o755);

    expectStoreError(
      () => trackStore(openSqliteControlStore(openOptions(applicationRoot))),
      "permission_mismatch",
    );
  });

  it("fails closed with zero writes after an opened runtime directory becomes 0755", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const store = trackStore(openSqliteControlStore(openOptions(applicationRoot)));
    const paths = fixedPaths(applicationRoot);
    chmodSync(paths.runtimeDir, 0o755);

    await expect(store.health()).resolves.toEqual({ ready: false });
    await expect(store.registerModule(registrationRequest())).rejects.toMatchObject({
      code: "invalid_state",
    });
    await store.close();

    const database = new DatabaseSync(paths.controlDbPath);
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM module_registrations").get()).toEqual({
        count: 0,
      });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM module_control_events").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("revalidates a raced mkdir EEXIST runtime path before creating lock or staging state", async () => {
    const applicationRoot = makeApplicationRoot();
    const escapeDir = makeTemporaryDirectory("logistics-mcp-runtime-escape-");
    const paths = fixedPaths(applicationRoot);
    injectedFaults.runtimeMkdirRace = {
      runtimeDir: paths.runtimeDir,
      escapeDir,
    };

    await expect(
      Promise.resolve().then(() =>
        initializeSqliteControlState(initializeOptions(applicationRoot)),
      ),
    ).rejects.toMatchObject({ code: "invalid_application_root" });

    expect(readdirSync(escapeDir)).toEqual([]);
    expect(existsSync(paths.stateDir)).toBe(false);
    expect(existsSync(join(escapeDir, ".mcp-instance-state-initialize.lock"))).toBe(false);
  });

  it("leaves an untrusted raced staging path when the runtime parent changes after lock", async () => {
    const applicationRoot = makeApplicationRoot();
    const escapeDir = makeTemporaryDirectory("logistics-mcp-staging-escape-");
    const paths = fixedPaths(applicationRoot);
    injectedFaults.runtimeBeforeStagingRace = {
      runtimeDir: paths.runtimeDir,
      escapeDir,
    };

    await expect(
      Promise.resolve().then(() =>
        initializeSqliteControlState(initializeOptions(applicationRoot)),
      ),
    ).rejects.toMatchObject({ code: "cleanup_failed" });

    // A same-UID process can ignore the cooperative lock and replace a pathname.
    // Once the parent identity changes, deleting that pathname would be unsafe.
    expect(readdirSync(escapeDir)).toHaveLength(1);
    expect(readdirSync(escapeDir)[0]).toMatch(/^\.mcp-instance-state-staging-/);
    expect(existsSync(join(escapeDir, "mcp-instance-state"))).toBe(false);
  });

  it("binds the created staging database inode across DatabaseSync reopen", async () => {
    const applicationRoot = makeApplicationRoot();
    const paths = fixedPaths(applicationRoot);
    injectedFaults.replaceStagingDatabaseBeforeOpen = true;

    await expect(
      Promise.resolve().then(() =>
        initializeSqliteControlState(initializeOptions(applicationRoot)),
      ),
    ).rejects.toMatchObject({ code: "cleanup_failed" });

    expect(existsSync(paths.stateDir)).toBe(false);
    expect(
      readdirSync(paths.runtimeDir).filter((entry) => entry.includes("staging")),
    ).not.toEqual([]);

    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const store = trackStore(openSqliteControlStore(openOptions(applicationRoot)));
    await expect(store.health()).resolves.toEqual({ ready: true });
  });

  it("rejects a staging database path swap after SQLite close but before fsync", async () => {
    const applicationRoot = makeApplicationRoot();
    const paths = fixedPaths(applicationRoot);
    injectedFaults.initializerDatabaseSwapBeforeFsync = true;

    await expect(
      Promise.resolve().then(() =>
        initializeSqliteControlState(initializeOptions(applicationRoot)),
      ),
    ).rejects.toMatchObject({ code: "initialization_failed" });

    expect(existsSync(paths.stateDir)).toBe(false);
  });

  it("rejects a marker path swap after write but before its fd fsync", async () => {
    const applicationRoot = makeApplicationRoot();
    const paths = fixedPaths(applicationRoot);
    injectedFaults.initializerMarkerSwapBeforeFsync = true;

    await expect(
      Promise.resolve().then(() =>
        initializeSqliteControlState(initializeOptions(applicationRoot)),
      ),
    ).rejects.toMatchObject({ code: "initialization_failed" });

    expect(existsSync(paths.stateDir)).toBe(false);
  });

  it("quarantines a replaced staging inode after rename without deleting unrelated data", async () => {
    const applicationRoot = makeApplicationRoot();
    const paths = fixedPaths(applicationRoot);
    const unrelatedDir = makeTemporaryDirectory("logistics-mcp-unrelated-rename-");
    writeFileSync(join(unrelatedDir, "do-not-delete.txt"), "unrelated");
    injectedFaults.initializerStagingSwapBeforeRename = { unrelatedDir };

    await expect(
      Promise.resolve().then(() =>
        initializeSqliteControlState(initializeOptions(applicationRoot)),
      ),
    ).rejects.toMatchObject({ code: "initialization_failed" });

    expect(existsSync(paths.stateDir)).toBe(false);
    expect(
      readdirSync(paths.runtimeDir).some((entry) =>
        existsSync(join(paths.runtimeDir, entry, "do-not-delete.txt")),
      ),
    ).toBe(true);

    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const store = trackStore(openSqliteControlStore(openOptions(applicationRoot)));
    await expect(store.health()).resolves.toEqual({ ready: true });
  });

  it("never recursively deletes an unrelated directory swapped in at cleanup", async () => {
    const applicationRoot = makeApplicationRoot();
    const paths = fixedPaths(applicationRoot);
    const unrelatedDir = makeTemporaryDirectory("logistics-mcp-unrelated-cleanup-");
    const sentinelPath = join(unrelatedDir, "do-not-delete.txt");
    writeFileSync(sentinelPath, "unrelated");
    injectedFaults.initializerCleanupSwap = { unrelatedDir };
    injectedFaults.initializerFsFault = {
      boundary: "marker_fsync",
      runtimeDir: paths.runtimeDir,
    };

    await expect(
      Promise.resolve().then(() =>
        initializeSqliteControlState(initializeOptions(applicationRoot)),
      ),
    ).rejects.toMatchObject({ code: "cleanup_failed" });

    expect(injectedFaults.initializerCleanupSwap).toBeNull();
    expect(
      readdirSync(paths.runtimeDir).some((entry) =>
        existsSync(join(paths.runtimeDir, entry, "do-not-delete.txt")),
      ),
    ).toBe(true);
    expect(existsSync(paths.stateDir)).toBe(false);
  });

  it.each([
    { name: "schema transaction commit", boundary: "schema_commit" },
    { name: "WAL checkpoint", boundary: "wal_checkpoint" },
    { name: "SQLite close", boundary: "close" },
    { name: "marker fsync", boundary: "marker_fsync" },
    { name: "staging directory fsync", boundary: "staging_dir_fsync" },
    { name: "rename", boundary: "rename" },
    { name: "runtime parent fsync", boundary: "parent_fsync" },
  ] as const)(
    "restart observes either no final state or a complete state after $name failure",
    async ({ boundary }) => {
      const applicationRoot = makeApplicationRoot();
      const paths = fixedPaths(applicationRoot);
      if (
        boundary === "schema_commit" ||
        boundary === "wal_checkpoint" ||
        boundary === "close"
      ) {
        injectedFaults.initializerSqliteFault = boundary;
      } else {
        injectedFaults.initializerFsFault = {
          boundary,
          runtimeDir: paths.runtimeDir,
        };
      }

      await expect(
        Promise.resolve().then(() =>
          initializeSqliteControlState(initializeOptions(applicationRoot)),
        ),
      ).rejects.toBeInstanceOf(SqliteControlStoreError);

      if (existsSync(paths.stateDir)) {
        expect(readdirSync(paths.stateDir).sort()).toEqual([
          "control-identity.json",
          "control.sqlite",
        ]);
      } else {
        await initializeSqliteControlState(initializeOptions(applicationRoot));
      }
      const store = trackStore(openSqliteControlStore(openOptions(applicationRoot)));
      await expect(store.health()).resolves.toEqual({ ready: true });
      expect(
        readdirSync(paths.runtimeDir).filter((entry) =>
          entry.startsWith(".mcp-instance-state-staging-") ||
          entry.startsWith(".mcp-instance-state-initialize.lock"),
        ),
      ).toEqual([]);
    },
  );

  it("recovers a complete initializer lock owned by a dead PID", async () => {
    const applicationRoot = makeApplicationRoot();
    const paths = fixedPaths(applicationRoot);
    mkdirSync(paths.runtimeDir, { mode: 0o700 });
    const lockPath = join(paths.runtimeDir, ".mcp-instance-state-initialize.lock");
    writeFileSync(lockPath, "pid:999999\n", { flag: "wx", mode: 0o600 });
    chmodSync(lockPath, 0o600);

    await expect(initializeSqliteControlState(initializeOptions(applicationRoot))).resolves.toBeUndefined();

    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(paths.stateDir).sort()).toEqual([
      "control-identity.json",
      "control.sqlite",
    ]);
  });

  it.each(["", "pid:", "not-a-pid\n"])(
    "never steals a malformed or incomplete fixed initializer lock %#",
    async (contents) => {
      const applicationRoot = makeApplicationRoot();
      const paths = fixedPaths(applicationRoot);
      mkdirSync(paths.runtimeDir, { mode: 0o700 });
      const lockPath = join(paths.runtimeDir, ".mcp-instance-state-initialize.lock");
      writeFileSync(lockPath, contents, { flag: "wx", mode: 0o600 });
      chmodSync(lockPath, 0o600);
      const oldTime = new Date(Date.now() - 60_000);
      utimesSync(lockPath, oldTime, oldTime);

      await expect(
        Promise.resolve().then(() =>
          initializeSqliteControlState(initializeOptions(applicationRoot)),
        ),
      ).rejects.toMatchObject({ code: "lock_conflict" });

      expect(readFileSync(lockPath, "utf8")).toBe(contents);
      expect(existsSync(paths.stateDir)).toBe(false);
    },
  );

  it("never exposes a malformed fixed lock when lock-owner writing fails", async () => {
    const applicationRoot = makeApplicationRoot();
    const paths = fixedPaths(applicationRoot);
    injectedFaults.initializerLockWriteFailure = true;

    await expect(
      Promise.resolve().then(() =>
        initializeSqliteControlState(initializeOptions(applicationRoot)),
      ),
    ).rejects.toMatchObject({ code: "initialization_failed" });

    expect(existsSync(join(paths.runtimeDir, ".mcp-instance-state-initialize.lock"))).toBe(false);
    expect(
      readdirSync(paths.runtimeDir).filter((entry) =>
        entry.startsWith(".mcp-instance-state-initialize.lock.tmp-"),
      ),
    ).toEqual([]);
  });

  it("cleans a complete abandoned dead-PID lock temp before initialization", async () => {
    const applicationRoot = makeApplicationRoot();
    const paths = fixedPaths(applicationRoot);
    mkdirSync(paths.runtimeDir, { mode: 0o700 });
    const tempPath = join(
      paths.runtimeDir,
      `.mcp-instance-state-initialize.lock.tmp-999999-${"a".repeat(32)}`,
    );
    writeFileSync(tempPath, "pid:999999\n", { flag: "wx", mode: 0o600 });
    chmodSync(tempPath, 0o600);

    await initializeSqliteControlState(initializeOptions(applicationRoot));

    expect(existsSync(tempPath)).toBe(false);
    expect(readdirSync(paths.stateDir).sort()).toEqual([
      "control-identity.json",
      "control.sqlite",
    ]);
  });

  it("recovers a dead-PID crash after atomic lock link but before temp unlink", async () => {
    const applicationRoot = makeApplicationRoot();
    const paths = fixedPaths(applicationRoot);
    mkdirSync(paths.runtimeDir, { mode: 0o700 });
    const tempPath = join(
      paths.runtimeDir,
      `.mcp-instance-state-initialize.lock.tmp-999999-${"b".repeat(32)}`,
    );
    const lockPath = join(paths.runtimeDir, ".mcp-instance-state-initialize.lock");
    writeFileSync(tempPath, "pid:999999\n", { flag: "wx", mode: 0o600 });
    chmodSync(tempPath, 0o600);
    linkSync(tempPath, lockPath);

    await initializeSqliteControlState(initializeOptions(applicationRoot));

    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(paths.stateDir).sort()).toEqual([
      "control-identity.json",
      "control.sqlite",
    ]);
  });

  it("never steals a live initializer lock or reports it as installed state", async () => {
    const applicationRoot = makeApplicationRoot();
    const paths = fixedPaths(applicationRoot);
    mkdirSync(paths.runtimeDir, { mode: 0o700 });
    const lockPath = join(paths.runtimeDir, ".mcp-instance-state-initialize.lock");
    writeFileSync(lockPath, `pid:${process.pid}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(lockPath, 0o600);

    await expect(
      Promise.resolve().then(() =>
        initializeSqliteControlState(initializeOptions(applicationRoot)),
      ),
    ).rejects.toMatchObject({ code: "lock_conflict" });

    expect(readFileSync(lockPath, "utf8")).toBe(`pid:${process.pid}\n`);
    expect(existsSync(paths.stateDir)).toBe(false);
  });

  it("does not overwrite an existing state directory on duplicate initialization", async () => {
    const applicationRoot = makeApplicationRoot();
    const options = initializeOptions(applicationRoot);
    await initializeSqliteControlState(options);
    const paths = fixedPaths(applicationRoot);
    const markerBefore = readFileSync(paths.markerPath);
    const entriesBefore = readdirSync(paths.stateDir).sort();

    await expect(
      Promise.resolve().then(() => initializeSqliteControlState(options)),
    ).rejects.toMatchObject({ code: "state_exists" });

    expect(readFileSync(paths.markerPath)).toEqual(markerBefore);
    expect(readdirSync(paths.stateDir).sort()).toEqual(entriesBefore);
    expect(readdirSync(paths.runtimeDir).filter((entry) => entry.includes("staging"))).toEqual(
      [],
    );
  });

  it("allows exactly one concurrent initializer to install the fixed directory", async () => {
    const applicationRoot = makeApplicationRoot();
    const results = await runConcurrentInitializer(initializeOptions(applicationRoot));
    const successful = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);

    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    expect(
      rejected.every(
        (result) =>
          result.output.includes("state_exists") || result.output.includes("lock_conflict"),
      ),
    ).toBe(true);
    expect(readdirSync(fixedPaths(applicationRoot).stateDir).sort()).toEqual([
      "control-identity.json",
      "control.sqlite",
    ]);
    expect(readdirSync(fixedPaths(applicationRoot).runtimeDir).filter((entry) =>
      entry.includes("staging"),
    )).toEqual([]);
  });

  it("normalizes proxy option failures before any path or database access", () => {
    const rawFailure = "raw proxy option failure";
    const hostileOptions = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(rawFailure);
        },
      },
    );

    for (const operation of [
      () => initializeSqliteControlState(hostileOptions as never),
      () => openSqliteControlStore(hostileOptions as never),
    ]) {
      const error = captureSyncError(operation);
      expect(error).toBeInstanceOf(SqliteControlStoreError);
      expect((error as StoreErrorLike).code).toBe("invalid_options");
      expect((error as StoreErrorLike).message).not.toContain(rawFailure);
    }
  });

  it.each(["stateDir", "controlDbPath", "markerPath"])(
    "rejects explicit %s path overrides",
    (forbiddenKey) => {
      const applicationRoot = makeApplicationRoot();
      const initializeWithOverride = {
        ...initializeOptions(applicationRoot),
        [forbiddenKey]: join(applicationRoot, "attacker-selected-path"),
      };
      const openWithOverride = {
        ...openOptions(applicationRoot),
        [forbiddenKey]: join(applicationRoot, "attacker-selected-path"),
      };

      expectStoreError(
        () => initializeSqliteControlState(initializeWithOverride),
        "invalid_options",
      );
      expectStoreError(
        () => openSqliteControlStore(openWithOverride),
        "invalid_options",
      );
      expect(existsSync(join(applicationRoot, ".runtime"))).toBe(false);
    },
  );

  it("retries close after an isolated DatabaseSync close failure without claiming closed", async () => {
    const applicationRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(applicationRoot));
    const store = trackStore(openSqliteControlStore(openOptions(applicationRoot)));
    injectedFaults.closeFailuresRemaining = 1;

    const firstFailure = await Promise.resolve()
      .then(() => store.close())
      .catch((error: unknown) => error);
    expect(firstFailure).toBeInstanceOf(SqliteControlStoreError);
    expect(firstFailure).toMatchObject({ code: "close_failed" });
    expect(String((firstFailure as Error).message)).not.toMatch(
      /native close|\/private\/secret|SELECT/i,
    );
    await expect(store.health()).resolves.toEqual({ ready: true });

    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.health()).resolves.toEqual({ ready: false });
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("classifies a corrupt database separately from a live exclusive-lock conflict", async () => {
    const corruptRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(corruptRoot));
    const corruptPaths = fixedPaths(corruptRoot);
    writeFileSync(corruptPaths.controlDbPath, "not a sqlite database", { mode: 0o600 });
    chmodSync(corruptPaths.controlDbPath, 0o600);

    const corruptError = captureSyncError(() =>
      openSqliteControlStore(openOptions(corruptRoot)),
    );
    expect(corruptError).toBeInstanceOf(SqliteControlStoreError);
    expect((corruptError as StoreErrorLike).code).toBe("quick_check_failed");
    expect((corruptError as StoreErrorLike).code).not.toBe("lock_conflict");

    const lockedRoot = makeApplicationRoot();
    await initializeSqliteControlState(initializeOptions(lockedRoot));
    const first = trackStore(openSqliteControlStore(openOptions(lockedRoot)));
    const lockError = captureSyncError(() =>
      openSqliteControlStore(openOptions(lockedRoot)),
    );
    expect(lockError).toBeInstanceOf(SqliteControlStoreError);
    expect((lockError as StoreErrorLike).code).toBe("lock_conflict");
    await expect(first.health()).resolves.toEqual({ ready: true });
  });
});
