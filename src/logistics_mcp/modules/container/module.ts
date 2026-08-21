import {
  containerPlanSummaryHandler,
  containerPlanSummaryToolContract,
} from "../../domains/container/service";
import type { ModuleDefinition } from "../../module-runtime";

export const containerModule: ModuleDefinition = {
  manifest: {
    module_id: "container",
    version: "2026-08-21.v0",
    risk_level: "T0",
    required_capabilities: [],
    optional_capabilities: [],
    standard_ids: ["module-runtime.v0", "platform.contracts"],
    lifecycle: "static",
  },
  mount: ({ tools }) => {
    tools.register({
      name: "container.plan_summary",
      title: "装柜摘要计算",
      description: "汇总理论容量、运营目标和超限提醒。",
      inputSchemaId: "urn:logistics-mcp:container.plan_summary:2026-08-11.v1",
      outputSchemaId: "container-plan.schema.json",
      permission: "container:calculate",
      kind: "read",
      riskLevel: "T0",
      standardRefs: ["module-runtime.v0", "platform.contracts"],
      handler: containerPlanSummaryHandler,
      inputSchema: containerPlanSummaryToolContract.inputSchema,
      validateOutput: containerPlanSummaryToolContract.validateOutput,
      ...(containerPlanSummaryToolContract.outputSchema === undefined
        ? {}
        : { outputSchema: containerPlanSummaryToolContract.outputSchema }),
    });
  },
};
