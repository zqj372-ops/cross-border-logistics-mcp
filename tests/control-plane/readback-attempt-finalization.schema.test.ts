import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  assertExactControlSchema,
  CONTROL_SCHEMA_FINGERPRINT,
  CONTROL_SCHEMA_STATEMENTS,
  fingerprintControlSchema,
  normalizeControlSchema,
} from "../../src/logistics_mcp/control-plane/readback-attempt-schema";

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("readback attempt finalization schema artifact", () => {
  it("matches the accepted artifact in statement order and fingerprint", () => {
    const artifact = readFileSync(
      new URL(
        "../../docs/rfcs/2026-08-23-readback-attempt-finalization-v1.schema.sql",
        import.meta.url,
      ),
    );
    const normalized = normalizeControlSchema(artifact);

    expect(normalized).toHaveLength(18);
    expect(CONTROL_SCHEMA_STATEMENTS).toEqual(normalized);
    expect(fingerprintControlSchema(normalized)).toBe(CONTROL_SCHEMA_FINGERPRINT);
    expect(() => assertExactControlSchema(normalized)).not.toThrow();
    expect(new Set(normalized.filter((statement) => /CREATE TABLE/i.test(statement)))).toHaveLength(9);
    expect(new Set(normalized.filter((statement) => /CREATE (?:UNIQUE )?INDEX/i.test(statement)))).toHaveLength(9);
    expect(normalized.some((statement) => statement.includes("module_readback_attempts"))).toBe(true);
    expect(
      normalized
        .find((statement) => statement.startsWith("CREATE TABLE module_readbacks"))
        ?.includes("status IN ('pending'"),
    ).toBe(false);
  });

  it("preserves token separation across quoted comments and CRLF line comments", () => {
    const left = normalizeControlSchema(
      utf8("CREATE TABLE t(a/*comment*/TEXT);\nCREATE INDEX i ON t(a);"),
    );
    const right = normalizeControlSchema(
      utf8("CREATE TABLE t(aTEXT);\r\nCREATE INDEX i ON t(a);"),
    );
    const crlf = normalizeControlSchema(
      utf8("-- ignored\r\nCREATE TABLE t(a TEXT);\r\nCREATE INDEX i ON t(a);"),
    );

    expect(left[0]).toContain("a TEXT");
    expect(right[0]).toContain("aTEXT");
    expect(left).not.toEqual(right);
    expect(fingerprintControlSchema(left)).not.toBe(fingerprintControlSchema(right));
    expect(crlf).toEqual([
      "CREATE TABLE t(a TEXT)",
      "CREATE INDEX i ON t(a)",
    ]);
  });

  it("does not treat comment markers inside quoted strings or identifiers as comments", () => {
    const normalized = normalizeControlSchema(
      utf8(
        "CREATE TABLE \"quoted--identifier/*literal*/\" (" +
          "value TEXT CHECK (value = 'quoted -- text /* text */')" +
          ") STRICT;" +
          "CREATE INDEX \"index--identifier/*literal*/\" ON " +
          "\"quoted--identifier/*literal*/\"(value);",
      ),
    );

    expect(normalized).toEqual([
      "CREATE TABLE \"quoted--identifier/*literal*/\" (value TEXT CHECK (value = 'quoted -- text /* text */')) STRICT",
      "CREATE INDEX \"index--identifier/*literal*/\" ON \"quoted--identifier/*literal*/\"(value)",
    ]);
  });

  it("consumes CR, LF, and CRLF line comments and replaces block comments once", () => {
    expect(
      normalizeControlSchema(
        utf8(
          "-- CR comment\rCREATE TABLE a(x TEXT);\n" +
            "-- LF comment\nCREATE INDEX b ON a(x);\r\n" +
            "-- CRLF comment\r\n",
        ),
      ),
    ).toEqual(["CREATE TABLE a(x TEXT)", "CREATE INDEX b ON a(x)"]);

    expect(
      normalizeControlSchema(utf8("CREATE TABLE a(a/* one */ /* two */TEXT);")),
    ).toEqual(["CREATE TABLE a(a TEXT)"]);
  });

  it("rejects unknown or duplicate/missing schema statements", () => {
    expect(() =>
      normalizeControlSchema(utf8("CREATE VIEW unexpected AS SELECT 1;")),
    ).toThrow();
    expect(() =>
      assertExactControlSchema([
        ...CONTROL_SCHEMA_STATEMENTS.slice(0, -1),
        CONTROL_SCHEMA_STATEMENTS[0]!,
      ]),
    ).toThrow();
    expect(() =>
      assertExactControlSchema([
        ...CONTROL_SCHEMA_STATEMENTS,
        CONTROL_SCHEMA_STATEMENTS[0]!,
      ]),
    ).toThrow();
  });

  it("executes the normalized artifact in an empty SQLite database", () => {
    const artifact = readFileSync(
      new URL(
        "../../docs/rfcs/2026-08-23-readback-attempt-finalization-v1.schema.sql",
        import.meta.url,
      ),
    );
    const statements = normalizeControlSchema(artifact);
    assertExactControlSchema(statements);
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      for (const statement of statements) database.exec(statement + ";");
      database.exec("PRAGMA user_version = 1");

      const tables = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as unknown as readonly { name: string }[];
      expect(tables).toHaveLength(9);
      expect(
        (database.prepare("PRAGMA table_list").all() as unknown as readonly { name: string; strict: number }[])
          .filter((row) => !row.name.startsWith("sqlite_"))
          .every((row) => Number(row.strict) === 1),
      ).toBe(true);

      const indexes = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as unknown as readonly { name: string }[];
      expect(indexes).toHaveLength(9);
      expect(
        database.prepare("PRAGMA foreign_key_check").all() as readonly unknown[],
      ).toHaveLength(0);
      expect(
        Number((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys),
      ).toBe(1);
      expect(
        Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
      ).toBe(1);
    } finally {
      database.close();
    }
  });
});
