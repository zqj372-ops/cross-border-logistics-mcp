import Decimal from "decimal.js";
import type { CountryResult } from "../contracts/query";

export type Currency = "USD" | "CAD" | "CNY";
export type DestinationCountry = "US" | "CA";

export type CalcRow = {
  readonly name: string;
  readonly hsCode: string;
  readonly quantity: number | null;
  readonly declaredValue: number | string;
  readonly currency: Currency;
};

export type ExchangeRates = {
  readonly usdCny?: string;
  readonly cadCny?: string;
};

const TARGET_CURRENCY: Record<DestinationCountry, Currency> = { US: "USD", CA: "CAD" };
const QUANTITY_RATE_NOTE = "存在从量/复合税率，金额需人工复核";

function positiveDecimal(value: string | undefined): Decimal | null {
  if (!value) return null;
  const text = value.trim();
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return null;
  try {
    const parsed = new Decimal(text);
    return parsed.gt(0) ? parsed : null;
  } catch {
    return null;
  }
}

export type ConvertedValue = {
  readonly value: Decimal | null;
  readonly currency: Currency;
  readonly issue: string | null;
};

export function convertValue(row: CalcRow, destination: DestinationCountry, rates: ExchangeRates): ConvertedValue {
  const target = TARGET_CURRENCY[destination];
  const base = new Decimal(row.declaredValue);
  if (row.currency === target) return { value: base, currency: target, issue: null };
  if (row.currency === "CNY") {
    const rate = positiveDecimal(destination === "US" ? rates.usdCny : rates.cadCny);
    if (!rate) {
      return {
        value: null,
        currency: target,
        issue: destination === "US" ? "缺少官方美元兑人民币汇率" : "缺少官方加元兑人民币汇率",
      };
    }
    return { value: base.dividedBy(rate), currency: target, issue: null };
  }
  const usdRate = positiveDecimal(rates.usdCny);
  const cadRate = positiveDecimal(rates.cadCny);
  if (!usdRate || !cadRate) {
    return { value: null, currency: target, issue: "跨币种换算缺少官方美元/加元人民币汇率" };
  }
  if (row.currency === "USD") {
    return { value: base.times(usdRate).dividedBy(cadRate), currency: target, issue: null };
  }
  return { value: base.times(cadRate).dividedBy(usdRate), currency: target, issue: null };
}

export type EstimateStatus = "confirmed" | "manual_review" | "not_found" | "needs_rate";

export type TariffEstimate = {
  readonly status: EstimateStatus;
  readonly ratePercent: string | null;
  readonly estimatedAmount: string | null;
  readonly note: string;
};

export type TaxLineCategory =
  | "base_duty"
  | "additional_duty"
  | "trade_remedy"
  | "excise_duty"
  | "excise_tax"
  | "gst"
  | "official_fee"
  | "tax"
  | "fee";

export type TaxLineStatus = "included" | "manual_review" | "excluded" | "not_applicable";

export type TaxLineEstimate = {
  readonly id: string;
  readonly label: string;
  readonly category: TaxLineCategory;
  readonly rateExpressionRaw: string;
  readonly ratePercent: string | null;
  readonly amount: string | null;
  readonly base: string;
  readonly status: TaxLineStatus;
  readonly effectiveFrom: string;
  readonly sourceId: string;
  readonly note: string;
};

export type TariffBreakdown = {
  readonly status: EstimateStatus;
  readonly lines: readonly TaxLineEstimate[];
  readonly valueForDuty: string | null;
  readonly valueForTax: string | null;
  readonly customsPayable: string | null;
  readonly ratePercent: string | null;
  readonly estimatedAmount: string | null;
  readonly note: string;
  readonly risks: readonly string[];
};

/**
 * Query-level publication gate. The calculator must never turn fixture or
 * unreviewed query data into a determined amount, even when an individual
 * result happens to contain a percentage-looking rate.
 */
export type TariffDataGate = {
  readonly ready: boolean;
  readonly testData: boolean;
};

const DEFAULT_DATA_GATE: TariffDataGate = { ready: false, testData: true };

const SIMPLE_PERCENT_PATTERN = /^(\d+(?:\.\d+)?)\s*%$/u;

function simplePercent(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (text.toLocaleLowerCase("en-US") === "free") return "0";
  const match = SIMPLE_PERCENT_PATTERN.exec(text);
  return match ? match[1]! : null;
}

