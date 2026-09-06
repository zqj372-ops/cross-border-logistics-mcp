import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface ApiKeysUi {
  page(view?: string): string;
  action(button: { dataset: Record<string, string> }): Promise<boolean>;
  submit(form: unknown): Promise<boolean>;
}
let createApiKeysUi: (ui: unknown) => ApiKeysUi;

beforeAll(async () => {
  const loaded = await import(pathToFileURL(resolve("apps/console/api-keys.js")).href) as unknown as { createApiKeysUi: (ui: unknown) => ApiKeysUi };
  createApiKeysUi = loaded.createApiKeysUi;
});

const application = (id: string, name: string) => ({ application_id: id, name, status: "active", owner_user_id: "user_owner" });
const credential = (overrides = {}) => ({ credential_id: "bkey_one", application_id: "app_one", label: "报价系统", operations: ["quote.zone_preview"], t0_mode: "none", status: "active", delivery_status: "acknowledged", secret_last_four: "1234", created_at: "2026-09-06T00:00:00.000Z", expires_at: 1_900_000_000, last_used_at: null, version: 4, ...overrides });

type FixtureRow = Record<string, unknown> & { application_id?: string };

function harness(input: { applications?: FixtureRow[]; t0Grants?: FixtureRow[]; businessGrants?: FixtureRow[]; credentials?: FixtureRow[]; unavailable?: boolean; role?: string } = {}) {
  const model = { session: { organization_id: "org_one", identity: { user_id: "user_owner" } }, state: { applications: input.applications ?? [], memberships: [{ organization_id: "org_one", user_id: "user_owner", status: "active", role: input.role ?? "developer" }] } };
  const overview = { grants: input.businessGrants ?? [], credentials: input.credentials ?? [], unavailable: input.unavailable ?? false };
  const mutate = vi.fn().mockResolvedValue({ data: { credential: credential({ credential_id: "bkey_new", version: 1 }), api_key: "flcbk_secret", delivery: "one_time" } });
  const ui = {
    model: () => model,
    businessAccess: { overview: () => overview },
    request: vi.fn(), mutate,
    esc: (value: unknown) => String(value), icon: (name: string) => `<i>${name}</i>`,
    head: (title: string, description = "", action = "") => `<header><h1>${title}</h1><p>${description}</p>${action}</header>`,
    panel: (title: string, description: string, body: string, action = "") => `<section><h2>${title}</h2><p>${description}</p>${body}${action}</section>`,
    table: (headers: string[], rows: string[]) => `<table><thead>${headers.join("|")}</thead><tbody>${rows.join("")}</tbody></table>`,
    note: (text: string) => `<aside>${text}</aside>`,
    empty: (title: string, description: string, action = "") => `<div class="empty"><h2>${title}</h2><p>${description}</p>${action}</div>`,
    link: (label: string, route: string) => `<a data-go="${route}">${label}</a>`,
    badge: (status: string) => `<b>${status}</b>`, date: (value: string) => value,
    canCredential: (app: { owner_user_id?: string }) => app?.owner_user_id === "user_owner",
    effectiveGrants: (id: string) => (input.t0Grants ?? []).filter((grant) => grant.application_id === id),
    refresh: vi.fn().mockResolvedValue(undefined), go: vi.fn(), notify: vi.fn(), showSecret: vi.fn(), render: vi.fn(),
  };
  return { api: createApiKeysUi(ui), ui, mutate, overview };
}

