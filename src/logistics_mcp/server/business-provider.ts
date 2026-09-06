import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createFetchJsonClient, type FetchImplementation } from "../adapters/http-client";
import { BUSINESS_MCP_TOOLS } from "../platform/application-tools";
import { ENVELOPE_STATUSES, envelopeSchema, type SourceRef } from "../platform/envelope";
import { authorizeTool, getToolPolicy } from "../platform/rbac";
import { requireRequestCredential } from "./request-credential";
import type { ToolDefinition } from "./tool-registry";
import { businessMcpInputs, businessMcpResultSchema } from "../../../services/access-gateway/portal/business-access/mcp-contracts";
import { assertBusinessMachineExecutionResult } from "../../../services/access-gateway/portal/business-access/http";

export function createBusinessRuntimeProvider(options: { baseUrl: string; allowedHosts: readonly string[]; runtimeSecret: string; fetchImpl?: FetchImplementation }) {
  if (options.runtimeSecret.length < 32) throw new Error("mcp_provider_secret_invalid");
  const client = createFetchJsonClient({ enabled: true, baseUrl: options.baseUrl, allowedHosts: options.allowedHosts, timeoutMs: 25_000, maxResponseBytes: 2 * 1024 * 1024,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const definitions: readonly ToolDefinition[] = BUSINESS_MCP_TOOLS.map(operation => ({
    name: operation, title: operation, description: "已授权业务查询；来源版本、人工复核和未就绪状态保持原样。",
    inputSchemaId: `${operation}.input@2026-09-06.v1`, outputSchemaId: "business-mcp-result@2026-09-06.v1",
    permission: getToolPolicy(operation).permission, kind: "read", riskLevel: "T1", moduleId: "business-api", moduleVersion: "1.0.0",
    inputSchema: businessMcpInputs[operation], statusMapping: ENVELOPE_STATUSES,
    outputSchema: envelopeSchema.extend({ data: businessMcpResultSchema.nullable() }),
    validateOutput(data) { if (data !== null) businessMcpResultSchema.parse(data); },
    async handler(input, context, signal) {
      authorizeTool(context, operation);
      const requestId = `req_${randomUUID().replaceAll("-", "")}`;
      try {
        const result = await client.post(`/access/v2/application/mcp/tools/${operation}`, {
          schema_version: "application-mcp-call@2026-09-06.v1", request_id: requestId, input,
        }, { authorization: `Bearer ${requireRequestCredential()}`, "x-freightclaw-runtime-token": options.runtimeSecret }, signal);
        const source = assertBusinessMachineExecutionResult(result, requestId, operation);
        const data = businessMcpResultSchema.parse({ schema_version: "business-mcp-result@2026-09-06.v1", operation, result: source });
        const notices = source.reason_codes.map(code => ({ code, message: code, severity: "warning" as const }));
        return { status: source.status, data,
          sourceRefs: Array.isArray(source.source_refs) ? source.source_refs as SourceRef[] : [],
          warnings: source.status === "success" ? notices : [],
          blockers: source.status !== "success" ? (notices.length ? notices : [{ code: "business_source_unready", message: "业务来源未就绪。", severity: "error" as const }]) : [],
          reviewStatus: source.status === "manual_review" ? "manual_review" : "not_required",
        };
      } catch {
        return { status: "unavailable", data: null, blockers: [{ code: "business_provider_unavailable", message: "业务提供方暂不可用。", severity: "error" }] };
      }
    },
  }));
  return Object.freeze({ definitions });
}

export function loadBusinessRuntimeProvider(environment: NodeJS.ProcessEnv) {
  const baseUrl = environment.MCP_BUSINESS_PROVIDER_URL?.trim();
  const host = environment.MCP_BUSINESS_PROVIDER_ALLOWED_HOST?.trim();
  const secretFile = environment.MCP_BUSINESS_PROVIDER_SECRET_FILE?.trim();
  if (!baseUrl || !host || !secretFile || !isAbsolute(secretFile)) throw new Error("MCP business provider URL, host and secret file are required.");
  const stat = lstatSync(secretFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error("mcp_provider_secret_invalid");
  return createBusinessRuntimeProvider({ baseUrl, allowedHosts: [host], runtimeSecret: readFileSync(secretFile, "utf8").trim() });
}
