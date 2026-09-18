import { isAbsolute, resolve } from "node:path";

import type { PortalService } from "../../access-gateway/portal/service";
import { normalizeCarrierId } from "../schedule-collector/carriers/aliases";
import { CollectorRuntimeError } from "../schedule-collector/errors";
import type { CarrierHttpPort } from "../schedule-collector/ports";
import { createControlledHttpTransport } from "../schedule-collector/transport/http";
import { createCoscoLiveTransportPolicy } from "../schedule-collector/transport/cosco-live";
import { createHmmLiveTransportPolicy } from "../schedule-collector/transport/hmm-live";
import { createNodePinnedConnector } from "../schedule-collector/transport/node-connector";
import { createOneLiveTransportPolicy } from "../schedule-collector/transport/one-live";
import type { TransportPolicy } from "../schedule-collector/transport/config";
import {
  createScheduleLiveService,
  type ScheduleLiveAuditSink,
  type ScheduleLivePolicy,
  type ScheduleLiveServiceApi,
} from "./service";

const TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CARRIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u;

/** Parses `tenant_a,tenant_b`; empty/missing returns an empty allowlist. */
export function parseScheduleLiveTenantAllowlist(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => !TENANT.test(entry))) {
    throw new Error("schedule_live_tenant_allowlist_invalid");
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error("schedule_live_tenant_allowlist_invalid");
  }
  return entries;
}

/** Parses `tenant=ONE,COSCO;tenant2=ONE`; empty/missing means "all carriers". */
export function parseScheduleLiveCarrierAllowlist(
  value: string | undefined,
): Readonly<Record<string, readonly string[]>> {
  if (value === undefined || value.trim() === "") return {};
  const result: Record<string, readonly string[]> = {};
  for (const group of value.split(";").map((entry) => entry.trim()).filter(Boolean)) {
    const separator = group.indexOf("=");
    if (separator <= 0) throw new Error("schedule_live_carrier_allowlist_invalid");
    const tenant = group.slice(0, separator).trim();
    const carriers = group.slice(separator + 1).split(",").map((entry) => entry.trim()).filter(Boolean);
    if (!TENANT.test(tenant) || carriers.length === 0 || carriers.some((carrier) => !CARRIER.test(carrier))) {
      throw new Error("schedule_live_carrier_allowlist_invalid");
    }
    if (new Set(carriers).size !== carriers.length) {
      throw new Error("schedule_live_carrier_allowlist_invalid");
    }
    result[tenant] = carriers;
  }
  return result;
}

function liveHttpPort(policy: TransportPolicy): CarrierHttpPort {
  return createControlledHttpTransport({
    policy,
    connector: createNodePinnedConnector({
      maxResponseBytes: policy.maxResponseBytes,
      timeoutMs: policy.timeoutMs,
    }),
  });
}

/**
 * Production assembly: real pinned connector per verified carrier, deployment
 * tenant allowlist, tenant-scoped evidence root and append-only audit sink.
 * Unimplemented carriers keep returning `not_implemented`.
 */
export function createProductionScheduleLiveService(options: {
  readonly portal: Pick<PortalService, "getState">;
  readonly audit: ScheduleLiveAuditSink;
  readonly evidenceRoot: string;
  readonly tenantAllowlist: readonly string[];
  readonly carrierAllowlist?: Readonly<Record<string, readonly string[]>>;
  readonly now?: () => Date;
}): ScheduleLiveServiceApi {
  if (!isAbsolute(options.evidenceRoot)) {
    throw new Error("schedule_live_evidence_root_invalid");
  }
  const allowedTenants = new Set(options.tenantAllowlist);
  if ([...allowedTenants].some((tenant) => !TENANT.test(tenant))) {
    throw new Error("schedule_live_tenant_allowlist_invalid");
  }
  const carrierAllowlist = options.carrierAllowlist ?? {};
  const ports = new Map<string, CarrierHttpPort>([
    ["ONE", liveHttpPort(createOneLiveTransportPolicy())],
    ["COSCO", liveHttpPort(createCoscoLiveTransportPolicy())],
    ["HMM", liveHttpPort(createHmmLiveTransportPolicy())],
  ]);
  const http: CarrierHttpPort = {
    request(input) {
      const carrier = normalizeCarrierId(input.carrier) ?? input.carrier;
      const port = ports.get(carrier);
      if (port === undefined) {
        return Promise.reject(
          new CollectorRuntimeError(
            "not_implemented",
            "unavailable",
            "collector_carrier_not_implemented",
          ),
        );
      }
      return port.request(input);
    },
  };
  const policy: ScheduleLivePolicy = {
    liveEnabled: (tenantId) => allowedTenants.has(tenantId),
    carrierEnabled: (tenantId, carrier) => {
      const allowed = carrierAllowlist[tenantId];
      if (allowed === undefined) return true;
      const normalized = normalizeCarrierId(carrier) ?? carrier;
      return allowed.some((entry) => (normalizeCarrierId(entry) ?? entry) === normalized);
    },
  };
  const now = options.now ?? (() => new Date());
  return createScheduleLiveService({
    portal: options.portal,
    policy,
    clock: { now },
    audit: options.audit,
    evidenceRoot: resolve(options.evidenceRoot),
    adapters: [],
    http,
  });
}
