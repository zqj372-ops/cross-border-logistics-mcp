import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const appPath = fileURLToPath(new URL("../../apps/access-console/app.js", import.meta.url));

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<() => void>>();
  readonly classList = { toggle() {} };
  readonly dataset: Record<string, string> = {};
  textContent = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  isConnected = true;
  tabIndex = 0;
  type = "";
  className = "";

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
    if (selector === "input:checked") return descendants.filter((child) => child.type === "checkbox" && child.checked);
    if (selector === "input") return descendants.filter((child) => child.type === "checkbox");
    return descendants;
  }

  addEventListener(name: string, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }

  setAttribute(): void {}
  removeAttribute(): void {}
  focus(): void {}
  scrollIntoView(): void {}
  showModal(): void {}
  close(): void { this.dispatch("close"); }
}

interface FetchCall {
  readonly url: string;
  readonly options: Record<string, unknown>;
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: () => Promise.resolve(body) } as Response;
}

function createHarness(fetchImpl: (url: string, options: Record<string, unknown>) => Promise<Response>) {
  const elements = new Map<string, FakeElement>();
  const byId = (id: string) => {
    let element = elements.get(id);
    if (element === undefined) {
      element = new FakeElement();
      elements.set(id, element);
    }
    return element;
  };
  byId("rotation-expiry").value = "2592000";

  const document = {
    getElementById: byId,
    createElement: () => new FakeElement(),
    createTextNode: () => new FakeElement(),
    querySelectorAll: () => [] as FakeElement[],
    querySelector: () => null,
  };
  const source = `${readFileSync(appPath, "utf8")}\n;globalThis.__rotationTest = { openRotationDialog, updateRotationDiff, submitRotation };`;
  const context = vm.createContext({
    console,
    document,
    fetch: fetchImpl,
    crypto: { randomUUID: () => "11111111-2222-4333-8444-555555555555" },
    Date,
    FormData: class { get() { return "2592000"; } },
    HTMLInputElement: FakeElement,
    HTMLSelectElement: FakeElement,
    URLSearchParams,
    encodeURIComponent,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: appPath });
  return {
    elements,
    api: (context as unknown as { __rotationTest: {
      openRotationDialog(credential: unknown, trigger: FakeElement): void;
      updateRotationDiff(): void;
      submitRotation(): Promise<void>;
    } }).__rotationTest,
  };
}

const credential = Object.freeze({
  credential_id: "key_original",
  tenant_id: "tenant_alpha",
  client_id: "agent_ops",
  label: "Operations",
  secret_last_four: "1234",
  effective_status: "active",
  expires_at: 1_800_000_000,
  tool_names: ["cargo.calculate", "system.agent_context.get"],
});

describe("Access Console credential rotation behavior", () => {
  it("preserves the target tools, locks double submits, and does not rotate again after committed readback failure", async () => {
    const calls: FetchCall[] = [];
    let releaseRotate!: () => void;
    const rotateGate = new Promise<void>((resolve) => { releaseRotate = resolve; });
    const harness = createHarness(async (url, options = {}) => { await Promise.resolve();
      calls.push({ url, options });
      if (url.endsWith("/rotate")) {
        await rotateGate;
        return jsonResponse({
          status: "success",
          data: {
            api_key: "lmcpk_new_secret",
            credential: { credential_id: "key_new" },
            operation: { operation_id: "operation_rotate" },
          },
        });
      }
      throw new Error("readback unavailable");
    });

    harness.api.openRotationDialog(credential, new FakeElement());
    const checked = harness.elements.get("rotation-tools")!.querySelectorAll("input:checked").map((item) => item.value);
    expect(checked).toEqual(credential.tool_names);
    const first = harness.api.submitRotation();
    const duplicate = harness.api.submitRotation();
    releaseRotate();
    await Promise.all([first, duplicate]);
    await harness.api.submitRotation();

    const rotations = calls.filter((call) => call.url.endsWith("/rotate"));
    expect(rotations).toHaveLength(1);
    expect(JSON.parse(String(rotations[0]!.options.body))).toEqual({
      schema_version: "2026-08-27.v1",
      tool_names: credential.tool_names,
      expires_in_seconds: 2_592_000,
      reason_code: "operator_rotated",
    });
    expect(harness.elements.get("one-time-key")!.textContent).toBe("lmcpk_new_secret");
  });

  it("compares the edited tools with the target credential tools", () => {
    const harness = createHarness(() => Promise.reject(new Error("network must not be used")));
    harness.api.openRotationDialog(credential, new FakeElement());
    expect(harness.elements.get("rotation-diff")!.textContent).toBe("权限不变");
  });

  it("retries an unknown network result with the same idempotency key and identical body", async () => {
    const calls: FetchCall[] = [];
    let attempts = 0;
    const harness = createHarness(async (url, options = {}) => { await Promise.resolve();
      calls.push({ url, options });
      if (!url.endsWith("/rotate")) throw new Error("initial state unavailable");
      attempts += 1;
      if (attempts === 1) throw new Error("network unavailable");
      return jsonResponse({
        status: "success",
        data: {
          api_key: "lmcpk_retry_secret",
          credential: { credential_id: "key_retry" },
          operation: { operation_id: "operation_retry" },
        },
      });
    });

    harness.api.openRotationDialog(credential, new FakeElement());
    await harness.api.submitRotation();
    await harness.api.submitRotation();

    const rotations = calls.filter((call) => call.url.endsWith("/rotate"));
    expect(rotations).toHaveLength(2);
    const firstHeaders = rotations[0]!.options.headers as Record<string, string>;
    const secondHeaders = rotations[1]!.options.headers as Record<string, string>;
    expect(secondHeaders["Idempotency-Key"]).toBe(firstHeaders["Idempotency-Key"]);
    expect(rotations[1]!.options.body).toBe(rotations[0]!.options.body);
  });
});