beforeEach(() => {
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("FormData", class {
    readonly #values: Record<string, string>;
    constructor(form: { values?: Record<string, string> }) { this.#values = form.values ?? {}; }
    get(name: string) { return this.#values[name] ?? null; }
  });
});

describe("unified API Key console module", () => {
  it("uses one service-application action when no application or live grant exists", () => {
    const withoutApp = harness();
    expect(withoutApp.api.page()).toContain('data-go="apply"');
    expect(withoutApp.api.page()).toContain("申请服务");

    const withoutGrant = harness({ applications: [application("app_one", "报价 Agent")] });
    expect(withoutGrant.api.page()).toContain("尚无已开通服务");
    expect(withoutGrant.api.page()).toContain('data-go="apply"');
    expect(withoutGrant.api.page()).not.toContain('data-go="api-keys/new"');
  });

  it("blocks a viewer from Key pages and mutations without sending a request", async () => {
    const value = harness({ role: "viewer", applications: [application("app_one", "报价 Agent")], credentials: [credential()] });
    expect(value.api.page()).toContain("无需管理 API Key");
    expect(value.api.page("new")).toContain('data-go="workbench"');
    expect(value.api.page("new")).not.toContain('data-form="api-key-create"');
    await expect(value.api.submit({ dataset: { form: "api-key-create" } })).rejects.toMatchObject({ code: "organization_role_required" });
    await expect(value.api.action({ dataset: { action: "api-key-revoke", id: "bkey_one" } })).rejects.toMatchObject({ code: "organization_role_required" });
    expect(value.mutate).not.toHaveBeenCalled();
  });

  it("renders one combined list and explicitly enables T0 on a legacy key with the current version", async () => {
    const value = harness({
      applications: [application("app_one", "报价 Agent")],
      t0Grants: [{ application_id: "app_one", state: "active", capabilities: ["cargo.calculate"] }],
      businessGrants: [{ application_id: "app_one", state: "active", operations: ["quote.zone_preview"] }],
      credentials: [credential()],
    });
    const html = value.api.page();
    expect(html).toContain("统一 API Key");
    expect(html).toContain("flcbk_…1234");
    expect(html).toContain("启用基础工具");
    expect(html).toContain("加拿大尾程询价");

    await value.api.action({ dataset: { action: "api-key-enable-t0", id: "bkey_one" } });
    expect(value.mutate).toHaveBeenCalledWith("/business-access/credentials/bkey_one/t0-mode", "POST", { expected_version: 4, mode: "current_grant" });
    expect(value.ui.refresh).toHaveBeenCalledOnce();
    expect(value.ui.render).toHaveBeenCalledOnce();
  });

  it("keeps existing keys visible without a live grant so they can still be revoked", () => {
    const value = harness({ applications: [application("app_one", "报价 Agent")], credentials: [credential()] });
    const html = value.api.page();
    expect(html).toContain("flcbk_…1234");
    expect(html).toContain('data-action="api-key-revoke"');
    expect(html).not.toContain('data-action="api-key-update-services"');
    expect(html).not.toContain('data-action="api-key-rotate"');
    expect(html).not.toContain('data-go="api-keys/new"');
  });

  it("shows an unavailable state instead of treating a failed overview as empty authorization", () => {
    const value = harness({ applications: [application("app_one", "报价 Agent")], unavailable: true });
    expect(value.api.page()).toContain("统一 API Key 状态暂时不可用");
    expect(value.api.page()).not.toContain('data-go="apply"');
    expect(value.api.page()).not.toContain('data-go="api-keys/new"');
    expect(value.api.page("new")).toContain("暂不签发新 Key");
  });

  it("creates one key with every active scope and no permission checkboxes", async () => {
    const value = harness({
      applications: [application("app_one", "报价 Agent"), application("app_two", "关务 Agent")],
      t0Grants: [{ application_id: "app_two", state: "active", capabilities: ["cargo.calculate", "container.plan_summary"] }],
      businessGrants: [{ application_id: "app_one", state: "active", operations: ["quote.zone_preview"] }, { application_id: "app_two", state: "active", operations: ["customs.query", "quote.zone_preview"] }],
    });
    const html = value.api.page("new");
    expect(html).toContain('name="application_id"');
    expect(html).toContain("自动读取所选应用当前全部已开通服务");
    expect(html).not.toContain('type="checkbox"');

    const form = { dataset: { form: "api-key-create" }, values: { application_id: "app_two", label: "生产 Agent", expires_in_seconds: "2592000" } } as unknown as HTMLFormElement;
    await value.api.submit(form);
    expect(value.mutate).toHaveBeenCalledWith("/business-access/applications/app_two/credentials", "POST", {
      label: "生产 Agent",
      operations: ["customs.query", "quote.zone_preview"],
      t0_mode: "current_grant",
      expires_in_seconds: 2_592_000,
    });
    expect(value.ui.showSecret).toHaveBeenCalledWith(expect.anything(), "app_two", "unified");
    expect(value.ui.go).toHaveBeenCalledWith("api-keys");
  });

  it("offers an explicit service update after a new grant and rotates to the current operations", async () => {
    const value = harness({
      applications: [application("app_one", "报价 Agent")],
      businessGrants: [{ application_id: "app_one", state: "active", operations: ["quote.zone_preview", "customs.query"] }],
      credentials: [credential({ operations: ["quote.zone_preview", "quote.ai_extract_preview"] })],
    });
    const html = value.api.page();
    expect(html).toContain('data-action="api-key-update-services"');
    expect(html).toContain("加拿大尾程询价");
    expect(html).not.toContain("关税与归类");
    await value.api.action({ dataset: { action: "api-key-update-services", id: "bkey_one" } });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("旧 Key 失效"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("重新保存"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("新增或移除"));
    expect(value.mutate).toHaveBeenCalledWith("/business-access/credentials/bkey_one/rotate", "POST", {
      expected_version: 4,
      operations: ["quote.zone_preview", "customs.query"],
      t0_mode: "none",
      expires_in_seconds: 2_592_000,
    });
    expect(value.ui.showSecret).toHaveBeenCalledWith(expect.anything(), "app_one", "unified");
  });

  it("offers removal-only synchronization and drops current_grant when no T0 grant remains", async () => {
    const value = harness({
      applications: [application("app_one", "报价 Agent")],
      businessGrants: [{ application_id: "app_one", state: "active", operations: ["quote.zone_preview"] }],
      credentials: [credential({ operations: ["quote.zone_preview", "customs.query"], t0_mode: "current_grant" })],
    });
    const html = value.api.page();
    expect(html).toContain('data-action="api-key-update-services"');
    expect(html).not.toContain("关税与归类");
    await value.api.action({ dataset: { action: "api-key-update-services", id: "bkey_one" } });
    expect(value.mutate).toHaveBeenCalledWith("/business-access/credentials/bkey_one/rotate", "POST", {
      expected_version: 4,
      operations: ["quote.zone_preview"],
      t0_mode: "none",
      expires_in_seconds: 2_592_000,
    });
  });

  it("creates a T0-only unified key without inventing a business operation", async () => {
    const value = harness({
      applications: [application("app_one", "装柜 Agent")],
      t0Grants: [{ application_id: "app_one", state: "active", capabilities: ["container.plan_summary"] }],
    });
    const form = { dataset: { form: "api-key-create" }, values: { application_id: "app_one", label: "装柜接入", expires_in_seconds: "604800" } };
    await value.api.submit(form);
    expect(value.mutate).toHaveBeenCalledWith("/business-access/applications/app_one/credentials", "POST", {
      label: "装柜接入",
      operations: [],
      t0_mode: "current_grant",
      expires_in_seconds: 604_800,
    });
  });

  it("keeps a legacy key's authority unchanged during rotation and supports acknowledgement and revocation", async () => {
    const value = harness({
      applications: [application("app_one", "报价 Agent")],
      t0Grants: [{ application_id: "app_one", state: "active", capabilities: ["cargo.calculate"] }],
      businessGrants: [{ application_id: "app_one", state: "active", operations: ["quote.zone_preview", "customs.query"] }],
      credentials: [credential({ delivery_status: "pending" })],
    });
    await value.api.action({ dataset: { action: "api-key-rotate", id: "bkey_one" } });
    expect(value.mutate).toHaveBeenCalledWith("/business-access/credentials/bkey_one/rotate", "POST", { expected_version: 4, operations: ["quote.zone_preview"], t0_mode: "none", expires_in_seconds: 2_592_000 });
    expect(value.ui.showSecret).toHaveBeenCalledWith(expect.anything(), "app_one", "unified");

    value.mutate.mockClear();
    await value.api.action({ dataset: { action: "api-key-acknowledge", id: "bkey_one" } });
    expect(value.mutate).toHaveBeenCalledWith("/business-access/credentials/bkey_one/acknowledge", "POST", { expected_version: 4 });

    value.mutate.mockClear();
    await value.api.action({ dataset: { action: "api-key-revoke", id: "bkey_one" } });
    expect(value.mutate).toHaveBeenCalledWith("/business-access/credentials/bkey_one/revoke", "POST", { expected_version: 4 });
  });
});
