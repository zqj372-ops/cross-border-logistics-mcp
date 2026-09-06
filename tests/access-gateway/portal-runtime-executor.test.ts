import { describe, expect, it, vi } from "vitest";
import { createPortalRuntimeExecutor } from "../../services/access-gateway/portal/runtime-executor";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import { createEnvelope } from "../../src/logistics_mcp/platform/envelope";

const context = () => parseExecutionContext({ tenant_id: "tenant_test", actor_id: "bkey_0123456789abcdef01234567", actor_role: "service", roles: ["service"], scopes: ["tool:cargo.calculate"], client_id: "client_test", session_id: "session_test", expires_at: Math.floor(Date.now()/1000)+300 });

describe("Portal MCP Runtime delegation", () => {
  it("uses a short exact-scope JWT and preserves Runtime's blocked result and audit reference", async () => {
    const signed = vi.fn(() => Promise.resolve({ token: "signed.short.jwt", kid: "key1" }));
    const result = createEnvelope({ requestId: "req_runtime", auditId: "audit_persisted", status: "blocked", data: null, blockers: [{ code: "module_disabled", message: "Module disabled", severity: "error" }] });
    const methods: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer signed.short.jwt");
      expect(init?.redirect).toBe("error");
      if (init?.method === "GET") return Promise.resolve(new Response(null, { status: 405 }));
      if (init?.method === "DELETE") { methods.push("DELETE"); return Promise.resolve(new Response(null, { status: 200 })); }
      const message = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { id?: number; method: string; params?: { protocolVersion: string } };
      methods.push(message.method);
      if (message.id === undefined) return Promise.resolve(new Response(null, { status: 202 }));
      return Promise.resolve(Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
        ? { protocolVersion: message.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "runtime", version: "1" } }
        : { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true } }, { headers: { "mcp-session-id": "session_runtime" } }));
    });
    const authorize = vi.fn(() => Promise.resolve());
    const executor = createPortalRuntimeExecutor({ url: "https://runtime.example.invalid/mcp", allowedHosts: ["runtime.example.invalid"], issuer: "https://issuer.invalid/", audience: "mcp", signer: { sign: signed }, fetchImpl });
    await expect(executor.execute({ context: context(), toolName: "cargo.calculate", input: {} }, authorize)).resolves.toEqual(result);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(signed).toHaveBeenCalledWith(expect.objectContaining({ aud: "mcp", scopes: ["tool:cargo.calculate"], actor_id: context().actorId }));
    expect(methods).toContain("tools/call");
    expect(methods).toContain("DELETE");
  });

  it("does not connect if a grant is revoked while signing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const authorize = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked"));
    const executor = createPortalRuntimeExecutor({ url: "https://runtime.example.invalid/mcp", allowedHosts: ["runtime.example.invalid"], issuer: "https://issuer.invalid/", audience: "mcp", signer: { sign: () => Promise.resolve({ token: "short.jwt", kid: "key1" }) }, fetchImpl });
    await expect(executor.execute({ context: context(), toolName: "cargo.calculate", input: {} }, authorize)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
