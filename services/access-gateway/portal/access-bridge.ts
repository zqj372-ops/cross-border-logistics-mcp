import { createHash, randomUUID } from "node:crypto";

import { T0_TOOL_NAMES, type ExchangeInput, type T0ToolName } from "../contracts";
import { AccessGatewayError } from "../errors";
import type { AccessGateway } from "../service";
import type { AuthorizedT0TokenIssuer } from "../ports";
import type { BusinessAccessService } from "./business-access/service";
import {
  PORTAL_SCHEMA_VERSION,
  PortalError,
  type PortalContext,
  type PortalMutation,
} from "./contracts";
import type { PortalService } from "./service";
import {
  TENANT_ACCESS_SCHEMA_VERSION,
  type TenantAccessService,
} from "../../../src/logistics_mcp/control-plane/tenant-access-service";
import {
  parseExecutionContext,
  type ExecutionContext,
} from "../../../src/logistics_mcp/platform/context";
import { isExactT0ServiceIdentity } from "../../../src/logistics_mcp/platform/rbac";
import {
  validateShortLivedToken,
  type ShortLivedTokenValidationOptions,
} from "../../../src/logistics_mcp/platform/security";
import {
  executeRegisteredTool,
  type ToolDefinition,
} from "../../../src/logistics_mcp/server/tool-registry";

type ApplicationInput = Readonly<{
  name: string;
  purpose: string;
  environment: "test" | "production";
  ownerUserId?: string;
}>;

type IssueCredentialInput = Readonly<{
  label: string;
  tool_names: readonly T0ToolName[];
  expires_in_seconds: number;
}>;

type RotateCredentialInput = Readonly<{
  tool_names: readonly T0ToolName[];
  expires_in_seconds: number;
}>;

type EmptyInput = Readonly<Record<string, never>>;

export interface PortalMachineTokenVerifier {
  verify(token: string): Promise<Record<string, unknown>>;
}

export interface PortalAccessBridgeOptions {
  readonly dataMode: "fixtures" | "production";
  readonly portalService: PortalService;
  readonly tenantAccessService: TenantAccessService;
  readonly accessGateway: AccessGateway;
  readonly applicationTokenIssuer?: AuthorizedT0TokenIssuer;
  readonly internalAdminContext: ExecutionContext | (() => ExecutionContext);
  readonly tokenVerifier: PortalMachineTokenVerifier;
  readonly restTokenPolicy: ShortLivedTokenValidationOptions;
  readonly applicationTokenVerifier?: PortalMachineTokenVerifier;
  readonly applicationTokenPolicy?: ShortLivedTokenValidationOptions;
  readonly exchangeAudience: string;
  readonly t0Definitions: readonly ToolDefinition[];
  readonly applicationCredentialAuthority?: Pick<BusinessAccessService,
    "authorizeT0ApiKey" | "authorizeT0Credential" | "exchangeApplicationToken"
  >;
  readonly id?: (prefix: "req" | "audit") => string;
}

function exactTools(value: unknown): readonly T0ToolName[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > T0_TOOL_NAMES.length ||
    value.some((item) => typeof item !== "string" || !T0_TOOL_NAMES.includes(item as T0ToolName)) ||
    new Set(value).size !== value.length
  ) {
    throw new PortalError("tool_entitlement_invalid");
  }
  const selected = new Set(value);
  return Object.freeze(T0_TOOL_NAMES.filter((toolName) => selected.has(toolName)));
}

