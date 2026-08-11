import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";

export interface SchemaValidationReport {
  readonly schemaCount: number;
  readonly exampleCount: number;
  readonly failures: readonly string[];
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function validateContractSchemas(
  rootDir = fileURLToPath(new URL("../../../", import.meta.url)),
): SchemaValidationReport {
  const schemasDir = join(rootDir, "docs", "contracts", "schemas");
  const examplesDir = join(rootDir, "docs", "contracts", "examples");
  const failures: string[] = [];
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  addFormats(ajv);

  const schemaFiles = readdirSync(schemasDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  for (const file of schemaFiles) {
    try {
      ajv.addSchema(readJson(join(schemasDir, file)));
    } catch (error: unknown) {
      failures.push(
        `schema ${file}: ${error instanceof Error ? error.message : "invalid schema"}`,
      );
    }
  }

  for (const file of schemaFiles) {
    const schema = readJson(join(schemasDir, file));
    const schemaId = typeof schema.$id === "string" ? schema.$id : null;
    if (schemaId === null) {
      failures.push(`schema ${file}: missing $id`);
      continue;
    }
    try {
      if (ajv.getSchema(schemaId) === undefined) {
        ajv.compile(schema);
      }
    } catch (error: unknown) {
      failures.push(
        `schema ${file}: ${error instanceof Error ? error.message : "cannot compile"}`,
      );
    }
  }

  const envelopeSchemaId =
    "https://schemas.example.invalid/logistics-mcp/2026-08-11/envelope.schema.json";
  const envelopeValidator = ajv.getSchema(envelopeSchemaId);
  if (envelopeValidator === undefined) {
    failures.push("envelope.schema.json: validator is unavailable");
  }

  const exampleFiles = readdirSync(examplesDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  if (envelopeValidator !== undefined) {
    for (const file of exampleFiles) {
      const valid = envelopeValidator(readJson(join(examplesDir, file)));
      if (!valid) {
        failures.push(
          `example ${file}: ${ajv.errorsText(envelopeValidator.errors)}`,
        );
      }
    }
  }

  return {
    schemaCount: schemaFiles.length,
    exampleCount: exampleFiles.length,
    failures,
  };
}

if (process.argv[1]?.endsWith("validate-contracts.ts") === true) {
  const report = validateContractSchemas();
  if (report.failures.length > 0) {
    for (const failure of report.failures) {
      console.error(failure);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `validated ${report.schemaCount} schemas and ${report.exampleCount} examples`,
    );
  }
}
