import type { FreightcomRatePort } from "../../adapters/ports";
import {
  createFreightcomLtlToolHandler,
  freightcomLtlEnvelopeSchema,
  freightcomLtlInputSchema,
  validateFreightcomLtlOutput,
} from "../../domains/quote/freightcom-ltl-tool";
import type { ModuleDefinition } from "../../module-runtime";

export const FREIGHTCOM_RATE_CAPABILITY =
  "quote.freightcom_ltl.rate_adapter" as const;
export const FREIGHTCOM_RATE_CAPABILITY_VERSION =
  "freightcom-rate-port@2026-08-26.v1" as const;

export function createFreightcomLtlModule(): ModuleDefinition {
  return {
    manifest: {
      module_id: "freightcom-ltl",
      version: "2026-08-26.v1",
      risk_level: "T1",
      required_capabilities: [{
        name: FREIGHTCOM_RATE_CAPABILITY,
        version: FREIGHTCOM_RATE_CAPABILITY_VERSION,
      }],
      optional_capabilities: [],
      standard_ids: ["module-runtime.v0", "platform.contracts"],
      lifecycle: "static",
    },
    mount: ({ capabilities, tools }) => {
      const adapter = capabilities.resolve<FreightcomRatePort>(
        FREIGHTCOM_RATE_CAPABILITY,
      );
      tools.register({
        name: "quote.freightcom_ltl.preview",
        title: "Freightcom 测试 LTL 报价预览",
        description: "提交 pallet LTL 测试询价并轮询结果；仅供人工复核，不可下单。",
        inputSchemaId: "urn:logistics-mcp:quote.freightcom_ltl.preview:2026-08-26.v1",
        outputSchemaId: "urn:logistics-mcp:quote.freightcom_ltl.preview:result:2026-08-26.v1",
        permission: "quote:calculate",
        kind: "read",
        idempotentHint: false,
        riskLevel: "T1",
        standardRefs: ["module-runtime.v0", "platform.contracts"],
        handler: createFreightcomLtlToolHandler(adapter),
        inputSchema: freightcomLtlInputSchema,
        validateOutput: validateFreightcomLtlOutput,
        outputSchema: freightcomLtlEnvelopeSchema,
      });
    },
  };
}
