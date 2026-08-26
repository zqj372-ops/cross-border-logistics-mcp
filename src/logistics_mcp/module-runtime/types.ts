import type { ZodType } from "zod";

import type {
  CalculationStep,
  EnvelopeData,
  EnvelopeStatus,
  Notice,
  ReviewStatus,
  SourceRef,
} from "../platform/envelope";
import type { ExecutionContext } from "../platform/context";
import type {
  CapabilityRegistry,
  CapabilityRequirementInput,
  CapabilityView,
} from "./capabilities";
import type { ModuleCatalog } from "./catalog";
import type { RegistrationLease } from "./lease";

export type ModuleRiskLevel = "T0" | "T1" | "T2" | "T3";

export interface ModuleManifest {
  readonly module_id: string;
  readonly version: string;
  readonly risk_level: ModuleRiskLevel;
  readonly required_capabilities: readonly CapabilityRequirementInput[];
  readonly optional_capabilities: readonly CapabilityRequirementInput[];
  readonly standard_ids: readonly string[];
  readonly lifecycle: "static";
}

export interface ModuleToolOutcome {
  readonly status: EnvelopeStatus;
  readonly data: EnvelopeData;
  readonly sourceRefs?: readonly SourceRef[];
  readonly assumptions?: readonly Notice[];
  readonly warnings?: readonly Notice[];
  readonly blockers?: readonly Notice[];
  readonly calculationTrace?: readonly CalculationStep[];
  readonly reviewStatus?: ReviewStatus;
}

export type ModuleToolHandler = (
  input: unknown,
  context: ExecutionContext,
  signal?: AbortSignal,
) => ModuleToolOutcome | Promise<ModuleToolOutcome>;

export interface ModuleToolContract {
  readonly inputSchema: ZodType;
  readonly validateOutput: (data: EnvelopeData) => void;
  readonly outputSchema?: ZodType;
}

export interface ModuleToolContribution {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly permission: string;
  readonly kind: "read" | "write";
  readonly idempotentHint?: boolean;
  readonly riskLevel: ModuleRiskLevel;
  readonly standardRefs: readonly string[];
  readonly handler: ModuleToolHandler;
  readonly inputSchema: ZodType;
  readonly validateOutput: (data: EnvelopeData) => void;
  readonly outputSchema?: ZodType;
}

export interface ModuleToolRegistrar {
  register(contribution: ModuleToolContribution): void;
}

export interface ModuleMountContext {
  readonly capabilities: CapabilityView;
  readonly tools: ModuleToolRegistrar;
  readonly lease: RegistrationLease;
}

export interface ModuleDefinition {
  readonly manifest: ModuleManifest;
  readonly mount: (context: ModuleMountContext) => void | Promise<void>;
  readonly unmount?: () => void | Promise<void>;
}

export interface ModuleCatalogEntry extends ModuleToolContribution {
  readonly module_id: string;
  readonly module_version: string;
}

export interface ModuleHostOptions {
  readonly capabilities: CapabilityRegistry;
  readonly modules: readonly ModuleDefinition[];
}

export type ModuleHostStatus = "created" | "mounting" | "mounted" | "closing" | "closed" | "failed";

export interface ModuleHostSnapshot {
  readonly status: ModuleHostStatus;
  readonly modules: readonly {
    readonly module_id: string;
    readonly version: string;
    readonly risk_level: ModuleRiskLevel;
    readonly mounted: boolean;
    readonly tool_names: readonly string[];
  }[];
}

export type { ModuleCatalog };
