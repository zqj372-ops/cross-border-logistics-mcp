import { describe, expect, it } from "vitest";
import {
  DocumentItemSchema,
  QueryRequestSchema,
  QueryResponseSchema,
  RateLineSchema,
  SourceRefSchema,
  TradeMeasureSchema,
} from "../../services/customs-native/upstream/shared/contracts/query";
import { makeValidResponse } from "./fixtures";

describe("query contract", () => {
  it("accepts a Chinese name with a rule date and no origin field", () => {
    const result = QueryRequestSchema.parse({ query: "不锈钢保温杯", ruleDate: "2026-08-03", attributes: {} });
    expect(result.query).toBe("不锈钢保温杯");
    expect("originCountry" in result).toBe(false);
  });

  it("accepts only a UUID query session ID", () => {
    const querySessionId = "00000000-0000-4000-8000-000000000001";
    const result = QueryRequestSchema.safeParse({
      query: "保温杯",
      ruleDate: "2026-08-04",
      attributes: {},
      querySessionId,
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.querySessionId).toBe(querySessionId);
    expect(QueryRequestSchema.safeParse({
      query: "保温杯",
      ruleDate: "2026-08-04",
      attributes: {},
      querySessionId: "not-a-uuid",
    }).success).toBe(false);
  });

  it("rejects an invalid date and empty query", () => {
    expect(() => QueryRequestSchema.parse({ query: " ", ruleDate: "03/08/2026" })).toThrow();
  });

  it("rejects a rate whose source reference is missing", () => {
    const incomplete = makeValidResponse();
    incomplete.results[0]!.rates[0]!.sourceId = "missing-source";
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it("rejects a rate whose effective date is missing", () => {
    const incomplete = makeValidResponse();
    Reflect.deleteProperty(incomplete.results[0]!.rates[0]!, 'effectiveFrom');
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it("keeps Canada's English and French legal names separate from Chinese explanation", () => {
    const result = QueryResponseSchema.parse(makeValidResponse());
    expect(result.results.find((item) => item.country === "CA")?.legalNames.map((item) => item.language)).toEqual(["en", "fr"]);
    expect(result.results.find((item) => item.country === "CA")?.chineseExplanation.status).toBe("human_reviewed");
  });

  it("accepts the selected fixture as an exact-code response", () => {
    const result = QueryResponseSchema.parse(makeValidResponse());
    expect(result.mode).toBe("exact_code");
    expect(result.selectedHs6).toBe("732393");
  });

  it.each(["http://example.com/source", "javascript:alert(1)", "data:text/plain,source", "ftp://example.com/source"])(
    "rejects a non-HTTPS official source URL: %s",
    (officialUrl) => {
      const source = makeValidResponse().sources[0]!;
      expect(() => SourceRefSchema.parse({ ...source, officialUrl })).toThrow();
    },
  );

  it("rejects empty next-question fields and options", () => {
    const incomplete = makeValidResponse();
    incomplete.nextQuestion = { id: "", label: "", attribute: "", options: [] };
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it("rejects more than three next-question options", () => {
    const incomplete = makeValidResponse();
    incomplete.nextQuestion = { id: "q1", label: "Choose", attribute: "material", options: ["a", "b", "c", "d"] };
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it("rejects an empty next-question option", () => {
    const incomplete = makeValidResponse();
    incomplete.nextQuestion = { id: "q1", label: "Choose", attribute: "material", options: [""] };
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it("rejects a candidate code digit count that disagrees with its code", () => {
    const incomplete = makeValidResponse();
    incomplete.results[0]!.codeDigits = 5;
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it("rejects an hs6 value that is not the code prefix", () => {
    const incomplete = makeValidResponse();
    incomplete.results[0]!.hs6 = "999999";
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it("rejects a parent code that is not a strict hierarchy prefix", () => {
    const incomplete = makeValidResponse();
    incomplete.results[0]!.parentCode = "732393";
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it("rejects a valid parent prefix that is missing from the hierarchy", () => {
    const incomplete = makeValidResponse();
    incomplete.results[0]!.hierarchy = [incomplete.results[0]!.hierarchy[1]!];
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it("rejects a hierarchy node digit count that disagrees with its code", () => {
    const incomplete = makeValidResponse();
    incomplete.results[0]!.hierarchy[0]!.codeDigits = 5;
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it("rejects a hierarchy leaf that is not a candidate-code prefix", () => {
    const incomplete = makeValidResponse();
    const leaf = incomplete.results[0]!.hierarchy.at(-1)!;
    leaf.code = "999999";
    leaf.displayCode = "9999.99";
    leaf.codeDigits = 6;
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it("rejects reverse effective date ranges across source and result line types", () => {
    const response = makeValidResponse();
    const cases = [
      [SourceRefSchema, response.sources[0]!],
      [RateLineSchema, response.results[0]!.rates[0]!],
      [DocumentItemSchema, response.results[0]!.documents[0]!],
      [TradeMeasureSchema, response.results[0]!.measures[0]!],
    ] as const;

    for (const [schema, value] of cases) {
      expect(() => schema.parse({ ...value, effectiveTo: "2026-08-02" })).toThrow();
    }
  });

  it("rejects a rate included in the confirmed total when it is unconfirmed", () => {
    const incomplete = makeValidResponse();
    incomplete.results[0]!.rates[0]!.confirmed = false;
    incomplete.results[0]!.rates[0]!.includedInConfirmedTotal = true;
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it.each(["tax", "fee"])("rejects a confirmed %s rate included in the confirmed total", (category) => {
    const incomplete = makeValidResponse();
    Reflect.set(incomplete.results[0]!.rates[0]!, "category", category);
    incomplete.results[0]!.rates[0]!.confirmed = true;
    incomplete.results[0]!.rates[0]!.includedInConfirmedTotal = true;
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it.each([
    ["CN", "us_import"],
    ["US", "ca_import"],
    ["CA", "cn_export"],
  ] as const)("rejects a %s document with a mismatched side", (country, wrongSide) => {
    const incomplete = makeValidResponse();
    incomplete.results.find((item) => item.country === country)!.documents[0]!.side = wrongSide;
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });

  it("derives fixture source IDs from release, artifact, and locator", () => {
    const result = makeValidResponse();
    for (const source of result.sources) {
      expect(source.id).toBe(`fixture-source:${source.releaseId}:${source.artifactId}:${source.sourceLocator}`);
    }
  });

  it("rejects duplicate countries in non-empty results", () => {
    const incomplete = makeValidResponse();
    incomplete.results[1]!.country = "CN";
    incomplete.results[1]!.documents[0]!.side = "cn_export";
    expect(() => QueryResponseSchema.parse(incomplete)).toThrow();
  });
});
