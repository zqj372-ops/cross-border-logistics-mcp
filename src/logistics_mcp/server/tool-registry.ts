import {
  createEnvelope,
  ENVELOPE_STATUSES,
  type CalculationStep,
  type CreateEnvelopeInput,
  type EnvelopeData,
  type EnvelopeStatus,
  type Notice,
  type ReviewStatus,
  type ResponseEnvelope,
  type SourceRef,
} from "../platform/envelope";
import type { ExecutionContext } from "../platform/context";
import { authorizeTool } from "../platform/rbac";
import {
  getToolPolicy,
  phaseOneToolNames as allowlistedToolNames,
} from "../platform/rbac";

export const phaseOneToolNames = allowlistedToolNames;
export type PhaseOneToolName = (typeof phaseOneToolNames)[number];

export class HandlerUnavailableError extends Error {
  readonly code = "handler_unavailable";

  constructor() {
    super("The domain handler for this tool is not configured.");
    this.name = "HandlerUnavailableError";
  }
}

export interface DomainToolOutcome {
  readonly status: EnvelopeStatus;
  readonly data: EnvelopeData;
  readonly sourceRefs?: readonly SourceRef[];
  readonly assumptions?: readonly Notice[];
  readonly warnings?: readonly Notice[];
  readonly blockers?: readonly Notice[];
  readonly calculationTrace?: readonly CalculationStep[];
  readonly reviewStatus?: ReviewStatus;
}

export type DomainToolHandler = (
  input: unknown,
  context: ExecutionContext,
) => DomainToolOutcome | Promise<DomainToolOutcome>;

export interface ToolDefinition {
  readonly name: PhaseOneToolName;
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly permission: string;
  readonly kind: "read" | "write";
  readonly statusMapping: typeof ENVELOPE_STATUSES;
  readonly handler?: DomainToolHandler;
}

export interface ToolExecutionMetadata {
  readonly requestId: string;
  readonly auditId: string;
}

const outputSchemaByTool: Record<PhaseOneToolName, string> = {
  "knowledge.search_curated": "knowledge-search-result.schema.json",
  "system.get_data_status": "data-status.schema.json",
  "cargo.calculate": "cargo-result.schema.json",
  "container.plan_summary": "container-plan.schema.json",
  "quote.canada_final_mile.calculate": "quote-result.schema.json",
  "customs.ca.search": "customs-search-result.schema.json",
  "customs.ca.estimate": "customs-assessment.schema.json",
  "quote.save_draft": "write-result.schema.json",
  "review.create_task": "write-result.schema.json",
};

export type ToolHandlerMap = Partial<
  Record<PhaseOneToolName, DomainToolHandler>
>;

export function registerPhaseOneTools(
  handlers: ToolHandlerMap = {},
): readonly ToolDefinition[] {
  return phaseOneToolNames.map((name) => {
    const policy = getToolPolicy(name);
    const handler = handlers[name];
    return {
      name,
      inputSchemaId: `urn:logistics-mcp:${name}:2026-08-11.v1`,
      outputSchemaId: outputSchemaByTool[name],
      permission: policy.permission,
      kind: policy.kind,
      statusMapping: ENVELOPE_STATUSES,
      ...(handler === undefined ? {} : { handler }),
    };
  });
}

export async function executeRegisteredTool(
  definition: ToolDefinition,
  input: unknown,
  context: ExecutionContext,
  metadata: ToolExecutionMetadata,
): Promise<ResponseEnvelope> {
  authorizeTool(context, definition.name);
  if (definition.handler === undefined) {
    throw new HandlerUnavailableError();
  }

  const outcome = await definition.handler(input, context);
  const envelopeInput: CreateEnvelopeInput = {
    requestId: metadata.requestId,
    auditId: metadata.auditId,
    status: outcome.status,
    data: outcome.data,
    ...(outcome.sourceRefs === undefined
      ? {}
      : { sourceRefs: outcome.sourceRefs }),
    ...(outcome.assumptions === undefined
      ? {}
      : { assumptions: outcome.assumptions }),
    ...(outcome.warnings === undefined ? {} : { warnings: outcome.warnings }),
    ...(outcome.blockers === undefined ? {} : { blockers: outcome.blockers }),
    ...(outcome.calculationTrace === undefined
      ? {}
      : { calculationTrace: outcome.calculationTrace }),
    ...(outcome.reviewStatus === undefined
      ? {}
      : { reviewStatus: outcome.reviewStatus }),
  };
  return createEnvelope(envelopeInput);
}
