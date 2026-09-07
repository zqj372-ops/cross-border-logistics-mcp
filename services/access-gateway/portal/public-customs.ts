import { inputSchema } from "./business/customs-client";
import { batchInputSchema, singleInputSchema } from "./business/tax-client";
import { PORTAL_BUSINESS_SCHEMA_VERSION, type PortalBusinessService, type PortalBusinessOperation, type PortalBusinessClientResult, type PortalBusinessEnvelope } from "./business/service";
import type { PublicQuota, PublicQuotaStore } from "./public-quota";

export class PortalPublicCustomsService {
  readonly #business: PortalBusinessService;
  readonly #quota: PublicQuotaStore;
  readonly #now: () => number;
  constructor(options: { business: PortalBusinessService; quota: PublicQuotaStore; now?: () => number }) { this.#business = options.business; this.#quota = options.quota; this.#now = options.now ?? Date.now; }
  status(address: string) { return this.#quota.read(address, this.#now()); }
  async execute(address: string, operation: PortalBusinessOperation, input: unknown, requestId: string, batch: boolean): Promise<{ httpStatus: number; body: PortalBusinessClientResult | PortalBusinessEnvelope<never>; quota?: PublicQuota }> {
    const fail = (httpStatus: number, status: "blocked" | "needs_input" | "unavailable", reason: string, quota?: PublicQuota) => ({ httpStatus, body: { schema_version: PORTAL_BUSINESS_SCHEMA_VERSION, status, data: null, reason_codes: [reason] }, ...(quota ? { quota } : {}) });
    if (!["customs.query", "customs.tax.estimate"].includes(operation) || batch && operation !== "customs.tax.estimate") return fail(404, "blocked", "route_not_found");
    const parsed = (operation === "customs.query" ? inputSchema : batch ? batchInputSchema : singleInputSchema).safeParse(input);
    if (!parsed.success) return fail(400, "needs_input", "public_customs_input_invalid");
    if (!this.#business.publicAvailable(operation)) return fail(503, "unavailable", "public_customs_unavailable");
    try {
      const count = batch && "items" in parsed.data ? parsed.data.items.length : 1;
      const quota = this.#quota.reserve(address, count, this.#now());
      if (!quota.allowed) return fail(429, "blocked", quota.remaining === 0 ? "public_daily_limit_reached" : "public_daily_limit_insufficient", quota);
      const body = await this.#business.executePublic(operation, parsed.data, requestId, batch);
      return { httpStatus: 200, body, quota };
    } catch { return fail(503, "unavailable", "public_customs_unavailable"); }
  }
}
