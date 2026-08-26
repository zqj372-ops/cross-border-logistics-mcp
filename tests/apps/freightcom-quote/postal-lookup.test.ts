import { describe, expect, it, vi } from "vitest";

import {
  createPostalLookup,
  parseNorthAmericanPostal,
} from "../../../apps/freightcom-quote/postal-lookup.mjs";

describe("美加邮编自动识别", () => {
  it("规范化加拿大邮编和美国 ZIP Code", () => {
    expect(parseNorthAmericanPostal("l3r 8n4")).toEqual({
      country: "CA",
      normalizedPostalCode: "L3R 8N4",
      lookupPostalCode: "L3R",
      approximate: true,
    });
    expect(parseNorthAmericanPostal("10001-1234")).toEqual({
      country: "US",
      normalizedPostalCode: "10001-1234",
      lookupPostalCode: "10001",
      approximate: false,
    });
    expect(parseNorthAmericanPostal("SW1A 1AA")).toBeNull();
  });

  it("使用加拿大 FSA 查询并返回城市、省份和国家", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      country: "Canada",
      "country abbreviation": "CA",
      places: [{
        "place name": "Markham",
        state: "Ontario",
        "state abbreviation": "ON",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const lookup = createPostalLookup({ fetchImpl });

    await expect(lookup("L3R 8N4")).resolves.toEqual({
      postal_code: "L3R 8N4",
      city: "Markham",
      region: "ON",
      country: "CA",
      approximate: true,
      source: "Zippopotam.us / GeoNames",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.zippopotam.us/ca/L3R",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("拒绝加拿大和美国以外的邮编格式", async () => {
    const lookup = createPostalLookup({ fetchImpl: vi.fn() });

    await expect(lookup("SW1A 1AA")).rejects.toMatchObject({
      code: "POSTAL_LOOKUP_INPUT_INVALID",
      status: 422,
    });
  });
});
