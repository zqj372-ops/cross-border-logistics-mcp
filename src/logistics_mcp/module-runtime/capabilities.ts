import { ModuleRuntimeError } from "./errors";

interface CapabilityEntry {
  readonly value: unknown;
  readonly version: string;
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityEntry>();

  provide(name: string, value: unknown, version = "v1"): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name)) {
      throw new ModuleRuntimeError("capability_name_invalid", `Invalid capability name: ${name}`);
    }
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
}
