import {
  agentContextToolContract,
  createAgentAccessRuntime,
  type AgentAccessRuntime,
} from "../../agent-context/runtime";
import type { ModuleDefinition } from "../../module-runtime";

export function createAgentAccessModule(
  runtime: AgentAccessRuntime = createAgentAccessRuntime(),
): ModuleDefinition {
  return {
    manifest: {
      module_id: "agent-access",
      version: "2026-08-21.v0",
      risk_level: "T0",
      required_capabilities: [],
      optional_capabilities: [],
      standard_ids: ["module-runtime.v0", "platform.contracts", "agent-access.v0"],
      lifecycle: "static",
    },
    mount: ({ tools }) => {
      tools.register({
        name: "system.agent_context.get",
        title: "Agent 标准上下文",
        description: "读取 allowlisted Agent profile 对应的标准、规则和模块目录。",
        inputSchemaId: "urn:logistics-mcp:system.agent_context.get:2026-08-21.v1",
        outputSchemaId: "agent-context-envelope.schema.json",
        permission: "system:agent_context",
        kind: "read",
        riskLevel: "T0",
        standardRefs: ["module-runtime.v0", "platform.contracts", "agent-access.v0"],
        handler: (input) => runtime.getContext(input),
        inputSchema: agentContextToolContract.inputSchema,
        validateOutput: agentContextToolContract.validateOutput,
        ...(agentContextToolContract.outputSchema === undefined
          ? {}
          : { outputSchema: agentContextToolContract.outputSchema }),
      });
    },
  };
}
