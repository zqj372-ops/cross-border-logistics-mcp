import type { QuoteAdapter } from "../../adapters/ports";
import {
  quoteV2InputSchema,
  quoteV2ResultSchema,
} from "../../adapters/quote/quote-v2-contract";
import { calculateCanadaFinalMile } from "../../domains/quote/canada-final-mile";
import { quoteV2EnvelopeSchema } from "../../domains/quote/v2-envelope";
import type { ModuleDefinition } from "../../module-runtime";

export const CANADA_FINAL_MILE_QUOTE_CAPABILITY =
  "quote.canada_final_mile.adapter" as const;
export const CANADA_FINAL_MILE_QUOTE_CAPABILITY_VERSION =
  "quote-adapter-port@2026-09-02.v1" as const;

function recordInput(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Quote input must be an object after contract validation.");
  }
  return input as Record<string, unknown>;
}

export function createCanadaFinalMileQuoteModule(): ModuleDefinition {
  return {
    manifest: {
      module_id: "canada-final-mile-quote",
      version: "2026-09-02.v1",
      risk_level: "T1",
      required_capabilities: [{
        name: CANADA_FINAL_MILE_QUOTE_CAPABILITY,
        version: CANADA_FINAL_MILE_QUOTE_CAPABILITY_VERSION,
      }],
      optional_capabilities: [],
      standard_ids: ["module-runtime.v0", "platform.contracts"],
      lifecycle: "static",
    },
    mount: ({ capabilities, tools }) => {
      const adapter = capabilities.resolve<QuoteAdapter>(
        CANADA_FINAL_MILE_QUOTE_CAPABILITY,
      );
      tools.register({
        name: "quote.canada_final_mile.calculate",
        title: "加拿大尾程报价预览",
        description: "通过受控 T1 读取接口获取不可发送的加拿大尾程报价预览。",
        inputSchemaId: "urn:logistics-mcp:quote.canada_final_mile.calculate:2026-08-13.v2",
        outputSchemaId: "quote-envelope-v2.schema.json",
        permission: "quote:calculate",
        kind: "read",
        idempotentHint: true,
        riskLevel: "T1",
        standardRefs: ["module-runtime.v0", "platform.contracts"],
        handler: (input, context, signal) =>
          calculateCanadaFinalMile(adapter, recordInput(input), context, signal),
        inputSchema: quoteV2InputSchema,
        validateOutput: (data) => {
          if (data !== null) quoteV2ResultSchema.parse(data);
        },
        outputSchema: quoteV2EnvelopeSchema,
      });
    },
  };
}
