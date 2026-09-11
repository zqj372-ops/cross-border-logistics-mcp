import { z } from "zod";
import { OutreachError } from "../../../../services/logistics-outreach/types.js";
import type { Draft, Job, Lead } from "../../../../services/logistics-outreach/types.js";
import type { OutreachService } from "../../../../services/logistics-outreach/service.js";
import type { ModuleDefinition, ModuleToolOutcome } from "../../module-runtime/types";
import { isTrustedExecutionContext, ACTOR_ROLES } from "../../platform/context";
import type { ExecutionContext } from "../../platform/context";
import { ENVELOPE_SCHEMA_VERSION, envelopeSchema } from "../../platform/envelope";
import {
  OUTREACH_TOOL_POLICIES,
  type OutreachToolName,
} from "../../platform/outreach-tools";

export const OUTREACH_CAPABILITY = "outreach.private_service";
export const OUTREACH_VERSION = "2026-09-11.v0";
export const OUTREACH_CAPABILITY_VERSION = "outreach-service@2026-09-11.v0";

/** No worker, database, arbitrary URL, approval mutation or generic invoke in Gateway. */
export type OutreachServicePort = Pick<OutreachService,
  "research" | "importLead" | "listLeads" | "previewDraft" | "prepareDraft" | "getDraft" |
  "previewQueue" | "queue" | "getJob" | "previewInbox" | "syncInbox" | "listInbox" |
  "previewReply" | "prepareReply" | "previewSuppress" | "suppress">;

const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const preview = z.string().regex(/^\d{1,16}\.[a-f0-9]{64}$/u);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{15,199}$/u);
const common = { schema_version: z.literal(ENVELOPE_SCHEMA_VERSION), version: z.literal(OUTREACH_VERSION) };
const candidate = { candidate_only: z.literal(true), production_eligible: z.literal(false) };
const input = <S extends z.ZodRawShape>(shape: S) => z.object({ ...common, ...shape }).strict();
const output = <S extends z.ZodRawShape>(shape: S) => z.object({ ...candidate, ...shape }).strict();

const writeContextSchema = z.object({
  tenant_context: z.object({
    tenant_id: ref,
    actor_id: ref,
    actor_role: z.enum(ACTOR_ROLES),
    client_id: ref,
    session_id: ref,
  }).strict(),
  idempotency_key: idempotencyKey,
  operation_mode: z.literal("commit"),
  preview_ref: preview,
  approval: z.object({
    required: z.boolean(),
    status: z.enum(["not_required", "pending", "approved", "rejected", "manual_review"]).optional(),
    approval_id: ref.optional(),
  }).strict(),
}).strict();

const leadViewSchema = z.object({
  lead_ref: ref, company: z.string().max(200), city: z.literal("Toronto"),
  evidence_ref: ref, evidence_digest: digest, china_import_status: z.literal("unknown"),
  test_data: z.boolean(), suppressed: z.boolean(), paused: z.boolean(),
}).strict();
const draftViewSchema = output({
  draft_ref: ref, lead_ref: ref, content_ref: ref, digest,
  generation: z.enum(["template", "model"]), status: z.literal("pending_review"),
  reply_to: ref.nullable(), created_at: z.string().datetime(),
});
const jobViewSchema = output({
  job_ref: ref, draft_ref: ref, state: z.enum(["queued", "dispatching", "simulated", "provider_accepted", "cancelled", "manual_review"]),
  reason: ref.nullable(), provider_message_ref: ref.nullable(), updated_at: z.string().datetime(),
});
const draftInput = input({ lead_ref: ref, write_context: writeContextSchema });
const queueFields = { draft_ref: ref, approval_ref: ref, digest };
const leadView = (lead: Lead) => ({
  lead_ref: lead.lead_ref, company: lead.company, city: lead.city, evidence_ref: lead.evidence_ref,
  evidence_digest: lead.evidence_digest, china_import_status: lead.china_import_status,
  test_data: lead.test_data, suppressed: lead.suppressed, paused: lead.paused,
});
const draftView = (draft: Draft) => ({
  draft_ref: draft.draft_ref, lead_ref: draft.lead_ref, content_ref: draft.draft_ref,
  digest: draft.digest, generation: draft.generation, status: draft.status,
  reply_to: draft.reply_to, created_at: draft.created_at,
});
const jobView = (job: Job) => ({
  job_ref: job.job_ref, draft_ref: job.draft_ref, state: job.state, reason: job.reason,
  provider_message_ref: job.provider_message_ref, updated_at: job.updated_at,
});

