import {
  MemoryAuditRepository,
  type AuditRepository,
} from "./audit";
import {
  MemoryIdempotencyRepository,
  type IdempotencyRepository,
} from "./idempotency";
import type {
  SessionRuntimeHandle,
  SessionRuntimeRegistryOptions,
} from "./session-runtime";
import { SessionRuntimeRegistry } from "./session-runtime";
import type { McpTransportMode } from "./transport-mode";

export interface DependencyHealth {
  readonly ready: boolean;
}

export interface DurableDependency {
  readonly durability: "durable";
  health(): Promise<DependencyHealth>;
  close(): Promise<void>;
}

export type DurableAuditRepository = AuditRepository & DurableDependency;
export type DurableIdempotencyRepository = IdempotencyRepository & DurableDependency;

export interface SessionBinding {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly clientId: string;
  readonly authSessionId: string;
  readonly contextFingerprint: string;
  readonly ownerId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

/**
 * Metadata-only sticky-owner binding. It must never receive an SDK server or
 * transport; those objects are process-local and cannot be serialized safely.
 */
export interface SessionBindingStore {
  get(sessionId: string): Promise<SessionBinding | null>;
  put(binding: SessionBinding): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export type DurableSessionBindingStore = SessionBindingStore & DurableDependency;

export type PlatformConfigurationErrorCode =
  | "platform_dependency_missing"
  | "platform_dependency_not_durable"
  | "platform_dependency_lifecycle_invalid";

export class PlatformConfigurationError extends Error {
  readonly code: PlatformConfigurationErrorCode;

