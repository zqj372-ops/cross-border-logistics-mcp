import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  loadAgentProfile,
  loadAgentRegistry,
  loadWorkstreamProjection,
  readRegisteredStandard,
} from "./registry";
import type {
  AgentStandardPack,
  AgentPackStandard,
  AgentRegistry,
} from "./types";

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function packStandard(
  registry: AgentRegistry,
  rootDir: string,
  standardId: string,
): AgentPackStandard {
  const standard = readRegisteredStandard(rootDir, registry, standardId);
  return {
    standard_id: standard.standard_id,
    version: standard.version,
    priority: standard.priority,
    audiences: [...standard.audiences].sort(),
    rule_ids: [...standard.rule_ids].sort(),
    summary: standard.summary,
    sha256: sha256(standard.content),
    source_ref: `standard:${standard.standard_id}:${standard.version}`,
    content: standard.content,
  };
}

export function buildAgentStandardPack(rootDir: string): AgentStandardPack {
  const registry = loadAgentRegistry(rootDir);
  const standards = registry.standards
    .map((standard) => packStandard(registry, rootDir, standard.standard_id))
    .sort((left, right) => left.standard_id.localeCompare(right.standard_id));
  const profiles = registry.profiles
    .map((profile) => loadAgentProfile(rootDir, registry, profile.profile_id))
    .sort((left, right) => left.profile_id.localeCompare(right.profile_id));
  const modules = [...registry.modules].sort((left, right) => left.module_id.localeCompare(right.module_id));
  const resources = [...registry.resources].sort((left, right) => left.resource_id.localeCompare(right.resource_id));
  return {
    pack_schema_version: "2026-08-21.v1",
    registry_id: registry.registry_id,
    standards,
    profiles,
    modules,
    resources,
    workstreams: loadWorkstreamProjection(rootDir),
  };
}

export function serializeAgentStandardPack(pack: AgentStandardPack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

export function writeAgentStandardPack(rootDir: string, outputPath: string): AgentStandardPack {
  const pack = buildAgentStandardPack(rootDir);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  const temporaryPath = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, serializeAgentStandardPack(pack), "utf8");
    renameSync(temporaryPath, target);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return pack;
}

export function readAgentStandardPack(packPath: string): AgentStandardPack {
  return JSON.parse(readFileSync(resolve(packPath), "utf8")) as AgentStandardPack;
}
