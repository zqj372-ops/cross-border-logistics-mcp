import { describe, expect, it } from "vitest";

import { normalizeCarrierId } from "../../../services/maritime/schedule-collector/carriers/aliases";
import {
  CARRIER_IDS,
  parseCollectorQueryInput,
} from "../../../services/maritime/schedule-collector/contracts";

describe("schedule collector carrier aliases", () => {
  it("normalizes every supported alias to one canonical carrier id", () => {
    expect(normalizeCarrierId("emc")).toBe("EVERGREEN");
    expect(normalizeCarrierId("MSK")).toBe("MAERSK");
    expect(normalizeCarrierId("美森")).toBe("MATSON");
    expect(normalizeCarrierId("WAN_HAI")).toBe("WHL");
    expect(normalizeCarrierId("YANG_MING")).toBe("YML");
    expect(normalizeCarrierId("HAPAG")).toBe("HAPAG_LLOYD");
    expect(normalizeCarrierId("unknown")).toBeNull();
  });

  it("normalizes aliases before query contract validation", () => {
    const base = {
      origin: { text: "Shanghai", country_code: "CN", carrier_location_id: null },
      destination: {
        text: "Vancouver",
        country_code: "CA",
        carrier_location_id: null,
      },
      from: "2026-09-17",
      until: "2026-10-14",
      routing: "any" as const,
    };
    for (const [alias, canonical] of [
      ["EMC", "EVERGREEN"],
      ["msk", "MAERSK"],
      ["美森", "MATSON"],
    ] as const) {
      expect(
        parseCollectorQueryInput({ ...base, carrier: alias }).carrier,
      ).toBe(canonical);
    }
    expect(() =>
      parseCollectorQueryInput({ ...base, carrier: "NOT_A_CARRIER" }),
    ).toThrow();
  });

  it("keeps the canonical registry list closed and stable", () => {
    expect(CARRIER_IDS).toEqual([
      "COSCO",
      "OOCL",
      "EVERGREEN",
      "HMM",
      "WHL",
      "YML",
      "ZIM",
      "HAPAG_LLOYD",
      "ONE",
      "MAERSK",
      "MSC",
      "MATSON",
    ]);
  });
});
