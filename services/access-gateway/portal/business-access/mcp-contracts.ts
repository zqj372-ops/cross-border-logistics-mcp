import { z } from "zod";
import { inputSchema as customs } from "../business/customs-client";
import { singleInputSchema as tax } from "../business/tax-client";
import { zoneInputSchema as zone, extractInputSchema as extract } from "../business/quote-client";
import { freightcomInputSchema as freightcom } from "../business/freightcom-client";
import businessResponse from "../../../../schemas/access-gateway/business-call-response.schema.json" with { type: "json" };
import { BUSINESS_MCP_TOOLS, type BusinessMcpTool } from "../../../../src/logistics_mcp/platform/application-tools";

export const businessMcpInputs: Readonly<Record<BusinessMcpTool, z.ZodType>> = Object.freeze({
  "customs.query": customs, "customs.tax.estimate": tax, "quote.zone_preview": zone,
  "quote.ai_extract_preview": extract, "quote.freightcom_ltl.preview": freightcom,
});
export const businessMcpResultSchema = z.object({ schema_version: z.literal("business-mcp-result@2026-09-06.v1"),
  operation: z.enum(BUSINESS_MCP_TOOLS), result: z.fromJSONSchema(businessResponse as Parameters<typeof z.fromJSONSchema>[0]),
}).strict();
