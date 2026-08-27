import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const consoleDirectory = fileURLToPath(new URL("../../apps/access-console/", import.meta.url));

describe("narrow Access Console boundary", () => {
  it("contains only tenant, client, key, three tools, and operation readback surfaces", () => {
    const html = readFileSync(`${consoleDirectory}/index.html`, "utf8");
    const app = readFileSync(`${consoleDirectory}/app.js`, "utf8");
    const styles = readFileSync(`${consoleDirectory}/styles.css`, "utf8");
    const combined = `${html}\n${app}\n${styles}`;
    expect(html).toMatch(/租户/u);
    expect(html).toMatch(/客户端/u);
    expect(html).toMatch(/密钥/u);
    expect(html).toMatch(/工具权限/u);
    expect(html).toMatch(/操作回读/u);
    expect(combined).not.toMatch(/模块|适配器|报价|关务|Freightcom|审批|发布|generic_write|任意 JSON|arbitrary JSON/iu);
    expect(combined).not.toMatch(/localStorage|sessionStorage|document\.cookie|location\.search|location\.hash/iu);
    expect(app).toMatch(/fetch\(["']\/access\/v1\/state/iu);
    expect(app).toMatch(/requested_tool_names|tool_names/iu);
  });
});
