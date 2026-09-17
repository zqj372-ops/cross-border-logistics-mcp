import { randomUUID } from "node:crypto";
import { z } from "zod";
import { APPLICATION_MCP_TOOLS, isApplicationMcpIdentity, isScheduleMcpIdentity, SCHEDULE_MCP_TOOLS, type ApplicationMcpTool, type ScheduleMcpTool } from "../../../../src/logistics_mcp/platform/application-tools";
import { parseExecutionContext } from "../../../../src/logistics_mcp/platform/context";
import { validateShortLivedToken } from "../../../../src/logistics_mcp/platform/security";
import type { ApplicationMcpJwtClaims } from "../../contracts";
import type { JwtSigningProvider, RateLimitRepository } from "../../ports";
import { BusinessAccessError } from "./contracts";
import type { BusinessAccessService } from "./service";

export const APPLICATION_MCP_EXCHANGE_VERSION = "application-mcp-exchange@2026-09-06.v1" as const;
const EXCHANGE_TOOLS = Object.freeze([...APPLICATION_MCP_TOOLS, ...SCHEDULE_MCP_TOOLS] as const);
type CredentialTool = ApplicationMcpTool | ScheduleMcpTool;
export const applicationMcpExchangeSchema = z.object({ schema_version: z.literal(APPLICATION_MCP_EXCHANGE_VERSION),
  requested_tool_names: z.array(z.enum(EXCHANGE_TOOLS)).min(1).max(8).refine(values => new Set(values).size === values.length),
}).strict();

export class ApplicationMcpAccessService {
  constructor(readonly options: {
    authority: Pick<BusinessAccessService, "authorizeMcpApiKey" | "authorizeMcpCredential">;
    signer: Pick<JwtSigningProvider, "sign">; verifier: { verify(token: string): Promise<Record<string, unknown>> };
    limiter: Pick<RateLimitRepository, "reserve">; issuer: string; audience: string;
  }) {}

  async exchange(apiKey: string, body: unknown, clientIp: string) {
    const parsed = applicationMcpExchangeSchema.safeParse(body);
    if (!parsed.success) throw new BusinessAccessError("business_body_invalid");
    const requested = parsed.data.requested_tool_names;
    const scheduleProfile = requested.every((tool) => SCHEDULE_MCP_TOOLS.includes(tool as ScheduleMcpTool));
    const businessProfile = requested.every((tool) => APPLICATION_MCP_TOOLS.includes(tool as ApplicationMcpTool));
    if (!scheduleProfile && !businessProfile) throw new BusinessAccessError("business_body_invalid");
    const mcpProfile = scheduleProfile && requested.some((tool) => SCHEDULE_MCP_TOOLS.includes(tool as ScheduleMcpTool))
      ? "schedule-live-v1" as const
      : "business-v1" as const;
    const current = await this.options.authority.authorizeMcpApiKey(apiKey, parsed.data.requested_tool_names, false);
    const now = Math.floor(Date.now()/1000);
    if (!await this.options.limiter.reserve({ ...current, clientIp, nowSeconds: now })) throw new BusinessAccessError("business_rate_limited");
    const claims: ApplicationMcpJwtClaims = {
      iss: this.options.issuer, aud: this.options.audience, sub: current.credentialId, iat: now, exp: now+300,
      jti: `jwt_${randomUUID().replaceAll("-", "")}`, tenant_id: current.tenantId, actor_id: current.credentialId,
      actor_role: "service", roles: ["service"], scopes: current.toolNames.map(tool => `tool:${tool}` as const),
      client_id: current.clientId, session_id: `auth_${randomUUID().replaceAll("-", "")}`, mcp_profile: mcpProfile,
    };
    const signed = await this.options.signer.sign(claims);
    // Validate the signed payload and re-read all live grants after asynchronous signing.
    const verified = await this.verify(signed.token, current.toolNames);
    if (verified.credentialId !== current.credentialId || verified.clientId !== current.clientId || verified.tenantId !== current.tenantId
      || verified.toolNames.length !== current.toolNames.length) throw new BusinessAccessError("business_authentication_failed");
    return { schema_version: "application-mcp-access@2026-09-06.v1", status: "success", data: {
      access_token: signed.token, token_type: "Bearer", expires_in: 300, mcp_profile: mcpProfile, tool_names: current.toolNames,
    }, reason_codes: [] };
  }

  async verify(token: string, required: readonly CredentialTool[] = []) {
    const claims = validateShortLivedToken(await this.options.verifier.verify(token), { issuer: this.options.issuer, audience: this.options.audience, maxLifetimeSeconds: 300 });
    const identity = { role: claims.actor_role, roles: claims.roles, scopes: claims.scopes, profile: claims.mcp_profile };
    const identityOk = claims.mcp_profile === "business-v1"
      ? isApplicationMcpIdentity(identity)
      : claims.mcp_profile === "schedule-live-v1" && isScheduleMcpIdentity(identity);
    if (Object.keys(claims).sort().join(",") !== "actor_id,actor_role,aud,client_id,exp,iat,iss,jti,mcp_profile,roles,scopes,session_id,sub,tenant_id"
      || !identityOk
      || claims.sub !== claims.actor_id || !/^bkey_[a-f0-9]{24}$/u.test(String(claims.actor_id))) throw new BusinessAccessError("business_authentication_failed");
    const context = parseExecutionContext({ tenant_id: claims.tenant_id, actor_id: claims.actor_id, actor_role: claims.actor_role,
      roles: claims.roles, scopes: claims.scopes, client_id: claims.client_id, session_id: claims.session_id, expires_at: claims.exp, mcp_profile: claims.mcp_profile });
    const tools = context.scopes.map(scope => scope.slice(5)) as CredentialTool[];
    if (required.some(tool => !tools.includes(tool))) throw new BusinessAccessError("business_authorization_denied");
    return this.options.authority.authorizeMcpCredential({ credentialId: context.actorId, tenantId: context.tenantId, clientId: context.clientId, requestedToolNames: tools });
  }
}
