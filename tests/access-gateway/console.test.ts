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
    expect(html).toMatch(/API Key/u);
    expect(html).toMatch(/工具权限/u);
    expect(html).toMatch(/操作记录/u);
    expect(html).toMatch(/接入工作台/u);
    expect(html).toMatch(/最近需要关注/u);
    expect(html).toMatch(/Agent 接入/u);
    expect(html).toMatch(/class="skip-link"/u);
    expect(html).toMatch(/class="app-shell"/u);
    expect(html).toMatch(/class="sidebar"/u);
    expect(html).toMatch(/data-page="overview"/u);
    expect(html).toMatch(/data-page="access"/u);
    expect(html).toMatch(/data-page="operations"/u);
    expect(html).toMatch(/data-page="identity"/u);
    expect(combined).not.toMatch(/generic_write|任意 JSON|arbitrary JSON/iu);
    expect(combined).not.toMatch(/localStorage|sessionStorage|document\.cookie|location\.search|location\.hash/iu);
    expect(styles).toMatch(/#202939/iu);
    expect(styles).toMatch(/#3659db/iu);
    expect(styles).toMatch(/grid-template-columns:\s*224px/iu);
    expect(styles).toMatch(/:focus-visible/iu);
    expect(styles).toMatch(/prefers-reduced-motion/iu);
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
    expect(app).toMatch(
      /async function acknowledgeDelivery[\s\S]*await post[\s\S]*payload !== null[\s\S]*pendingCredentialId === credentialId[\s\S]*hideOneTimeKey\(\)/u,
    );
    expect(app).toMatch(/total_audit_events/iu);
    expect(app).toMatch(/recent_issues/iu);
    expect(app).toMatch(/supported_clients/iu);
    expect(html).not.toMatch(/7776000|90 天/iu);
  });

  it("freezes one credential rotation attempt and never rotates again after a key is returned", () => {
    const html = readFileSync(`${consoleDirectory}/index.html`, "utf8");
    const app = readFileSync(`${consoleDirectory}/app.js`, "utf8");

    expect(html).toMatch(/原 Key 到期时间|rotation-current/u);
    expect(html).toMatch(/从现在起 30 天/u);
    expect(html).toMatch(/旧凭证将立即失效/u);
    expect(app).toMatch(/tenant_id[\s\S]*client_id[\s\S]*secret_last_four/u);
    expect(app).toMatch(/credential\.expires_at/u);
    expect(app).toMatch(/Date\.now\(\) \+ seconds \* 1000/u);
    expect(app).toMatch(/lockRotationAttempt[\s\S]*idempotencyKey: idempotencyKey\(\)[\s\S]*Object\.freeze/u);
    expect(app).toMatch(/options\.idempotencyKey \?\? idempotencyKey\(\)/u);
    expect(app).toMatch(/pendingRotation\.committed \|\| pendingRotation\.submitting/u);
    expect(app).toMatch(/pendingRotation\.attempt\.body[\s\S]*pendingRotation\.attempt\.idempotencyKey/u);
    expect(app).toMatch(/pendingRotation\.committed = true[\s\S]*api_key[\s\S]*refreshState/u);
    expect(app).toMatch(/Key 已轮换，状态待核验[\s\S]*不要再次轮换/u);
    expect(app).toMatch(/使用同一请求重试/u);
    expect(app).toMatch(/trigger\?\.isConnected[\s\S]*elements\.credentials\.focus/u);
    expect(app).not.toMatch(/rotateCredential\(credentialId\)/u);
  });
});
