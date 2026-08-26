export declare const CONTROL_SCHEMA_VERSION: "2026-08-22.v1";

export type ControlRecord = Readonly<Record<string, unknown>>;

export type RegisterPackagePayload = Readonly<{
  schema_version: typeof CONTROL_SCHEMA_VERSION;
  module_id: string;
  version: string;
  descriptor_digest: string;
}>;

export type ControlModuleRef = Readonly<{
  module_id: string;
  version: string;
  descriptor_digest: string;
}>;

export type ChangePreviewPayload = Readonly<{
  schema_version: typeof CONTROL_SCHEMA_VERSION;
  intent: "change";
  desired_modules: readonly ControlModuleRef[];
}>;

export type RollbackPreviewPayload = Readonly<{
  schema_version: typeof CONTROL_SCHEMA_VERSION;
  intent: "rollback";
  target_release_id: string;
}>;

export type PreviewPayload = ChangePreviewPayload | RollbackPreviewPayload;

export type ApprovalPayload = Readonly<{
  schema_version: typeof CONTROL_SCHEMA_VERSION;
  preview_ref: string;
  decision: "approve" | "reject";
  reason_code: string;
}>;

export type PublishPayload = Readonly<{
  schema_version: typeof CONTROL_SCHEMA_VERSION;
  preview_ref: string;
  approval_id: string;
}>;

export type ReconcilePayload = Readonly<{
  schema_version: typeof CONTROL_SCHEMA_VERSION;
  release_id: string;
}>;

export type ControlRegistration = Readonly<{
  registered_by_actor_ref: string;
  registered_at: string;
}> | null;

export type InventoryModule = ControlModuleRef & Readonly<{
  risk_level: "T0" | "T1" | "T2" | "T3";
  evidence_level: "local_build";
  production_eligible: false;
  tool_names: readonly string[];
  standard_ids: readonly string[];
  registration: ControlRegistration;
}>;

export type ActiveActivation = Readonly<{
  state: "active";
  release_id: string;
  revision: number;
  active_modules: readonly ControlModuleRef[];
}>;

export type InactiveActivation = Readonly<{
  state: "inactive";
  release_id: null;
  revision: 0;
  active_modules: readonly [];
}>;

export type ControlActivation = ActiveActivation | InactiveActivation;

export type ControlState = Readonly<{
  kind: "control_state";
  activation: ControlActivation;
  inventory_modules: readonly InventoryModule[];
  latest_preview: ControlRecord | null;
  latest_approval: ControlRecord | null;
  latest_readback: ControlRecord | null;
  release_history: readonly ControlRecord[];
  events: readonly ControlRecord[];
  events_truncated: boolean;
}>;

export type ReleaseStageStatus =
  | "complete"
  | "empty"
  | "pending"
  | "blocked"
  | "manual_review"
  | "unavailable";

export type ReleaseStage = Readonly<{
  key: string;
  label: string;
  status: ReleaseStageStatus;
}>;

export type DesiredDraftDiff = Readonly<{
  added: readonly ControlModuleRef[];
  removed: readonly ControlModuleRef[];
  retained: readonly ControlModuleRef[];
}>;

export type ActionAvailabilityInput = Readonly<{
  state: ControlState;
  draftModules: readonly ControlModuleRef[];
  actorRole: string;
  actorRef?: string;
  creatorActorRef?: string;
  environment?: string;
}>;

export type ActionAvailability = Readonly<{
  saveDraft: boolean;
  register: boolean;
  generatePreview: boolean;
  submitApproval: boolean;
  publish: boolean;
  reconcile: boolean;
  rollback: boolean;
}>;

export declare function validateControlState(value: unknown): ControlState;

export declare function abbreviateDigest(
  value: unknown,
  visiblePrefix?: number,
  visibleSuffix?: number,
): string;

export declare function redactReference(value: unknown, fallback?: string): string;

export declare function deriveReleaseStages(state: ControlState): readonly ReleaseStage[];

export declare function deriveDesiredDraftDiff(
  currentModules: readonly ControlModuleRef[],
  desiredModules: readonly ControlModuleRef[],
): DesiredDraftDiff;

export declare function isFixtureIdentityVisible(search?: unknown): boolean;

export type FixtureIdentity = Readonly<{
  actor: string;
  label: string;
  role: "admin";
  token: string;
}>;

export declare const FIXTURE_IDENTITIES: readonly FixtureIdentity[];

export type ControlPlaneErrorOptions = Readonly<{
  status?: string;
  reasonCodes?: readonly unknown[];
  data?: unknown;
}>;

export declare class ControlPlaneError extends Error {
  readonly status: string;
  readonly reasonCodes: readonly string[];
  readonly data: unknown;

  constructor(message: string, options?: ControlPlaneErrorOptions);
}

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

export type ControlPlaneClientOptions = Readonly<{
  fetchImpl?: FetchImplementation;
  basePath?: string;
}>;

export interface ControlPlaneClient {
  setToken(token: string): void;
  clearToken(): void;
  getControlState(): Promise<ControlState>;
  registerPackage(payload: RegisterPackagePayload, idempotencyKey?: string): Promise<unknown>;
  createPreview(payload: PreviewPayload, idempotencyKey?: string): Promise<unknown>;
  decideApproval(payload: ApprovalPayload, idempotencyKey?: string): Promise<unknown>;
  publish(payload: PublishPayload, idempotencyKey?: string): Promise<unknown>;
  reconcile(payload: ReconcilePayload, idempotencyKey?: string): Promise<unknown>;
}

export declare function actionAvailability(input: ActionAvailabilityInput): ActionAvailability;

export declare function createControlPlaneClient(
  options?: ControlPlaneClientOptions,
): ControlPlaneClient;
