import { describe, expect, it } from "vitest";
import { detectQueryKind, normalizeCode } from "../../services/customs-native/upstream/shared/domain/code";

describe("code normalization", () => {
  it("normalizes punctuation without losing leading zeroes", () => {
    expect(normalizeCode("01.01-21 0000")).toBe("0101210000");
    expect(detectQueryKind("9617.00.1000")).toBe("code");
  });

  it("rejects values that are not four to ten digits after normalization", () => {
    expect(() => normalizeCode("123")).toThrow(/4.*10.*digits/i);
    expect(() => normalizeCode("96/17")).toThrow(/4.*10.*digits/i);
  });

  it("treats non-code queries as names", () => {
    expect(detectQueryKind("stainless steel mug")).toBe("name");
    expect(detectQueryKind("123")).toBe("name");
  });
});
