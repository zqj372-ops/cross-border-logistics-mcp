import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildAgentStandardPack } from "./pack";
import {
  loadAgentProfile,
  loadAgentRegistry,
  loadWorkstreamProjection,
  readRegisteredStandard,
  resolveRegisteredPath,
} from "./registry";

export interface AgentStandardsValidationReport {
  readonly standardCount: number;
  readonly profileCount: number;
  readonly moduleCount: number;
  readonly resourceCount: number;
  readonly failures: readonly string[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function defaultRootDir(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

export function validateAgentStandards(rootDir = defaultRootDir()): AgentStandardsValidationReport {
  const failures: string[] = [];
  let standardCount = 0;
  let profileCount = 0;
  let moduleCount = 0;
  let resourceCount = 0;
  try {
    const schemaDir = join(rootDir, "schemas");
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    for (const file of [
      "agent-index.schema.json",
      "agent-profile.schema.json",
      "agent-workstreams.schema.json",
      "agent-context-get.schema.json",
      "agent-context-envelope.schema.json",
    ]) {
      ajv.addSchema(readJson(join(schemaDir, file)) as object);
    }
    const registryPath = resolveRegisteredPath(rootDir, "docs/agent/index.json");
    const registrySchema = ajv.getSchema("https://schemas.example.invalid/logistics-mcp/2026-08-21/agent-index.schema.json");
    if (registrySchema === undefined || !registrySchema(readJson(registryPath))) {
      failures.push(`docs/agent/index.json: ${registrySchema?.errors === null ? "schema validation failed" : ajv.errorsText(registrySchema?.errors)}`);
    }
    const registry = loadAgentRegistry(rootDir);
    standardCount = registry.standards.length;
    profileCount = registry.profiles.length;
    moduleCount = registry.modules.length;
    resourceCount = registry.resources.length;
    for (const standard of registry.standards) {
      try {
        readRegisteredStandard(rootDir, registry, standard.standard_id);
      } catch (error: unknown) {
        failures.push(`standard ${standard.standard_id}: ${error instanceof Error ? error.message : "invalid standard"}`);
      }
    }
    const profileSchema = ajv.getSchema("https://schemas.example.invalid/logistics-mcp/2026-08-21/agent-profile.schema.json");
    for (const profileRef of registry.profiles) {
      const profilePath = resolveRegisteredPath(rootDir, profileRef.path);
      if (profileSchema === undefined || !profileSchema(readJson(profilePath))) {
        failures.push(`profile ${profileRef.profile_id}: ${ajv.errorsText(profileSchema?.errors)}`);
      }
      try {
        loadAgentProfile(rootDir, registry, profileRef.profile_id);
      } catch (error: unknown) {
        failures.push(`profile ${profileRef.profile_id}: ${error instanceof Error ? error.message : "invalid profile"}`);
      }
    }
    const workstreamSchema = ajv.getSchema("https://schemas.example.invalid/logistics-mcp/2026-08-21/agent-workstreams.schema.json");
    const workstreamPath = resolveRegisteredPath(rootDir, "docs/agent/workstreams/current.json");
    if (workstreamSchema === undefined || !workstreamSchema(readJson(workstreamPath))) {
      failures.push(`workstreams: ${ajv.errorsText(workstreamSchema?.errors)}`);
    }
    loadWorkstreamProjection(rootDir);
    buildAgentStandardPack(rootDir);
  } catch (error: unknown) {
    failures.push(error instanceof Error ? error.message : "agent standard validation failed");
  }
  return {
    standardCount,
    profileCount,
    moduleCount,
    resourceCount,
    failures,
  };
}
