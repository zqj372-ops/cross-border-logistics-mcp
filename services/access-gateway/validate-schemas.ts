import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

export function validateAccessGatewaySchemas(root = resolve(".")) {
  const directory = join(root, "schemas", "access-gateway");
  const failures: string[] = [];
  const files = readdirSync(directory).filter((file) => file.endsWith(".schema.json")).sort();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const file of files) {
    try {
      ajv.compile(JSON.parse(readFileSync(join(directory, file), "utf8")) as object);
    } catch (error: unknown) {
      failures.push(`${file}: ${error instanceof Error ? error.message : "invalid schema"}`);
    }
  }
  return { schemaCount: files.length, failures } as const;
}

if (process.argv[1]?.endsWith("validate-schemas.ts") === true) {
  const report = validateAccessGatewaySchemas();
  if (report.failures.length > 0) {
    report.failures.forEach((failure) => console.error(failure));
    process.exitCode = 1;
  } else {
    console.log(`validated ${report.schemaCount} Access Gateway schemas`);
  }
}
