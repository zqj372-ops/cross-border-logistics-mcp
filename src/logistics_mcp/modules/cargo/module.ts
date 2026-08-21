import {
  cargoToolContract,
  cargoToolHandler,
} from "../../domains/cargo/tool";
import type { ModuleDefinition } from "../../module-runtime";

export const cargoModule: ModuleDefinition = {
  manifest: {
    module_id: "cargo",
    version: "2026-08-21.v0",
    risk_level: "T0",
    required_capabilities: [],
    optional_capabilities: [],
    standard_ids: ["module-runtime.v0", "platform.contracts"],
    lifecycle: "static",
  },
  mount: ({ tools }) => {
    tools.register({
      name: "cargo.calculate",
      title: "货物与分泡计算",
      description: "计算体积、体积重、分泡和计费重。",
      inputSchemaId: "urn:logistics-mcp:cargo.calculate:2026-08-11.v1",
      outputSchemaId: "cargo-result.schema.json",
      permission: "quote:calculate",
      kind: "read",
      riskLevel: "T0",
      standardRefs: ["module-runtime.v0", "platform.contracts"],
      handler: cargoToolHandler,
      inputSchema: cargoToolContract.inputSchema,
      validateOutput: cargoToolContract.validateOutput,
      ...(cargoToolContract.outputSchema === undefined
        ? {}
        : { outputSchema: cargoToolContract.outputSchema }),
    });
  },
};