function taxLineCategory(category: string): TaxLineCategory {
  switch (category) {
    case "base_duty":
    case "additional_duty":
    case "trade_remedy":
    case "excise_duty":
    case "excise_tax":
    case "gst":
    case "official_fee":
    case "tax":
    case "fee":
      return category;
    default:
      return "fee";
  }
}

function rateLineEstimate(
  rate: CountryResult["rates"][number],
  valueForDuty: Decimal,
): TaxLineEstimate | null {
  const base = valueForDuty.toFixed(2);
  const category = taxLineCategory(rate.category);
  if (!rate.confirmed) {
    return {
      id: rate.id,
      label: rate.label,
      category,
      rateExpressionRaw: rate.rateExpressionRaw,
      ratePercent: null,
      amount: null,
      base,
      status: "manual_review",
      effectiveFrom: rate.effectiveFrom,
      sourceId: rate.sourceId,
      note: "官方税率未确认，需人工复核",
    };
  }
  if (rate.kind === "free") {
    return {
      id: rate.id,
      label: rate.label,
      category,
      rateExpressionRaw: rate.rateExpressionRaw,
      ratePercent: "0",
      amount: "0.00",
      base,
      status: "included",
      effectiveFrom: rate.effectiveFrom,
      sourceId: rate.sourceId,
      note: "",
    };
  }
  if (rate.kind === "specific" || rate.kind === "compound") {
    return {
      id: rate.id,
      label: rate.label,
      category,
      rateExpressionRaw: rate.rateExpressionRaw,
      ratePercent: null,
      amount: null,
      base,
      status: "manual_review",
      effectiveFrom: rate.effectiveFrom,
      sourceId: rate.sourceId,
      note: "从量/复合税率需数量，金额待人工复核",
    };
  }
  if (rate.kind === "text") {
    return {
      id: rate.id,
      label: rate.label,
      category,
      rateExpressionRaw: rate.rateExpressionRaw,
      ratePercent: null,
      amount: null,
      base,
      status: "manual_review",
      effectiveFrom: rate.effectiveFrom,
      sourceId: rate.sourceId,
      note: "文本税率需人工复核",
    };
  }
  const percent = simplePercent(rate.rateExpressionRaw);
  if (percent === null) {
    return {
      id: rate.id,
      label: rate.label,
      category,
      rateExpressionRaw: rate.rateExpressionRaw,
      ratePercent: null,
      amount: null,
      base,
      status: "manual_review",
      effectiveFrom: rate.effectiveFrom,
      sourceId: rate.sourceId,
      note: "无法解析官方税率表达式",
    };
  }
  return {
    id: rate.id,
    label: rate.label,
    category,
    rateExpressionRaw: rate.rateExpressionRaw,
    ratePercent: percent,
    amount: valueForDuty.times(percent).dividedBy(100).toFixed(2),
    base,
    status: "included",
    effectiveFrom: rate.effectiveFrom,
    sourceId: rate.sourceId,
    note: "",
  };
}

function measureLineEstimate(
  measure: CountryResult["measures"][number],
  valueForDuty: Decimal,
): TaxLineEstimate | null {
  if (measure.matchStatus === "not_indicated") return null;
  const base = valueForDuty.toFixed(2);
  const percent = simplePercent(measure.rateExpressionRaw);
  if (measure.matchStatus === "confirmed_by_rule" && percent !== null) {
    return {
      id: measure.id,
      label: measure.label,
      category: "trade_remedy",
      rateExpressionRaw: measure.rateExpressionRaw ?? "",
      ratePercent: percent,
      amount: valueForDuty.times(percent).dividedBy(100).toFixed(2),
      base,
      status: "included",
      effectiveFrom: measure.effectiveFrom,
      sourceId: measure.sourceId,
      note: "",
    };
  }
  return {
    id: measure.id,
    label: measure.label,
    category: "trade_remedy",
    rateExpressionRaw: measure.rateExpressionRaw ?? "",
    ratePercent: null,
    amount: null,
    base,
    status: "manual_review",
    effectiveFrom: measure.effectiveFrom,
    sourceId: measure.sourceId,
    note: measure.matchStatus === "confirmed_by_rule"
      ? "有官方适用范围但无确认税率，需人工复核"
      : "存在贸易救济风险提示，需人工复核",
  };
}

function sumAmounts(lines: readonly TaxLineEstimate[]): Decimal {
  return lines.reduce((total, line) => {
    return line.amount === null ? total : total.plus(new Decimal(line.amount));
  }, new Decimal(0));
}

