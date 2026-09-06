import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExecutionContext } from "../../../src/logistics_mcp/platform/context";
import { validateEnvelope, type ResponseEnvelope } from "../../../src/logistics_mcp/platform/envelope";
import { assertAllowedOutboundUrl } from "../../../src/logistics_mcp/platform/security";
import type { JwtSigningProvider } from "../ports";
import type { T0ToolName } from "../contracts";
import { PortalError } from "./contracts";

export interface PortalRuntimeExecutor {
  execute(input: { readonly context: ExecutionContext; readonly toolName: T0ToolName; readonly input: unknown; readonly signal?: AbortSignal }, authorize: () => Promise<void>): Promise<ResponseEnvelope>;
}

export function createPortalRuntimeExecutor(options: {
  readonly url: string; readonly allowedHosts: readonly string[];
  readonly issuer: string; readonly audience: string; readonly signer: Pick<JwtSigningProvider, "sign">;
  readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number;
}): PortalRuntimeExecutor {
  const url = new URL(options.url);
  assertAllowedOutboundUrl(url, options.allowedHosts);
  if (url.search || url.hash || url.pathname !== "/mcp") throw new Error("portal_runtime_configuration_invalid");
  const timeoutMs = options.timeoutMs ?? 30_000;
  return { async execute(input, authorize) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
    const client = new Client({ name: "freightclaw-portal", version: "1.0.0" });
    let transport: StreamableHTTPClientTransport | undefined;
    try {
      if (!input.input || typeof input.input !== "object" || Array.isArray(input.input)) throw new PortalError("input_invalid");
      await authorize();
      signal.throwIfAborted();
      const now = Math.floor(Date.now() / 1000), context = input.context;
      const signed = await options.signer.sign({
        iss: options.issuer, aud: options.audience, sub: context.actorId,
        iat: now, exp: Math.min(context.expiresAt, now + 60), jti: `jwt_${randomUUID().replaceAll("-", "")}`,
        tenant_id: context.tenantId, actor_id: context.actorId, actor_role: "service", roles: ["service"],
        scopes: [`tool:${input.toolName}`], client_id: context.clientId, session_id: context.sessionId,
      });
      await authorize();
      signal.throwIfAborted();
      const boundedFetch: typeof fetch = async (resource, init) => {
        const target = new URL(typeof resource === "string" ? resource : resource instanceof URL ? resource.href : resource.url);
        if (target.href !== url.href) throw new PortalError("runtime_unavailable");
        const response = await (options.fetchImpl ?? fetch)(resource, { ...init, signal: init?.method === "DELETE" ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : signal, redirect: "error" });
        if (!response.body) return response;
        let size = 0;
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, output) {
            size += chunk.byteLength;
            if (size > 2 * 1024 * 1024) throw new PortalError("runtime_unavailable");
            output.enqueue(chunk);
          },
        }));
        return new Response(body, { status: response.status, headers: response.headers });
      };
      transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${signed.token}` } }, fetch: boundedFetch });
      // SDK 1.30's sessionId getter includes undefined, unlike its Transport interface.
      await client.connect(transport as Parameters<Client["connect"]>[0], { timeout: timeoutMs, signal });
      const result = await client.callTool({ name: input.toolName, arguments: input.input as Record<string, unknown> }, undefined, { timeout: timeoutMs, signal });
      const envelope = validateEnvelope(result.structuredContent);
      return envelope;
    } catch (error) {
      if (error instanceof PortalError) throw error;
      throw new PortalError("runtime_unavailable");
    } finally {
      if (transport?.sessionId) await transport.terminateSession().catch(() => undefined);
      controller.abort();
      await client.close().catch(() => undefined);
      clearTimeout(timer);
    }
  } };
}
