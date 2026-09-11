import { z } from "zod";
import type { OutreachPorts } from "../types.js";
import { createProviderClient, providerError, providerHeaders, providerInvalid, type ProviderHttpOptions } from "./common.js";

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().min(1).max(20_000) }).passthrough(),
  }).passthrough()).min(1).max(1),
}).passthrough();
const draftSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(6000),
}).strict();

export interface OpenAiCompatibleModelOptions extends ProviderHttpOptions {
  readonly model: string;
  readonly jsonMode?: boolean;
}

export function createOpenAiCompatibleGenerator(
  options: OpenAiCompatibleModelOptions,
): NonNullable<OutreachPorts["generate"]> {
  if (options.model.trim().length === 0 || options.model.length > 200) throw providerInvalid();
  const client = createProviderClient(options);
  return async (input) => {
    try {
      const response = await client.post("/v1/chat/completions", {
        model: options.model,
        temperature: 0,
        ...(options.jsonMode === false ? {} : { response_format: { type: "json_object" } }),
        messages: [
          {
            role: "system",
            content: `${input.instructions}\nReturn only a JSON object with string fields "subject" and "body".`,
          },
          {
            role: "user",
            content: JSON.stringify({
              untrusted_company: input.untrusted_company,
              untrusted_incoming: input.untrusted_incoming,
              approved_service_description: input.approved_service_description,
            }),
          },
        ],
      }, providerHeaders(options.token));
      const parsed = responseSchema.safeParse(response);
      if (!parsed.success) throw providerInvalid();
      const content = parsed.data.choices[0]?.message.content;
      if (content === undefined) throw providerInvalid();
      let decoded: unknown;
      try {
        decoded = JSON.parse(content) as unknown;
      } catch {
        throw providerInvalid();
      }
      const draft = draftSchema.safeParse(decoded);
      if (!draft.success) throw providerInvalid();
      return draft.data;
    } catch (error: unknown) {
      throw providerError(error);
    }
  };
}
