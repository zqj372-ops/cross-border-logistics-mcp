import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const script = readFileSync("deploy/portal/configure-authentik-brand.py", "utf8");

describe("Authentik FreightClaw brand configuration", () => {
  it("keeps the locale selector legible on the light flow background", () => {
    expect(script).toContain("ak-locale-select::part(select)");
    expect(script).toContain("ak-locale-select.pf-m-dark");
    expect(script).toContain("color: #344054 !important");
    expect(script).toContain("background-color: #344054");
    expect(script).toContain("border: 1px solid #cdd5e2");
  });

  it("does not replace authentication labels with CSS-generated content", () => {
    expect(script).not.toMatch(/content\s*:/u);
    expect(script).not.toContain("Show password");
    expect(script).not.toContain("Log in");
  });
});
