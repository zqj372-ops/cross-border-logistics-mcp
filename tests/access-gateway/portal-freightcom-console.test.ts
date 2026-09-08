import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const consoleDirectory = fileURLToPath(new URL("../../apps/console/", import.meta.url));

describe("Freightcom Portal console", () => {
  it("offers an independent carrier preview without a quote save or booking action", () => {
    const source = readFileSync(`${consoleDirectory}/business.js`, "utf8");
    const freightcomView = source.slice(source.indexOf("function freightcomResults"), source.indexOf("function quoteResults"));
    expect(source).toContain("按实际托盘查询承运商费率");
    expect(source).toContain("data-form=\"business-freightcom\"");
    expect(source).toContain("call('quote/freightcom-ltl-preview', state.freightcomInput)");
    expect(freightcomView).toContain("承运商预估费用");
    expect(freightcomView).not.toContain("business-quote-save");
    expect(freightcomView).not.toContain("business-review-open");
  });

  it("lists the Freightcom operation as a separately requestable Business API permission", () => {
    const source = readFileSync(`${consoleDirectory}/business-access.js`, "utf8");
    expect(source).toContain("'quote.freightcom_ltl.preview': 'Freightcom LTL 承运商询价'");
    expect(source).toContain("'quote.freightcom_ltl.preview': '获取承运商当前费率、附加费和有效期'");
  });
});
