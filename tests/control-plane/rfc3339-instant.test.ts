import { describe, expect, it } from "vitest";

import {
  ADMIN_CONTROL_RFC3339_PATTERN,
  addRfc3339Milliseconds,
  compareRfc3339Instants,
  formatRfc3339InstantUtc,
  parseRfc3339Instant,
} from "../../src/logistics_mcp/control-plane/rfc3339-instant";

describe("admin-control RFC3339 instant helpers", () => {
  it("uses one strict lexical contract for years, leap days, offsets, and 1-9 fractions", () => {
    const accepted = [
      "0000-01-01T00:00:00Z",
      "2000-02-29T23:59:59.1Z",
      "2026-08-23T00:00:00.123456789+14:00",
      "2026-08-23T00:00:00-14:00",
      "9999-12-31T23:59:59.999999999Z",
    ];
    const rejected = [
      "1900-02-29T00:00:00Z",
      "2026-02-29T00:00:00Z",
      "2026-08-23T00:00:00.1234567890Z",
      "2026-08-23T00:00:00+14:01",
      "2026-08-23T00:00:00+15:00",
      "2026-08-23t00:00:00z",
    ];

    for (const value of accepted) {
      expect(ADMIN_CONTROL_RFC3339_PATTERN.test(value)).toBe(true);
      expect(parseRfc3339Instant(value)).not.toBeNull();
    }
    for (const value of rejected) {
      expect(ADMIN_CONTROL_RFC3339_PATTERN.test(value)).toBe(false);
      expect(parseRfc3339Instant(value)).toBeNull();
    }
  });

  it("parses Unix epoch, negative instants, bounded years, and every fractional precision exactly", () => {
    expect(parseRfc3339Instant("1970-01-01T00:00:00Z")).toBe(0n);
    expect(
      parseRfc3339Instant("1969-12-31T23:59:59.999999999Z"),
    ).toBe(-1n);
    expect(parseRfc3339Instant("0000-01-01T00:00:00Z")).not.toBeNull();
    expect(
      parseRfc3339Instant("9999-12-31T23:59:59.999999999Z"),
    ).not.toBeNull();

    for (let digits = 1; digits <= 9; digits += 1) {
      const fraction = "1".padEnd(digits, "0");
      expect(
        parseRfc3339Instant(`1970-01-01T00:00:00.${fraction}Z`),
      ).toBe(100_000_000n);
    }
  });

  it("compares nanoseconds, offset-equivalent instants, and day/year boundaries", () => {
    expect(
      compareRfc3339Instants(
        "1970-01-01T14:00:00+14:00",
        "1969-12-31T10:00:00-14:00",
      ),
    ).toBe(0);
    expect(
      compareRfc3339Instants(
        "2027-01-01T00:00:00.000000001Z",
        "2027-01-01T00:00:00.000000001Z",
      ),
    ).toBe(0);
    expect(
      compareRfc3339Instants(
        "2026-12-31T23:59:59.999999999Z",
        "2027-01-01T00:00:00Z",
      ),
    ).toBe(-1);
    expect(
      compareRfc3339Instants(
        "2027-01-01T00:00:00.000000002Z",
        "2027-01-01T00:00:00.000000001Z",
      ),
    ).toBe(1);
    expect(
      compareRfc3339Instants("not-a-timestamp", "2027-01-01T00:00:00Z"),
    ).toBeNull();
  });

  it("formats UTC with mathematical floor for negative instants and trims fractional zeros", () => {
    expect(formatRfc3339InstantUtc(-1n)).toBe(
      "1969-12-31T23:59:59.999999999Z",
    );
    expect(formatRfc3339InstantUtc(-1_000_000_001n)).toBe(
      "1969-12-31T23:59:58.999999999Z",
    );
    expect(formatRfc3339InstantUtc(0n)).toBe("1970-01-01T00:00:00Z");
    expect(formatRfc3339InstantUtc(123_400_000n)).toBe(
      "1970-01-01T00:00:00.1234Z",
    );
    expect(
      formatRfc3339InstantUtc(
        parseRfc3339Instant("0000-01-01T00:00:00Z")!,
      ),
    ).toBe("0000-01-01T00:00:00Z");
    expect(
      formatRfc3339InstantUtc(
        parseRfc3339Instant("9999-12-31T23:59:59.999999999Z")!,
      ),
    ).toBe("9999-12-31T23:59:59.999999999Z");
  });

  it("adds fixed milliseconds in instant space while preserving nanoseconds", () => {
    expect(
      addRfc3339Milliseconds(
        "2099-08-22T03:00:00.123456789+02:30",
        86_400_000n,
      ),
    ).toBe("2099-08-23T00:30:00.123456789Z");
    expect(
      addRfc3339Milliseconds(
        "2026-12-31T23:59:59.000000001Z",
        1_000n,
      ),
    ).toBe("2027-01-01T00:00:00.000000001Z");
    expect(
      addRfc3339Milliseconds("9999-12-31T23:59:59.999999999Z", 1n),
    ).toBeNull();
    expect(addRfc3339Milliseconds("invalid", 86_400_000n)).toBeNull();
  });
});