function stableIdentifier(
  prefix: "app" | "client",
  context: PortalContext,
  tenantId: string,
  idempotencyKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${prefix}\u0000${tenantId}\u0000${context.identity.userId}\u0000${idempotencyKey}`)
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

function applicationMutationInput(value: unknown): ApplicationInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PortalError("input_invalid");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["name", "purpose", "environment", "ownerUserId"].includes(key)) ||
    typeof input.name !== "string" ||
    input.name.trim().length === 0 ||
    typeof input.purpose !== "string" ||
    input.purpose.trim().length === 0 ||
    (input.environment !== "test" && input.environment !== "production") ||
    (input.ownerUserId !== undefined && typeof input.ownerUserId !== "string")
  ) {
    throw new PortalError("input_invalid");
  }
  return {
    name: input.name,
    purpose: input.purpose,
    environment: input.environment,
    ...(input.ownerUserId === undefined ? {} : { ownerUserId: input.ownerUserId }),
  };
}

function credentialMutationInput(value: unknown): IssueCredentialInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PortalError("input_invalid");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["label", "tool_names", "expires_in_seconds"].includes(key)) ||
    typeof input.label !== "string" ||
    input.label.trim().length === 0 ||
    !Number.isSafeInteger(input.expires_in_seconds)
  ) {
    throw new PortalError("input_invalid");
  }
  return {
    label: input.label,
    tool_names: exactTools(input.tool_names),
    expires_in_seconds: input.expires_in_seconds as number,
  };
}

function rotationMutationInput(value: unknown): RotateCredentialInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PortalError("input_invalid");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["tool_names", "expires_in_seconds"].includes(key)) ||
    !Number.isSafeInteger(input.expires_in_seconds)
  ) {
    throw new PortalError("input_invalid");
  }
  return {
    tool_names: exactTools(input.tool_names),
    expires_in_seconds: input.expires_in_seconds as number,
  };
}

function emptyMutationInput(value: unknown): EmptyInput {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new PortalError("input_invalid");
  }
  return Object.freeze({});
}

function claimsContext(claims: Record<string, unknown>): ExecutionContext {
  if (
    claims.sub !== claims.actor_id ||
    typeof claims.jti !== "string" ||
    typeof claims.client_id !== "string" ||
    typeof claims.session_id !== "string" ||
    !isExactT0ServiceIdentity({
      role: claims.actor_role,
      roles: claims.roles,
      scopes: claims.scopes,
    })
  ) {
    throw new PortalError("machine_authentication_failed");
  }
  try {
    return parseExecutionContext({
      tenant_id: claims.tenant_id,
      actor_id: claims.actor_id,
      actor_role: claims.actor_role,
      roles: claims.roles,
      scopes: claims.scopes,
      client_id: claims.client_id,
      session_id: claims.session_id,
      expires_at: claims.exp,
    });
  } catch {
    throw new PortalError("machine_authentication_failed");
  }
}

export class PortalAccessBridge {
  readonly #portal: PortalService;
  readonly #tenantAccess: TenantAccessService;
  readonly #gateway: AccessGateway;
  readonly #applicationTokenIssuer: AuthorizedT0TokenIssuer;
  readonly #admin: () => ExecutionContext;
  readonly #tokenVerifier: PortalMachineTokenVerifier;
  readonly #restTokenPolicy: ShortLivedTokenValidationOptions;
  readonly #applicationTokenVerifier: PortalMachineTokenVerifier | undefined;
  readonly #applicationTokenPolicy: ShortLivedTokenValidationOptions | undefined;
  readonly #definitions: ReadonlyMap<T0ToolName, ToolDefinition>;
  readonly #applicationCredentials?: PortalAccessBridgeOptions["applicationCredentialAuthority"];
  readonly #id: (prefix: "req" | "audit") => string;

  constructor(options: PortalAccessBridgeOptions) {
    if (
      options.dataMode === "production" &&
      options.restTokenPolicy.audience === options.exchangeAudience
    ) {
      throw new PortalError("rest_audience_not_isolated");
    }
    const definitions = new Map<string, ToolDefinition>();
    for (const definition of options.t0Definitions) definitions.set(definition.name, definition);
    if (
      definitions.size !== T0_TOOL_NAMES.length ||
      T0_TOOL_NAMES.some((toolName) => !definitions.has(toolName))
    ) {
      throw new PortalError("t0_catalog_invalid");
    }
    this.#portal = options.portalService;
    this.#tenantAccess = options.tenantAccessService;
    this.#gateway = options.accessGateway;
    this.#applicationTokenIssuer = options.applicationTokenIssuer ?? options.accessGateway;
    this.#admin = typeof options.internalAdminContext === "function"
      ? options.internalAdminContext
      : () => options.internalAdminContext as ExecutionContext;
    this.#tokenVerifier = options.tokenVerifier;
    this.#restTokenPolicy = options.restTokenPolicy;
    this.#applicationTokenVerifier = options.applicationTokenVerifier;
    this.#applicationTokenPolicy = options.applicationTokenPolicy;
    this.#definitions = definitions as ReadonlyMap<T0ToolName, ToolDefinition>;
    this.#applicationCredentials = options.applicationCredentialAuthority;
    this.#id = options.id ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
  }

  async #state() {
    return this.#tenantAccess.getState(this.#admin());
  }

  async #requireCurrentMachineAuthority(context: ExecutionContext, toolName: T0ToolName): Promise<void> {
    try {
      if (context.actorId.startsWith("bkey_")) {
        if (!this.#applicationCredentials) throw new PortalError("machine_authorization_denied");
        await this.#applicationCredentials.authorizeT0Credential({
          credentialId: context.actorId,
          tenantId: context.tenantId,
          clientId: context.clientId,
          requestedToolNames: [toolName],
        });
        return;
      }
      const portal = this.#portal.requireMachineGrants(context.clientId, [toolName]);
      if (portal.tenantId !== context.tenantId) throw new PortalError("machine_authorization_denied");
      const state = await this.#state();
      const tenant = state.data.tenants.find((item) => item.tenant_id === context.tenantId);
      const client = state.data.clients.find((item) => item.tenant_id === context.tenantId && item.client_id === context.clientId);
      const credential = state.data.credentials.find((item) => item.credential_id === context.actorId && item.tenant_id === context.tenantId && item.client_id === context.clientId);
      if (tenant?.status !== "active" || client?.status !== "active" || credential?.effective_status !== "active" || !credential.tool_names.includes(toolName)) {
        throw new PortalError("machine_authorization_denied");
      }
      const current = this.#portal.requireMachineGrants(context.clientId, [toolName]);
      if (current.tenantId !== context.tenantId) throw new PortalError("machine_authorization_denied");
    } catch {
      throw new PortalError("machine_authorization_denied");
    }
  }

  #delegatedAdmin(context: PortalContext): ExecutionContext {
    try {
      const admin = this.#admin();
      return parseExecutionContext({
        tenant_id: admin.tenantId,
        actor_id: context.identity.userId,
        actor_role: admin.role,
        roles: admin.roles,
        scopes: admin.scopes,
        client_id: admin.clientId,
        session_id: admin.sessionId,
        expires_at: admin.expiresAt,
      });
    } catch {
      throw new PortalError("credential_bridge_unavailable");
    }
  }

  #applicationTarget(context: PortalContext, applicationId: string) {
    const application = this.#portal.requireApplicationAccess(
      context,
      applicationId,
      undefined,
      "credential",
    );
    const organization = this.#portal.requireApplicationCreation(context, application.ownerUserId);
    return { application, organization };
  }

  async createApplication(
    context: PortalContext,
    mutation: PortalMutation<ApplicationInput>,
  ) {
    const input = applicationMutationInput(mutation.input);
    const ownerUserId = input.ownerUserId ?? context.identity.userId;
    const target = this.#portal.requireApplicationCreation(context, ownerUserId);
    const applicationId = stableIdentifier("app", context, target.tenantId, mutation.idempotencyKey);
    const clientId = stableIdentifier("client", context, target.tenantId, mutation.idempotencyKey);
    const created = await this.#tenantAccess.createClient(this.#delegatedAdmin(context), {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: target.tenantId,
      client_id: clientId,
      label: input.name,
    }, mutation.idempotencyKey);
    const state = await this.#state();
    const readback = state.data.clients.find((client) => (
      client.tenant_id === target.tenantId &&
      client.client_id === clientId &&
      client.status === "active"
    ));
    if (
      readback === undefined ||
      created.data.client.tenant_id !== target.tenantId ||
      created.data.client.client_id !== clientId
    ) {
      throw new PortalError("client_readback_unverified");
    }
    return this.#portal.createApplication(context, {
      idempotencyKey: mutation.idempotencyKey,
      input: {
        applicationId,
        clientId,
        name: input.name,
        purpose: input.purpose,
        environment: input.environment,
        ownerUserId,
      },
    });
  }

  async provisionGrant(
    context: PortalContext,
    grantId: string,
    mutation: PortalMutation<Readonly<{ expiresAt?: string }>>,
  ) {
    const target = this.#portal.requireGrantProvisioning(context, grantId);
    exactTools(target.capabilities);
    const state = await this.#state();
    const tenant = state.data.tenants.find((item) => item.tenant_id === target.tenantId);
    const client = state.data.clients.find((item) => (
      item.tenant_id === target.tenantId && item.client_id === target.clientId
    ));
    if (tenant?.status !== "active" || client?.status !== "active") {
      throw new PortalError("grant_provisioning_readback_unverified");
    }
    if (mutation.expectedVersion !== target.version) throw new PortalError("version_conflict");
    return this.#portal.markGrantActive(context, grantId, {
      idempotencyKey: mutation.idempotencyKey,
      expectedVersion: mutation.expectedVersion,
      input: {
        provisionedRef: `client:${target.clientId}`,
        ...(mutation.input.expiresAt === undefined ? {} : { expiresAt: mutation.input.expiresAt }),
      },
    });
  }

  async getCredentialState(context: PortalContext, applicationId: string) {
    const { application, organization } = this.#applicationTarget(context, applicationId);
    const state = await this.#state();
    const client = state.data.clients.find((item) => (
      item.tenant_id === organization.tenantId && item.client_id === application.clientId
    ));
    if (client === undefined) throw new PortalError("client_readback_unverified");
    return Object.freeze({
      schema_version: PORTAL_SCHEMA_VERSION,
      status: "success" as const,
      data: Object.freeze({
        application_id: application.applicationId,
        client,
        credentials: Object.freeze(state.data.credentials.filter((item) => (
          item.tenant_id === organization.tenantId && item.client_id === application.clientId
        ))),
      }),
      reason_codes: Object.freeze([]),
    });
  }

  #requireGrants(
    context: PortalContext,
    applicationId: string,
    toolNames: readonly T0ToolName[],
  ) {
    const target = this.#applicationTarget(context, applicationId);
    for (const toolName of toolNames) {
      if (this.#portal.getEffectiveGrant(context, applicationId, toolName) === null) {
        throw new PortalError("grant_required");
      }
    }
    return target;
  }

  async issueCredential(
    context: PortalContext,
    applicationId: string,
    mutation: PortalMutation<IssueCredentialInput | Record<string, unknown>>,
  ) {
    const input = credentialMutationInput(mutation.input);
    const { application, organization } = this.#requireGrants(
      context,
      applicationId,
      input.tool_names,
    );
    return this.#tenantAccess.issueCredential(this.#delegatedAdmin(context), {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tenant_id: organization.tenantId,
      client_id: application.clientId,
      label: input.label,
      tool_names: input.tool_names,
      expires_in_seconds: input.expires_in_seconds,
    }, mutation.idempotencyKey);
  }

  async #scopedCredential(
    context: PortalContext,
    applicationId: string,
    credentialId: string,
  ) {
    const target = this.#applicationTarget(context, applicationId);
    const state = await this.#state();
    const credential = state.data.credentials.find((item) => (
      item.credential_id === credentialId &&
      item.tenant_id === target.organization.tenantId &&
      item.client_id === target.application.clientId
    ));
    if (credential === undefined) throw new PortalError("credential_not_found");
    return { ...target, credential };
  }

  async acknowledgeCredentialDelivery(
    context: PortalContext,
    applicationId: string,
    credentialId: string,
    mutation: PortalMutation<EmptyInput | Record<string, unknown>>,
  ) {
    emptyMutationInput(mutation.input);
    await this.#scopedCredential(context, applicationId, credentialId);
    return this.#tenantAccess.acknowledgeCredentialDelivery(this.#delegatedAdmin(context), credentialId, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      reason_code: "owner_confirmed_secure_storage",
    }, mutation.idempotencyKey);
  }

  async rotateCredential(
    context: PortalContext,
    applicationId: string,
    credentialId: string,
    mutation: PortalMutation<RotateCredentialInput | Record<string, unknown>>,
  ) {
    const input = rotationMutationInput(mutation.input);
    await this.#scopedCredential(context, applicationId, credentialId);
    this.#requireGrants(context, applicationId, input.tool_names);
    return this.#tenantAccess.rotateCredential(this.#delegatedAdmin(context), credentialId, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      tool_names: input.tool_names,
      expires_in_seconds: input.expires_in_seconds,
      reason_code: "application_owner_rotated",
    }, mutation.idempotencyKey);
  }

  async revokeCredential(
    context: PortalContext,
    applicationId: string,
    credentialId: string,
    mutation: PortalMutation<EmptyInput | Record<string, unknown>>,
  ) {
    emptyMutationInput(mutation.input);
    await this.#scopedCredential(context, applicationId, credentialId);
    return this.#tenantAccess.revokeCredential(this.#delegatedAdmin(context), credentialId, {
      schema_version: TENANT_ACCESS_SCHEMA_VERSION,
      reason_code: "application_owner_revoked",
    }, mutation.idempotencyKey);
  }

  exchangeToken(input: ExchangeInput) {
    return this.#gateway.exchangeToken(input, (authorization) => {
      try {
        const current = this.#portal.requireMachineGrants(
          authorization.clientId,
          authorization.requestedToolNames,
        );
        if (
          current.tenantId !== authorization.tenantId ||
          current.clientId !== authorization.clientId
        ) {
          throw new AccessGatewayError("tool_entitlement_denied");
        }
      } catch (error) {
        if (error instanceof AccessGatewayError) throw error;
        throw new AccessGatewayError("tool_entitlement_denied");
      }
    });
  }

  exchangeApplicationToken(input: Readonly<{
    apiKey: string;
    requestedToolNames: readonly T0ToolName[];
    clientIp: string;
    requestId?: string;
  }>) {
    if (!this.#applicationCredentials) throw new PortalError("machine_authentication_failed");
    return this.#applicationCredentials.exchangeApplicationToken({
      ...input,
      issuer: this.#applicationTokenIssuer,
    });
  }

  async executeT0WithApplicationKey(input: Readonly<{
    apiKey: string;
    toolName: T0ToolName;
    input: unknown;
    signal?: AbortSignal;
  }>) {
    if (!this.#applicationCredentials || !T0_TOOL_NAMES.includes(input.toolName)) {
      throw new PortalError("machine_authentication_failed");
    }
    const machine = await this.#applicationCredentials.authorizeT0ApiKey(input.apiKey, [input.toolName]);
    const context = parseExecutionContext({
      tenant_id: machine.tenantId,
      actor_id: machine.credentialId,
      actor_role: "service",
      roles: ["service"],
      scopes: [`tool:${input.toolName}`],
      client_id: machine.clientId,
      session_id: this.#id("audit"),
      expires_at: Math.floor(Date.now() / 1_000) + 60,
    });
    await this.#requireCurrentMachineAuthority(context, input.toolName);
    const definition = this.#definitions.get(input.toolName);
    if (!definition) throw new PortalError("tool_not_found");
    return executeRegisteredTool(definition, input.input, context, {
      requestId: this.#id("req"),
      auditId: this.#id("audit"),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async verifyApplicationTokenAuthority(accessToken: string): Promise<void> {
    if (!this.#applicationCredentials || !this.#applicationTokenVerifier || !this.#applicationTokenPolicy) {
      throw new PortalError("machine_authentication_failed");
    }
    let claims: Record<string, unknown>;
    try {
      claims = validateShortLivedToken(
        await this.#applicationTokenVerifier.verify(accessToken),
        this.#applicationTokenPolicy,
      );
    } catch {
      throw new PortalError("machine_authentication_failed");
    }
    const context = claimsContext(claims);
    if (!context.actorId.startsWith("bkey_")) throw new PortalError("machine_authentication_failed");
    const toolNames = context.scopes.map((scope) => scope.startsWith("tool:") ? scope.slice(5) : "") as T0ToolName[];
    if (toolNames.length === 0 || toolNames.some((tool) => !T0_TOOL_NAMES.includes(tool))) {
      throw new PortalError("machine_authentication_failed");
    }
    await this.#applicationCredentials.authorizeT0Credential({
      credentialId: context.actorId,
      tenantId: context.tenantId,
      clientId: context.clientId,
      requestedToolNames: toolNames,
    });
  }

  async executeT0(input: Readonly<{
    accessToken: string;
    toolName: T0ToolName;
    input: unknown;
    signal?: AbortSignal;
  }>) {
    if (!T0_TOOL_NAMES.includes(input.toolName)) throw new PortalError("tool_not_found");
    let claims: Record<string, unknown>;
    try {
      claims = validateShortLivedToken(
        await this.#tokenVerifier.verify(input.accessToken),
        this.#restTokenPolicy,
      );
    } catch {
      throw new PortalError("machine_authentication_failed");
    }
    const context = claimsContext(claims);
    await this.#requireCurrentMachineAuthority(context, input.toolName);
    const definition = this.#definitions.get(input.toolName);
    if (definition === undefined) throw new PortalError("tool_not_found");
    return executeRegisteredTool(definition, input.input, context, {
      requestId: this.#id("req"),
      auditId: this.#id("audit"),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
}

export function createPortalAccessBridge(
  options: PortalAccessBridgeOptions,
): PortalAccessBridge {
  return new PortalAccessBridge(options);
}
