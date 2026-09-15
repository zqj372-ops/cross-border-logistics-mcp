import { z } from "zod";
import type { Inbound, MailPort, Receipt } from "../types.js";
import { createProviderClient, providerError, providerHeaders, providerInvalid, type ProviderHttpOptions } from "./common.js";

export const OUTREACH_MAIL_SEND_SCHEMA_VERSION = "outreach-mail-send@2026-09-11.v1" as const;
export const OUTREACH_MAIL_RECEIPT_SCHEMA_VERSION = "outreach-mail-receipt@2026-09-11.v1" as const;
export const OUTREACH_MAIL_INBOX_SCHEMA_VERSION = "outreach-mail-inbox@2026-09-11.v1" as const;

const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const receiptSchema = z.object({
  schema_version: z.literal(OUTREACH_MAIL_RECEIPT_SCHEMA_VERSION),
  message_ref: ref,
  idempotency_key: z.string().min(16).max(200),
  digest,
  recipient: z.string().email().max(254),
}).strict();
const inboxSchema = z.object({
  schema_version: z.literal(OUTREACH_MAIL_INBOX_SCHEMA_VERSION),
  messages: z.array(z.object({
    message_ref: ref,
    from: z.string().email().max(254),
    body: z.string().min(1).max(20_000),
    auto_submitted: z.boolean(),
  }).strict()).max(100),
}).strict();
const statusResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: z.unknown(),
}).strict();

export type HttpMailPortOptions = ProviderHttpOptions;

export function createHttpMailPort(options: HttpMailPortOptions): MailPort {
  const client = createProviderClient(options);
  const headers = (tenantId: string) => providerHeaders(options.token, tenantId);
  return Object.freeze({
    mode: "live" as const,
    async send(tenantId: string, input: Parameters<MailPort["send"]>[1]): Promise<Receipt> {
      try {
        const response = await client.post("/v1/messages", {
          schema_version: OUTREACH_MAIL_SEND_SCHEMA_VERSION,
          idempotency_key: input.idempotency_key,
          recipient: input.recipient,
          message: {
            subject: input.draft.subject,
            body: input.draft.body,
            reply_to: input.draft.reply_to,
            sender: input.draft.sender,
          },
        }, headers(tenantId));
        const parsed = receiptSchema.safeParse(response);
        if (
          !parsed.success
          || parsed.data.idempotency_key !== input.idempotency_key
          || parsed.data.recipient !== input.recipient
          || parsed.data.digest !== input.draft.digest
        ) throw providerInvalid();
        return parsed.data;
      } catch (error: unknown) {
        throw providerError(error);
      }
    },
    async readSent(tenantId: string, key: string): Promise<Receipt | null> {
      try {
        const response = await client.get(
          `/v1/messages/${encodeURIComponent(key)}`,
          headers(tenantId),
          undefined,
          [200, 404],
        );
        const status = statusResponseSchema.safeParse(response);
        if (!status.success) throw providerInvalid();
        if (status.data.status === 404) return null;
        if (status.data.status !== 200) throw providerInvalid();
        const parsed = receiptSchema.safeParse(status.data.body);
        if (!parsed.success || parsed.data.idempotency_key !== key) throw providerInvalid();
        return parsed.data;
      } catch (error: unknown) {
        throw providerError(error);
      }
    },
    async inbox(tenantId: string): Promise<readonly Inbound[]> {
      try {
        const response = await client.get("/v1/inbox", headers(tenantId));
        const parsed = inboxSchema.safeParse(response);
        if (!parsed.success) throw providerInvalid();
        return parsed.data.messages;
      } catch (error: unknown) {
        throw providerError(error);
      }
    },
  });
}