interface WriteFields {
  readonly preview_ref: string;
  readonly idempotency_key: string;
}

function writeFields(value: unknown, context: ExecutionContext): WriteFields {
  const parsed = writeContextSchema.safeParse(value);
  if (!parsed.success) throw new OutreachError("write_context_invalid");
  const tenant = parsed.data.tenant_context;
  if (
    tenant.tenant_id !== context.tenantId
    || tenant.actor_id !== context.actorId
    || tenant.actor_role !== context.role
    || tenant.client_id !== context.clientId
    || tenant.session_id !== context.sessionId
  ) {
    throw new OutreachError("write_context_invalid");
  }
  return {
    preview_ref: parsed.data.preview_ref,
    idempotency_key: parsed.data.idempotency_key,
  };
}

function hasPermission(context: ExecutionContext, permission: string): boolean {
  return context.scopes.includes(permission)
    || context.scopes.includes(`${permission}:*`)
    || context.scopes.includes("platform:admin");
}

function isOutreachAuthorized(context: ExecutionContext, name: OutreachToolName): boolean {
  const policy = OUTREACH_TOOL_POLICIES[name];
  if (
    !isTrustedExecutionContext(context)
    || context.expiresAt <= Math.floor(Date.now() / 1000)
    || !policy.roles.some((role) => context.roles.includes(role))
  ) {
    return false;
  }
  const exactEntitlements = context.scopes.some((scope) => scope.startsWith("tool:"));
  if (exactEntitlements) {
    return context.profile === undefined
      && context.role !== "service"
      && context.scopes.includes(`tool:${name}`);
  }
  return hasPermission(context, policy.permission);
}

interface ToolSpec {
  readonly name: OutreachToolName;
  readonly title: string;
  readonly schema: z.ZodType;
  readonly result: z.ZodType;
  readonly run: (port: OutreachServicePort, context: ExecutionContext, value: unknown) => unknown;
}

