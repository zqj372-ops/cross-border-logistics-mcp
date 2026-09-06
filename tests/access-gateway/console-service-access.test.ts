import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface ServiceAccessUi {
  page(serviceId?: string): string;
  submit(form: unknown): Promise<boolean>;
  action(button: { dataset: Record<string, string> }): Promise<boolean>;
  change(event: unknown): boolean;
  reset(): void;
}
let createServiceAccessUi: (ui: unknown) => ServiceAccessUi;

beforeAll(async () => {
  const loaded = await import(pathToFileURL(resolve("apps/console/service-access.js")).href) as unknown as { createServiceAccessUi: (ui: unknown) => ServiceAccessUi };
  createServiceAccessUi = loaded.createServiceAccessUi;
});

type Row = Record<string, unknown>;
function harness(input: { organizationId?: string | null; applications?: Row[]; grants?: Row[]; requests?: Row[]; businessGrants?: Row[]; businessRequests?: Row[]; businessUnavailable?: boolean; role?: string } = {}) {
  const model = {
    session: { organization_id: input.organizationId === undefined ? "org_one" : input.organizationId, identity: { user_id: "user_owner" } },
    state: {
      current_organization: { organization_id: "org_one", display_name: "示例物流" }, organizations: [{ organization_id: "org_one", display_name: "示例物流" }],
      applications: input.applications ?? [], grants: input.grants ?? [], requests: input.requests ?? [], memberships: [{ organization_id: "org_one", user_id: "user_owner", status: "active", role: input.role ?? "developer" }],
    },
  };
  const businessOverview = { grants: input.businessGrants ?? [], requests: input.businessRequests ?? [], credentials: [], unavailable: input.businessUnavailable ?? false };
  const mutate = vi.fn(async (path: string) => { await Promise.resolve();
    if (path === "/applications") return { data: { application_id: "app_created" } };
    if (path === "/requests") return { data: { request_id: "preq_created", version: 1 } };
    if (path === "/business-access/requests") return { data: { request_id: "breq_created", version: 1 } };
    return { data: { state: "submitted", version: 2 } };
  });
  const ui = {
    model: () => model, businessAccess: { overview: () => businessOverview }, mutate,
    esc: (value: unknown) => String(value), icon: (name: string) => `<i>${name}</i>`,
    head: (title: string, description = "", action = "") => `<header><h1>${title}</h1><p>${description}</p>${action}</header>`,
    panel: (title: string, description: string, body: string, action = "") => `<section><h2>${title}</h2><p>${description}</p>${body}${action}</section>`,
    table: (headers: string[], rows: string[]) => `<table><thead>${headers.join("|")}</thead><tbody>${rows.join("")}</tbody></table>`,
    note: (text: string, tone = "") => `<aside data-tone="${tone}">${text}</aside>`,
    empty: (title: string, description: string, action = "") => `<div class="empty"><h2>${title}</h2><p>${description}</p>${action}</div>`,
    link: (label: string, route: string) => `<a data-go="${route}">${label}</a>`, badge: (status: string) => `<b>${status}</b>`, date: (value: string) => value,
    canCredential: (application: Row) => application?.owner_user_id === "user_owner",
    effectiveGrants: (id: string) => (input.grants ?? []).filter((grant) => grant.application_id === id && grant.state === "active"),
    refresh: vi.fn().mockResolvedValue(undefined), go: vi.fn(), notify: vi.fn(), render: vi.fn(),
  };
  return { api: createServiceAccessUi(ui), ui, mutate, model, businessOverview };
}

