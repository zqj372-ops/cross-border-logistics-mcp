import { z } from "zod";
import type { createQuoteRecordPortalClient } from "./quote-record-client";
import type { QuotePortalZoneInput } from "./quote-client";
import { PortalError, type PortalContext } from "../contracts";
import type { PortalService } from "../service";

export const PORTAL_BUSINESS_SCHEMA_VERSION = "portal-business@2026-09-05.v1" as const;
export type PortalBusinessOperation = "customs.query" | "customs.tax.estimate" | "quote.zone_preview" | "quote.ai_extract_preview" | "quote.freightcom_ltl.preview";
export type PortalBusinessStatus = "success" | "needs_input" | "manual_review" | "blocked" | "unavailable";
export interface PortalBusinessClientResult { readonly schema_version: string; readonly status: PortalBusinessStatus; readonly data: unknown; readonly reason_codes: readonly string[]; readonly [key: string]: unknown }
export interface CustomsBusinessClientPort { query(request: { readonly input: unknown; readonly actor: { readonly type: "user" | "service"; readonly id: string }; readonly requestId: string }): Promise<PortalBusinessClientResult> }
export interface TaxBusinessClientPort {
  estimate(request: { readonly input: unknown; readonly actor: { readonly type: "user" | "service"; readonly id: string }; readonly requestId: string }): Promise<PortalBusinessClientResult>;
  estimateBatch(request: { readonly input: unknown; readonly actor: { readonly type: "user" | "service"; readonly id: string }; readonly requestId: string }): Promise<PortalBusinessClientResult>;
}
export interface QuoteBusinessClientPort {
  preview(request: { readonly input: unknown; readonly actor: { readonly type: "user" | "service"; readonly id: string }; readonly requestId: string }): Promise<PortalBusinessClientResult>;
  extract(request: { readonly input: unknown; readonly actor: { readonly type: "user" | "service"; readonly id: string }; readonly requestId: string }): Promise<PortalBusinessClientResult>;
}
export interface FreightcomBusinessClientPort {
  preview(request: { readonly input: unknown; readonly requestId: string }): Promise<PortalBusinessClientResult>;
}
export interface PortalBusinessConnection {
  readonly organizationId: string; readonly tenantId: string; readonly enabledOperations: readonly PortalBusinessOperation[];
  readonly serviceActors?: Readonly<{ customs?: string; quote?: string }>;
  readonly recordOperations?: readonly ("quote.record_save"|"quote.record_read"|"quote.review_read"|"quote.review_manage"|"quote.document_generate"|"quote.document_read")[];
  readonly quoteRecordClient?: ReturnType<typeof createQuoteRecordPortalClient>;
  readonly customsClient?: CustomsBusinessClientPort; readonly taxClient?: TaxBusinessClientPort; readonly quoteClient?: QuoteBusinessClientPort;
  readonly freightcomClient?: FreightcomBusinessClientPort;
}
export interface PortalBusinessServiceOptions { readonly portalService: Pick<PortalService, "getState"> & Partial<Pick<PortalService, "requireBusinessApplication">>; readonly connections: readonly PortalBusinessConnection[] }
export interface PortalBusinessDescription { readonly organization_id: string; readonly operations: ReadonlyArray<{ readonly operation: PortalBusinessOperation; readonly configured: boolean; readonly reason_code: string | null }> }
export type PortalBusinessEnvelope<T> = Readonly<{ schema_version: typeof PORTAL_BUSINESS_SCHEMA_VERSION; status: PortalBusinessStatus; data: T | null; reason_codes: readonly string[] }>;
interface BusinessAccess { readonly organizationId: string; readonly tenantId: string; readonly role: "owner" | "admin" | "developer" | "viewer"; readonly connection: PortalBusinessConnection | null }

