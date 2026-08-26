import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import {
  loadAgentProfile,
  loadAgentRegistry,
  loadWorkstreamProjection,
  readRegisteredBytes,
  readRegisteredText,
  readRegisteredStandard,
} from "./registry";
import {
  validateAndFreezeAgentStandardPack,
} from "./pack-validation";
import type {
  AgentStandardPack,
  AgentPackStandard,
  AgentRegistry,
} from "./types";
import { REVIEWED_RUNTIME_PACK_DESCRIPTOR } from "./reviewed-runtime-pack";

const runtimeTrustedPackBrand = new WeakSet<object>();

function trustPackForRuntime(pack: AgentStandardPack): AgentStandardPack {
  runtimeTrustedPackBrand.add(pack);
  return pack;
}

export function isRuntimeTrustedAgentStandardPack(
  value: unknown,
): value is AgentStandardPack {
  return (
    typeof value === "object" &&
    value !== null &&
    runtimeTrustedPackBrand.has(value)
  );
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function sha256Bytes(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function reviewedDescriptorMismatch(): Error {
  return new Error(
    "Bytes do not match the reviewed Agent Standard Pack descriptor. " +
    "A security review must update the code descriptor before this pack can be built or loaded.",
  );
}

function assertReviewedSerializedBytes(content: Uint8Array): void {
  if (
    content.byteLength !== REVIEWED_RUNTIME_PACK_DESCRIPTOR.serialized_bytes ||
    sha256Bytes(content) !== REVIEWED_RUNTIME_PACK_DESCRIPTOR.serialized_sha256
  ) {
    throw reviewedDescriptorMismatch();
  }
}

function assertReviewedPackMetadata(pack: AgentStandardPack): void {
  if (
    pack.registry_id !== REVIEWED_RUNTIME_PACK_DESCRIPTOR.registry_id ||
    pack.pack_schema_version !== REVIEWED_RUNTIME_PACK_DESCRIPTOR.pack_schema_version ||
    pack.standards.length !== REVIEWED_RUNTIME_PACK_DESCRIPTOR.standard_count
  ) {
    throw reviewedDescriptorMismatch();
  }
}

function reviewedSerializedBytes(pack: AgentStandardPack): Buffer {
  const content = Buffer.from(serializeAgentStandardPack(pack), "utf8");
  assertReviewedSerializedBytes(content);
  assertReviewedPackMetadata(pack);
  return content;
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
  const pack = validateAndFreezeAgentStandardPack({
    pack_schema_version: "2026-08-21.v1",
    registry_id: registry.registry_id,
    standards,
    profiles,
    modules,
    resources,
    workstreams: loadWorkstreamProjection(rootDir),
  });
  reviewedSerializedBytes(pack);
  return pack;
}

export function serializeAgentStandardPack(pack: AgentStandardPack): string {
  const validated = validateAndFreezeAgentStandardPack(pack);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function writeAgentStandardPack(rootDir: string, outputPath: string): AgentStandardPack {
  const pack = buildAgentStandardPack(rootDir);
  const serialized = reviewedSerializedBytes(pack);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  const temporaryPath = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, serialized);
    renameSync(temporaryPath, target);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return pack;
}

export function readAgentStandardPack(packPath: string): AgentStandardPack {
  const absolutePath = resolve(packPath);
  const content = readRegisteredText(dirname(absolutePath), basename(absolutePath));
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error("Agent Standard Pack JSON is invalid.");
  }
  return validateAndFreezeAgentStandardPack(parsed);
}

function fixedRuntimePackLocation(): {
  readonly rootDir: string;
  readonly registeredPath: string;
} {
  const codeBase = fileURLToPath(new URL("../../../", import.meta.url));
  return basename(codeBase) === "dist"
    ? { rootDir: codeBase, registeredPath: "standards/agent-standard-pack.json" }
    : {
        rootDir: codeBase,
        registeredPath: "dist/standards/agent-standard-pack.json",
      };
}

export function readFixedAgentStandardPack(): AgentStandardPack {
  const location = fixedRuntimePackLocation();
  const serialized = readRegisteredBytes(location.rootDir, location.registeredPath);
  assertReviewedSerializedBytes(serialized);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(serialized);
  } catch {
    throw new Error("Agent Standard Pack JSON is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error("Agent Standard Pack JSON is invalid.");
  }
  const pack = validateAndFreezeAgentStandardPack(parsed);
  assertReviewedPackMetadata(pack);
  return trustPackForRuntime(pack);
}
