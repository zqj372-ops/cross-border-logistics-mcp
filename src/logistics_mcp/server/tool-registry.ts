import {
  createEnvelope,
  ENVELOPE_STATUSES,
  validateEnvelope,
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
import {
  hashPayload,
  IdempotencyInProgressError,
  IdempotencyRequiredError,
  IdempotencyStateError,
} from "../platform/idempotency";
import type {
  AuditEvent,
  IdempotencyRepository,
} from "../platform/repositories";
import type { ZodType } from "zod";

export const phaseOneToolNames = allowlistedToolNames;
export type PhaseOneToolName = (typeof phaseOneToolNames)[number];

export class HandlerUnavailableError extends Error {
  readonly code = "handler_unavailable";

  constructor() {
    super("The domain handler for this tool is not configured.");
    this.name = "HandlerUnavailableError";
  }
}

export class ToolContractUnavailableError extends Error {
  readonly code = "tool_contract_unavailable";

  constructor() {
    super("The tool input/output contract is not configured.");
    this.name = "ToolContractUnavailableError";
  }
}

export class ToolContractValidationError extends Error {
  readonly code = "tool_contract_invalid";

  constructor() {
    super("The domain handler returned data outside the tool contract.");
    this.name = "ToolContractValidationError";
  }
}

export class WriteContractError extends Error {
  readonly code: string;
  readonly status: Extract<EnvelopeStatus, "needs_input" | "blocked" | "manual_review">;

  constructor(
    code: string,
    status: Extract<EnvelopeStatus, "needs_input" | "blocked" | "manual_review">,
    message: string,
  ) {
    super(message);
    this.name = "WriteContractError";
    this.code = code;
    this.status = status;
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
  signal?: AbortSignal,
) => DomainToolOutcome | Promise<DomainToolOutcome>;

export interface ToolContract {
  readonly inputSchema: ZodType;
  readonly validateOutput: (data: EnvelopeData) => void;
}

export type ToolContractMap = Partial<Record<PhaseOneToolName, ToolContract>>;

export interface ToolDefinition {
  readonly name: PhaseOneToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly permission: string;
  readonly kind: "read" | "write";
  readonly statusMapping: typeof ENVELOPE_STATUSES;
  readonly handler?: DomainToolHandler;
  readonly inputSchema?: ZodType;
  readonly validateOutput?: (data: EnvelopeData) => void;
}

export interface ToolExecutionMetadata {
  readonly requestId: string;
  readonly auditId: string;
  readonly idempotencyRepository?: IdempotencyRepository;
  readonly signal?: AbortSignal;
}

export interface ToolExecutionResult {
  readonly envelope: ResponseEnvelope;
  readonly idempotencyOutcome: AuditEvent["idempotency_outcome"];
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

const presentationByTool: Record<
  PhaseOneToolName,
  { readonly title: string; readonly description: string }
> = {
  "knowledge.search_curated": {
    title: "精选知识搜索",
    description: "只查询经过审核的当前操作资料。",
  },
  "system.get_data_status": {
    title: "数据状态查询",
    description: "读取已接入来源的就绪状态和版本证据。",
  },
  "cargo.calculate": {
    title: "货物与分泡计算",
    description: "计算体积、体积重、分泡和计费重。",
  },
  "container.plan_summary": {
    title: "装柜摘要计算",
    description: "汇总理论容量、运营目标和超限提醒。",
  },
  "quote.canada_final_mile.calculate": {
    title: "加拿大尾程报价",
    description: "通过受控接口获取加拿大尾程报价。",
  },
  "customs.ca.search": {
    title: "加拿大关务候选查询",
    description: "查询海关编码候选和待补充问题。",
  },
  "customs.ca.estimate": {
    title: "加拿大税费估算",
    description: "正式估算接口约定完成前保持不可用。",
  },
  "quote.save_draft": {
    title: "保存报价草稿",
    description: "正式草稿接口和写后读回完成前保持不可用。",
  },
  "review.create_task": {
    title: "创建人工复核任务",
    description: "正式任务接口和写后读回完成前保持不可用。",
  },
};

export type ToolHandlerMap = Partial<
  Record<PhaseOneToolName, DomainToolHandler>
>;

export function registerPhaseOneTools(
  handlers: ToolHandlerMap = {},
  contracts: ToolContractMap = {},
): readonly ToolDefinition[] {
  return phaseOneToolNames.map((name) => {
    const policy = getToolPolicy(name);
    const presentation = presentationByTool[name];
    const handler = handlers[name];
    const contract = contracts[name];
    return {
      name,
      title: presentation.title,
      description: presentation.description,
      inputSchemaId: `urn:logistics-mcp:${name}:2026-08-11.v1`,
      outputSchemaId: outputSchemaByTool[name],
      permission: policy.permission,
      kind: policy.kind,
      statusMapping: ENVELOPE_STATUSES,
      ...(handler === undefined ? {} : { handler }),
      ...(contract === undefined
        ? {}
        : {
            inputSchema: contract.inputSchema,
            validateOutput: contract.validateOutput,
          }),
    };
  });
}

interface WriteRequest {
  readonly idempotencyKey: string;
  readonly operationMode: "preview" | "commit";
  readonly previewRef: string | null;
}

type WriteToolName = "quote.save_draft" | "review.create_task";

const writeApprovalPolicy: Readonly<Record<WriteToolName, true>> = {
  "quote.save_draft": true,
  "review.create_task": true,
};

function requiresCommitApproval(toolName: PhaseOneToolName): boolean {
  return toolName in writeApprovalPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeContractError(
  code: string,
  status: WriteContractError["status"],
  message: string,
): WriteContractError {
  return new WriteContractError(code, status, message);
}

function parseWriteRequest(
  input: unknown,
  context: ExecutionContext,
  toolName: PhaseOneToolName,
): WriteRequest {
  if (!isRecord(input) || !isRecord(input.write_context)) {
    throw writeContractError(
      "write_context.required",
      "needs_input",
      "A write_context is required for write tools.",
    );
  }
  const writeContext = input.write_context;
  const tenantContext = writeContext.tenant_context;
  if (!isRecord(tenantContext)) {
    throw writeContractError(
      "tenant_context.required",
      "blocked",
      "The server-injected tenant context is required.",
    );
  }
  if (tenantContext.tenant_id !== context.tenantId) {
    throw writeContractError(
      "security.cross_tenant_denied",
      "blocked",
      "The requested tenant is outside the authenticated scope.",
    );
  }
  if (
    tenantContext.actor_id !== context.actorId ||
    tenantContext.actor_role !== context.role ||
    tenantContext.client_id !== context.clientId ||
    tenantContext.session_id !== context.sessionId
  ) {
    throw writeContractError(
      "security.context_override",
      "blocked",
      "The write context does not match the authenticated context.",
    );
  }

  const idempotencyKey = writeContext.idempotency_key;
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length < 16 ||
    idempotencyKey.length > 200
  ) {
    throw writeContractError(
      "idempotency_key.required",
      "needs_input",
      "A valid idempotency key is required for write tools.",
    );
  }

  const operationMode = writeContext.operation_mode;
  if (operationMode !== "preview" && operationMode !== "commit") {
    throw writeContractError(
      "operation_mode.invalid",
      "needs_input",
      "The write operation mode must be preview or commit.",
    );
  }

  const previewRef = writeContext.preview_ref;
  if (
    operationMode === "preview"
      ? previewRef !== null
      : typeof previewRef !== "string" || previewRef.length === 0
  ) {
    throw writeContractError(
      "preview_ref.invalid",
      "needs_input",
      "The preview reference does not match the write operation mode.",
    );
  }

  const approval = writeContext.approval;
  if (!isRecord(approval) || typeof approval.required !== "boolean") {
    throw writeContractError(
      "approval.required",
      "needs_input",
      "Approval metadata is required for write tools.",
    );
  }
  if (
    operationMode === "commit" &&
    requiresCommitApproval(toolName) &&
    (approval.status !== "approved" ||
      typeof approval.approval_id !== "string" ||
      approval.approval_id.length === 0)
  ) {
    throw writeContractError(
      "approval.not_approved",
      "blocked",
      "The write operation is not approved for commit.",
    );
  }

  return {
    idempotencyKey,
    operationMode,
    previewRef: typeof previewRef === "string" ? previewRef : null,
  };
}

function validateToolOutput(
  definition: ToolDefinition,
  outcome: DomainToolOutcome,
): void {
  if (outcome.status === "success" && outcome.data === null) {
    throw new ToolContractValidationError();
  }
  if (outcome.data === null) {
    return;
  }
  try {
    definition.validateOutput?.(outcome.data);
  } catch {
    throw new ToolContractValidationError();
  }
}

function validateWriteOutcome(
  request: WriteRequest,
  outcome: DomainToolOutcome,
): void {
  if (outcome.status !== "success") {
    return;
  }
  if (!isRecord(outcome.data)) {
    throw writeContractError(
      "write_result.invalid",
      "manual_review",
      "A successful write must return a structured write result.",
    );
  }
  if (outcome.data.idempotency_key !== request.idempotencyKey) {
    throw writeContractError(
      "write_result.idempotency_mismatch",
      "manual_review",
      "The write result idempotency key does not match the request.",
    );
  }
  if (request.operationMode === "preview") {
    if (
      outcome.data.operation_status !== "previewed" ||
      typeof outcome.data.preview_ref !== "string"
    ) {
      throw writeContractError(
        "write_result.preview_invalid",
        "manual_review",
        "A successful preview must return a preview reference.",
      );
    }
    return;
  }
  if (
    outcome.data.operation_status !== "committed" &&
    outcome.data.operation_status !== "already_committed"
  ) {
    throw writeContractError(
      "write_result.commit_invalid",
      "manual_review",
      "A committed write must return a committed operation status.",
    );
  }
  if (outcome.data.preview_ref !== request.previewRef) {
    throw writeContractError(
      "write_result.preview_mismatch",
      "manual_review",
      "The committed write does not reference the approved preview.",
    );
  }
  const readback = outcome.data.readback_evidence;
  if (!isRecord(readback) || readback.verified !== true) {
    throw writeContractError(
      "write_result.readback_unverified",
      "manual_review",
      "A committed write requires verified readback evidence.",
    );
  }
}

export async function executeRegisteredToolWithResult(
  definition: ToolDefinition,
  input: unknown,
  context: ExecutionContext,
  metadata: ToolExecutionMetadata,
): Promise<ToolExecutionResult> {
  authorizeTool(context, definition.name);
  metadata.signal?.throwIfAborted();
  if (definition.handler === undefined) {
    throw new HandlerUnavailableError();
  }
  if (definition.inputSchema === undefined || definition.validateOutput === undefined) {
    throw new ToolContractUnavailableError();
  }
  if (!definition.inputSchema.safeParse(input).success) {
    throw writeContractError(
      "tool_input.invalid",
      "needs_input",
      "The tool input does not satisfy its contract.",
    );
  }

  const writeRequest =
    definition.kind === "write"
      ? parseWriteRequest(input, context, definition.name)
      : null;
  let idempotencyOutcome: AuditEvent["idempotency_outcome"] = "not_applicable";
  let reservation:
    | Awaited<ReturnType<IdempotencyRepository["reserve"]>>
    | undefined;
  if (writeRequest !== null) {
    if (metadata.idempotencyRepository === undefined) {
      throw new IdempotencyRequiredError();
    }
    reservation = await metadata.idempotencyRepository.reserve({
      tenantId: context.tenantId,
      tool: definition.name,
      key: writeRequest.idempotencyKey,
      requestHash: hashPayload(input),
    });
    metadata.signal?.throwIfAborted();
    if (reservation.replayed) {
      if (reservation.record.status !== "committed" || reservation.record.result === null) {
        throw new IdempotencyStateError();
      }
      return {
        envelope: validateEnvelope(reservation.record.result),
        idempotencyOutcome: "replayed",
      };
    }
    if (reservation.inProgress) {
      throw new IdempotencyInProgressError();
    }
    idempotencyOutcome = "reserved";
  }

  const outcome = await definition.handler(input, context, metadata.signal);
  metadata.signal?.throwIfAborted();
  validateToolOutput(definition, outcome);
  if (writeRequest !== null) {
    validateWriteOutcome(writeRequest, outcome);
  }

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
  const envelope = createEnvelope(envelopeInput);

  if (writeRequest !== null && reservation !== undefined) {
    metadata.signal?.throwIfAborted();
    await metadata.idempotencyRepository!.commit({
      tenantId: context.tenantId,
      tool: definition.name,
      key: writeRequest.idempotencyKey,
      requestHash: hashPayload(input),
      result: envelope,
    });
  }

  return { envelope, idempotencyOutcome };
}

export async function executeRegisteredTool(
  definition: ToolDefinition,
  input: unknown,
  context: ExecutionContext,
  metadata: ToolExecutionMetadata,
): Promise<ResponseEnvelope> {
  const result = await executeRegisteredToolWithResult(
    definition,
    input,
    context,
    metadata,
  );
  return result.envelope;
}