  constructor(
    code: PlatformConfigurationErrorCode,
    readonly dependency: string,
  ) {
    super(`The ${dependency} platform dependency is not configured for production.`);
    this.name = "PlatformConfigurationError";
    this.code = code;
  }
}

export type PlatformReasonCode =
  | "platform_audit_repository_missing"
  | "platform_audit_repository_not_durable"
  | "platform_audit_repository_lifecycle_invalid"
  | "platform_audit_repository_unhealthy"
  | "platform_idempotency_repository_missing"
  | "platform_idempotency_repository_not_durable"
  | "platform_idempotency_repository_lifecycle_invalid"
  | "platform_idempotency_repository_unhealthy"
  | "platform_session_binding_store_missing"
  | "platform_session_binding_store_not_durable"
  | "platform_session_binding_store_lifecycle_invalid"
  | "platform_session_binding_store_unhealthy";

export interface FixturePlatformDependencies {
  readonly auditRepository: AuditRepository;
  readonly idempotencyRepository: IdempotencyRepository;
  readonly sessionRegistry: SessionRuntimeRegistry<SessionRuntimeHandle>;
}

export interface FixturePlatformDependencyOptions {
  readonly auditRepository?: AuditRepository;
  readonly idempotencyRepository?: IdempotencyRepository;
  readonly sessionRegistry?: SessionRuntimeRegistry<SessionRuntimeHandle>;
  readonly sessionRegistryOptions?: SessionRuntimeRegistryOptions;
}

export const DEFAULT_FIXTURE_SESSION_RUNTIME_LIMITS = {
  idleTtlMs: 5 * 60 * 1000,
  maxLifetimeMs: 15 * 60 * 1000,
  maxTokenLifetimeMs: 15 * 60 * 1000,
  maxSessions: 256,
} as const satisfies SessionRuntimeRegistryOptions;

export function createFixturePlatformDependencies(
  options: FixturePlatformDependencyOptions = {},
): FixturePlatformDependencies {
  return {
    auditRepository: options.auditRepository ?? new MemoryAuditRepository(),
    idempotencyRepository:
      options.idempotencyRepository ?? new MemoryIdempotencyRepository(),
    sessionRegistry:
      options.sessionRegistry ??
      new SessionRuntimeRegistry(
        options.sessionRegistryOptions ?? DEFAULT_FIXTURE_SESSION_RUNTIME_LIMITS,
      ),
  };
}

interface DependencyInspection<T extends DurableDependency> {
  readonly dependency: T | null;
  readonly error: PlatformConfigurationError | null;
  readonly reasonCode: PlatformReasonCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inspectDependency<T extends DurableDependency>(
  dependencyName: string,
  value: T | undefined,
): DependencyInspection<T> {
  const prefix = `platform_${dependencyName}` as const;
  if (value === undefined) {
    return {
      dependency: null,
      error: new PlatformConfigurationError(
        "platform_dependency_missing",
        dependencyName,
      ),
      reasonCode: `${prefix}_missing` as PlatformReasonCode,
    };
  }
  const isMemoryImplementation =
    (dependencyName === "audit_repository" && value instanceof MemoryAuditRepository) ||
    (dependencyName === "idempotency_repository" &&
      value instanceof MemoryIdempotencyRepository);
  if (
    !isRecord(value) ||
    value.durability !== "durable" ||
    isMemoryImplementation
  ) {
    return {
      dependency: null,
      error: new PlatformConfigurationError(
        "platform_dependency_not_durable",
        dependencyName,
      ),
      reasonCode: `${prefix}_not_durable` as PlatformReasonCode,
    };
  }
  if (typeof value.health !== "function" || typeof value.close !== "function") {
    return {
      dependency: null,
      error: new PlatformConfigurationError(
        "platform_dependency_lifecycle_invalid",
        dependencyName,
      ),
      reasonCode: `${prefix}_lifecycle_invalid` as PlatformReasonCode,
    };
  }
  return { dependency: value, error: null, reasonCode: `${prefix}_unhealthy` as PlatformReasonCode };
}

export interface ProductionPlatformDependencyOptions {
  readonly transportMode?: McpTransportMode;
  readonly auditRepository?: DurableAuditRepository;
  readonly idempotencyRepository?: DurableIdempotencyRepository;
  readonly sessionBindingStore?: DurableSessionBindingStore;
  readonly sessionRegistry?: SessionRuntimeRegistry<SessionRuntimeHandle>;
  readonly sessionRegistryOptions?: SessionRuntimeRegistryOptions;
}

export interface ProductionPlatformDependencies {
  readonly auditRepository: DurableAuditRepository;
  readonly idempotencyRepository: DurableIdempotencyRepository;
  readonly sessionBindingStore?: DurableSessionBindingStore;
  readonly sessionRegistry?: SessionRuntimeRegistry<SessionRuntimeHandle>;
}

export interface PlatformReadiness {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

export interface ProductionPlatformAssembly {
  readonly status: "available" | "unavailable";
  readonly reasonCodes: readonly PlatformReasonCode[];
  readonly errors: readonly PlatformConfigurationError[];
  readonly dependencies?: ProductionPlatformDependencies;
  readiness(): Promise<PlatformReadiness>;
  close(): Promise<void>;
}

export function createProductionPlatformAssembly(
  options: ProductionPlatformDependencyOptions,
): ProductionPlatformAssembly {
  const transportMode = options.transportMode ?? "stateful";
  const requiredChecks = [
    inspectDependency("audit_repository", options.auditRepository),
    inspectDependency("idempotency_repository", options.idempotencyRepository),
  ];
  const sessionCheck = transportMode === "stateful"
    ? inspectDependency("session_binding_store", options.sessionBindingStore)
    : null;
  const checks = sessionCheck === null
    ? requiredChecks
    : [...requiredChecks, sessionCheck];
  const reasonCodes = checks.map((check) => check.reasonCode);
  const errors = checks.flatMap((check) =>
    check.error === null ? [] : [check.error],
  );
  if (errors.length > 0) {
    return {
      status: "unavailable",
      reasonCodes,
      errors,
      readiness: () => Promise.resolve({ ready: false, reasons: reasonCodes }),
      close: () => Promise.resolve(),
    };
  }

  const auditRepository = checks[0]!.dependency as DurableAuditRepository;
  const idempotencyRepository = checks[1]!.dependency as DurableIdempotencyRepository;
  const sessionBindingStore = sessionCheck?.dependency ?? undefined;
  const sessionRegistry = transportMode === "stateful"
    ? options.sessionRegistry ?? new SessionRuntimeRegistry(
        options.sessionRegistryOptions ?? DEFAULT_FIXTURE_SESSION_RUNTIME_LIMITS,
      )
    : undefined;
  const dependencies: ProductionPlatformDependencies = {
    auditRepository,
    idempotencyRepository,
    ...(sessionBindingStore === undefined ? {} : { sessionBindingStore }),
    ...(sessionRegistry === undefined ? {} : { sessionRegistry }),
  };

  return {
    status: "available",
    reasonCodes: [],
    errors: [],
    dependencies,
    readiness: async () => {
      const healthChecks = [
        ["platform_audit_repository_unhealthy", auditRepository] as const,
        ["platform_idempotency_repository_unhealthy", idempotencyRepository] as const,
        ...(sessionBindingStore === undefined
          ? []
          : [["platform_session_binding_store_unhealthy", sessionBindingStore] as const]),
      ];
      const uniqueDependencies = new Map<DurableDependency, string[]>();
      for (const [reason, dependency] of healthChecks) {
        const reasons = uniqueDependencies.get(dependency) ?? [];
        reasons.push(reason);
        uniqueDependencies.set(dependency, reasons);
      }
      const results = await Promise.all(
        [...uniqueDependencies].map(async ([dependency, dependencyReasons]) => {
          try {
            return (await dependency.health()).ready ? [] : dependencyReasons;
          } catch {
            return dependencyReasons;
          }
        }),
      );
      const reasons = results.flat();
      return { ready: reasons.length === 0, reasons };
    },
    close: async () => {
      const dependencies = new Set<DurableDependency>([
        auditRepository,
        idempotencyRepository,
        ...(sessionBindingStore === undefined ? [] : [sessionBindingStore]),
      ]);
      const results = await Promise.allSettled([
        ...(sessionRegistry === undefined ? [] : [sessionRegistry.close()]),
        ...[...dependencies].map((dependency) => dependency.close()),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("A production platform dependency could not be closed.");
      }
    },
  };
}
