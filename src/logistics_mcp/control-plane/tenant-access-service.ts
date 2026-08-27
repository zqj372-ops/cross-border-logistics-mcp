import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

import type { AuthClaims, ExecutionContext } from "../platform/context";
import { isTrustedExecutionContext } from "../platform/context";
import {
  acknowledgeCredentialDeliveryRequestSchema,
  createTenantRequestSchema,
  issueCredentialRequestSchema,
  revokeCredentialRequestSchema,
  rotateCredentialRequestSchema,
  setClientStatusRequestSchema,
  setTenantStatusRequestSchema,
  TENANT_ACCESS_SCHEMA_VERSION,
  TENANT_API_KEY_TOOL_CATALOG,
  TENANT_API_KEY_TOOL_NAMES,
  tenantApiKeyScopesForToolNames,
  tenantApiKeyToolNamesForScopes,
  type TenantAccessClientAction,
  type TenantAccessCredentialAction,
  type TenantAccessOperationAction,
  type TenantAccessOperationState,
  type TenantAccessTenantAction,
  type TenantApiKeyToolName,
} from "./tenant-access-contracts";
import { TenantAccessError } from "./tenant-access-errors";
import type {
  ClientRecord,
  StoredCredentialRecord,
  TenantAccessEventRecord,
  TenantAccessRepository,
  TenantAccessStateRecord,
  TenantRecord,
} from "./tenant-access-repository";
import { TenantAccessRepositoryError } from "./tenant-access-repository";

export { TENANT_ACCESS_SCHEMA_VERSION } from "./tenant-access-contracts";
export { TenantAccessError } from "./tenant-access-errors";

const API_KEY_PATTERN = /^lmcpk_([A-Za-z0-9][A-Za-z0-9._:-]{0,127})_([A-Za-z0-9_-]{43})$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
const allowedToolNames = new Set<string>(TENANT_API_KEY_TOOL_NAMES);

export interface TenantAccessServiceOptions {
  readonly clock?: () => number;
  readonly idGenerator?: (prefix: "event" | "key") => string;
  readonly secretGenerator?: () => string;
  readonly saltGenerator?: () => Uint8Array;
  readonly credentialSecretProvider?: TenantCredentialSecretProvider;
}

export interface TenantCredentialSecretProvider {
  hash(secret: string, salt: Uint8Array): Promise<Uint8Array>;
  verify(secret: string, salt: Uint8Array, expectedHash: Uint8Array): Promise<boolean>;
}

type TenantDto = Readonly<{
  tenant_id: string;
  display_name: string;
  status: "active" | "suspended";
  created_at: string;
  updated_at: string;
  allowed_actions: readonly TenantAccessTenantAction[];
}>;

type ClientDto = Readonly<{
  client_id: string;
  tenant_id: string;
  label: string;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
  allowed_actions: readonly TenantAccessClientAction[];
}>;

type CredentialDto = Readonly<{
  credential_id: string;
  tenant_id: string;
  client_id: string;
  label: string;
  actor_role: "service";
  roles: readonly ["service"];
  tool_names: readonly TenantApiKeyToolName[];
  status: "active" | "expired" | "revoked";
  delivery_status: "pending" | "acknowledged";
  delivery_acknowledged_at: string | null;
  effective_status: "pending_delivery" | "active" | "tenant_suspended" | "client_disabled" | "expired" | "revoked";
  allowed_actions: readonly TenantAccessCredentialAction[];
  key_prefix: string;
  secret_last_four: string;
  created_at: string;
  expires_at: number;
  last_used_at: string | null;
  revoked_at: string | null;
  rotated_from_id: string | null;
}>;

type OperationDto = Readonly<{
  operation_id: string;
  tenant_id: string;
  client_id: string | null;
  credential_id: string | null;
  actor_ref: string;
  action: TenantAccessOperationAction;
  from_status: TenantAccessOperationState;
  to_status: TenantAccessOperationState;
  status: "success";
  reason_code: string;
  created_at: string;
}>;

type WriteResponse<T> = Readonly<{
  schema_version: typeof TENANT_ACCESS_SCHEMA_VERSION;
  status: "success";
  replayed: boolean;
  data: T;
  reason_codes: readonly string[];
}>;

