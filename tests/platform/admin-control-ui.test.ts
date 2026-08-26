import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { actionAvailability, CONTROL_SCHEMA_VERSION, createControlPlaneClient, deriveDesiredDraftDiff, deriveReleaseStages, isFixtureIdentityVisible, redactReference, validateControlState } from "../../apps/admin/control-plane.js";

const descriptorDigest = `sha256:${"a".repeat(64)}`;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const validControlState = {
  kind: "control_state",
  activation: {
    state: "active",
    release_id: "release-1",
    revision: 3,
    active_modules: [
      {
        module_id: "cargo",
        version: "1.0.0",
        descriptor_digest: descriptorDigest,
      },
    ],
  },
  inventory_modules: [
    {
      module_id: "cargo",
      version: "1.0.0",
      risk_level: "T0",
      descriptor_digest: descriptorDigest,
      evidence_level: "local_build",
      production_eligible: false,
      tool_names: ["cargo.calculate"],
      standard_ids: ["cargo.contract.v1"],
      registration: {
        registered_by_actor_ref: "actor-1",
        registered_at: "2026-08-26T00:00:00.000Z",
      },
    },
  ],
  latest_preview: null,
  latest_approval: null,
  latest_readback: null,
  release_history: [],
  events: [],
  events_truncated: false,
} as const;

