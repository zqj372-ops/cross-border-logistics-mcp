import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { CapabilityRegistry } from "../../src/logistics_mcp/module-runtime/capabilities";
import { ModuleHost } from "../../src/logistics_mcp/module-runtime/host";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context";
import { createLogisticsOutreachModule, OUTREACH_CAPABILITY, OUTREACH_CAPABILITY_VERSION, OUTREACH_TOOL_NAMES, OUTREACH_VERSION } from "../../src/logistics_mcp/modules/logistics-outreach/module";
import { OutreachService } from "../../services/logistics-outreach/service.js";
import { createFixturePorts } from "../../services/logistics-outreach/fixtures.js";

const baseInput = { schema_version: "2026-08-11.v1", version: OUTREACH_VERSION };
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "outreach-module-"));
  const ports = createFixturePorts();
  const service = new OutreachService(join(directory, "private.sqlite"), ports);
  const capabilities = new CapabilityRegistry();
  capabilities.provide(OUTREACH_CAPABILITY, service, OUTREACH_CAPABILITY_VERSION);
  const host = new ModuleHost({ capabilities, modules: [createLogisticsOutreachModule()] });
  host.mountSync();
  return { ports, service, host, async close() { await host.close(); service.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function context(tool: string, permission: string, roles: ("sales" | "viewer")[] = ["sales"]) {
  return parseExecutionContext({
    tenant_id: "tenant_fixture", actor_id: "sales_fixture", actor_role: roles[0], roles,
    scopes: [permission, `tool:${tool}`], client_id: "client_fixture", session_id: "session_fixture",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
}
function researchTool(host: ModuleHost) {
  const tool = host.catalog.get("outreach.research.preview");
  if (!tool) throw new Error("missing_candidate_tool");
  return tool;
}

test("candidate mounts through the existing ModuleHost with exactly 16 tools", async () => {
  const f = setup(); try {
    expect(f.host.catalog.list().map((tool) => tool.name).sort()).toEqual([...OUTREACH_TOOL_NAMES].sort());
    expect(OUTREACH_TOOL_NAMES).toHaveLength(16);
    expect(f.host.snapshot().modules[0]?.risk_level).toBe("T2");
    expect(OUTREACH_TOOL_NAMES.some((name) => /approve|dispatch|send$/u.test(name))).toBe(false);
  } finally { await f.close(); }
});

test("all candidate contracts convert to closed Draft 2020-12 JSON Schema", async () => {
  const f = setup(); try {
    for (const tool of f.host.catalog.list()) {
      const schema = z.toJSONSchema(tool.inputSchema, { target: "draft-2020-12" });
      expect(schema.additionalProperties).toBe(false);
      expect(schema.$schema).toContain("2020-12");
      expect(tool.outputSchema).toBeDefined();
      if (tool.outputSchema) expect(z.toJSONSchema(tool.outputSchema, { target: "draft-2020-12" }).additionalProperties).toBe(false);
    }
  } finally { await f.close(); }
});

test("research returns references, not customer emails or copied page HTML", async () => {
  const f = setup(); try {
    const tool = researchTool(f.host);
    const result = await tool.handler({ ...baseInput, capture_ref: "capture_fixture" }, context(tool.name, tool.permission));
    expect(result.status).toBe("manual_review");
    expect(result.data).toMatchObject({ candidate_only: true, production_eligible: false, test_data: true, china_import_status: "unknown", candidates: [{ candidate_index: 0 }] });
    expect(JSON.stringify(result)).not.toContain("sales@example.invalid");
    expect(JSON.stringify(result)).not.toContain("<main>");
    tool.validateOutput(result.data);
    expect(f.service.listLeads({ tenantId: "tenant_fixture", actorId: "sales_fixture" })).toEqual([]);
  } finally { await f.close(); }
});

test("untrusted identity and missing exact tool grants fail before source access", async () => {
  const f = setup(); try {
    const tool = researchTool(f.host); const trusted = context(tool.name, tool.permission);
    expect((await tool.handler({ ...baseInput, capture_ref: "capture_fixture" }, { ...trusted })).status).toBe("blocked");
    expect((await tool.handler({ ...baseInput, capture_ref: "capture_fixture" }, context("other.tool", tool.permission))).status).toBe("blocked");
    expect((await tool.handler({ ...baseInput, capture_ref: "capture_fixture" }, context(tool.name, "outreach:read"))).status).toBe("blocked");
  } finally { await f.close(); }
});

test("client tenant, arbitrary URL, credentials and script parameters are rejected", async () => {
  const f = setup(); try {
    const tool = researchTool(f.host);
    for (const extra of [{ tenant_id: "other" }, { url: "https://example.invalid/" }, { api_key: "synthetic" }, { script: "alert(1)" }]) {
      const result = await tool.handler({ ...baseInput, capture_ref: "capture_fixture", ...extra }, context(tool.name, tool.permission));
      expect(result.status).toBe("needs_input");
    }
  } finally { await f.close(); }
});

test("write tools require trusted business roles and a bound preview", async () => {
  const f = setup(); try {
    const tool = f.host.catalog.get("outreach.lead.import"); if (!tool) throw new Error("missing_candidate_tool");
    const value = { ...baseInput, capture_ref: "capture_fixture", candidate_index: 0, operation_mode: "commit", idempotency_key: "i", preview_ref: `${Date.now() + 1000}.${"0".repeat(64)}` };
    expect((await tool.handler(value, context(tool.name, tool.permission, ["viewer"]))).status).toBe("blocked");
    expect((await tool.handler(value, context(tool.name, tool.permission))).status).toBe("blocked");
    expect(f.service.listLeads({ tenantId: "tenant_fixture", actorId: "sales_fixture" })).toEqual([]);
    expect(f.ports.state.sent).toEqual([]);
  } finally { await f.close(); }
});

test("cancellation is checked before dispatching any private service action", async () => {
  const f = setup(); try {
    const tool = researchTool(f.host); const controller = new AbortController(); controller.abort();
    expect((await tool.handler({ ...baseInput, capture_ref: "capture_fixture" }, context(tool.name, tool.permission), controller.signal)).status).toBe("blocked");
  } finally { await f.close(); }
});
