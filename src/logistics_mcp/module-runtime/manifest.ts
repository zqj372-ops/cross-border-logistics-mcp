import { z } from "zod";

import { normalizeCapabilityRequirement } from "./capabilities";
import { ModuleRuntimeError } from "./errors";
import type { ModuleManifest } from "./types";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/);
const capabilityName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const capabilityReference = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?:@[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127})?$/,
);
const capabilityRequirement = z.union([
  capabilityReference,
  z.object({ name: capabilityName, version: version.optional() }).strict(),
]);

const manifestSchema = z
  .object({
    module_id: identifier,
    version,
    risk_level: z.enum(["T0", "T1", "T2", "T3"]),
    required_capabilities: z.array(capabilityRequirement),
    optional_capabilities: z.array(capabilityRequirement),
    standard_ids: z.array(identifier).min(1),
    lifecycle: z.literal("static"),
  })
  .strict();

export function validateModuleManifest(input: ModuleManifest): ModuleManifest {
  const result = manifestSchema.safeParse(input);
  if (!result.success) {
    throw new ModuleRuntimeError("manifest_invalid", result.error.message);
  }
  const required = result.data.required_capabilities.map(normalizeCapabilityRequirement);
  const optional = result.data.optional_capabilities.map(normalizeCapabilityRequirement);
  const requiredNames = new Set(required.map((requirement) => requirement.name));
  if (optional.some((requirement) => requiredNames.has(requirement.name))) {
    throw new ModuleRuntimeError("manifest_capability_overlap", `Module ${result.data.module_id} repeats a required capability as optional.`);
  }
  if (new Set(required.map((requirement) => requirement.name)).size !== required.length) {
    throw new ModuleRuntimeError("manifest_capability_duplicate", `Module ${result.data.module_id} repeats a required capability.`);
  }
  if (new Set(optional.map((requirement) => requirement.name)).size !== optional.length) {
    throw new ModuleRuntimeError("manifest_capability_duplicate", `Module ${result.data.module_id} repeats an optional capability.`);
  }
  if (new Set(result.data.standard_ids).size !== result.data.standard_ids.length) {
    throw new ModuleRuntimeError("manifest_standard_duplicate", `Module ${result.data.module_id} repeats a standard reference.`);
  }
  return result.data;
}
