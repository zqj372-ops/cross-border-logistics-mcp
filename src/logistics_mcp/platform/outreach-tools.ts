import type { ActorRole } from "./context";

export interface OutreachToolPolicy {
  readonly permission: string;
  readonly kind: "read" | "write";
  readonly roles: readonly ActorRole[];
}

export const OUTREACH_TOOL_NAMES = Object.freeze([
  "outreach.research.preview",
  "outreach.leads.list",
  "outreach.lead.import",
  "outreach.draft.preview",
  "outreach.draft.prepare",
  "outreach.draft.get",
  "outreach.message.preview",
  "outreach.message.queue",
  "outreach.job.get",
  "outreach.inbox.preview",
  "outreach.inbox.sync",
  "outreach.inbox.list",
  "outreach.reply.preview",
  "outreach.reply.prepare",
  "outreach.contact.preview",
  "outreach.contact.suppress",
] as const);

export type OutreachToolName = (typeof OUTREACH_TOOL_NAMES)[number];

export const OUTREACH_READ_ROLES = Object.freeze([
  "admin",
  "sales",
  "operator",
  "customs_reviewer",
  "finance",
  "viewer",
] as const satisfies readonly ActorRole[]);

export const OUTREACH_WRITE_ROLES = Object.freeze([
  "admin",
  "sales",
  "operator",
] as const satisfies readonly ActorRole[]);

export const OUTREACH_TOOL_POLICIES = Object.freeze({
  "outreach.research.preview": Object.freeze({ permission: "outreach:research", kind: "read", roles: OUTREACH_READ_ROLES }),
  "outreach.leads.list": Object.freeze({ permission: "outreach:read", kind: "read", roles: OUTREACH_READ_ROLES }),
  "outreach.lead.import": Object.freeze({ permission: "outreach:lead_write", kind: "write", roles: OUTREACH_WRITE_ROLES }),
  "outreach.draft.preview": Object.freeze({ permission: "outreach:draft", kind: "read", roles: OUTREACH_READ_ROLES }),
  "outreach.draft.prepare": Object.freeze({ permission: "outreach:draft", kind: "write", roles: OUTREACH_WRITE_ROLES }),
  "outreach.draft.get": Object.freeze({ permission: "outreach:read", kind: "read", roles: OUTREACH_READ_ROLES }),
  "outreach.message.preview": Object.freeze({ permission: "outreach:queue", kind: "read", roles: OUTREACH_READ_ROLES }),
  "outreach.message.queue": Object.freeze({ permission: "outreach:queue", kind: "write", roles: OUTREACH_WRITE_ROLES }),
  "outreach.job.get": Object.freeze({ permission: "outreach:read", kind: "read", roles: OUTREACH_READ_ROLES }),
  "outreach.inbox.preview": Object.freeze({ permission: "outreach:inbox", kind: "read", roles: OUTREACH_READ_ROLES }),
  "outreach.inbox.sync": Object.freeze({ permission: "outreach:inbox", kind: "write", roles: OUTREACH_WRITE_ROLES }),
  "outreach.inbox.list": Object.freeze({ permission: "outreach:inbox", kind: "read", roles: OUTREACH_READ_ROLES }),
  "outreach.reply.preview": Object.freeze({ permission: "outreach:draft", kind: "read", roles: OUTREACH_READ_ROLES }),
  "outreach.reply.prepare": Object.freeze({ permission: "outreach:draft", kind: "write", roles: OUTREACH_WRITE_ROLES }),
  "outreach.contact.preview": Object.freeze({ permission: "outreach:suppress", kind: "read", roles: OUTREACH_READ_ROLES }),
  "outreach.contact.suppress": Object.freeze({ permission: "outreach:suppress", kind: "write", roles: OUTREACH_WRITE_ROLES }),
} as const satisfies Readonly<Record<OutreachToolName, OutreachToolPolicy>>);
