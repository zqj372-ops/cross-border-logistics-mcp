const runtime = await import("../../dist/services/access-gateway/start.mjs");

try {
  const summary = await runtime.migrateSqliteGatewayToPostgresFromEnvironment();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch {
  process.stderr.write("Access Gateway SQLite to PostgreSQL migration failed; no secret material was emitted.\n");
  process.exitCode = 1;
}