const OPERATIONS: readonly PortalBusinessOperation[] = Object.freeze(["customs.query", "customs.tax.estimate", "quote.zone_preview", "quote.ai_extract_preview", "quote.freightcom_ltl.preview"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const failure = (status: "blocked" | "unavailable", code: string): PortalBusinessEnvelope<never> => Object.freeze({ schema_version: PORTAL_BUSINESS_SCHEMA_VERSION, status, data: null, reason_codes: Object.freeze([code]) });

export class PortalBusinessService {
  readonly #portal: Pick<PortalService, "getState"> & Partial<Pick<PortalService, "requireBusinessApplication">>;
  readonly #connections: readonly PortalBusinessConnection[];
  constructor(options: PortalBusinessServiceOptions) { this.#portal = options.portalService; this.#connections = Object.freeze([...options.connections]); }

  #access(ctx: PortalContext): BusinessAccess {
    if (ctx.identity.platformRole !== null) throw new PortalError("business_personnel_session_required");
    const state = this.#portal.getState(ctx);
    const org = state.data?.current_organization;
    const membership = state.data?.memberships.find((item) => item.organizationId === org?.organizationId && item.userId === ctx.identity.userId && item.status === "active");
    if (state.status !== "success" || !org || org.status !== "active" || !membership) {
      throw new PortalError("active_organization_membership_required");
    }
    const connection = this.#connections.find((item) => item.organizationId === org.organizationId) ?? null;
    if (connection && connection.tenantId !== org.tenantId) throw new PortalError("business_connection_tenant_mismatch");
    return { organizationId: org.organizationId, tenantId: org.tenantId, role: membership.role, connection };
  }

  describe(ctx: PortalContext): PortalBusinessEnvelope<PortalBusinessDescription> {
    try {
      const access = this.#access(ctx);
      return Object.freeze({ schema_version: PORTAL_BUSINESS_SCHEMA_VERSION, status: "success", data: Object.freeze({ organization_id: access.organizationId, operations: Object.freeze(OPERATIONS.map((operation) => {
        const enabled = access.connection?.enabledOperations.includes(operation) === true;
        const client = operation === "customs.query" ? access.connection?.customsClient : operation === "customs.tax.estimate" ? access.connection?.taxClient : operation === "quote.freightcom_ltl.preview" ? access.connection?.freightcomClient : access.connection?.quoteClient;
        return Object.freeze({ operation, configured: enabled && client !== undefined, reason_code: enabled && client !== undefined ? null : enabled ? "business_client_unconfigured" : "business_operation_not_enabled" });
      })) }), reason_codes: Object.freeze([]) });
    } catch (error) {
      return failure("blocked", error instanceof PortalError ? error.code : "business_access_denied");
    }
  }

  async execute(ctx: PortalContext, operation: PortalBusinessOperation, input: unknown, requestId: string): Promise<PortalBusinessClientResult | PortalBusinessEnvelope<never>> {
    if (!OPERATIONS.includes(operation) || !ID.test(requestId)) return failure("blocked", "business_request_invalid");
    let access: BusinessAccess;
    try { access = this.#access(ctx); } catch (error) { return failure("blocked", error instanceof PortalError ? error.code : "business_access_denied"); }
    const connection = access.connection;
    if (!connection) return failure("unavailable", "business_connection_unconfigured");
    if (!connection.enabledOperations.includes(operation)) return failure("blocked", "business_operation_not_enabled");
    const request = { input, actor: { type: "user" as const, id: ctx.identity.userId }, requestId };
    if (operation === "customs.query") return connection.customsClient ? connection.customsClient.query(request) : failure("unavailable", "business_client_unconfigured");
    if (operation === "customs.tax.estimate") return connection.taxClient ? connection.taxClient.estimate(request) : failure("unavailable", "business_client_unconfigured");
    if (operation === "quote.freightcom_ltl.preview") return connection.freightcomClient ? connection.freightcomClient.preview({ input, requestId }) : failure("unavailable", "freightcom_connection_unconfigured");
    if (!connection.quoteClient) return failure("unavailable", "business_client_unconfigured");
    return operation === "quote.zone_preview" ? connection.quoteClient.preview(request) : connection.quoteClient.extract(request);
  }

  async executeBatch(ctx: PortalContext, input: unknown, requestId: string): Promise<PortalBusinessClientResult | PortalBusinessEnvelope<never>> {
    if (!ID.test(requestId)) return failure("blocked", "business_request_invalid");
    let access: BusinessAccess;
    try { access = this.#access(ctx); } catch (error) { return failure("blocked", error instanceof PortalError ? error.code : "business_access_denied"); }
    const connection = access.connection;
    if (!connection) return failure("unavailable", "business_connection_unconfigured");
    if (!connection.enabledOperations.includes("customs.tax.estimate")) return failure("blocked", "business_operation_not_enabled");
    if (!connection.taxClient) return failure("unavailable", "business_client_unconfigured");
    return connection.taxClient.estimateBatch({ input, actor: { type: "user", id: ctx.identity.userId }, requestId });
  }
  isAvailable(tenantId: string, operation: PortalBusinessOperation): boolean {
    const candidates = this.#connections.filter(item => item.tenantId === tenantId);
    if (candidates.length !== 1) return false;
    const item = candidates[0]!;
    return item.enabledOperations.includes(operation) && (operation === "customs.query" ? !!item.customsClient : operation === "customs.tax.estimate" ? !!item.taxClient : operation === "quote.freightcom_ltl.preview" ? !!item.freightcomClient : !!item.quoteClient);
  }

  async executeMachine(request: { operation: PortalBusinessOperation; input: unknown; requestId: string; batch: boolean; machine: { tenantId: string; clientId: string; applicationId: string; credentialId: string } }): Promise<PortalBusinessClientResult | PortalBusinessEnvelope<never>> {
    const { operation, input, requestId, machine, batch } = request;
    if (!OPERATIONS.includes(operation) || !ID.test(requestId) || batch && operation !== "customs.tax.estimate") return failure("blocked", "business_request_invalid");
    let application;
    try { application = this.#portal.requireBusinessApplication?.(machine.clientId); } catch { return failure("blocked", "business_application_denied"); }
    if (!application || application.tenantId !== machine.tenantId || application.applicationId !== machine.applicationId) return failure("blocked", "business_application_denied");
    const connection = this.#connections.find(item => item.organizationId === application.organizationId && item.tenantId === application.tenantId);
    if (!connection || !this.isAvailable(machine.tenantId, operation)) return failure("unavailable", "business_operation_unavailable");
    if (operation === "quote.freightcom_ltl.preview") return connection.freightcomClient!.preview({ input, requestId });
    const actorId = operation.startsWith("customs.") ? connection.serviceActors?.customs : connection.serviceActors?.quote;
    if (!actorId || !ID.test(actorId)) return failure("unavailable", "business_machine_identity_unconfigured");
    const call = { input, actor: { type: "service" as const, id: actorId }, requestId };
    if (operation === "customs.query") return connection.customsClient!.query(call);
    if (operation === "customs.tax.estimate") return batch ? connection.taxClient!.estimateBatch(call) : connection.taxClient!.estimate(call);
    return operation === "quote.zone_preview" ? connection.quoteClient!.preview(call) : connection.quoteClient!.extract(call);
  }

  async records(ctx: PortalContext, action: "prepare"|"save"|"get"|"list"|"review"|"reviewQueue"|"reviewPrepare"|"reviewResolve"|"documentCreate"|"documentGet"|"documentDownload", input: unknown, requestId: string, idempotencyKey?: string): Promise<unknown> {
    if (!ID.test(requestId)) return failure("blocked", "business_request_invalid");
    let access: BusinessAccess;
    try { access = this.#access(ctx); } catch { return failure("blocked", "business_access_denied"); }
    const connection = access.connection;
    const permission = action === "save" || action === "prepare" ? "quote.record_save" : action === "review" ? "quote.review_read" :
      action.startsWith("review") ? "quote.review_manage" : action === "documentCreate" ? "quote.document_generate" : action.startsWith("document") ? "quote.document_read" : "quote.record_read";
    if (!connection?.recordOperations?.includes(permission)) return failure("unavailable", "quote_record_operation_unconfigured");
    const client = connection.quoteRecordClient;
    if (!client) return failure("unavailable", "quote_record_connection_unconfigured");
    const base = { actor: { type: "user" as const, id: ctx.identity.userId }, requestId };
    if (action === "reviewQueue") {
      if (access.role !== "owner" && access.role !== "admin") return failure("blocked", "quote_reviewer_role_required");
      return client.reviewQueue(base);
    }
    if (action === "reviewPrepare") {
      if (access.role !== "owner" && access.role !== "admin") return failure("blocked", "quote_reviewer_role_required");
      const parsed = z.object({ task_ref: z.string() }).strict().safeParse(input);
      return parsed.success ? client.prepareReview({ ...base, taskRef: parsed.data.task_ref }) : failure("blocked", "business_request_invalid");
    }
    if (action === "reviewResolve") {
      if (access.role !== "owner" && access.role !== "admin") return failure("blocked", "quote_reviewer_role_required");
      const parsed = z.object({ task_ref: z.string(), expected_task_version: z.number().int().min(1), resolution_handle: z.string(),
        decision: z.enum(["approve_manual_price", "keep_manual_review"]), total_price_usd: z.string().optional(), evidence_ref: z.string().optional(),
        evidence_version: z.string().optional(), effective_at: z.string().optional(), valid_until: z.string().optional(),
        charge_lines: z.array(z.object({ code: z.string(), label: z.string(), amount_usd: z.string() }).strict()).optional(), customer_terms: z.string().optional(),
        note: z.string(), confirmed: z.literal("human_verified_price_and_source").optional() }).strict().safeParse(input);
      if (!parsed.success || !idempotencyKey) return failure("blocked", "business_request_invalid");
      return client.resolveReview({ ...base, taskRef: parsed.data.task_ref, expectedTaskVersion: parsed.data.expected_task_version,
        resolutionHandle: parsed.data.resolution_handle, decision: parsed.data.decision, note: parsed.data.note, idempotencyKey,
        ...(parsed.data.total_price_usd ? { totalPriceUsd: parsed.data.total_price_usd } : {}), ...(parsed.data.evidence_ref ? { evidenceRef: parsed.data.evidence_ref } : {}),
        ...(parsed.data.evidence_version ? { evidenceVersion: parsed.data.evidence_version } : {}), ...(parsed.data.effective_at ? { effectiveAt: parsed.data.effective_at } : {}),
        ...(parsed.data.valid_until ? { validUntil: parsed.data.valid_until } : {}), ...(parsed.data.charge_lines ? { chargeLines: parsed.data.charge_lines.map((line) => ({ code: line.code, label: line.label, amountUsd: line.amount_usd })) } : {}),
        ...(parsed.data.customer_terms ? { customerTerms: parsed.data.customer_terms } : {}),
        ...(parsed.data.confirmed ? { confirmed: parsed.data.confirmed } : {}) });
    }
    if (action === "documentCreate") {
      const parsed = z.object({ record_ref: z.string(), document_kind: z.enum(["formal_quote_pdf", "draft_quote_pdf"]) }).strict().safeParse(input);
      if (!parsed.success || !idempotencyKey) return failure("blocked", "business_request_invalid");
      return client.createDocument({ ...base, recordRef: parsed.data.record_ref, documentKind: parsed.data.document_kind, idempotencyKey });
    }
    if (action === "documentGet" || action === "documentDownload") {
      const parsed = z.object({ document_ref: z.string() }).strict().safeParse(input);
      if (!parsed.success) return failure("blocked", "business_request_invalid");
      return action === "documentGet" ? client.getDocument({ ...base, documentRef: parsed.data.document_ref }) : client.downloadDocument({ ...base, documentRef: parsed.data.document_ref });
    }
    if (action === "prepare") return client.prepare({ ...base, input: input as QuotePortalZoneInput });
    if (action === "save") {
      const parsed = z.object({ request: z.unknown(), preview_handle: z.string().min(32).max(4096), intent: z.literal("save_draft") }).strict().safeParse(input);
      if (!parsed.success || !idempotencyKey) return failure("blocked", "business_request_invalid");
      return client.save({ ...base, input: parsed.data.request as QuotePortalZoneInput, previewHandle: parsed.data.preview_handle, idempotencyKey });
    }
    if (action === "list") {
      const parsed = z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), status: z.enum(["draft", "manual_required", "quoted"]).optional() }).strict().safeParse(input);
      if (!parsed.success) return failure("blocked", "business_request_invalid");
      return client.list({ ...base, ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}), ...(parsed.data.limit ? { limit: parsed.data.limit } : {}), ...(parsed.data.status ? { status: parsed.data.status } : {}) });
    }
    const parsed = z.object({ record_ref: z.string() }).strict().safeParse(input);
    if (!parsed.success) return failure("blocked", "business_request_invalid");
    return action === "get" ? client.get({ ...base, recordRef: parsed.data.record_ref }) : client.reviewTasks({ ...base, recordRef: parsed.data.record_ref });
  }

}
