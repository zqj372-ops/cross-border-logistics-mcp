import { describe, expect, it } from "vitest";

import type {
  AdapterResult,
  CustomsAdapter,
  FreightcomRatePort,
  QuoteAdapter,
} from "../../src/logistics_mcp/adapters/ports.js";
import { parseExecutionContext } from "../../src/logistics_mcp/platform/context.js";
import {
  isExactReadPreviewServiceIdentity,
  isExactT0ServiceIdentity,
} from "../../src/logistics_mcp/platform/rbac.js";
import {
  createProductionComposition,
  type T1ReadWorker,
} from "../../src/logistics_mcp/server/composition.js";

function unavailable(code: string): AdapterResult {
  return {
    status: "unavailable",
    data: null,
    sourceRefs: [],
    calculationTrace: [],
    blockers: [{ code, message: code, severity: "error", field: null }],
  };
}

function worker(): T1ReadWorker {
  const quote: QuoteAdapter = {
    calculate: () => Promise.resolve(unavailable("quote.adapter_disabled")),
    previewDraft: () => Promise.resolve(unavailable("write.closed")),
    commitDraft: () => Promise.resolve(unavailable("write.closed")),
    readDraft: () => Promise.resolve(unavailable("write.closed")),
  };
  const customs: CustomsAdapter = {
    getStatus: () => Promise.resolve(unavailable("customs.adapter_disabled")),
    search: () => Promise.resolve(unavailable("customs.adapter_disabled")),
    estimate: () => Promise.resolve(unavailable("customs.estimate_unavailable")),
  };
  const freightcom: FreightcomRatePort = {
    requestRate: () => Promise.resolve(unavailable("freightcom.test_disabled")),
  };
  return {
    kind: "t1_read_worker",
    adapters: { quote, customs, freightcom },
    health: () => Promise.resolve({ ready: true }),
    close: () => Promise.resolve(),
  };
}

describe("read-preview staging composition", () => {
  it("mounts only the reviewed read-only catalog and keeps write tools absent", async () => {
    const composition = createProductionComposition({
      dataMode: "production",
      profile: "read-preview-staging",
      t1Worker: worker(),
    });
    try {
      expect(composition.definitions.map(({ name }) => name).sort()).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "customs.ca.estimate",
        "customs.ca.search",
        "quote.canada_final_mile.calculate",
        "quote.freightcom_ltl.preview",
        "system.agent_context.get",
      ]);
      expect(composition.moduleHost.snapshot().modules.map(({ module_id }) => module_id)).toEqual([
        "cargo",
        "container",
        "canada-final-mile-quote",
        "riskcustoms-ca",
        "freightcom-ltl",
        "agent-access",
      ]);
      expect(composition.definitions.every(({ kind }) => kind === "read")).toBe(true);
      expect(composition.definitions.some(({ name }) => name === "quote.save_draft")).toBe(false);
      expect(composition.definitions.some(({ name }) => name === "review.create_task")).toBe(false);
      expect(composition.catalogGeneration?.profile).toBe("read-preview-staging");
    } finally {
      await composition.close();
    }
  });

  it("fails readiness when the isolated worker is missing", async () => {
    const composition = createProductionComposition({
      dataMode: "production",
      profile: "read-preview-staging",
    });
    try {
      expect((await composition.readiness()).reasons).toContain(
        "production_t1_read_worker_missing",
      );
    } finally {
      await composition.close();
    }
  });

  it("does not let a T1 worker widen the T0 composition", async () => {
    let healthCalls = 0;
    let closeCalls = 0;
    const configured = worker();
    const t1Worker: T1ReadWorker = {
      ...configured,
      health: () => {
        healthCalls += 1;
        return Promise.resolve({ ready: true });
      },
      close: () => {
        closeCalls += 1;
        return Promise.resolve();
      },
    };
    const composition = createProductionComposition({
      dataMode: "production",
      profile: "t0-v1",
      t1Worker,
    });
    try {
      expect(composition.definitions.map(({ name }) => name)).toEqual([
        "cargo.calculate",
        "container.plan_summary",
        "system.agent_context.get",
      ]);
      expect((await composition.readiness()).reasons).toContain(
        "production_t1_worker_configured_for_t0",
      );
      expect(healthCalls).toBe(0);
    } finally {
      await composition.close();
    }
    expect(closeCalls).toBe(0);
  });

  it("keeps T0 and read-preview JWT scope boundaries distinct and exact", () => {
    const t0 = {
      role: "service",
      roles: ["service"],
      scopes: ["tool:cargo.calculate", "tool:system.agent_context.get"],
    };
    const preview = {
      role: "service",
      roles: ["service"],
      scopes: [
        "tool:customs.ca.search",
        "tool:quote.freightcom_ltl.preview",
        "tool:system.agent_context.get",
      ],
    };
    expect(isExactT0ServiceIdentity(t0)).toBe(true);
    expect(isExactReadPreviewServiceIdentity(t0)).toBe(true);
    expect(isExactT0ServiceIdentity(preview)).toBe(false);
    expect(isExactReadPreviewServiceIdentity(preview)).toBe(true);
    expect(isExactReadPreviewServiceIdentity({
      ...preview,
      scopes: [...preview.scopes, "platform:admin"],
    })).toBe(false);
  });

  it("reconstructs a trusted execution context before any worker call", () => {
    const context = parseExecutionContext({
      tenant_id: "tenant-preview",
      actor_id: "service-preview",
      actor_role: "service",
      roles: ["service"],
      scopes: ["tool:customs.ca.search"],
      client_id: "client-preview",
      session_id: "session-preview",
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    expect(context.tenantId).toBe("tenant-preview");
  });
});
