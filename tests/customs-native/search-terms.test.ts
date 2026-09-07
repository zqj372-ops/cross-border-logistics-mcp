import { describe, expect, it } from "vitest";
import { toSearchTerms } from "../../services/customs-native/upstream/shared/domain/search-terms";

describe("deterministic search terms", () => {
  it("builds deterministic Chinese bigrams", () => {
    expect(toSearchTerms("不锈钢保温杯")).toContain("保温");
    expect(toSearchTerms("不锈钢保温杯")).toContain("温杯");
  });

  it("normalizes Latin text, punctuation, aliases, and ordering", () => {
    expect(toSearchTerms("Stainless-Steel MUG!", ["Travel Mug"]))
      .toBe("mug stainless steel travel");
    expect(toSearchTerms("B C A")).toBe("a b c");
  });
});
