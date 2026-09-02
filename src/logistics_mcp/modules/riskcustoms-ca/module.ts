import type { CustomsAdapter } from "../../adapters/ports";
import {
  estimateCanadaCustoms,
  customsEstimateInputSchema,
  customsEstimateOutputValidator,
} from "../../domains/customs/ca-estimate";
import {
  searchCanadaCustoms,
  customsSearchInputSchema,
  customsSearchOutputValidator,
} from "../../domains/customs/ca-search";
import type { ModuleDefinition } from "../../module-runtime";

export const RISK_CUSTOMS_CA_CAPABILITY = "customs.ca.adapter" as const;
export const RISK_CUSTOMS_CA_CAPABILITY_VERSION =
  "customs-adapter-port@2026-09-02.v1" as const;

function recordInput(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Customs input must be an object after contract validation.");
  }
  return input as Record<string, unknown>;
}

export function createRiskCustomsCaModule(): ModuleDefinition {
  return {
    manifest: {
      module_id: "riskcustoms-ca",
      version: "2026-09-02.v1",
      risk_level: "T1",
      required_capabilities: [{
        name: RISK_CUSTOMS_CA_CAPABILITY,
        version: RISK_CUSTOMS_CA_CAPABILITY_VERSION,
      }],
      optional_capabilities: [],
      standard_ids: ["module-runtime.v0", "platform.contracts"],
      lifecycle: "static",
    },
    mount: ({ capabilities, tools }) => {
      const adapter = capabilities.resolve<CustomsAdapter>(
        RISK_CUSTOMS_CA_CAPABILITY,
      );
      tools.register({
        name: "customs.ca.search",
        title: "加拿大关务候选查询",
        description: "通过 RiskCustoms 的受控 status→query 读取合同查询关务候选。",
        inputSchemaId: "urn:logistics-mcp:customs.ca.search:2026-08-11.v1",
        outputSchemaId: "customs-search-result.schema.json",
        permission: "tariff:read",
        kind: "read",
        idempotentHint: true,
        riskLevel: "T1",
        standardRefs: ["module-runtime.v0", "platform.contracts"],
        handler: (input, context, signal) =>
          searchCanadaCustoms(adapter, recordInput(input), context, signal),
        inputSchema: customsSearchInputSchema,
        validateOutput: customsSearchOutputValidator,
      });
      tools.register({
        name: "customs.ca.estimate",
        title: "加拿大税费估算（未开放）",
        description: "保留正式估算合同入口；当前固定不可用且不产生上游请求。",
        inputSchemaId: "urn:logistics-mcp:customs.ca.estimate:2026-08-11.v1",
        outputSchemaId: "customs-assessment.schema.json",
        permission: "tariff:estimate",
        kind: "read",
        idempotentHint: true,
        riskLevel: "T1",
        standardRefs: ["module-runtime.v0", "platform.contracts"],
        handler: (input, context, signal) =>
          estimateCanadaCustoms(adapter, recordInput(input), context, signal),
        inputSchema: customsEstimateInputSchema,
        validateOutput: customsEstimateOutputValidator,
      });
    },
  };
}
