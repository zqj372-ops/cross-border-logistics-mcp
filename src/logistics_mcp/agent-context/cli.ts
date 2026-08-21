import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { buildAgentStandardPack, writeAgentStandardPack } from "./pack";
import { resolveAgentContextFromRepository } from "./resolver";
import { validateAgentStandards } from "./validation";
import { validateAgentAdapters } from "./adapters";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const command = process.argv[2];

if (command === "validate") {
  const report = validateAgentStandards(rootDir);
  if (report.failures.length > 0) {
    for (const failure of report.failures) console.error(failure);
    process.exitCode = 1;
  } else {
    console.log(`validated ${report.standardCount} standards, ${report.profileCount} profiles, ${report.moduleCount} modules and ${report.resourceCount} resources`);
  }
} else if (command === "build") {
  const outputPath = process.argv[3] === undefined
    ? resolve(rootDir, "dist/standards/agent-standard-pack.json")
    : resolve(rootDir, process.argv[3]);
  const pack = writeAgentStandardPack(rootDir, outputPath);
  console.log(`built ${pack.standards.length} standards into ${outputPath}`);
} else if (command === "context") {
  const profileId = process.argv[3];
  if (profileId === undefined) {
    console.error("usage: agent-context context <profile-id> [module-id]");
    process.exitCode = 2;
  } else {
    const result = resolveAgentContextFromRepository({
      rootDir,
      profileId,
      ...(process.argv[4] === undefined ? {} : { moduleId: process.argv[4] }),
    });
    console.log(JSON.stringify(result, null, 2));
  }
} else if (command === "adapters") {
  const report = validateAgentAdapters(rootDir);
  if (report.failures.length > 0) {
    for (const failure of report.failures) console.error(failure);
    process.exitCode = 1;
  } else {
    console.log(`validated ${report.adapterCount} Agent client adapters and fixed resource allowlists`);
  }
} else {
  console.error("usage: agent-context <validate|build|context|adapters>");
  process.exitCode = 2;
}

export { buildAgentStandardPack };
