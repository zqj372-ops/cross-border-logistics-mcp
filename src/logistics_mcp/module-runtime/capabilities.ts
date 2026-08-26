import { ModuleRuntimeError } from "./errors";

interface CapabilityEntry {
  readonly value: unknown;
  readonly version: string;
}

/**
 * A manifest capability requirement. An omitted version is intentional: it
 * preserves the v0 manifest contract where a string names a capability but
 * does not constrain its version.
 */
export interface CapabilityRequirement {
  readonly name: string;
  readonly version?: string | undefined;
}

export type CapabilityRequirementInput = string | CapabilityRequirement;

export interface CapabilityView {
  has(name: string): boolean;
  resolve<T>(name: string): T;
  version(name: string): string;
  names(): readonly string[];
}

const capabilityName = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const capabilityVersion = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

/**
 * Normalize both supported manifest forms:
 *
 *   "safe_http"       -> { name: "safe_http" }
 *   "safe_http@v1"    -> { name: "safe_http", version: "v1" }
 *   { name, version }  -> the same structured requirement
 *
 * Version matching is deliberately exact. Capability versions in this
 * runtime are opaque contract identifiers (for example, `v1` or a dated
 * profile), not semver ranges.
 */
export function normalizeCapabilityRequirement(
  input: CapabilityRequirementInput,
): CapabilityRequirement {
  if (typeof input === "string") {
    const separator = input.indexOf("@");
    if (separator === -1) {
      assertCapabilityName(input);
      return { name: input };
    }

    const name = input.slice(0, separator);
    const version = input.slice(separator + 1);
    assertCapabilityName(name);
    assertCapabilityVersion(version);
    return { name, version };
  }

  if (input === null || typeof input !== "object") {
    throw new ModuleRuntimeError("capability_requirement_invalid", "Capability requirements must be strings or objects.");
  }

  const name = input.name;
  const version = input.version;
  if (typeof name !== "string") {
    throw new ModuleRuntimeError("capability_requirement_invalid", "Capability requirement name must be a string.");
  }
  assertCapabilityName(name);
  if (version !== undefined) {
    assertCapabilityVersion(version);
    return { name, version };
  }
  return { name };
}

function assertCapabilityName(name: string): void {
  if (!capabilityName.test(name)) {
    throw new ModuleRuntimeError("capability_name_invalid", `Invalid capability name: ${name}`);
  }
}

function assertCapabilityVersion(version: string): void {
  if (!capabilityVersion.test(version)) {
    throw new ModuleRuntimeError("capability_version_invalid", `Invalid capability version: ${version}`);
  }
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityEntry>();

  provide(name: string, value: unknown, version = "v1"): void {
    assertCapabilityName(name);
    assertCapabilityVersion(version);
    if (this.entries.has(name)) {
      throw new ModuleRuntimeError("capability_duplicate", `Capability already provided: ${name}`);
    }
    this.entries.set(name, { value, version });
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  resolve<T>(name: string): T {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new ModuleRuntimeError("capability_missing", `Required capability is not available: ${name}`);
    }
    return entry.value as T;
  }

  version(name: string): string {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new ModuleRuntimeError("capability_missing", `Required capability is not available: ${name}`);
    }
    return entry.version;
  }

  names(): readonly string[] {
    return [...this.entries.keys()].sort();
  }

  /** Return whether a capability satisfies a manifest requirement. */
  satisfies(input: CapabilityRequirementInput): boolean {
    const requirement = normalizeCapabilityRequirement(input);
    const entry = this.entries.get(requirement.name);
    return entry !== undefined && (requirement.version === undefined || entry.version === requirement.version);
  }

  /**
   * Create a capability view for one module. The view captures only
   * capabilities named by the manifest and only entries matching their
   * declared versions. It intentionally has no `provide` method.
   */
  scoped(requirements: readonly CapabilityRequirementInput[]): CapabilityView {
    return new ScopedCapabilityView(this, requirements);
  }

  /** Alias kept explicit for callers that prefer the longer boundary name. */
  scopedView(requirements: readonly CapabilityRequirementInput[]): CapabilityView {
    return this.scoped(requirements);
  }

  /** Internal lookup used while constructing a scoped view. */
  getEntry(name: string): CapabilityEntry | undefined {
    return this.entries.get(name);
  }
}

export class ScopedCapabilityView implements CapabilityView {
  private readonly declaredNames: ReadonlySet<string>;
  private readonly entries: ReadonlyMap<string, CapabilityEntry>;

  constructor(
    registry: CapabilityRegistry,
    requirements: readonly CapabilityRequirementInput[],
  ) {
    const declaredNames = new Set<string>();
    const entries = new Map<string, CapabilityEntry>();
    for (const input of requirements) {
      const requirement = normalizeCapabilityRequirement(input);
      declaredNames.add(requirement.name);
      const entry = registry.getEntry(requirement.name);
      if (entry === undefined) continue;
      if (requirement.version !== undefined && entry.version !== requirement.version) continue;
      entries.set(requirement.name, entry);
    }
    this.declaredNames = declaredNames;
    this.entries = entries;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  resolve<T>(name: string): T {
    if (!this.declaredNames.has(name)) {
      throw new ModuleRuntimeError("capability_undeclared", `Capability is not declared by this module: ${name}`);
    }
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new ModuleRuntimeError("capability_missing", `Declared capability is not available: ${name}`);
    }
    return entry.value as T;
  }

  version(name: string): string {
    if (!this.declaredNames.has(name)) {
      throw new ModuleRuntimeError("capability_undeclared", `Capability is not declared by this module: ${name}`);
    }
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new ModuleRuntimeError("capability_missing", `Declared capability is not available: ${name}`);
    }
    return entry.version;
  }

  names(): readonly string[] {
    return [...this.entries.keys()].sort();
  }
}
