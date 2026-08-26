import { describe, expect, it } from "vitest";

import {
  ORIGIN_ADDRESS_PRESETS,
  findOriginAddressPreset,
} from "../../../apps/freightcom-quote/origin-presets.mjs";

describe("Freightcom 固定发货地址", () => {
  it("只提供 Calgary 和 Markham 两个加拿大地址", () => {
    expect(ORIGIN_ADDRESS_PRESETS).toEqual([
      {
        id: "calgary-t2e6m9",
        label: "Calgary · 1155 40 Ave NE",
        address_line_1: "1155 40 Ave NE",
        city: "Calgary",
        region: "AB",
        country: "CA",
        postal_code: "T2E 6M9",
      },
      {
        id: "markham-l3r3j7",
        label: "Markham · 331 Amber St",
        address_line_1: "331 Amber St",
        city: "Markham",
        region: "ON",
        country: "CA",
        postal_code: "L3R 3J7",
      },
    ]);
  });

  it("未知选项保持失败闭合", () => {
    expect(findOriginAddressPreset("calgary-t2e6m9")).toEqual(ORIGIN_ADDRESS_PRESETS[0]);
    expect(findOriginAddressPreset("warehouse-3")).toBeNull();
    expect(findOriginAddressPreset("")).toBeNull();
  });
});