const specs: readonly ToolSpec[] = [
  {
    name: "outreach.research.preview", title: "研究已授权的多伦多企业页面快照",
    schema: input({ capture_ref: ref }),
    result: output({ capture_ref: ref, evidence_digest: digest, company: z.string().max(200), city: z.literal("Toronto"), china_import_status: z.literal("unknown"), test_data: z.boolean(), candidates: z.array(z.object({ candidate_index: z.number().int().min(0).max(29) }).strict()).max(30), preview_ref: preview }),
    run: async (p, c, v) => {
      const r = await p.research(c, input({ capture_ref: ref }).parse(v).capture_ref);
      const { emails, ...metadata } = r;
      return { ...metadata, candidates: emails.map((_email, candidate_index) => ({ candidate_index })) };
    },
  },
  {
    name: "outreach.leads.list", title: "查询企业线索摘要",
    schema: input({ limit: z.number().int().min(1).max(100) }), result: output({ leads: z.array(leadViewSchema).max(100) }),
    run: (p, c, v) => ({ leads: p.listLeads(c, input({ limit: z.number() }).parse(v).limit).map(leadView) }),
  },
  {
    name: "outreach.lead.import", title: "导入预览中实际观察到的业务联系方式",
    schema: input({ capture_ref: ref, candidate_index: z.number().int().min(0).max(29), write_context: writeContextSchema }),
    result: output({ lead: leadViewSchema }),
    run: async (p, c, v) => {
      const data = input({ capture_ref: ref, candidate_index: z.number().int(), write_context: writeContextSchema }).parse(v);
      const write = writeFields(data.write_context, c);
      const research = await p.research(c, data.capture_ref);
      const email = research.emails[data.candidate_index];
      if (email === undefined) throw new OutreachError("email_not_observed");
      return { lead: leadView(await p.importLead(c, { capture_ref: data.capture_ref, email, preview_ref: write.preview_ref, idempotency_key: write.idempotency_key })) };
    },
  },
  {
    name: "outreach.draft.preview", title: "预览开发信生成意图",
    schema: input({ lead_ref: ref }), result: output({ lead_ref: ref, evidence_digest: digest, sender_digest: digest, preview_ref: preview }),
    run: (p, c, v) => p.previewDraft(c, input({ lead_ref: ref }).parse(v).lead_ref),
  },
  {
    name: "outreach.draft.prepare", title: "保存待人工审核的开发信草稿",
    schema: draftInput, result: draftViewSchema,
    run: async (p, c, v) => {
      const data = draftInput.parse(v);
      const write = writeFields(data.write_context, c);
      return draftView(await p.prepareDraft(c, { lead_ref: data.lead_ref, idempotency_key: write.idempotency_key, preview_ref: write.preview_ref }));
    },
  },
  {
    name: "outreach.draft.get", title: "读取草稿摘要及受保护内容引用",
    schema: input({ draft_ref: ref }), result: draftViewSchema,
    run: (p, c, v) => draftView(p.getDraft(c, input({ draft_ref: ref }).parse(v).draft_ref)),
  },
  {
    name: "outreach.message.preview", title: "检查已审核邮件的排队条件",
    schema: input(queueFields), result: output({ draft_ref: ref, approval_ref: ref, digest, preview_ref: preview, sends_email: z.literal(false) }),
    run: (p, c, v) => p.previewQueue(c, input(queueFields).parse(v)),
  },
  {
    name: "outreach.message.queue", title: "将已审核邮件放入私有服务队列",
    schema: input({ ...queueFields, write_context: writeContextSchema }),
    result: jobViewSchema,
    run: async (p, c, v) => {
      const data = input({ ...queueFields, write_context: writeContextSchema }).parse(v);
      const write = writeFields(data.write_context, c);
      return jobView(await p.queue(c, { draft_ref: data.draft_ref, approval_ref: data.approval_ref, digest: data.digest, idempotency_key: write.idempotency_key, preview_ref: write.preview_ref }));
    },
  },
  {
    name: "outreach.job.get", title: "查询邮件任务实际状态",
    schema: input({ job_ref: ref }), result: jobViewSchema,
    run: (p, c, v) => jobView(p.getJob(c, input({ job_ref: ref }).parse(v).job_ref)),
  },
  {
    name: "outreach.inbox.preview", title: "预览已绑定业务邮箱的同步意图",
    schema: input({}), result: output({ mailbox_ref: digest, preview_ref: preview }),
    run: (p, c) => p.previewInbox(c),
  },
  {
    name: "outreach.inbox.sync", title: "同步来信并执行暂停或退订规则",
    schema: input({ write_context: writeContextSchema }),
    result: output({ imported: z.number().int().min(0).max(100) }),
    run: async (p, c, v) => {
      const data = input({ write_context: writeContextSchema }).parse(v);
      const write = writeFields(data.write_context, c);
      return p.syncInbox(c, { preview_ref: write.preview_ref, idempotency_key: write.idempotency_key });
    },
  },
  {
    name: "outreach.inbox.list", title: "读取来信引用与分类，不返回原文",
    schema: input({ limit: z.number().int().min(1).max(100) }),
    result: output({ messages: z.array(z.object({ message_ref: ref, lead_ref: ref, classification: z.enum(["unsubscribe", "auto_reply", "human_reply"]) }).strict()).max(100) }),
    run: (p, c, v) => ({ messages: p.listInbox(c, input({ limit: z.number() }).parse(v).limit) }),
  },
  {
    name: "outreach.reply.preview", title: "预览针对客户来信的回复生成意图",
    schema: input({ message_ref: ref }), result: output({ message_ref: ref, incoming_digest: digest, sender_digest: digest, preview_ref: preview }),
    run: (p, c, v) => p.previewReply(c, input({ message_ref: ref }).parse(v).message_ref),
  },
  {
    name: "outreach.reply.prepare", title: "保存待审销售回复，不自动发送",
    schema: input({ message_ref: ref, write_context: writeContextSchema }), result: draftViewSchema,
    run: async (p, c, v) => {
      const data = input({ message_ref: ref, write_context: writeContextSchema }).parse(v);
      const write = writeFields(data.write_context, c);
      return draftView(await p.prepareReply(c, { message_ref: data.message_ref, idempotency_key: write.idempotency_key, preview_ref: write.preview_ref }));
    },
  },
  {
    name: "outreach.contact.preview", title: "预览联系人禁发操作",
    schema: input({ lead_ref: ref }), result: output({ lead_ref: ref, preview_ref: preview }),
    run: (p, c, v) => p.previewSuppress(c, input({ lead_ref: ref }).parse(v).lead_ref),
  },
  {
    name: "outreach.contact.suppress", title: "禁发联系人并取消待发邮件",
    schema: draftInput, result: output({ lead: leadViewSchema }),
    run: (p, c, v) => {
      const data = draftInput.parse(v);
      const write = writeFields(data.write_context, c);
      return { lead: leadView(p.suppress(c, { lead_ref: data.lead_ref, idempotency_key: write.idempotency_key, preview_ref: write.preview_ref })) };
    },
  },
];