export function estimateTariffBreakdown(
  result: CountryResult | null,
  converted: ConvertedValue,
  destination: DestinationCountry,
  dataGate: TariffDataGate = DEFAULT_DATA_GATE,
): TariffBreakdown {
  if (converted.issue || converted.value === null) {
    return {
      status: "needs_rate",
      lines: [],
      valueForDuty: null,
      valueForTax: null,
      customsPayable: null,
      ratePercent: null,
      estimatedAmount: null,
      note: converted.issue ?? "缺少金额换算依据",
      risks: [],
    };
  }
  if (!result) {
    const dataGateNote = dataGate.testData
      ? "关税数据为测试数据，无法确认税率"
      : !dataGate.ready
        ? "关税数据未达到正式发布门禁，无法确认税率"
        : null;
    if (dataGateNote) {
      return {
        status: "manual_review",
        lines: [],
        valueForDuty: converted.value.toFixed(2),
        valueForTax: null,
        customsPayable: null,
        ratePercent: null,
        estimatedAmount: null,
        note: dataGateNote,
        risks: [dataGateNote],
      };
    }
    return {
      status: "not_found",
      lines: [],
      valueForDuty: converted.value.toFixed(2),
      valueForTax: null,
      customsPayable: null,
      ratePercent: null,
      estimatedAmount: null,
      note: "未找到该 HS 编码的税率",
      risks: [],
    };
  }

  const valueForDuty = converted.value;
  const dataGateNote = dataGate.testData
    ? "关税数据为测试数据，不能生成确定金额"
    : !dataGate.ready
      ? "关税数据未达到正式发布门禁，不能生成确定金额"
      : null;
  const lines: TaxLineEstimate[] = [
    ...result.rates
      .map((rate) => rateLineEstimate(rate, valueForDuty))
      .filter((line): line is TaxLineEstimate => line !== null),
    ...result.measures
      .map((measure) => measureLineEstimate(measure, valueForDuty))
      .filter((line): line is TaxLineEstimate => line !== null),
  ];
  if (dataGateNote) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line || line.status !== "included") continue;
      lines[index] = {
        ...line,
        ratePercent: null,
        amount: null,
        status: "manual_review",
        note: dataGateNote,
      };
    }
  }

  const gstCandidates = lines.filter((line) =>
    line.category === "gst"
    && line.status === "included"
    && line.ratePercent !== null
    && line.amount !== null,
  );
  const hasManualNonGstLine = lines.some((line) => line.category !== "gst" && line.status === "manual_review");
  if (gstCandidates.length > 0 && !hasManualNonGstLine) {
    const gstBase = valueForDuty.plus(
      sumAmounts(lines.filter((line) => line.status === "included" && line.amount !== null && line.category !== "gst")),
    );
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line || line.category !== "gst" || line.status !== "included" || line.ratePercent === null) continue;
      lines[index] = {
        ...line,
        amount: gstBase.times(line.ratePercent).dividedBy(100).toFixed(2),
        base: gstBase.toFixed(2),
      };
    }
  } else if (gstCandidates.length > 0 && hasManualNonGstLine) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line || line.category !== "gst" || line.status !== "included") continue;
      lines[index] = {
        ...line,
        amount: null,
        status: "manual_review",
        note: "GST 计税基础含未确认项目，需人工复核",
      };
    }
  }

  const hasConfirmedGst = lines.some((line) =>
    line.category === "gst"
    && line.status === "included"
    && line.ratePercent !== null
    && line.amount !== null,
  );
  const reviewReasons: string[] = [];
  if (dataGateNote) reviewReasons.push(dataGateNote);
  if (result.status !== "confirmed") reviewReasons.push("编码结果未确认，需人工复核");
  if (result.confirmedTotalPercent === null) reviewReasons.push("税率合计未确认，需人工复核");
  if (result.rates.some((rate) => !rate.confirmed)) reviewReasons.push("存在未确认官方税率行，需人工复核");
  if (destination === "CA" && !hasConfirmedGst) {
    reviewReasons.push(hasManualNonGstLine && gstCandidates.length > 0
      ? "GST 计税基础含未确认项目，需人工复核"
      : "缺少明确、已确认的加拿大进口 GST 税率，需人工复核");
  }

  const included = lines.filter((line) => line.status === "included" && line.amount !== null);
  if (lines.some((line) => line.status === "manual_review")) reviewReasons.push("税费明细含需人工复核项目");
  if (included.length === 0) reviewReasons.push("没有已确认且可计算的税费行");
  const manualReview = reviewReasons.length > 0;
  const risks = lines
    .filter((line) => line.status === "manual_review")
    .map((line) => line.note)
    .filter((note, index, notes) => notes.indexOf(note) === index);
  const status: EstimateStatus = manualReview ? "manual_review" : "confirmed";
  const customsPayable = manualReview ? null : sumAmounts(included).toFixed(2);
  const gstLine = lines.find((line) => line.category === "gst");
  return {
    status,
    lines,
    valueForDuty: valueForDuty.toFixed(2),
    valueForTax: destination === "CA" ? (manualReview ? null : gstLine?.base ?? null) : null,
    customsPayable,
    ratePercent: manualReview ? null : result.confirmedTotalPercent,
    estimatedAmount: customsPayable,
    note: [...reviewReasons, ...risks].filter((note, index, notes) => notes.indexOf(note) === index).join("；") || "已按官方确认税率估算",
    risks: [...reviewReasons, ...risks].filter((note, index, notes) => notes.indexOf(note) === index),
  };
}

