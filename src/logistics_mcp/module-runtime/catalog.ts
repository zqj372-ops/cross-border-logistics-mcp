import { ModuleRuntimeError } from "./errors";
import type {
  ModuleCatalogEntry,
  ModuleToolContribution,
} from "./types";
import type { RegistrationLease } from "./lease";

export class ModuleCatalog {
  private readonly entries = new Map<string, ModuleCatalogEntry>();

  register(
    moduleId: string,
    moduleVersion: string,
    contribution: ModuleToolContribution,
    lease: RegistrationLease,
  ): void {
    if (this.entries.has(contribution.name)) {
      throw new ModuleRuntimeError("tool_duplicate", `Tool is already registered: ${contribution.name}`);
    }
    const entry: ModuleCatalogEntry = {
      ...contribution,
      module_id: moduleId,
      module_version: moduleVersion,
    };
    this.entries.set(entry.name, entry);
    lease.add(() => {
      const current = this.entries.get(entry.name);
      if (current?.module_id === moduleId) {
        this.entries.delete(entry.name);
      }
    });
  }

  get(name: string): ModuleCatalogEntry | undefined {
    return this.entries.get(name);
  }

  list(): readonly ModuleCatalogEntry[] {
    return [...this.entries.values()];
  }
}
