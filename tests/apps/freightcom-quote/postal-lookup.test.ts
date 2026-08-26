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
    let requestedUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = input;
      requestInit = init;
      return Promise.resolve(new Response(JSON.stringify({
        country: "Canada",
        "country abbreviation": "CA",
        places: [{
          "place name": "Markham",
          state: "Ontario",
          "state abbreviation": "ON",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    const lookup = createPostalLookup({ fetchImpl });

    await expect(lookup("L3R 8N4")).resolves.toEqual({
      postal_code: "L3R 8N4",
      city: "Markham",
      region: "ON",
      country: "CA",
      approximate: true,
      source: "Zippopotam.us / GeoNames",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestedUrl).toBe("https://api.zippopotam.us/ca/L3R");
    expect(new Headers(requestInit?.headers).get("accept")).toBe("application/json");
    expect(requestInit?.redirect).toBe("error");
  });

  it("拒绝邮编服务重定向而不跟随到非许可主机", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return Promise.resolve(new Response("", {
        status: 302,
        headers: { location: "http://127.0.0.1/internal" },
      }));
    });
    const lookup = createPostalLookup({ fetchImpl });

    await expect(lookup("10001")).rejects.toMatchObject({
      code: "POSTAL_LOOKUP_UNAVAILABLE",
      status: 503,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestInit?.redirect).toBe("error");
  });

  it.each([
    [
      "a missing postal code",
      new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
      "POSTAL_LOOKUP_NOT_FOUND",
      404,
    ],
    [
      "malformed provider JSON",
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
      "POSTAL_LOOKUP_RESPONSE_INVALID",
      503,
    ],
    [
      "an oversized not-found response",
      new Response("{}", {
        status: 404,
        headers: {
          "content-length": String(64 * 1024 + 1),
          "content-type": "application/json",
        },
      }),
      "POSTAL_LOOKUP_RESPONSE_INVALID",
      503,
    ],
  ] as const)("preserves the classification for %s", async (_label, providerResponse, code, status) => {
    const fetchImpl = vi.fn(() => Promise.resolve(providerResponse));
    const lookup = createPostalLookup({ fetchImpl });

    await expect(lookup("10001")).rejects.toMatchObject({ code, status });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("拒绝加拿大和美国以外的邮编格式", async () => {
    const lookup = createPostalLookup({ fetchImpl: vi.fn() });

    await expect(lookup("SW1A 1AA")).rejects.toMatchObject({
      code: "POSTAL_LOOKUP_INPUT_INVALID",
      status: 422,
    });
  });
});