describe("admin control-plane model boundary", () => {
  it("validates the closed control-state snapshot and rejects production claims", () => {
    expect(validateControlState(validControlState)).toEqual(validControlState);
    expect(() => validateControlState({ ...validControlState, events: {} })).toThrow();
    expect(() => validateControlState({
      ...validControlState,
      inventory_modules: [{
        ...validControlState.inventory_modules[0],
        evidence_level: "verified_release",
      }],
    })).toThrow();
    expect(() => validateControlState({
      ...validControlState,
      inventory_modules: [{
        ...validControlState.inventory_modules[0],
        production_eligible: true,
      }],
    })).toThrow();
  });

  it("keeps the module token out of storage, DOM, URL, console, and error visibility", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const client = createControlPlaneClient({
      fetchImpl: (url: RequestInfo | URL, init?: RequestInit) => {
        request = { url: requestUrl(url), init: init ?? {} };
        return new Response(JSON.stringify({
          status: "success",
          data: validControlState,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    client.setToken("module-scoped-fixture-token");
    await expect(client.getControlState()).resolves.toEqual(validControlState);
    expect(request?.url).toBe("/admin/api/v1/control/state");
    expect(new Headers(request?.init.headers).get("authorization")).toBe(
      "Bearer module-scoped-fixture-token",
    );
    expect(request?.init.credentials).toBe("omit");

    const source = await readFile(new URL("../../apps/admin/control-plane.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(?:localStorage|sessionStorage)\b/);
    expect(source).not.toMatch(/\bdocument\b|\bwindow\.location\b|\blocation\.(?:href|search|hash)\b/);
    expect(source).not.toMatch(/\bconsole\.(?:log|error|warn|info|debug)\b/);
    expect(source).not.toMatch(/(?:throw new Error|Promise\.reject)\([^)]*module-scoped-fixture-token/);
  });

  it("keeps release gating deterministic and requires a distinct approver", () => {
    const previewState = {
      ...validControlState,
      latest_preview: {
        preview_ref: "preview-1",
        creator_actor_ref: "actor-1",
        consumed: false,
      },
      release_history: [{ status: "manual_review", release_id: "release-0" }],
    };
    const diff = deriveDesiredDraftDiff(
      validControlState.activation.active_modules,
      [],
    );
    expect(diff.added).toEqual([]);
    expect(diff.removed).toHaveLength(1);
    expect(diff.retained).toEqual([]);
    expect(deriveReleaseStages(previewState).map((stage: { status: string }) => stage.status)).toEqual([
      "complete",
      "complete",
      "empty",
      "empty",
    ]);

    const sameActor = actionAvailability({
      state: previewState,
      draftModules: [],
      actorRole: "admin",
      actorRef: "actor-1",
      creatorActorRef: "actor-1",
      environment: "fixture",
    });
    expect(sameActor.submitApproval).toBe(false);
    expect(sameActor.reconcile).toBe(true);

    const distinctActor = actionAvailability({
      state: previewState,
      draftModules: [],
      actorRole: "admin",
      actorRef: "actor-2",
      creatorActorRef: "actor-1",
      environment: "fixture",
    });
    expect(distinctActor.submitApproval).toBe(true);
    expect(distinctActor.publish).toBe(false);

    const rejectedState = {
      ...previewState,
      latest_approval: { decision: "reject" },
    };
    expect(deriveReleaseStages(rejectedState).find((stage: { key: string }) => stage.key === "approval")?.status).toBe("blocked");
    expect(actionAvailability({
      state: rejectedState,
      draftModules: [],
      actorRole: "admin",
      actorRef: "actor-2",
      creatorActorRef: "actor-1",
      environment: "fixture",
    }).publish).toBe(false);

    const pendingReadbackState = {
      ...validControlState,
      latest_readback: { status: "pending" },
    };
    expect(deriveReleaseStages(pendingReadbackState).find((stage: { key: string }) => stage.key === "publish_readback")?.status).toBe("pending");
    expect(deriveReleaseStages({
      ...validControlState,
      inventory_modules: [{ ...validControlState.inventory_modules[0], registration: null }],
    }).find((stage: { key: string }) => stage.key === "registration")?.status).toBe("pending");
  });

  it("uses the control API client for each write path without persisting credentials", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = createControlPlaneClient({
      fetchImpl: (url: RequestInfo | URL, init?: RequestInit) => {
        const path = requestUrl(url);
        requests.push({ url: path, init: init ?? {} });
        const data = path.endsWith("/state") ? validControlState : {};
        return new Response(JSON.stringify({ status: "success", data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    client.setToken("request-scoped-token");
    await client.getControlState();
    await client.registerPackage({
      schema_version: CONTROL_SCHEMA_VERSION,
      module_id: "cargo",
      version: "1.0.0",
      descriptor_digest: descriptorDigest,
    }, "key-register");
    await client.createPreview({
      schema_version: CONTROL_SCHEMA_VERSION,
      intent: "change",
      desired_modules: [{
        module_id: "cargo",
        version: "1.0.0",
        descriptor_digest: descriptorDigest,
      }],
    }, "key-preview");
    await client.decideApproval({
      schema_version: CONTROL_SCHEMA_VERSION,
      preview_ref: "preview-1",
      decision: "approve",
      reason_code: "admin_ui_approval",
    }, "key-approval");
    await client.publish({
      schema_version: CONTROL_SCHEMA_VERSION,
      preview_ref: "preview-1",
      approval_id: "approval-1",
    }, "key-publish");
    await client.reconcile({
      schema_version: CONTROL_SCHEMA_VERSION,
      release_id: "release-1",
    }, "key-reconcile");

    expect(requests.map((request) => request.url)).toEqual([
      "/admin/api/v1/control/state",
      "/admin/api/v1/control/packages/register",
      "/admin/api/v1/control/deployments/preview",
      "/admin/api/v1/control/approvals",
      "/admin/api/v1/control/deployments/publish",
      "/admin/api/v1/control/deployments/reconcile",
    ]);
    for (const [index, request] of requests.entries()) {
      const headers = new Headers(request.init.headers);
      expect(headers.get("authorization")).toBe("Bearer request-scoped-token");
      expect(request.init.credentials).toBe("omit");
      if (index > 0) expect(headers.get("idempotency-key")).toBeTruthy();
    }
    expect(redactReference("opaque-ref")).toBe("已记录（具体内容隐藏）");
    expect(isFixtureIdentityVisible("fixture=1")).toBe(true);
    expect(isFixtureIdentityVisible("fixture=0")).toBe(false);
  });

  it("does not accept a success envelope from a non-2xx response", async () => {
    let request: { init: RequestInit } | undefined;
    const client = createControlPlaneClient({
      fetchImpl: (_url: RequestInfo | URL, init?: RequestInit) => {
        request = { init: init ?? {} };
        return new Response(JSON.stringify({ status: "success", data: validControlState }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(client.getControlState()).rejects.toMatchObject({
      name: "ControlPlaneError",
      status: "blocked",
    });
    expect(request?.init.credentials).toBe("omit");
  });

  it("wires the module-center shell, identity dialog, and fail-closed interactions", async () => {
    const [html, app, css] = await Promise.all([
      readFile(new URL("../../apps/admin/index.html", import.meta.url), "utf8"),
      readFile(new URL("../../apps/admin/app.js", import.meta.url), "utf8"),
      readFile(new URL("../../apps/admin/styles.css", import.meta.url), "utf8"),
    ]);

    expect(html).toContain('data-view="modules"');
    expect(html).toContain("模块中心");
    expect(html).toContain("Agent 接入");
    expect(html).toContain("适配器状态");
    expect(html).toContain("审批与发布");
    expect(html).toContain("审计日志");
    expect(html).toContain('id="identity-dialog"');
    expect(html).toMatch(/id="identity-token"[^>]+type="password"/);
    expect(html).not.toMatch(/local-fixture-(?:token|approver-token)/);
    expect(app).toContain('from "./control-plane.js"');
    expect(app).toContain("renderModuleCenter");
    expect(app).toContain("data-control-action");
    expect(app).toContain("已登记");
    expect(app).toContain("待审批");
    expect(app).toContain("当前激活");
    expect(app).toContain("本地演示申请人");
    expect(app).toContain("本地演示审批人");
    expect(app).toContain("报价、关务与客户数据仍由外部权威系统管理");
    expect(app).toContain("登记制品");
    expect(app).toContain("发布轨迹与回滚目标");
    expect(app).toContain("运行时已读回");
    expect(app).toContain("未获生产资格");
    expect(app).toContain("只有生成预览后才进入服务端审批链");
    expect(app).toContain("回滚到上一已读回版本（本地受控环境）");
    expect(app).toContain("manual_review");
    expect(app).toContain("publish");
    expect(app).toContain("reconcile");
    expect(app).toContain("rollback");
    expect(app).toContain("isFixtureIdentityVisible");
    expect(app).toContain("草稿只保留在当前浏览器内存");
    expect(app).not.toMatch(/active_verified.{0,80}(签名|生产资格)/s);
    expect(app).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("overflow-x: auto");
    expect(css).not.toMatch(/linear-gradient|radial-gradient|backdrop-filter/);
  });
});
