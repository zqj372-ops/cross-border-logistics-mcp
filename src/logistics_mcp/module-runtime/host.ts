import { ModuleRuntimeError } from "./errors";
import {
  normalizeCapabilityRequirement,
  type CapabilityRegistry,
} from "./capabilities";
import { ModuleCatalog } from "./catalog";
import { RegistrationLease } from "./lease";
import { validateModuleManifest } from "./manifest";
import {
  assertExactStringSet,
  assertModuleDescriptorMatchesManifest,
  assertReviewedToolContractMatchesCatalogEntry,
  validateModuleDescriptor,
  type ModuleDescriptor,
} from "./production";
import type {
  ModuleDefinition,
  ModuleHostOptions,
  ModuleHostSnapshot,
  ModuleHostStatus,
  ModuleMountContext,
} from "./types";

export class ModuleHost {
  readonly catalog = new ModuleCatalog();
  readonly capabilities: CapabilityRegistry;
  private readonly modules: readonly ModuleDefinition[];
  private readonly trustedDescriptors: ReadonlyMap<string, ModuleDescriptor>;
  private readonly leases: { readonly definition: ModuleDefinition; readonly lease: RegistrationLease }[] = [];
  private _status: ModuleHostStatus = "created";
  private mountPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: ModuleHostOptions) {
    this.capabilities = options.capabilities;
    this.modules = [...options.modules];
    const ids = this.modules.map((module) => module.manifest.module_id);
    if (new Set(ids).size !== ids.length) {
      throw new ModuleRuntimeError("module_duplicate", "Module IDs must be unique.");
    }
    for (const module of this.modules) {
      validateModuleManifest(module.manifest);
    }
    const descriptors = (options.trustedDescriptors ?? []).map(validateModuleDescriptor);
    if (options.trustedDescriptors !== undefined) {
      assertExactStringSet(
        descriptors.map((descriptor) => descriptor.module_id),
        ids,
        "module_descriptor_set_mismatch",
      );
      for (const descriptor of descriptors) {
        const module = this.modules.find(
          (candidate) => candidate.manifest.module_id === descriptor.module_id,
        );
        if (module === undefined) {
          throw new ModuleRuntimeError(
            "module_descriptor_set_mismatch",
            `No module is mounted for descriptor ${descriptor.module_id}.`,
          );
        }
        assertModuleDescriptorMatchesManifest(descriptor, module.manifest);
      }
    }
    this.trustedDescriptors = new Map(
      descriptors.map((descriptor) => [descriptor.module_id, descriptor]),
    );
  }

  get status(): ModuleHostStatus {
    return this._status;
  }

  async mount(): Promise<void> {
    if (this.mountPromise !== null) return this.mountPromise;
    if (this._status !== "created") {
      throw new ModuleRuntimeError("host_state_invalid", `Cannot mount host in state ${this._status}.`);
    }
    this.mountPromise = this.mountInternal();
    return this.mountPromise;
  }

  mountSync(): void {
    if (this.mountPromise !== null) {
      throw new ModuleRuntimeError("host_state_invalid", "The module host is already mounting or mounted.");
    }
    if (this._status !== "created") {
      throw new ModuleRuntimeError("host_state_invalid", `Cannot mount host in state ${this._status}.`);
    }
    this._status = "mounting";
    try {
      this.assertRequiredCapabilities();
      for (const module of this.modules) {
        const lease = new RegistrationLease();
        this.leases.push({ definition: module, lease });
        const result = module.mount(this.contextFor(module, lease));
        if (result instanceof Promise) {
          throw new ModuleRuntimeError("mount_async", `Module ${module.manifest.module_id} requires asynchronous mounting.`);
        }
      }
      this.assertTrustedToolSets();
      this._status = "mounted";
    } catch (error: unknown) {
      try {
        this.releaseLeasesSync();
      } catch {
        // The original mount error is the actionable failure; the host remains failed.
      }
      this._status = "failed";
      if (error instanceof ModuleRuntimeError) throw error;
      throw new ModuleRuntimeError("mount_failed", "A module failed during mount.", { cause: error });
    }
  }

  private async mountInternal(): Promise<void> {
    this._status = "mounting";
    try {
      this.assertRequiredCapabilities();
      for (const module of this.modules) {
        const lease = new RegistrationLease();
        this.leases.push({ definition: module, lease });
        await module.mount(this.contextFor(module, lease));
      }
      this.assertTrustedToolSets();
      this._status = "mounted";
    } catch (error: unknown) {
      await this.releaseLeases();
      this._status = "failed";
      if (error instanceof ModuleRuntimeError) throw error;
      throw new ModuleRuntimeError("mount_failed", "A module failed during mount.", { cause: error });
    }
  }

  private assertRequiredCapabilities(): void {
    for (const module of this.modules) {
      for (const input of module.manifest.required_capabilities) {
        const capability = normalizeCapabilityRequirement(input);
        if (!this.capabilities.has(capability.name)) {
          throw new ModuleRuntimeError(
            "capability_missing",
            `Module ${module.manifest.module_id} requires unavailable capability ${capability.name}.`,
          );
        }
        if (capability.version !== undefined && !this.capabilities.satisfies(capability)) {
          throw new ModuleRuntimeError(
            "capability_version_mismatch",
            `Module ${module.manifest.module_id} requires capability ${capability.name}@${capability.version}, but the provided version is ${this.capabilities.version(capability.name)}.`,
          );
        }
      }
    }
  }

  private contextFor(module: ModuleDefinition, lease: RegistrationLease): ModuleMountContext {
    const capabilityRequirements = [
      ...module.manifest.required_capabilities,
      ...module.manifest.optional_capabilities,
    ];
    return {
      capabilities: this.capabilities.scoped(capabilityRequirements),
      lease,
      tools: {
        register: (contribution) => {
          if (contribution.riskLevel !== module.manifest.risk_level) {
            throw new ModuleRuntimeError(
              "tool_risk_mismatch",
              `Tool ${contribution.name} risk does not match module ${module.manifest.module_id}.`,
            );
          }
          if (!module.manifest.standard_ids.every((standardId) => contribution.standardRefs.includes(standardId))) {
            throw new ModuleRuntimeError(
              "tool_standard_missing",
              `Tool ${contribution.name} does not declare every module conformance standard.`,
            );
          }
          this.catalog.register(
            module.manifest.module_id,
            module.manifest.version,
            contribution,
            lease,
          );
        },
      },
    };
  }

  private assertTrustedToolSets(): void {
    for (const module of this.modules) {
      const descriptor = this.trustedDescriptors.get(module.manifest.module_id);
      if (descriptor === undefined) continue;
      const actualToolNames = this.catalog
        .list()
        .filter((tool) => tool.module_id === module.manifest.module_id)
        .map((tool) => tool.name);
      assertExactStringSet(
        actualToolNames,
        descriptor.tool_names,
        "module_descriptor_tool_set_mismatch",
      );
      for (const contract of descriptor.tool_contracts) {
        const entry = this.catalog.get(contract.name);
        if (entry === undefined || entry.module_id !== module.manifest.module_id) {
          throw new ModuleRuntimeError(
            "module_descriptor_tool_contract_mismatch",
            `The reviewed tool contract is not mounted: ${contract.name}.`,
          );
        }
        assertReviewedToolContractMatchesCatalogEntry(contract, entry);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    if (this._status === "closed") return;
    this._status = "closing";
    const errors: unknown[] = [];
    for (const { definition } of [...this.leases].reverse()) {
      try {
        await definition.unmount?.();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    try {
      await this.releaseLeases();
    } catch (error: unknown) {
      errors.push(error);
    }
    this._status = errors.length === 0 ? "closed" : "failed";
    if (errors.length > 0) {
      throw new ModuleRuntimeError("host_close_failed", "The module host could not close cleanly.", { cause: new AggregateError(errors) });
    }
  }

  private async releaseLeases(): Promise<void> {
    const errors: unknown[] = [];
    for (const { lease } of [...this.leases].reverse()) {
      try {
        await lease.close();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    this.leases.length = 0;
    if (errors.length > 0) {
      throw new ModuleRuntimeError("lease_close_failed", "Module registrations could not be released.", { cause: new AggregateError(errors) });
    }
  }

  private releaseLeasesSync(): void {
    const errors: unknown[] = [];
    for (const { lease } of [...this.leases].reverse()) {
      try {
        lease.closeSync();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    this.leases.length = 0;
    if (errors.length > 0) {
      throw new ModuleRuntimeError("lease_close_failed", "Module registrations could not be released.", { cause: new AggregateError(errors) });
    }
  }

  snapshot(): ModuleHostSnapshot {
    return {
      status: this._status,
      modules: this.modules.map((module) => {
        const descriptor = this.trustedDescriptors.get(module.manifest.module_id);
        return {
          module_id: module.manifest.module_id,
          version: module.manifest.version,
          risk_level: module.manifest.risk_level,
          mounted: this.leases.some((entry) => entry.definition === module),
          tool_names: this.catalog
            .list()
            .filter((tool) => tool.module_id === module.manifest.module_id)
            .map((tool) => tool.name),
          ...(descriptor === undefined ? {} : { manifest_digest: descriptor.manifest_digest }),
        };
      }),
    };
  }
}