export const OUTREACH_TOOL_NAMES = specs.map((spec) => spec.name);
const blockers = (code: string, message: string) => [{ code, message, severity: "error" as const }];

/** Candidate only: deliberately not imported by either existing production profile. */
export function createLogisticsOutreachModule(): ModuleDefinition {
  return {
    manifest: {
      module_id: "logistics-outreach", version: OUTREACH_VERSION, risk_level: "T2",
      required_capabilities: [{ name: OUTREACH_CAPABILITY, version: OUTREACH_CAPABILITY_VERSION }],
      optional_capabilities: [], standard_ids: ["module-runtime.v0", "platform.contracts"], lifecycle: "static",
    },
    mount: ({ capabilities, tools }) => {
      const port = capabilities.resolve<OutreachServicePort>(OUTREACH_CAPABILITY);
      for (const spec of specs) {
        const policy = OUTREACH_TOOL_POLICIES[spec.name];
        tools.register({
          name: spec.name, title: spec.title,
          description: `${spec.title}。候选模块；不具生产启用资格，不允许模型审批或直接外发。`,
          inputSchemaId: `urn:logistics-mcp:${spec.name}:${OUTREACH_VERSION}`,
          outputSchemaId: `urn:logistics-mcp:${spec.name}:result:${OUTREACH_VERSION}`,
          permission: policy.permission, kind: policy.kind, idempotentHint: policy.kind === "write",
          riskLevel: "T2", standardRefs: ["module-runtime.v0", "platform.contracts"], inputSchema: spec.schema,
          outputSchema: envelopeSchema.extend({ data: spec.result.nullable() }),
          validateOutput: (data) => { if (data !== null) spec.result.parse(data); },
          handler: async (raw, context, signal): Promise<ModuleToolOutcome> => {
            if (!isOutreachAuthorized(context, spec.name)) {
              return { status: "blocked", data: null, blockers: blockers("outreach_unauthorized", "Verified tenant, actor and exact tool permissions are required.") };
            }
            const parsed = spec.schema.safeParse(raw);
            if (!parsed.success) return { status: "needs_input", data: null, blockers: blockers("outreach_input_invalid", "Input does not match the closed, versioned tool schema.") };
            if (signal?.aborted) return { status: "blocked", data: null, blockers: blockers("outreach_cancelled", "Cancelled before private-service dispatch.") };
            try {
              const value: unknown = await spec.run(port, context, parsed.data);
              if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_service_result");
              const result: unknown = spec.result.parse({ ...value, candidate_only: true, production_eligible: false });
              if (typeof result !== "object" || result === null || Array.isArray(result)) throw new Error("invalid_service_result");
              return {
                status: "manual_review", data: result as Record<string, unknown>, reviewStatus: "manual_review",
                blockers: blockers("outreach_candidate_only", "Candidate operation completed; production activation and real-provider validation remain required. A queued job is not a sent email."),
              };
            } catch (error: unknown) {
              const code = error instanceof OutreachError ? error.code : "outreach_service_unavailable";
              const unavailable = ["sender_missing", "provider_unavailable", "provider_timeout", "provider_invalid", "outreach_service_unavailable"].includes(code);
              // Never echo provider errors, recipient addresses, input or message bodies.
              return { status: unavailable ? "unavailable" : "blocked", data: null, blockers: blockers(code, "The private-service operation did not complete with verified evidence; do not retry uncertain sends with a new key.") };
            }
          },
        });
      }
    },
  };
}
