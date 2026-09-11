/** Private service contracts. Tenant/actor are injected, never tool arguments. */
export interface OutreachActor { readonly tenantId: string; readonly actorId: string }
export interface Capture {
  readonly capture_ref: string;
  readonly company: string;
  readonly city: string;
  readonly url: string;
  readonly captured_at: string;
  readonly html: string;
  readonly test_data: boolean;
}
export interface Lead {
  readonly lead_ref: string;
  readonly company: string;
  readonly city: string;
  readonly email: string;
  readonly evidence_ref: string;
  readonly evidence_digest: string;
  readonly china_import_status: "unknown";
  readonly test_data: boolean;
  readonly suppressed: boolean;
  readonly paused: boolean;
}
export interface Sender {
  readonly company: string;
  readonly name: string;
  readonly email: string;
  readonly mailing_address: string;
  readonly service_description: string;
}
export interface Draft {
  readonly draft_ref: string;
  readonly lead_ref: string;
  readonly created_by: string;
  readonly subject: string;
  readonly body: string;
  readonly sender: Sender;
  readonly digest: string;
  readonly generation: "template" | "model";
  readonly status: "pending_review";
  readonly reply_to: string | null;
  readonly created_at: string;
}
export interface Job {
  readonly job_ref: string;
  readonly draft_ref: string;
  readonly created_by: string;
  readonly approval_ref: string;
  readonly state: "queued" | "dispatching" | "simulated" | "provider_accepted" | "cancelled" | "manual_review";
  readonly reason: string | null;
  readonly provider_message_ref: string | null;
  readonly updated_at: string;
}
export interface Inbound {
  readonly message_ref: string;
  readonly from: string;
  readonly body: string;
  readonly auto_submitted: boolean;
}
export interface SavedInbound extends Inbound {
  readonly lead_ref: string;
  readonly classification: "unsubscribe" | "auto_reply" | "human_reply";
}
export interface Receipt {
  readonly message_ref: string;
  readonly idempotency_key: string;
  readonly digest: string;
  readonly recipient: string;
}
export interface MailPort {
  readonly mode: "fixture" | "live";
  send(tenantId: string, input: { readonly idempotency_key: string; readonly recipient: string; readonly draft: Draft }): Promise<Receipt>;
  readSent(tenantId: string, key: string): Promise<Receipt | null>;
  inbox(tenantId: string): Promise<readonly Inbound[]>;
}
export interface OutreachPorts {
  readonly previewKey: Uint8Array;
  readonly now: () => number;
  readonly capture: (tenantId: string, ref: string) => Promise<Capture | null>;
  readonly sender: (tenantId: string) => Sender | null;
  readonly sendEnabled: (tenantId: string) => boolean;
  readonly mayDispatch: (tenantId: string, actorId: string) => Promise<boolean>;
  readonly contactReview: (tenantId: string, lead: Lead) => Promise<{
    readonly approved: boolean; readonly evidence_ref: string; readonly evidence_digest: string; readonly valid_until: string;
  }>;
  readonly draftApproval: (tenantId: string, draft: Draft, ref: string) => Promise<{
    readonly approved: boolean; readonly draft_ref: string; readonly digest: string; readonly reviewer_id: string; readonly valid_until: string;
  }>;
  readonly generate?: (input: {
    readonly purpose: "introduction" | "reply";
    readonly instructions: string;
    readonly untrusted_company: string;
    readonly untrusted_incoming: string | null;
    readonly approved_service_description: string;
  }) => Promise<{ readonly subject: string; readonly body: string }>;
  readonly mail: MailPort;
}

export class OutreachError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OutreachError"; }
}
