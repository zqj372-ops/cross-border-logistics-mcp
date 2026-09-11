import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CapabilityRegistry } from "../../src/logistics_mcp/module-runtime/capabilities";
import { ModuleHost } from "../../src/logistics_mcp/module-runtime/host";
import { parseExecutionContext, type ExecutionContext } from "../../src/logistics_mcp/platform/context";
import { MemoryIdempotencyRepository } from "../../src/logistics_mcp/platform/idempotency";
import { toolVisibleForContext } from "../../src/logistics_mcp/platform/rbac";
import {
  createLogisticsOutreachModule,
  OUTREACH_CAPABILITY,
  OUTREACH_CAPABILITY_VERSION,
  OUTREACH_VERSION,
} from "../../src/logistics_mcp/modules/logistics-outreach/module";
import { registerModuleToolDefinitions, executeRegisteredToolWithResult, type ToolDefinition } from "../../src/logistics_mcp/server/tool-registry";
import { OutreachService } from "../../services/logistics-outreach/service.js";
import { createFixturePorts } from "../../services/logistics-outreach/fixtures.js";

const baseInput = { schema_version: "2026-08-11.v1", version: OUTREACH_VERSION };

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "outreach-gateway-"));
  const ports = createFixturePorts();
  const service = new OutreachService(join(directory, "private.sqlite"), ports);
  const capabilities = new CapabilityRegistry();
  capabilities.provide(OUTREACH_CAPABILITY, service, OUTREACH_CAPABILITY_VERSION);
  const host = new ModuleHost({ capabilities, modules: [createLogisticsOutreachModule()] });
  host.mountSync();
  const definitions = registerModuleToolDefinitions(host.catalog.list());
  return {
    ports,
    service,
    host,
    definitions,
    definition(name: string): ToolDefinition {
      const value = definitions.find((entry) => entry.name === name);
      if (value === undefined) throw new Error(`missing_tool:${name}`);
      return value;
    },
    async close() {
      await host.close();
      service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function context(tool: string, permission: string, roles: readonly ("sales" | "viewer")[] = ["sales"]): ExecutionContext {
  return parseExecutionContext({
    tenant_id: "tenant_fixture",
    actor_id: "sales_fixture",
    actor_role: roles[0],
    roles,
    scopes: [permission, `tool:${tool}`],
    client_id: "client_fixture",
    session_id: "session_fixture",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
}

function writeContext(ctx: ExecutionContext, previewRef: string, idempotencyKey: string) {
  return {
    tenant_context: {
      tenant_id: ctx.tenantId,
      actor_id: ctx.actorId,
      actor_role: ctx.role,
      client_id: ctx.clientId,
      session_id: ctx.sessionId,
    },
    idempotency_key: idempotencyKey,
    operation_mode: "commit" as const,
    preview_ref: previewRef,
    approval: { required: false },
  };
}

test("outreach read and write tools execute through the registered Gateway contract", async () => {
  const f = setup();
  try {
    const repository = new MemoryIdempotencyRepository();
    const researchDefinition = f.definition("outreach.research.preview");
    const researchContext = context(researchDefinition.name, researchDefinition.permission);
    const research = await executeRegisteredToolWithResult(
      researchDefinition,
      { ...baseInput, capture_ref: "capture_fixture" },
      researchContext,
      {
        requestId: "req_outreach_research",
        auditId: "audit_outreach_research",
        idempotencyRepository: repository,
      },
    );

    expect(research.envelope.status).toBe("manual_review");
    expect(toolVisibleForContext(researchContext, researchDefinition.name)).toBe(true);
    expect(toolVisibleForContext(context("other.tool", researchDefinition.permission), researchDefinition.name)).toBe(false);
    const previewRef = research.envelope.data?.preview_ref;
    expect(typeof previewRef).toBe("string");
    if (typeof previewRef !== "string") throw new Error("preview_ref_missing");

    const importDefinition = f.definition("outreach.lead.import");
    const importContext = context(importDefinition.name, importDefinition.permission);
    const input = {
      ...baseInput,
      capture_ref: "capture_fixture",
      candidate_index: 0,
      write_context: writeContext(importContext, previewRef, "gateway_import_0001"),
    };
    const first = await executeRegisteredToolWithResult(importDefinition, input, importContext, {
      requestId: "req_outreach_import",
      auditId: "audit_outreach_import",
      idempotencyRepository: repository,
    });
    expect(first.envelope.status).toBe("manual_review");
    expect(first.idempotencyOutcome).toBe("reserved");
    expect(f.service.listLeads({ tenantId: "tenant_fixture", actorId: "sales_fixture" })).toHaveLength(1);

    const replay = await executeRegisteredToolWithResult(importDefinition, input, importContext, {
      requestId: "req_outreach_import_replay",
      auditId: "audit_outreach_import_replay",
      idempotencyRepository: repository,
    });
    expect(replay.idempotencyOutcome).toBe("replayed");
    expect(replay.envelope).toEqual(first.envelope);
    expect(f.ports.state.sent).toEqual([]);
  } finally {
    await f.close();
  }
});

test("outreach writes fail closed for unauthorized roles before handler dispatch", async () => {
  const f = setup();
  try {
    const definition = f.definition("outreach.lead.import");
    const viewer = context(definition.name, definition.permission, ["viewer"]);
    const result = executeRegisteredToolWithResult(
      definition,
      {
        ...baseInput,
        capture_ref: "capture_fixture",
        candidate_index: 0,
        write_context: writeContext(viewer, `${Date.now() + 60_000}.${"0".repeat(64)}`, "gateway_import_0002"),
      },
      viewer,
      {
        requestId: "req_outreach_forbidden",
        auditId: "audit_outreach_forbidden",
        idempotencyRepository: new MemoryIdempotencyRepository(),
      },
    );
    await expect(result).rejects.toThrow();
    expect(f.service.listLeads({ tenantId: "tenant_fixture", actorId: "sales_fixture" })).toEqual([]);
  } finally {
    await f.close();
  }
});