beforeEach(() => {
  vi.stubGlobal("FormData", class {
    readonly #values: Record<string, string>;
    readonly #services: string[];
    constructor(form: { values?: Record<string, string>; services?: string[] }) { this.#values = form.values ?? {}; this.#services = form.services ?? []; }
    get(name: string) { return this.#values[name] ?? null; }
    getAll(name: string) { return name === "services" ? this.#services : []; }
  });
});

describe("single-page service access", () => {
  it("sends users without an organization to membership onboarding", () => {
    const value = harness({ organizationId: null });
    const html = value.api.page();
    expect(html).toContain("先加入企业");
    expect(html).toContain('data-go="members"');
    expect(html).not.toContain('data-go="apply/new"');

    const emptyOrganization = harness();
    expect(emptyOrganization.api.page().match(/data-go="apply\/new"/gu)).toHaveLength(1);
  });

  it("blocks a viewer from service application pages and writes", async () => {
    const value = harness({ role: "viewer", applications: [{ application_id: "app_one", name: "业务系统", status: "active", owner_user_id: "user_owner" }] });
    expect(value.api.page()).toContain("当前账号无需提交服务申请");
    expect(value.api.page("customs.query")).toContain('data-go="workbench"');
    expect(value.api.page("new")).not.toContain('data-form="service-access"');
    await expect(value.api.submit({ dataset: { form: "service-access" } })).rejects.toMatchObject({ code: "organization_role_required" });
    await expect(value.api.action({ dataset: { action: "service-access-retry" } })).rejects.toMatchObject({ code: "organization_role_required" });
    expect(value.mutate).not.toHaveBeenCalled();
  });

  it("aggregates live grants and pending requests without calling them usage history", () => {
    const value = harness({
      applications: [{ application_id: "app_one", name: "业务系统", status: "active", owner_user_id: "user_owner" }],
      grants: [{ application_id: "app_one", state: "active", capabilities: ["cargo.calculate"] }],
      businessRequests: [{ request_id: "breq_one", application_id: "app_one", operations: ["customs.query"], justification: "报关查询", state: "submitted", version: 2, updated_at: "2026-09-06T01:00:00Z" }],
    });
    const html = value.api.page();
    expect(html).toContain("货物计算");
    expect(html).toContain("已开通");
    expect(html).toContain("关税与商品归类");
    expect(html).toContain('data-go="business-request/breq_one"');
    expect(html).toContain('data-go="apply/new"');
    expect(html).toContain("不代表业务调用记录");
  });

  it("defaults a requested service, disables live services, and reuses the sole owner application", () => {
    const value = harness({
      applications: [{ application_id: "app_one", name: "业务系统", status: "active", owner_user_id: "user_owner" }],
      grants: [{ application_id: "app_one", state: "active", capabilities: ["cargo.calculate"] }],
    });
    const html = value.api.page("customs.query");
    expect(html).toContain('name="application_id" value="app_one"');
    expect(html).toMatch(/value="customs\.query" checked/u);
    expect(html).toMatch(/value="cargo\.calculate"[^>]*disabled/u);
    expect(html).toContain("使用说明");
    expect(html).not.toContain("应用名称");
  });

  it("recalculates choices for a changed application while preserving available selections, and reset clears the selection", () => {
    const value = harness({
      applications: [{ application_id: "app_one", name: "系统一", status: "active", owner_user_id: "user_owner" }, { application_id: "app_two", name: "系统二", status: "active", owner_user_id: "user_owner" }],
      grants: [{ application_id: "app_one", state: "active", capabilities: ["cargo.calculate"] }],
      businessGrants: [{ application_id: "app_two", state: "active", operations: ["customs.query"] }],
    });
    value.api.page("customs.query");
    const state = () => ({ textContent: "" });
    const row = () => ({ classList: { toggle: vi.fn() }, querySelector: () => state() });
    const inputs = [
      { value: "cargo.calculate", checked: false, disabled: true, closest: () => row() },
      { value: "customs.query", checked: true, disabled: false, closest: () => row() },
      { value: "quote.zone_preview", checked: true, disabled: false, closest: () => row() },
    ];
    const purpose = { value: "用户已填写的用途" };
    const form = { querySelectorAll: () => inputs, purpose };
    expect(value.api.change({ target: { id: "service-access-application", value: "app_two", form } })).toBe(true);
    expect(inputs[0]).toMatchObject({ disabled: false, checked: false });
    expect(inputs[1]).toMatchObject({ disabled: true, checked: false });
    expect(inputs[2]).toMatchObject({ disabled: false, checked: true });
    expect(purpose.value).toBe("用户已填写的用途");
    expect(value.api.page("new")).toMatch(/value="app_two" selected/u);
    value.api.reset();
    expect(value.api.page("new")).toMatch(/value="app_one" selected/u);
  });

  it("shows a revoked or expired grant as historical state and permits a new application", () => {
    const value = harness({
      applications: [{ application_id: "app_one", name: "业务系统", status: "active", owner_user_id: "user_owner" }],
      businessRequests: [{ request_id: "breq_old", application_id: "app_one", operations: ["customs.query"], justification: "旧用途", state: "approved", version: 3, updated_at: "2026-09-01T00:00:00Z" }],
      businessGrants: [{ grant_id: "grant_old", request_id: "breq_old", application_id: "app_one", operations: ["customs.query"], state: "revoked", updated_at: "2026-09-05T00:00:00Z" }],
    });
    expect(value.api.page()).toContain("原授权已撤销");
    const form = value.api.page("customs.query");
    expect(form).toMatch(/value="customs\.query" checked/u);
    expect(form).not.toMatch(/value="customs\.query"[^>]*disabled/u);
  });

  it("fails closed when the business access overview is unavailable", () => {
    const value = harness({ businessUnavailable: true });
    expect(value.api.page()).toContain("业务授权状态暂时不可用");
    expect(value.api.page()).not.toContain('data-go="apply/new"');
    expect(value.api.page("customs.query")).toContain("暂不提交新的申请");
  });

  it("creates a default application and submits T0 and business requests from one form", async () => {
    const value = harness();
    const form = { dataset: { form: "service-access" }, values: { justification: "内部系统处理货物与关务资料" }, services: ["cargo.calculate", "customs.query"] };
    await value.api.submit(form);
    expect(value.mutate.mock.calls).toEqual([
      ["/applications", "POST", { name: "示例物流系统接入", purpose: "统一物流服务接入", environment: "production", owner_user_id: "user_owner" }],
      ["/requests", "POST", { application_id: "app_created", capabilities: ["cargo.calculate"], justification: "内部系统处理货物与关务资料" }],
      ["/requests/preq_created/submit", "POST", { expected_version: 1 }],
      ["/business-access/requests", "POST", { application_id: "app_created", operations: ["customs.query"], justification: "内部系统处理货物与关务资料" }],
      ["/business-access/requests/breq_created/submit", "POST", { expected_version: 1 }],
    ]);
    expect(value.ui.go).toHaveBeenCalledWith("apply");
    expect(value.ui.notify).toHaveBeenCalledWith("服务申请已提交，等待审核与开通。", false);
  });

  it("keeps a partial result retryable and never duplicates its created request", async () => {
    const value = harness({ applications: [{ application_id: "app_one", name: "业务系统", status: "active", owner_user_id: "user_owner" }] });
    let businessSubmitAttempts = 0;
    value.mutate.mockImplementation(async (path: string) => { await Promise.resolve();
      if (path === "/requests") return { data: { request_id: "preq_created", version: 1 } };
      if (path === "/business-access/requests") return { data: { request_id: "breq_created", version: 1 } };
      if (path.endsWith("breq_created/submit") && businessSubmitAttempts++ === 0) throw Object.assign(new Error("network"), { code: "network" });
      return { data: { state: "submitted", version: 2 } };
    });
    const form = { dataset: { form: "service-access" }, values: { application_id: "app_one", justification: "一次申请两类服务" }, services: ["cargo.calculate", "customs.query"] };
    await value.api.submit(form);
    expect(value.api.page()).toContain("部分申请尚未确认");
    expect(value.api.page()).toContain('data-action="service-access-retry"');

    await value.api.action({ dataset: { action: "service-access-retry" } });
    expect(value.mutate.mock.calls.filter(([path]) => path === "/business-access/requests")).toHaveLength(1);
    expect(value.mutate.mock.calls.filter(([path]) => path === "/business-access/requests/breq_created/submit")).toHaveLength(2);
    expect(value.mutate.mock.calls.filter(([path]) => path === "/requests")).toHaveLength(1);
    expect(value.api.page()).not.toContain("部分申请尚未确认");
  });
});
