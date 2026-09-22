import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { PortalError, type PortalContext } from "../../access-gateway/portal/contracts";
import type { PortalService } from "../../access-gateway/portal/service";
import { FileEvidenceStore } from "../schedule-collector/evidence";
import { createEnvelope } from "../../../src/logistics_mcp/platform/envelope";
import type { ScheduleMcpTool } from "../../../src/logistics_mcp/platform/application-tools";
import type {
  AuditEvent,
  AuditPort,
  CollectorPorts,
  EvidenceStore,
} from "../schedule-collector/ports";
import { createCollectorService, type CollectorServiceApi } from "../schedule-collector/service";
import type { CarrierAdapter } from "../schedule-collector/carriers/types";
import { throwIfAborted } from "../schedule-collector/errors";
import type {
  CarrierBrowserPort,
  CarrierHttpPort,
  Clock,
} from "../schedule-collector/ports";
import {
  ScheduleLiveContractError,
  parseScheduleLiveLocationsRequest,
  parseScheduleLiveSearchRequest,
  type ScheduleLiveResponse,
} from "./contracts";

export const SCHEDULE_LIVE_SCHEMA_VERSION = "ocean-schedule-live@2026-09-18.v1" as const;

/** Roles that may start an outbound live query; carriers metadata is member-wide. */
export const SCHEDULE_LIVE_QUERY_ROLES = Object.freeze(["owner", "admin", "developer"] as const);

export interface ScheduleLivePolicy {
  /** Deployment-injected tenant allowlist. Missing tenant means live stays off. */
  liveEnabled(tenantId: string): boolean;
  /** Optional per-tenant carrier narrowing; defaults to the whole registry. */
  carrierEnabled?(tenantId: string, carrier: string): boolean;
}

export interface ScheduleLiveAuditEntry {
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly action: "carriers" | "locations" | "search" | "evidence_read";
  readonly request_id: string;
  readonly audit_id: string;
  readonly carrier: string | null;
  readonly status: string;
  readonly issue_code: string | null;
  readonly at: string;
  readonly input_sha256: string | null;
}

