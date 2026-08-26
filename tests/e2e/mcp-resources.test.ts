import { describe, expect, it } from "vitest";

import { createAgentAccessRuntime } from "../../src/logistics_mcp/agent-context/runtime";
import { createFixtureComposition } from "../../src/logistics_mcp/server/composition";
import type { AuthClaims, ExecutionContext } from "../../src/logistics_mcp/platform/context";
import {
  callTool,
  createFixtureHarness,
  initialize,
} from "./fixtures/tenant-fixtures";

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "agent-context-security-test", version: "1.0.0" },
  },
};

function claimsFor(
  role: AuthClaims["actor_role"],
  actorId: string,
  sessionId: string,
): AuthClaims {
  return {
    tenant_id: "tenant_agent_context_e2e",
    actor_id: actorId,
    actor_role: role,
    roles: [role],
    scopes: ["system:agent_context"],
    client_id: "agent-context-security-test",
    session_id: sessionId,
    expires_at: Math.floor(Date.now() / 1000) + 300,
  };
}

describe("MCP Agent resources and context tool", () => {
  it("lists fixed resources and returns an allowlisted context projection", async () => {
    const harness = createFixtureHarness({
      agentAccessRuntime: createAgentAccessRuntime(),
    });
    try {
      const sessionId = await initialize(harness);
      const listed = await harness.request({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/list",
        params: {},
      }, sessionId);
      const listBody = (await listed.json()) as {
        result?: { resources?: readonly { uri: string }[] };
      };
      expect(listBody.result?.resources?.map((resource) => resource.uri).sort()).toEqual([
        "logistics://agent/bootstrap",
        "logistics://agent/profiles",
        "logistics://contracts/envelope/current",
        "logistics://modules/catalog",
        "logistics://standards/index",
      ]);

      const read = await harness.request({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: "logistics://modules/catalog" },
      }, sessionId);
      const readBody = (await read.json()) as {
        result?: { contents?: readonly { text?: string }[] };
      };
      expect(readBody.result?.contents?.[0]?.text).toContain("cargo");

      const profileRead = await harness.request({
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: { uri: "logistics://agent/profiles" },
      }, sessionId);
      const profileReadBody = (await profileRead.json()) as {
        result?: { contents?: readonly { text?: string }[] };
      };
      const profileText = profileReadBody.result?.contents?.[0]?.text ?? "";
      expect(profileText).toContain('"profile_id": "runtime-caller"');
      for (const privateControlMarker of [
        "CONTROL-",
        "writable-module-control-plane-v1",
        "readback-attempt-finalization-v1",
        "admin-control",
        "platform:admin",
        "/admin/api/",
      ]) {
        expect(profileText).not.toContain(privateControlMarker);
      }

      const context = await callTool(harness, sessionId, "system.agent_context.get", {
        profile_id: "runtime-caller",
        module_id: "cargo",
      });
      expect(context.status).toBe("success");
      if (typeof context.data !== "object" || context.data === null) {
        throw new Error("agent context response did not contain a data object");
      }
      const contextData = context.data as Record<string, unknown>;
      expect(contextData.profile_id).toBe("runtime-caller");
      expect(contextData.selected_module_id).toBe("cargo");
    } finally {
      await harness.close();
    }
  });

  it("uses one trusted runtime policy while binding reviewer/operator access to server context", async () => {
    const authorizationCalls: Array<{
      readonly context: ExecutionContext;
      readonly profileId: string;
      readonly moduleId: string | null;
    }> = [];
    const runtime = createAgentAccessRuntime({
      authorizeProfile: (request) => {
        authorizationCalls.push(request);
        if (request.profileId === "module-reviewer") {
          return request.context.role === "customs_reviewer";
        }
        if (request.profileId === "release-operator") {
          return request.context.role === "operator";
        }
        return request.profileId === "runtime-caller" &&
          request.context.role === "sales" &&
          request.context.actorId === "resource_authorized_actor";
      },
    });
    const composition = createFixtureComposition({
      dataMode: "fixtures",
      allowedOrigins: ["https://client.example.invalid"],
      allowedHosts: ["mcp.example.invalid"],
      agentAccessRuntime: runtime,
      authenticate: (token) => {
        if (token === "sales-token") return claimsFor("sales", "sales_actor", "sales_session");
        if (token === "resource-authorized-token") {
          return claimsFor("sales", "resource_authorized_actor", "resource_authorized_session");
        }
        if (token === "resource-denied-token") {
          return claimsFor("sales", "resource_denied_actor", "resource_denied_session");
        }
        if (token === "reviewer-token") return claimsFor("customs_reviewer", "reviewer_actor", "reviewer_session");
        if (token === "operator-token") return claimsFor("operator", "operator_actor", "operator_session");
        throw new Error("unknown fixture token");
      },
    });
    const request = (token: string, body: unknown, sessionId?: string): Promise<Response> =>
      composition.handler(
        new Request("https://mcp.example.invalid/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            origin: "https://client.example.invalid",
            host: "mcp.example.invalid",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
          },
          body: JSON.stringify(body),
        }),
      );
    const initializeAs = async (token: string): Promise<string> => {
      const response = await request(token, initializeBody);
      expect(response.ok).toBe(true);
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId === null) throw new Error("security test session was not created");
      return sessionId;
    };
    const callAs = async (
      token: string,
      sessionId: string,
      args: unknown,
    ): Promise<Record<string, unknown>> => {
      const response = await request(token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "system.agent_context.get", arguments: args },
      }, sessionId);
      const body = (await response.json()) as {
        result?: { structuredContent?: Record<string, unknown> };
        error?: { message?: string };
      };
      if (body.result?.structuredContent !== undefined) return body.result.structuredContent;
      throw new Error(body.error?.message ?? `agent context call failed: ${response.status} ${JSON.stringify(body)}`);
    };
    const readResourceAs = async (
      token: string,
      sessionId: string,
      uri: string,
    ): Promise<{
      readonly response: Response;
      readonly body: {
        readonly result?: { readonly contents?: readonly { readonly text?: string }[] };
        readonly error?: { readonly message?: string };
      };
    }> => {
      const response = await request(token, {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri },
      }, sessionId);
      return {
        response,
        body: await response.json() as {
          readonly result?: { readonly contents?: readonly { readonly text?: string }[] };
          readonly error?: { readonly message?: string };
        },
      };
    };

    try {
      const authorizedResourceSession = await initializeAs("resource-authorized-token");
      const deniedResourceSession = await initializeAs("resource-denied-token");
      const reviewerSession = await initializeAs("reviewer-token");

      const authorizedResource = await readResourceAs(
        "resource-authorized-token",
        authorizedResourceSession,
        "logistics://modules/catalog",
      );
      expect(authorizedResource.response.ok).toBe(true);
      const authorizedContents = authorizedResource.body.result?.contents;
      expect(authorizedContents).toBeDefined();
      expect(Array.isArray(authorizedContents)).toBe(true);
      expect(authorizedResource.body.result?.contents?.[0]?.text).toContain("cargo");

      const deniedSalesResource = await readResourceAs(
        "resource-denied-token",
        deniedResourceSession,
        "logistics://modules/catalog",
      );
      expect(deniedSalesResource.body.result?.contents).toBeUndefined();
      expect(deniedSalesResource.body.error).toBeDefined();

      const deniedReviewerResource = await readResourceAs(
        "reviewer-token",
        reviewerSession,
        "logistics://modules/catalog",
      );
      expect(deniedReviewerResource.body.result?.contents).toBeUndefined();
      expect(deniedReviewerResource.body.error).toBeDefined();

      const borrowedResource = await readResourceAs(
        "resource-denied-token",
        authorizedResourceSession,
        "logistics://modules/catalog",
      );
      expect(borrowedResource.response.status).toBeGreaterThanOrEqual(400);
      expect(borrowedResource.body.result?.contents).toBeUndefined();

      const salesSession = await initializeAs("sales-token");
      for (const profileId of ["module-reviewer", "release-operator"]) {
        const blocked = await callAs("sales-token", salesSession, { profile_id: profileId });
        expect(blocked).toMatchObject({ status: "blocked", data: null });
        expect(JSON.stringify(blocked)).not.toContain("CONTROL-");
      }
      const invalidAuthorizationResponse = await request("sales-token", {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "system.agent_context.get",
          arguments: {
            profile_id: "module-reviewer",
            authorization: { audience: "reviewer", caller: "module-reviewer" },
          },
        },
      }, salesSession);
      const invalidAuthorizationBody = (await invalidAuthorizationResponse.json()) as {
        result?: {
          content?: readonly { text?: string }[];
          isError?: boolean;
        };
      };
      expect(invalidAuthorizationBody.result?.isError).toBe(true);
      expect(invalidAuthorizationBody.result?.content?.[0]?.text).toContain(
        'Unrecognized key: "authorization"',
      );
      expect(JSON.stringify(invalidAuthorizationBody)).not.toContain("CONTROL-");

      /* Keep the schema check at the MCP boundary; the runtime receives no authorization field. */
      const invalidAuthorization = await callAs("sales-token", salesSession, {
        profile_id: "module-reviewer",
      });
      expect(invalidAuthorization).toMatchObject({ status: "blocked", data: null });
      expect(JSON.stringify(invalidAuthorization)).not.toContain("CONTROL-");

      const reviewer = await callAs(
        "reviewer-token",
        await initializeAs("reviewer-token"),
        { profile_id: "module-reviewer" },
      );
      expect(reviewer.status).toBe("success");
      expect(JSON.stringify(reviewer)).toContain("CONTROL-WRITE-001");

      const operator = await callAs(
        "operator-token",
        await initializeAs("operator-token"),
        { profile_id: "release-operator" },
      );
      expect(operator.status).toBe("success");
      expect(JSON.stringify(operator)).toContain("CONTROL-RELEASE-001");
      expect(authorizationCalls.some((call) => call.context.role === "sales" && call.profileId === "module-reviewer")).toBe(true);
      expect(authorizationCalls.some((call) => call.context.role === "customs_reviewer" && call.profileId === "module-reviewer")).toBe(true);
      expect(authorizationCalls.some((call) => call.context.role === "operator" && call.profileId === "release-operator")).toBe(true);
      expect(authorizationCalls.some((call) =>
        call.profileId === "runtime-caller" &&
        call.context.sessionId === "resource_authorized_session" &&
        call.context.actorId === "resource_authorized_actor",
      )).toBe(true);
      expect(authorizationCalls.some((call) =>
        call.profileId === "runtime-caller" &&
        call.context.sessionId === "resource_denied_session" &&
        call.context.actorId === "resource_denied_actor",
      )).toBe(true);
      expect(authorizationCalls.some((call) =>
        call.profileId === "runtime-caller" &&
        call.context.sessionId === "reviewer_session" &&
        call.context.role === "customs_reviewer",
      )).toBe(true);
    } finally {
      await composition.close();
    }
  });
});