function rateNotes(result: CountryResult): string[] {
  const notes: string[] = [];
  if (result.rates.some((rate) => rate.category === "tax" || rate.category === "fee")) {
    notes.push("估算不含税和杂费");
  }
  if (result.rates.some((rate) => rate.confirmed && (rate.kind === "specific" || rate.kind === "compound"))) {
    notes.push(QUANTITY_RATE_NOTE);
  }
  if (result.measures.some((measure) => measure.matchStatus !== "not_indicated")) {
    notes.push("存在贸易救济风险提示，需人工复核");
  }
  const firstWarning = result.warnings[0];
  if (firstWarning) notes.push(firstWarning);
  return notes;
}

export function estimateTariff(
  result: CountryResult | null,
  converted: ConvertedValue,
  dataGate: TariffDataGate = DEFAULT_DATA_GATE,
): TariffEstimate {
  if (converted.issue) {
    return { status: "needs_rate", ratePercent: null, estimatedAmount: null, note: converted.issue };
  }
  if (converted.value === null) {
    return { status: "needs_rate", ratePercent: null, estimatedAmount: null, note: "缺少金额换算依据" };
  }
  if (dataGate.testData) {
    return { status: "manual_review", ratePercent: null, estimatedAmount: null, note: "关税数据为测试数据，不能生成确定金额" };
  }
  if (!dataGate.ready) {
    return { status: "manual_review", ratePercent: null, estimatedAmount: null, note: "关税数据未达到正式发布门禁，不能生成确定金额" };
  }
  if (!result) {
    return { status: "not_found", ratePercent: null, estimatedAmount: null, note: "未找到该 HS 编码的税率" };
  }
  if (result.confirmedTotalPercent === null) {
    return { status: "manual_review", ratePercent: null, estimatedAmount: null, note: ["税率未确认，需人工复核", ...rateNotes(result)].filter(Boolean).join("；") };
  }
  if (result.status !== "confirmed") {
    return {
      status: "manual_review",
      ratePercent: null,
      estimatedAmount: null,
      note: ["编码结果未确认，需人工复核", ...rateNotes(result)].filter(Boolean).join("；"),
    };
  }
  if (result.rates.some((rate) => !rate.confirmed)) {
    return {
      status: "manual_review",
      ratePercent: null,
      estimatedAmount: null,
      note: ["存在未确认税率行，需人工复核", ...rateNotes(result)].filter(Boolean).join("；"),
    };
  }
  const hasQuantityBasedRate = result.rates.some((rate) => rate.confirmed && (rate.kind === "specific" || rate.kind === "compound"));
  if (hasQuantityBasedRate) {
    return {
      status: "manual_review",
      ratePercent: null,
      estimatedAmount: null,
      note: ["存在从量/复合税率，不能仅按百分比估算", ...rateNotes(result).filter((note) => note !== QUANTITY_RATE_NOTE)].filter(Boolean).join("；"),
    };
  }
  const rate = new Decimal(result.confirmedTotalPercent);
  const amount = converted.value.times(rate).dividedBy(100);
  const note = rateNotes(result).filter(Boolean).join("；");
  return {
    status: "confirmed",
    ratePercent: result.confirmedTotalPercent,
    estimatedAmount: amount.toFixed(2),
    note: note || "按已确认合计税率估算",
  };
}
