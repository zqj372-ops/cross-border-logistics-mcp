import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const consoleDirectory = fileURLToPath(new URL("../../apps/access-console/", import.meta.url));

describe("narrow Access Console boundary", () => {
  it("adds a redacted operations overview and Agent onboarding without widening T0 authority", () => {
    const html = readFileSync(`${consoleDirectory}/index.html`, "utf8");
    const app = readFileSync(`${consoleDirectory}/app.js`, "utf8");
    const styles = readFileSync(`${consoleDirectory}/styles.css`, "utf8");
    const combined = `${html}\n${app}\n${styles}`;
    expect(html).toMatch(/租户/u);
    expect(html).toMatch(/密钥/u);
    expect(html).toMatch(/工具权限/u);
    expect(html).toMatch(/操作回读/u);
    expect(html).toMatch(/运营概览/u);
    expect(html).toMatch(/最近异常/u);
    expect(html).toMatch(/Agent 接入/u);
    expect(combined).not.toMatch(/模块|适配器|报价|关务|Freightcom|审批|发布|generic_write|任意 JSON|arbitrary JSON/iu);
    expect(combined).not.toMatch(/localStorage|sessionStorage|document\.cookie|location\.search|location\.hash/iu);
    expect(app).toMatch(/API_ROOT\s*=\s*["']\/admin\/api\/v1\/access["']/iu);
    expect(app).toMatch(/api\(["']\/state["']/iu);
    expect(app).toMatch(/api\(["']\/overview["']/iu);
    expect(app).toMatch(/\/access\/v1\/readyz/iu);
    expect(app).toMatch(/2026-08-27\.v1/iu);
    expect(app).toMatch(/Idempotency-Key/iu);
    expect(app).toMatch(/acknowledge-delivery|rotate|revoke/iu);
    expect(app).toMatch(/tool_names/iu);
    expect(app).toMatch(/operation_id/iu);
    expect(app).toMatch(/readback_not_verified/iu);
    expect(app).toMatch(/total_audit_events/iu);
    expect(app).toMatch(/recent_issues/iu);
    expect(app).toMatch(/supported_clients/iu);
    expect(html).not.toMatch(/7776000|90 天/iu);
  });
});