export interface ScheduleLiveAuditSink {
  record(
    entry: ScheduleLiveAuditEntry,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
}

export interface ScheduleLiveEvidenceReader {
  read(ctx: PortalContext, tenantId: string, reference: string): Promise<{
    readonly ref: string;
    readonly sha256: string;
    readonly byte_length: number;
  }>;
}

export interface ScheduleLivePersonalAccess {
  readonly scopeId: string;
  readonly perAccount?:boolean;
  authorize(ctx: PortalContext): Promise<boolean>;
}

export function isPersonalScheduleScope(access:ScheduleLivePersonalAccess|undefined,scope:string):boolean{
  return Boolean(access&&(scope===access.scopeId||access.perAccount===true&&scope.startsWith(`${access.scopeId}-`)&&/^[a-f0-9]{16}$/u.test(scope.slice(access.scopeId.length+1))));
}

export interface ScheduleLiveServiceOptions {
  readonly personalAccess?: ScheduleLivePersonalAccess;
  readonly portal: Pick<PortalService, "getState">;
  readonly policy: ScheduleLivePolicy;
  readonly clock: Clock;
  readonly audit: ScheduleLiveAuditSink;
  readonly evidenceRoot: string;
  readonly adapters: readonly CarrierAdapter[];
  readonly http: CarrierHttpPort;
  readonly browser?: CarrierBrowserPort;
  readonly deadlineMs?: number;
  readonly localFixture?: boolean;
}

export interface ScheduleLiveOperationOptions {
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export interface ScheduleLiveServiceApi {
  carriers(ctx: PortalContext, options?: ScheduleLiveOperationOptions): Promise<ScheduleLiveResponse>;
  locations(
    ctx: PortalContext,
    input: unknown,
    options?: ScheduleLiveOperationOptions,
  ): Promise<ScheduleLiveResponse>;
  search(
    ctx: PortalContext,
    input: unknown,
    options?: ScheduleLiveOperationOptions,
  ): Promise<ScheduleLiveResponse>;
  readEvidence(
    ctx: PortalContext,
    reference: string,
    options?: ScheduleLiveOperationOptions,
  ): Promise<{ readonly ref: string; readonly sha256: string; readonly byte_length: number }>;
  machineExecute(request: {
    readonly tool: ScheduleMcpTool;
    readonly tenantId: string;
    readonly actorId: string;
    readonly input: unknown;
    readonly requestId?: string;
    readonly signal?: AbortSignal;
  }): Promise<ScheduleLiveResponse>;
}

const EVIDENCE_REFERENCE =
  /^evidence:([A-Za-z0-9][A-Za-z0-9._:/-]{0,127}):([A-Za-z0-9][A-Za-z0-9._:/-]{0,127}):sha256:([a-f0-9]{64})$/u;

function identifier(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function tenantDirectory(root: string, tenantId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(tenantId)) {
    throw new PortalError("schedule_live_tenant_invalid");
  }
  return join(resolve(root), tenantId);
}

/**
 * Binds every collector operation to the server-side tenant/actor context.
 * Evidence is stored under a tenant directory, so a reference minted for one
 * tenant can never be read back for another one.
 */
export function createScheduleLiveService(
  options: ScheduleLiveServiceOptions,
): ScheduleLiveServiceApi {
  const evidenceRoot = resolve(options.evidenceRoot);

  async function member(ctx: PortalContext, action: "carriers" | "locations" | "search"): Promise<{
    readonly tenantId: string;
    readonly role: string;
  }> {
    if (ctx.identity.emailVerified && options.personalAccess && await options.personalAccess.authorize(ctx)) {
      const tenantId = options.personalAccess.perAccount?`${options.personalAccess.scopeId}-${digest(ctx.identity.userId).slice(0,16)}`:options.personalAccess.scopeId;
      tenantDirectory(evidenceRoot, tenantId);
      if (action !== "carriers" && !options.policy.liveEnabled(tenantId)) throw new PortalError("schedule_live_disabled");
      return {tenantId, role: "fcl_receiver"};
    }
    if (!ctx.identity.emailVerified || !ctx.organizationId) {
      throw new PortalError("schedule_live_membership_required");
    }
    const state = options.portal.getState(ctx).data;
    const membership = state?.memberships.find(
      (member) =>
        member.userId === ctx.identity.userId &&
        member.organizationId === ctx.organizationId &&
        member.status === "active",
    );
    if (!membership || state?.current_organization?.status !== "active") {
      throw new PortalError("schedule_live_membership_required");
    }
    if (action !== "carriers" && !SCHEDULE_LIVE_QUERY_ROLES.includes(membership.role as "owner")) {
      throw new PortalError("schedule_live_role_denied");
    }
    const tenantId = state.current_organization.tenantId;
    if (action !== "carriers" && !options.policy.liveEnabled(tenantId)) {
      throw new PortalError("schedule_live_disabled");
    }
    return { tenantId, role: membership.role };
  }

  function carrierAllowed(tenantId: string, carrier: string): boolean {
    return options.policy.carrierEnabled?.(tenantId, carrier) ?? true;
  }

  function tenantEvidence(tenantId: string): EvidenceStore {
    return new FileEvidenceStore({ root: tenantDirectory(evidenceRoot, tenantId) });
  }

  function auditFor(
    tenantId: string,
    actorId: string,
    action: ScheduleLiveAuditEntry["action"],
    auditId: string,
  ): AuditPort {
    const sink = options.audit;
    return {
      async record(event: AuditEvent, recordOptions) {
        const signal = recordOptions?.signal;
        throwIfAborted(signal);
        await sink.record({
          tenant_id: tenantId,
          actor_id: actorId,
          action,
          request_id: event.requestId,
          audit_id: auditId,
          carrier: event.carrier,
          status: event.status,
          issue_code: event.issue_code,
          at: event.at,
          input_sha256: null,
        }, signal === undefined ? undefined : { signal });
        throwIfAborted(signal);
      },
    };
  }

  function collector(
    tenantId: string,
    actorId: string,
    requestId: string,
    auditId: string,
    action: ScheduleLiveAuditEntry["action"],
  ): CollectorServiceApi {
    const ports: CollectorPorts = {
      clock: options.clock,
      context: {
        requestId,
        auditId,
        localFixture: options.localFixture ?? false,
      },
      audit: auditFor(tenantId, actorId, action, auditId),
      evidence: tenantEvidence(tenantId),
      http: options.http,
      ...(options.browser === undefined ? {} : { browser: options.browser }),
    };
    return createCollectorService({
      ports,
      adapters: options.adapters,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    });
  }

  function resolvedTenant(ctx: PortalContext): string {
    try {
      const state = options.portal.getState(ctx).data;
      const organization = state?.current_organization;
      if (
        organization !== null &&
        organization !== undefined &&
        organization.organizationId === ctx.organizationId
      ) {
        return organization.tenantId;
      }
    } catch {
      // Fall through to the unresolved marker; never substitute an org id.
    }
    return "unresolved";
  }

  async function denialAudit(
    ctx: PortalContext,
    action: ScheduleLiveAuditEntry["action"],
    requestId: string,
    auditId: string,
    code: string,
    input: unknown,
  ): Promise<void> {
    await options.audit.record({
      tenant_id: resolvedTenant(ctx),
      actor_id: ctx.identity.userId,
      action,
      request_id: requestId,
      audit_id: auditId,
      carrier: null,
      status: "blocked",
      issue_code: code,
      at: options.clock.now().toISOString(),
      input_sha256: input === undefined ? null : digest(input),
    });
  }

  function envelopeStatus(body: unknown, fallback: string): string {
    if (typeof body === "object" && body !== null && typeof (body as { status?: unknown }).status === "string") {
      return (body as { status: string }).status;
    }
    return fallback;
  }

  return {
    async carriers(ctx, operation) {
      const requestId = operation?.requestId ?? identifier("schedule-live-req");
      const auditId = identifier("schedule-live-audit");
      let tenantId: string;
      try {
        tenantId = (await member(ctx, "carriers")).tenantId;
      } catch (error) {
        const code = error instanceof PortalError ? error.code : "schedule_live_membership_required";
        await denialAudit(ctx, "carriers", requestId, auditId, code, undefined);
        throw error;
      }
      const service = collector(tenantId, ctx.identity.userId, requestId, auditId, "carriers");
      const result = service.carriers();
      await options.audit.record({
        tenant_id: tenantId,
        actor_id: ctx.identity.userId,
        action: "carriers",
        request_id: requestId,
        audit_id: auditId,
        carrier: null,
        status: envelopeStatus(result.envelope, "success"),
        issue_code: null,
        at: options.clock.now().toISOString(),
        input_sha256: null,
      });
      return { status: "success", body: result.envelope };
    },
    async locations(ctx, input, operation) {
      const requestId = operation?.requestId ?? identifier("schedule-live-req");
      const auditId = identifier("schedule-live-audit");
      const parsed = parseScheduleLiveLocationsRequest(input);
      let tenantId: string;
      try {
        tenantId = (await member(ctx, "locations")).tenantId;
        if (!carrierAllowed(tenantId, parsed.carrier)) {
          throw new PortalError("schedule_live_carrier_denied");
        }
      } catch (error) {
        const code = error instanceof PortalError ? error.code : "schedule_live_role_denied";
        await denialAudit(ctx, "locations", requestId, auditId, code, parsed);
        throw error;
      }
      const service = collector(tenantId, ctx.identity.userId, requestId, auditId, "locations");
      const result = await service.resolveLocations(
        {
          carrier: parsed.carrier,
          text: parsed.text,
          countryCode: parsed.country_code ?? null,
          locationId: parsed.carrier_location_id ?? null,
        },
        operation?.signal === undefined ? {} : { signal: operation.signal },
      );
      const status = envelopeStatus(result.envelope, "unavailable");
      await options.audit.record({
        tenant_id: tenantId,
        actor_id: ctx.identity.userId,
        action: "locations",
        request_id: requestId,
        audit_id: auditId,
        carrier: parsed.carrier,
        status,
        issue_code: status === "success" ? null : status,
        at: options.clock.now().toISOString(),
        input_sha256: digest(parsed),
      });
      return { status: status as ScheduleLiveResponse["status"], body: result.envelope };
    },
    async search(ctx, input, operation) {
      const requestId = operation?.requestId ?? identifier("schedule-live-req");
      const auditId = identifier("schedule-live-audit");
      const parsed = parseScheduleLiveSearchRequest(input);
      let tenantId: string;
      try {
        tenantId = (await member(ctx, "search")).tenantId;
        if (!carrierAllowed(tenantId, parsed.carrier)) {
          throw new PortalError("schedule_live_carrier_denied");
        }
      } catch (error) {
        const code = error instanceof PortalError ? error.code : "schedule_live_role_denied";
        await denialAudit(ctx, "search", requestId, auditId, code, parsed);
        throw error;
      }
      const service = collector(tenantId, ctx.identity.userId, requestId, auditId, "search");
      const result = await service.query(
        parsed,
        operation?.signal === undefined ? {} : { signal: operation.signal },
      );
      const status = envelopeStatus(result.envelope, "unavailable");
      await options.audit.record({
        tenant_id: tenantId,
        actor_id: ctx.identity.userId,
        action: "search",
        request_id: requestId,
        audit_id: auditId,
        carrier: parsed.carrier,
        status,
        issue_code: status === "success" ? null : status,
        at: options.clock.now().toISOString(),
        input_sha256: digest(parsed),
      });
      return { status: status as ScheduleLiveResponse["status"], body: result.envelope };
    },
    async readEvidence(ctx, reference, operation) {
      const requestId = operation?.requestId ?? identifier("schedule-live-req");
      const auditId = identifier("schedule-live-audit");
      const tenantId = (await member(ctx, "carriers")).tenantId;
      const match = EVIDENCE_REFERENCE.exec(reference);
      if (match === null) {
        await denialAudit(ctx, "evidence_read", requestId, auditId, "evidence_reference_invalid", undefined);
        throw new PortalError("evidence_reference_invalid");
      }
      const store = tenantEvidence(tenantId);
      let bytes: Uint8Array;
      try {
        bytes = await store.read(reference);
      } catch {
        await denialAudit(ctx, "evidence_read", requestId, auditId, "evidence_not_found", undefined);
        throw new PortalError("evidence_not_found");
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== match[3]) {
        await denialAudit(ctx, "evidence_read", requestId, auditId, "evidence_readback_failed", undefined);
        throw new PortalError("evidence_readback_failed");
      }
      await options.audit.record({
        tenant_id: tenantId,
        actor_id: ctx.identity.userId,
        action: "evidence_read",
        request_id: requestId,
        audit_id: auditId,
        carrier: match[2] ?? null,
        status: "success",
        issue_code: null,
        at: options.clock.now().toISOString(),
        input_sha256: null,
      });
      return { ref: reference, sha256, byte_length: bytes.byteLength };
    },
    async machineExecute(request) {
      const requestId = request.requestId ?? identifier("schedule-live-req");
      const auditId = identifier("schedule-live-audit");
      const action: ScheduleLiveAuditEntry["action"] =
        request.tool === "maritime.schedule.carriers"
          ? "carriers"
          : request.tool === "maritime.schedule.locations"
            ? "locations"
            : "search";
      const denied = (code: string): ScheduleLiveResponse => ({
        status: "blocked",
        body: createEnvelope({
          requestId,
          auditId,
          status: "blocked",
          data: null,
          blockers: [{ code, message: code, severity: "error" }],
        }),
      });
      try {
        // Personal access is session-bound; it does not grant machine/API Key access.
        if (isPersonalScheduleScope(options.personalAccess,request.tenantId) || action !== "carriers" && !options.policy.liveEnabled(request.tenantId)) {
          await options.audit.record({
            tenant_id: request.tenantId,
            actor_id: request.actorId,
            action,
            request_id: requestId,
            audit_id: auditId,
            carrier: null,
            status: "blocked",
            issue_code: "schedule_live_disabled",
            at: options.clock.now().toISOString(),
            input_sha256: null,
          });
          return denied("schedule_live_disabled");
        }
        const service = collector(
          request.tenantId,
          request.actorId,
          requestId,
          auditId,
          action,
        );
        let result: { readonly data: unknown; readonly envelope: unknown };
        if (action === "carriers") {
          result = service.carriers();
        } else if (action === "locations") {
          const parsed = parseScheduleLiveLocationsRequest(request.input);
          if (!carrierAllowed(request.tenantId, parsed.carrier)) {
            await options.audit.record({
              tenant_id: request.tenantId,
              actor_id: request.actorId,
              action,
              request_id: requestId,
              audit_id: auditId,
              carrier: parsed.carrier,
              status: "blocked",
              issue_code: "schedule_live_carrier_denied",
              at: options.clock.now().toISOString(),
              input_sha256: digest(parsed),
            });
            return denied("schedule_live_carrier_denied");
          }
          result = await service.resolveLocations(
            {
              carrier: parsed.carrier,
              text: parsed.text,
              countryCode: parsed.country_code ?? null,
              locationId: parsed.carrier_location_id ?? null,
            },
            request.signal === undefined ? {} : { signal: request.signal },
          );
        } else {
          const parsed = parseScheduleLiveSearchRequest(request.input);
          if (!carrierAllowed(request.tenantId, parsed.carrier)) {
            await options.audit.record({
              tenant_id: request.tenantId,
              actor_id: request.actorId,
              action,
              request_id: requestId,
              audit_id: auditId,
              carrier: parsed.carrier,
              status: "blocked",
              issue_code: "schedule_live_carrier_denied",
              at: options.clock.now().toISOString(),
              input_sha256: digest(parsed),
            });
            return denied("schedule_live_carrier_denied");
          }
          result = await service.query(
            parsed,
            request.signal === undefined ? {} : { signal: request.signal },
          );
        }
        const status = envelopeStatus(result.envelope, "unavailable");
        await options.audit.record({
          tenant_id: request.tenantId,
          actor_id: request.actorId,
          action,
          request_id: requestId,
          audit_id: auditId,
          carrier:
            action === "carriers"
              ? null
              : (request.input as { readonly carrier?: string }).carrier ?? null,
          status,
          issue_code: status === "success" ? null : status,
          at: options.clock.now().toISOString(),
          input_sha256: action === "carriers" ? null : digest(request.input),
        });
        return { status: status as ScheduleLiveResponse["status"], body: result.envelope };
      } catch (error) {
        const code = error instanceof PortalError ? error.code : "schedule_live_unavailable";
        await options.audit.record({
          tenant_id: request.tenantId,
          actor_id: request.actorId,
          action,
          request_id: requestId,
          audit_id: auditId,
          carrier: null,
          status: code.startsWith("schedule_live_") && code !== "schedule_live_unavailable" ? "blocked" : "unavailable",
          issue_code: code,
          at: options.clock.now().toISOString(),
          input_sha256: null,
        });
        return code.startsWith("schedule_live_") && code !== "schedule_live_unavailable"
          ? denied(code)
          : {
              status: "unavailable",
              body: createEnvelope({
                requestId,
                auditId,
                status: "unavailable",
                data: null,
                blockers: [
                  { code, message: code, severity: "error" as const },
                ],
              }),
            };
      }
    },
  };
}

export { ScheduleLiveContractError };