type SecretWriteResponse = Readonly<{
  schema_version: typeof TENANT_ACCESS_SCHEMA_VERSION;
  status: "success" | "manual_review";
  replayed: boolean;
  secret_delivery: Readonly<{
    status: "one_time" | "withheld";
    credential_id: string;
  }>;
  data: Readonly<{
    credential: CredentialDto;
    api_key: string | null;
    operation: OperationDto;
  }>;
  reason_codes: readonly string[];
}>;

function requestError(): never {
  throw new TenantAccessError("invalid_request");
}

function parseRequest<T>(
  schema: { readonly safeParse: (input: unknown) => { success: true; data: T } | { success: false } },
  input: unknown,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) requestError();
  return parsed.data;
}

function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    requestError();
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) requestError();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ));
    return `{${entries.join(",")}}`;
  }
  requestError();
}

function canonicalHash(value: unknown): string {
  return `sha256:v1:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalToolNames(
  toolNames: readonly TenantApiKeyToolName[],
): readonly TenantApiKeyToolName[] {
  return Object.freeze([...toolNames].sort());
}

function timestamp(nowSeconds: number): string {
  return new Date(nowSeconds * 1_000).toISOString();
}

function tenantDto(value: TenantRecord): TenantDto {
  return Object.freeze({
    tenant_id: value.tenantId,
    display_name: value.displayName,
    status: value.status,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
    allowed_actions: Object.freeze([
      value.status === "active" ? "suspend" : "activate",
    ] as const),
  });
}

function clientDto(value: ClientRecord): ClientDto {
  return Object.freeze({
    client_id: value.clientId,
    tenant_id: value.tenantId,
    label: value.label,
    status: value.status,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
    allowed_actions: Object.freeze([
      value.status === "active" ? "disable" : "enable",
    ] as const),
  });
}

function deliveryAcknowledgedAt(
  credentialId: string,
  acknowledgements: Readonly<Record<string, string>>,
): string | null {
  return acknowledgements[credentialId] ?? null;
}

function credentialDto(
  value: StoredCredentialRecord,
  nowSeconds: number,
  tenantStatus: TenantRecord["status"],
  clientStatus: ClientRecord["status"],
  acknowledgements: Readonly<Record<string, string>>,
): CredentialDto {
  const status = value.status === "active" && value.expiresAt <= nowSeconds
    ? "expired"
    : value.status;
  const acknowledgedAt = deliveryAcknowledgedAt(value.credentialId, acknowledgements);
  const deliveryStatus = acknowledgedAt === null ? "pending" : "acknowledged";
  const effectiveStatus = status === "revoked"
    ? "revoked"
    : status === "expired"
      ? "expired"
      : tenantStatus === "suspended"
          ? "tenant_suspended"
          : clientStatus === "disabled"
            ? "client_disabled"
            : deliveryStatus === "pending"
              ? "pending_delivery"
              : "active";
  const allowedActions: TenantAccessCredentialAction[] = [];
  if (status === "active") {
    if (deliveryStatus === "pending" && clientStatus === "active") {
      allowedActions.push("acknowledge_delivery");
    }
    if (
      deliveryStatus === "acknowledged" &&
      tenantStatus === "active" &&
      clientStatus === "active"
    ) {
      allowedActions.push("rotate");
    }
    allowedActions.push("revoke");
  }
  return Object.freeze({
    credential_id: value.credentialId,
    tenant_id: value.tenantId,
    client_id: value.clientId,
    label: value.label,
    actor_role: value.actorRole,
    roles: value.roles,
    tool_names: tenantApiKeyToolNamesForScopes(value.scopes),
    status,
    delivery_status: deliveryStatus,
    delivery_acknowledged_at: acknowledgedAt,
    effective_status: effectiveStatus,
    allowed_actions: Object.freeze(allowedActions),
    key_prefix: value.keyPrefix,
    secret_last_four: value.secretLastFour,
    created_at: value.createdAt,
    expires_at: value.expiresAt,
    last_used_at: value.lastUsedAt,
    revoked_at: value.revokedAt,
    rotated_from_id: value.rotatedFromId,
  });
}

function operationTransition(
  value: TenantAccessEventRecord,
  acknowledgements: Readonly<Record<string, string>>,
): readonly [TenantAccessOperationAction, TenantAccessOperationState, TenantAccessOperationState] {
  switch (value.action) {
    case "tenant.created":
      return ["tenant.create", "absent", "active"];
    case "tenant.active":
      return ["tenant.activate", "suspended", "active"];
    case "tenant.suspended":
      return ["tenant.suspend", "active", "suspended"];
    case "client.created":
      return ["client.create", "absent", "active"];
    case "client.active":
      return ["client.enable", "disabled", "active"];
    case "client.disabled":
      return ["client.disable", "active", "disabled"];
    case "credential.issued":
      return ["credential.issue", "absent", "pending_delivery"];
    case "credential.delivery_acknowledged":
      return ["credential.delivery_acknowledge", "pending_delivery", "active"];
    case "credential.rotated":
      return ["credential.rotate", "active", "pending_delivery"];
    case "credential.revoked": {
      const acknowledged = value.credentialId !== null
        && deliveryAcknowledgedAt(value.credentialId, acknowledgements) !== null;
      return ["credential.revoke", acknowledged ? "active" : "pending_delivery", "revoked"];
    }
    default:
      throw new TenantAccessError("schema_mismatch");
  }
}

function operationDto(
  value: TenantAccessEventRecord,
  acknowledgements: Readonly<Record<string, string>>,
): OperationDto {
  const [action, fromStatus, toStatus] = operationTransition(value, acknowledgements);
  return Object.freeze({
    operation_id: value.eventId,
    tenant_id: value.tenantId,
    client_id: value.clientId,
    credential_id: value.credentialId,
    actor_ref: value.actorRef,
    action,
    from_status: fromStatus,
    to_status: toStatus,
    status: "success",
    reason_code: value.reasonCode,
    created_at: value.createdAt,
  });
}

function mapRepositoryError(error: unknown): never {
  if (!(error instanceof TenantAccessRepositoryError)) throw error;
  switch (error.code) {
    case "closed":
      throw new TenantAccessError("closed", { cause: error });
    case "credential_delivery_acknowledged":
      throw new TenantAccessError("credential_delivery_acknowledged", { cause: error });
    case "credential_delivery_pending":
      throw new TenantAccessError("credential_delivery_pending", { cause: error });
    case "credential_expired":
      throw new TenantAccessError("credential_expired", { cause: error });
    case "credential_not_active":
      throw new TenantAccessError("credential_not_active", { cause: error });
    case "credential_not_found":
      throw new TenantAccessError("credential_not_found", { cause: error });
    case "client_not_active":
      throw new TenantAccessError("client_not_active", { cause: error });
    case "client_not_found":
      throw new TenantAccessError("client_not_found", { cause: error });
    case "client_status_unchanged":
      throw new TenantAccessError("client_status_unchanged", { cause: error });
    case "idempotency_conflict":
      throw new TenantAccessError("idempotency_conflict", { cause: error });
    case "tenant_already_exists":
      throw new TenantAccessError("tenant_already_exists", { cause: error });
    case "tenant_not_active":
      throw new TenantAccessError("tenant_not_active", { cause: error });
    case "tenant_not_found":
      throw new TenantAccessError("tenant_not_found", { cause: error });
    case "tenant_status_unchanged":
      throw new TenantAccessError("tenant_status_unchanged", { cause: error });
    case "corrupt":
    case "path_invalid":
    case "schema_unsupported":
      throw new TenantAccessError("schema_mismatch", { cause: error });
  }
}

function assertAdmin(context: ExecutionContext, managementTenantId: string): void {
  if (!isTrustedExecutionContext(context)) {
    throw new TenantAccessError("authentication_failed");
  }
  if (context.tenantId !== managementTenantId) {
    throw new TenantAccessError("management_tenant_mismatch");
  }
  if (context.role !== "admin" || !context.roles.includes("admin")) {
    throw new TenantAccessError("admin_role_required");
  }
  if (!context.scopes.includes("platform:admin")) {
    throw new TenantAccessError("platform_admin_scope_required");
  }
  if (!context.scopes.includes("tenant:admin")) {
    throw new TenantAccessError("tenant_admin_scope_required");
  }
}

function inspectRequestedToolNames(input: unknown): void {
  if (typeof input !== "object" || input === null || !("tool_names" in input)) return;
  const toolNames = (input as { readonly tool_names?: unknown }).tool_names;
  if (Array.isArray(toolNames) && toolNames.some((toolName) => (
    typeof toolName === "string" && !allowedToolNames.has(toolName)
  ))) {
    throw new TenantAccessError("scope_not_allowed");
  }
}

async function deriveSecret(secret: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, value) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(new Uint8Array(value));
    });
  });
}

const DEFAULT_CREDENTIAL_SECRET_PROVIDER: TenantCredentialSecretProvider = Object.freeze({
  hash: deriveSecret,
  async verify(secret: string, salt: Uint8Array, expectedHash: Uint8Array) {
    const candidate = await deriveSecret(secret, salt);
    return candidate.byteLength === expectedHash.byteLength &&
      timingSafeEqual(candidate, expectedHash);
  },
});

function createEvent(
  idGenerator: (prefix: "event" | "key") => string,
  context: ExecutionContext,
  now: string,
  values: Omit<TenantAccessEventRecord, "eventId" | "actorRef" | "createdAt">,
): TenantAccessEventRecord {
  return Object.freeze({
    eventId: idGenerator("event"),
    tenantId: values.tenantId,
    clientId: values.clientId,
    credentialId: values.credentialId,
    actorRef: `${context.actorId}:${context.clientId}`,
    action: values.action,
    reasonCode: values.reasonCode,
    createdAt: now,
  });
}

export class TenantAccessService {
  readonly #repository: TenantAccessRepository;
  readonly #clock: () => number;
  readonly #idGenerator: (prefix: "event" | "key") => string;
  readonly #secretGenerator: () => string;
  readonly #saltGenerator: () => Uint8Array;
  readonly #credentialSecretProvider: TenantCredentialSecretProvider;

  constructor(
    repository: TenantAccessRepository,
    options: TenantAccessServiceOptions = {},
  ) {
    this.#repository = repository;
    this.#clock = options.clock ?? (() => Math.floor(Date.now() / 1_000));
    this.#idGenerator = options.idGenerator ?? ((prefix) => (
      `${prefix}_${randomUUID().replaceAll("-", "")}`
    ));
    this.#secretGenerator = options.secretGenerator ?? (() => randomBytes(32).toString("base64url"));
    this.#saltGenerator = options.saltGenerator ?? (() => randomBytes(16));
    this.#credentialSecretProvider = options.credentialSecretProvider ??
      DEFAULT_CREDENTIAL_SECRET_PROVIDER;
  }

  async getState(context: ExecutionContext): Promise<Readonly<{
    schema_version: typeof TENANT_ACCESS_SCHEMA_VERSION;
    status: "success";
    data: Readonly<{
      tenants: readonly TenantDto[];
      clients: readonly ClientDto[];
      available_tools: typeof TENANT_API_KEY_TOOL_CATALOG;
      credentials: readonly CredentialDto[];
      operations: readonly OperationDto[];
    }>;
    reason_codes: readonly string[];
  }>> {
    assertAdmin(context, this.#repository.managementTenantId);
    let state: TenantAccessStateRecord;
    try {
      state = await this.#repository.getState();
    } catch (error) {
      mapRepositoryError(error);
    }
    const now = this.#clock();
    const tenantsById = new Map(state.tenants.map((tenant) => [tenant.tenantId, tenant]));
    const clientsById = new Map(state.clients.map((client) => [
      `${client.tenantId}\u0000${client.clientId}`,
      client,
    ]));
    return Object.freeze({
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      status: "success",
      data: Object.freeze({
        available_tools: TENANT_API_KEY_TOOL_CATALOG,
        tenants: Object.freeze(state.tenants.map(tenantDto)),
        clients: Object.freeze(state.clients.map(clientDto)),
        credentials: Object.freeze(state.credentials.map((value) => {
          const tenant = tenantsById.get(value.tenantId);
          const client = clientsById.get(`${value.tenantId}\u0000${value.clientId}`);
          if (tenant === undefined || client === undefined) {
            throw new TenantAccessError("schema_mismatch");
          }
          return credentialDto(
            value,
            now,
            tenant.status,
            client.status,
            state.deliveryAcknowledgements,
          );
        })),
        operations: Object.freeze(state.events.map((event) => (
          operationDto(event, state.deliveryAcknowledgements)
        ))),
      }),
      reason_codes: Object.freeze([]),
    });
  }

  async createTenant(
    context: ExecutionContext,
    input: unknown,
    rawIdempotencyKey: string,
  ): Promise<WriteResponse<Readonly<{ tenant: TenantDto; operation: OperationDto }>>> {
    assertAdmin(context, this.#repository.managementTenantId);
    const request = parseRequest(createTenantRequestSchema, input);
    if (request.tenant_id === this.#repository.managementTenantId) {
      throw new TenantAccessError("management_tenant_forbidden");
    }
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const now = timestamp(this.#clock());
    const tenant: TenantRecord = Object.freeze({
      tenantId: request.tenant_id,
      displayName: request.display_name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const event = createEvent(this.#idGenerator, context, now, {
      tenantId: tenant.tenantId,
      clientId: null,
      credentialId: null,
      action: "tenant.created",
      reasonCode: "operator_created",
    });
    try {
      const result = await this.#repository.createTenant({
        tenant,
        event,
        idempotencyKey,
        requestHash: canonicalHash({ action: "tenant.create", actor: context.actorId, request }),
      });
      return Object.freeze({
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "success",
        replayed: result.replayed,
        data: Object.freeze({
          tenant: tenantDto(result.value),
          operation: operationDto(result.operation, Object.freeze({})),
        }),
        reason_codes: Object.freeze([]),
      });
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async setTenantStatus(
    context: ExecutionContext,
    tenantId: string,
    input: unknown,
    rawIdempotencyKey: string,
  ): Promise<WriteResponse<Readonly<{ tenant: TenantDto; operation: OperationDto }>>> {
    assertAdmin(context, this.#repository.managementTenantId);
    const request = parseRequest(setTenantStatusRequestSchema, input);
    if (tenantId === this.#repository.managementTenantId) {
      throw new TenantAccessError("management_tenant_forbidden");
    }
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const now = timestamp(this.#clock());
    const event = createEvent(this.#idGenerator, context, now, {
      tenantId,
      clientId: null,
      credentialId: null,
      action: `tenant.${request.status}`,
      reasonCode: request.reason_code,
    });
    try {
      const result = await this.#repository.setTenantStatus({
        tenantId,
        status: request.status,
        updatedAt: now,
        event,
        idempotencyKey,
        requestHash: canonicalHash({ action: "tenant.status", tenant_id: tenantId, actor: context.actorId, request }),
      });
      return Object.freeze({
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "success",
        replayed: result.replayed,
        data: Object.freeze({
          tenant: tenantDto(result.value),
          operation: operationDto(result.operation, Object.freeze({})),
        }),
        reason_codes: Object.freeze([]),
      });
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async setClientStatus(
    context: ExecutionContext,
    tenantId: string,
    clientId: string,
    input: unknown,
    rawIdempotencyKey: string,
  ): Promise<WriteResponse<Readonly<{ client: ClientDto; operation: OperationDto }>>> {
    assertAdmin(context, this.#repository.managementTenantId);
    const request = parseRequest(setClientStatusRequestSchema, input);
    if (tenantId === this.#repository.managementTenantId) {
      throw new TenantAccessError("management_tenant_forbidden");
    }
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const now = timestamp(this.#clock());
    const event = createEvent(this.#idGenerator, context, now, {
      tenantId,
      clientId,
      credentialId: null,
      action: `client.${request.status}`,
      reasonCode: request.reason_code,
    });
    try {
      const result = await this.#repository.setClientStatus({
        tenantId,
        clientId,
        status: request.status,
        updatedAt: now,
        event,
        idempotencyKey,
        requestHash: canonicalHash({
          action: "client.status",
          tenant_id: tenantId,
          client_id: clientId,
          actor: context.actorId,
          request,
        }),
      });
      return Object.freeze({
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "success",
        replayed: result.replayed,
        data: Object.freeze({
          client: clientDto(result.value),
          operation: operationDto(result.operation, Object.freeze({})),
        }),
        reason_codes: Object.freeze([]),
      });
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async issueCredential(
    context: ExecutionContext,
    input: unknown,
    rawIdempotencyKey: string,
  ): Promise<SecretWriteResponse> {
    assertAdmin(context, this.#repository.managementTenantId);
    inspectRequestedToolNames(input);
    const request = parseRequest(issueCredentialRequestSchema, input);
    if (request.tenant_id === this.#repository.managementTenantId) {
      throw new TenantAccessError("management_tenant_forbidden");
    }
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const nowSeconds = this.#clock();
    const now = timestamp(nowSeconds);
    const credentialId = this.#idGenerator("key");
    const secret = this.#secretGenerator();
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) requestError();
    const salt = this.#saltGenerator();
    if (!(salt instanceof Uint8Array) || salt.byteLength < 16) requestError();
    const hash = await this.#credentialSecretProvider.hash(secret, salt);
    const toolNames = canonicalToolNames(request.tool_names);
    const scopes = tenantApiKeyScopesForToolNames(toolNames);
    const credential: StoredCredentialRecord = Object.freeze({
      credentialId,
      tenantId: request.tenant_id,
      clientId: request.client_id,
      label: request.label,
      actorRole: "service",
      roles: Object.freeze(["service"] as const),
      scopes,
      status: "active",
      keyPrefix: `lmcpk_${credentialId}`,
      secretLastFour: secret.slice(-4),
      secretSalt: new Uint8Array(salt),
      secretHash: hash,
      createdAt: now,
      expiresAt: nowSeconds + request.expires_in_seconds,
      lastUsedAt: null,
      revokedAt: null,
      rotatedFromId: null,
    });
    const event = createEvent(this.#idGenerator, context, now, {
      tenantId: credential.tenantId,
      clientId: credential.clientId,
      credentialId: credential.credentialId,
      action: "credential.issued",
      reasonCode: "operator_issued",
    });
    try {
      const result = await this.#repository.issueCredential({
        credential,
        event,
        idempotencyKey,
        requestHash: canonicalHash({
          action: "credential.issue",
          actor: context.actorId,
          request: { ...request, tool_names: toolNames },
        }),
      });
      const replayed = result.replayed;
      const replayState = replayed ? await this.#repository.getState() : null;
      const acknowledgements = replayState?.deliveryAcknowledgements ?? Object.freeze({});
      const tenantStatus = replayState?.tenants.find((tenant) => (
        tenant.tenantId === result.value.tenantId
      ))?.status ?? "active";
      const clientStatus = replayState?.clients.find((client) => (
        client.tenantId === result.value.tenantId && client.clientId === result.value.clientId
      ))?.status ?? "active";
      return Object.freeze({
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: replayed ? "manual_review" : "success",
        replayed,
        secret_delivery: Object.freeze({
          status: replayed ? "withheld" : "one_time",
          credential_id: result.value.credentialId,
        }),
        data: Object.freeze({
          credential: credentialDto(
            result.value,
            nowSeconds,
            tenantStatus,
            clientStatus,
            acknowledgements,
          ),
          api_key: replayed ? null : `lmcpk_${credentialId}_${secret}`,
          operation: operationDto(result.operation, acknowledgements),
        }),
        reason_codes: Object.freeze(replayed ? ["credential_secret.withheld"] : []),
      });
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async rotateCredential(
    context: ExecutionContext,
    credentialId: string,
    input: unknown,
    rawIdempotencyKey: string,
  ): Promise<SecretWriteResponse> {
    assertAdmin(context, this.#repository.managementTenantId);
    inspectRequestedToolNames(input);
    const request = parseRequest(rotateCredentialRequestSchema, input);
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    let state: TenantAccessStateRecord;
    try {
      state = await this.#repository.getState();
    } catch (error) {
      mapRepositoryError(error);
    }
    const previous = state.credentials.find((value) => value.credentialId === credentialId);
    if (previous === undefined) throw new TenantAccessError("credential_not_found");
    const nowSeconds = this.#clock();
    if (previous.expiresAt <= nowSeconds) throw new TenantAccessError("credential_expired");
    if (deliveryAcknowledgedAt(
      previous.credentialId,
      state.deliveryAcknowledgements,
    ) === null) {
      throw new TenantAccessError("credential_delivery_pending");
    }
    const now = timestamp(nowSeconds);
    const nextCredentialId = this.#idGenerator("key");
    const secret = this.#secretGenerator();
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) requestError();
    const salt = this.#saltGenerator();
    if (!(salt instanceof Uint8Array) || salt.byteLength < 16) requestError();
    const next: StoredCredentialRecord = Object.freeze({
      credentialId: nextCredentialId,
      tenantId: previous.tenantId,
      clientId: previous.clientId,
      label: previous.label,
      actorRole: "service",
      roles: Object.freeze(["service"] as const),
      scopes: tenantApiKeyScopesForToolNames(canonicalToolNames(request.tool_names)),
      status: "active",
      keyPrefix: `lmcpk_${nextCredentialId}`,
      secretLastFour: secret.slice(-4),
      secretSalt: new Uint8Array(salt),
      secretHash: await this.#credentialSecretProvider.hash(secret, salt),
      createdAt: now,
      expiresAt: nowSeconds + request.expires_in_seconds,
      lastUsedAt: null,
      revokedAt: null,
      rotatedFromId: previous.credentialId,
    });
    const event = createEvent(this.#idGenerator, context, now, {
      tenantId: next.tenantId,
      clientId: next.clientId,
      credentialId: next.credentialId,
      action: "credential.rotated",
      reasonCode: request.reason_code,
    });
    try {
      const result = await this.#repository.rotateCredential({
        previousCredentialId: credentialId,
        credential: next,
        revokedAt: now,
        nowSeconds,
        event,
        idempotencyKey,
        requestHash: canonicalHash({
          action: "credential.rotate",
          credential_id: credentialId,
          actor: context.actorId,
          request: {
            ...request,
            tool_names: canonicalToolNames(request.tool_names),
          },
        }),
      });
      const replayed = result.replayed;
      const tenant = state.tenants.find((value) => value.tenantId === result.value.tenantId);
      const client = state.clients.find((value) => (
        value.tenantId === result.value.tenantId && value.clientId === result.value.clientId
      ));
      if (tenant === undefined || client === undefined) {
        throw new TenantAccessError("schema_mismatch");
      }
      return Object.freeze({
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: replayed ? "manual_review" : "success",
        replayed,
        secret_delivery: Object.freeze({
          status: replayed ? "withheld" : "one_time",
          credential_id: result.value.credentialId,
        }),
        data: Object.freeze({
          credential: credentialDto(
            result.value,
            nowSeconds,
            tenant.status,
            client.status,
            state.deliveryAcknowledgements,
          ),
          api_key: replayed ? null : `lmcpk_${nextCredentialId}_${secret}`,
          operation: operationDto(result.operation, state.deliveryAcknowledgements),
        }),
        reason_codes: Object.freeze(replayed ? ["credential_secret.withheld"] : []),
      });
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async revokeCredential(
    context: ExecutionContext,
    credentialId: string,
    input: unknown,
    rawIdempotencyKey: string,
  ): Promise<WriteResponse<Readonly<{ credential: CredentialDto; operation: OperationDto }>>> {
    assertAdmin(context, this.#repository.managementTenantId);
    const request = parseRequest(revokeCredentialRequestSchema, input);
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const nowSeconds = this.#clock();
    const now = timestamp(nowSeconds);
    let state: TenantAccessStateRecord;
    try {
      state = await this.#repository.getState();
    } catch (error) {
      mapRepositoryError(error);
    }
    const existing = state.credentials.find((value) => value.credentialId === credentialId);
    if (existing === undefined) throw new TenantAccessError("credential_not_found");
    if (existing.expiresAt <= nowSeconds) throw new TenantAccessError("credential_expired");
    const event = createEvent(this.#idGenerator, context, now, {
      tenantId: existing.tenantId,
      clientId: existing.clientId,
      credentialId,
      action: "credential.revoked",
      reasonCode: request.reason_code,
    });
    try {
      const result = await this.#repository.revokeCredential({
        credentialId,
        revokedAt: now,
        nowSeconds,
        event,
        idempotencyKey,
        requestHash: canonicalHash({
          action: "credential.revoke",
          credential_id: credentialId,
          actor: context.actorId,
          request,
        }),
      });
      const tenant = state.tenants.find((value) => value.tenantId === result.value.tenantId);
      const client = state.clients.find((value) => (
        value.tenantId === result.value.tenantId && value.clientId === result.value.clientId
      ));
      if (tenant === undefined || client === undefined) {
        throw new TenantAccessError("schema_mismatch");
      }
      return Object.freeze({
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "success",
        replayed: result.replayed,
        data: Object.freeze({
          credential: credentialDto(
            result.value,
            nowSeconds,
            tenant.status,
            client.status,
            state.deliveryAcknowledgements,
          ),
          operation: operationDto(result.operation, state.deliveryAcknowledgements),
        }),
        reason_codes: Object.freeze([]),
      });
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async acknowledgeCredentialDelivery(
    context: ExecutionContext,
    credentialId: string,
    input: unknown,
    rawIdempotencyKey: string,
  ): Promise<WriteResponse<Readonly<{ credential: CredentialDto; operation: OperationDto }>>> {
    assertAdmin(context, this.#repository.managementTenantId);
    const request = parseRequest(acknowledgeCredentialDeliveryRequestSchema, input);
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const nowSeconds = this.#clock();
    const now = timestamp(nowSeconds);
    let state: TenantAccessStateRecord;
    try {
      state = await this.#repository.getState();
    } catch (error) {
      mapRepositoryError(error);
    }
    const existing = state.credentials.find((value) => value.credentialId === credentialId);
    if (existing === undefined) throw new TenantAccessError("credential_not_found");
    if (existing.status !== "active") throw new TenantAccessError("credential_not_active");
    if (existing.expiresAt <= nowSeconds) throw new TenantAccessError("credential_expired");
    const tenant = state.tenants.find((value) => value.tenantId === existing.tenantId);
    const client = state.clients.find((value) => (
      value.tenantId === existing.tenantId && value.clientId === existing.clientId
    ));
    if (tenant === undefined || client === undefined) {
      throw new TenantAccessError("schema_mismatch");
    }
    const event = createEvent(this.#idGenerator, context, now, {
      tenantId: existing.tenantId,
      clientId: existing.clientId,
      credentialId,
      action: "credential.delivery_acknowledged",
      reasonCode: request.reason_code,
    });
    try {
      const result = await this.#repository.acknowledgeCredentialDelivery({
        credentialId,
        nowSeconds,
        event,
        idempotencyKey,
        requestHash: canonicalHash({
          action: "credential.delivery_acknowledge",
          credential_id: credentialId,
          actor: context.actorId,
          request,
        }),
      });
      const acknowledgements = Object.freeze({
        ...state.deliveryAcknowledgements,
        [result.value.credentialId]: result.operation.createdAt,
      });
      return Object.freeze({
        schema_version: TENANT_ACCESS_SCHEMA_VERSION,
        status: "success",
        replayed: result.replayed,
        data: Object.freeze({
          credential: credentialDto(
            result.value,
            nowSeconds,
            tenant.status,
            client.status,
            acknowledgements,
          ),
          operation: operationDto(result.operation, acknowledgements),
        }),
        reason_codes: Object.freeze([]),
      });
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async verifyApiKey(token: string): Promise<AuthClaims> {
    try {
      if (typeof token !== "string" || token.length > 256) {
        throw new TenantAccessError("authentication_failed");
      }
      const match = API_KEY_PATTERN.exec(token);
      if (match === null) throw new TenantAccessError("authentication_failed");
      const credentialId = match[1];
      const secret = match[2];
      if (credentialId === undefined || secret === undefined) {
        throw new TenantAccessError("authentication_failed");
      }
      const found = await this.#repository.findCredentialForAuthentication(credentialId);
      if (
        found === null ||
        found.tenant.status !== "active" ||
        found.client.status !== "active" ||
        found.credential.status !== "active" ||
        found.deliveryAcknowledgedAt === null ||
        found.credential.expiresAt <= this.#clock()
      ) {
        throw new TenantAccessError("authentication_failed");
      }
      if (!(await this.#credentialSecretProvider.verify(
        secret,
        found.credential.secretSalt,
        found.credential.secretHash,
      ))) {
        throw new TenantAccessError("authentication_failed");
      }
      const acceptedAt = this.#clock();
      const accepted = await this.#repository.markCredentialUsed(
        found.credential.credentialId,
        timestamp(acceptedAt),
        acceptedAt,
      );
      if (!accepted) throw new TenantAccessError("authentication_failed");
      const roles: AuthClaims["roles"] = ["service"];
      const scopes: AuthClaims["scopes"] = [...found.credential.scopes];
      return {
        tenant_id: found.tenant.tenantId,
        actor_id: `service:${found.credential.clientId}`,
        actor_role: "service",
        roles,
        scopes,
        client_id: found.credential.clientId,
        session_id: `credential:${found.credential.credentialId}`,
        expires_at: found.credential.expiresAt,
      };
    } catch (error) {
      if (error instanceof TenantAccessError && error.code === "authentication_failed") {
        throw error;
      }
      throw new TenantAccessError("authentication_failed", { cause: error });
    }
  }
}
