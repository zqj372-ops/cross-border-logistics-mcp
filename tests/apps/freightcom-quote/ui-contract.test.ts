import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const APP_DIR = new URL("../../../apps/freightcom-quote/", import.meta.url);

describe("Freightcom 询价页中文界面契约", () => {
  it("所有主要静态界面文案均使用中文", async () => {
    const html = await readFile(new URL("index.html", APP_DIR), "utf8");

    expect(html).toContain("<title>询价工作台 · 新建询价</title>");
    expect(html).toContain("发货地");
    expect(html).toContain("收货地");
    expect(html).toContain("最低必填信息");
    expect(html).toContain("邮编会自动带出城市、省/州和国家");
    expect(html).toContain("托盘明细");
    expect(html).toContain("获取测试报价");
    expect(html).toContain("承运商 / 服务");
    expect(html).not.toContain("询价条件");
    expect(html).not.toContain("高级选项");
    expect(html).not.toContain("托盘附加服务");
    expect(html).not.toMatch(/Quote Workbench|Shipment details|RATE RESPONSE|USD display only|No FX conversion|Carrier \/ Service|MANUAL REVIEW/);
  });

  it("仅保留最低必填输入并自动查询美加邮编", async () => {
    const [html, script] = await Promise.all([
      readFile(new URL("index.html", APP_DIR), "utf8"),
      readFile(new URL("app.js", APP_DIR), "utf8"),
    ]);

    expect(script).toContain("托盘 ${index + 1}");
    expect(script).toContain("来源币种：");
    expect(script).toContain("未知承运商");
    expect(script).toContain("天");
    expect(script).toContain("/api/postal-lookup");
    expect(script).toContain("currentLocalDate");
    expect(script).not.toContain("nextBusinessDate");
    expect(script).not.toMatch(/Unknown carrier|Unknown service|manual review|Rates ready|provider rates|TEST · review/);

    expect(html).toContain('name="origin.addressPreset"');
    expect(html).toContain('name="origin.postal_code" type="hidden"');
    expect(html).toContain('name="destination.postal_code"');
    expect(html).not.toContain('data-postal-input="origin"');
    expect(html).toContain('data-postal-input="destination"');
    expect(html).toContain('name="expectedShipDate" type="hidden"');
    expect(html).toContain('name="destination.readyAt" type="hidden" value="09:00"');
    expect(html).toContain('name="destination.readyUntil" type="hidden" value="17:00"');
    expect(html).toContain('name="destination.signatureRequirement" type="hidden" value="not-required"');
    expect(html).toContain('name="origin.locationType"');
    expect(html).toContain('name="destination.locationType"');
    expect(html).toContain('value="commercial-no-tailgate"');
    expect(html).toContain('value="residential-tailgate"');
    expect(script).toContain("ORIGIN_ADDRESS_PRESETS");
    expect(script).toContain("initializeOriginAddressPresets");
    expect(script).toContain("applyOriginAddressPreset");
    expect(script).toContain("suggestFreightClass");
    expect(script).toContain("updatePalletFreightClass");
    expect(script).toContain("NMFTA 2025 密度建议");
    expect(script).toContain("特殊商品请核对 NMFC");
    expect(script).toContain('<option value="kg" selected>kg</option>');
    expect(script).toContain('<option value="cm" selected>cm</option>');
    expect(script).toContain('placeholder="120"');
    expect(script).toContain('placeholder="100" aria-label="宽度"');
    expect(script).toContain('placeholder="130" aria-label="高度"');
    expect(script).not.toContain('<option value="lb" selected>lb</option>');
    expect(script).not.toContain('<option value="in" selected>in</option>');
    expect(html).toContain("发货地址限定为 Calgary 和 Markham 两个仓库");
    expect(html).toContain("CAD 报价保留原数字，仅将显示币种改为 USD");
    expect(html).toContain("100 CAD 显示为 USD 100.00");
    expect(html).not.toContain("只有上游实际返回 USD 结算金额时才显示");
    expect(html).not.toContain("不会把 CAD 数字改标为 USD");
    expect(html).not.toContain('name="services"');
    expect(html).not.toContain('name="pallet.dangerousGoods"');
    expect(html).not.toContain('name="advanced.insuranceType"');
  });

  it("报价结果表只展示服务商、总价和运输时效", async () => {
    const [html, script, styles] = await Promise.all([
      readFile(new URL("index.html", APP_DIR), "utf8"),
      readFile(new URL("app.js", APP_DIR), "utf8"),
      readFile(new URL("styles.css", APP_DIR), "utf8"),
    ]);

    expect(html).toContain("<th>承运商 / 服务</th><th>总价 <small>显示为 USD</small></th><th>运输时效</th>");
    expect(html).not.toContain("<th>基础运费</th>");
    expect(html).not.toContain("<th>附加费与税费</th>");
    expect(html).not.toContain("<th>状态</th>");
    expect(script).not.toContain("formatChargeList");
    expect(script).not.toContain("charge-cell");
    expect(script).not.toContain("row-status");
    expect(script).toContain('colspan="3"');
    expect(styles).toContain("min-width: 0");
  });
});
