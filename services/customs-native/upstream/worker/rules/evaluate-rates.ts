import {
  type DecimalInput,
  type EvaluatedRateLine,
  type RateEvaluationResult,
  type RateInput,
  type RateKind,
  sumConfirmedPercent,
} from "../../shared/domain/rates";

export interface EvaluateRatesOptions {
  readonly country?: "CN" | "US" | "CA";
  readonly originCountry?: string;
  readonly origin?: string;
  readonly ruleDate?: string;
  readonly asOf?: string;
}

type AnyRecord = Readonly<Record<string, unknown>>;

const CUSTOMS_DUTY_CATEGORIES = new Set([
  "export_duty",
  "provisional_export_duty",
  "base_duty",
  "additional_duty",
  "trade_remedy",
]);
const NON_DUTY_CATEGORIES = new Set([
  "tax",
  "fee",
  "excise_duty",
  "excise_tax",
  "gst",
  "official_fee",
]);

interface WorkingLine {
  readonly input: RateInput;
  readonly output: EvaluatedRateLine;
  readonly record: AnyRecord;
  readonly category: string;
  readonly kind: RateKind;
  readonly confirmed: boolean;
  readonly percent: DecimalInput | undefined;
  readonly priority: number;
  readonly priorityValid: boolean;
  readonly country: string | undefined;
  readonly originCountry: string | undefined;
  readonly treatment: string | undefined;
  readonly valueBasis: string | undefined;
  readonly interaction: InteractionInfo;
}

interface InteractionInfo {
  readonly explicit: boolean;
  readonly known: boolean;
  readonly reviewed: boolean;
  readonly additive: boolean;
  readonly stackingGroup: string | undefined;
  readonly stackWith: ReadonlySet<string>;
  readonly nonStacking: boolean;
  readonly nonStackingWith: ReadonlySet<string>;
  readonly excludes: ReadonlySet<string>;
  readonly excludedBy: ReadonlySet<string>;
  readonly replaces: ReadonlySet<string>;
  readonly replaceGroup: string | undefined;
  readonly rawNote: string;
}

interface CountryContext {
  readonly country: "CN" | "US" | "CA" | undefined;
  readonly originCountry: string | undefined;
  readonly ruleDate: string | undefined;
  readonly ambiguousCountry: boolean;
  readonly ambiguousOrigin: boolean;
}

type PairRelation = "stack" | "exclude" | "replace" | "unknown";

function recordOf(value: RateInput): AnyRecord {
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function recordValue(value: unknown): AnyRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as AnyRecord) : undefined;
}

function stringSet(value: unknown): ReadonlySet<string> {
  if (Array.isArray(value)) {
    return new Set(value.flatMap((item) => {
      const text = stringValue(item);
      return text ? [text] : [];
    }));
  }
  const text = stringValue(value);
  return text ? new Set([text]) : new Set<string>();
}

function parseInteraction(record: AnyRecord): InteractionInfo {
  const raw = record.interaction ?? record.interactionJson ?? record.interaction_json;
  let parsed = recordValue(raw);
  let rawNote = stringValue(record.interactionNote) ?? "";

  if (!parsed && typeof raw === "string") {
    rawNote = rawNote || raw;
    try {
      const json: unknown = JSON.parse(raw);
      parsed = recordValue(json);
    } catch {
      // A non-JSON interaction note is preserved but remains unknown.
    }
  }

  const source: AnyRecord = parsed ?? {};
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (source[key] !== undefined) return source[key];
      if (record[key] !== undefined) return record[key];
    }
    return undefined;
  };
  const mode = stringValue(pick("mode", "stacking", "stackingMode", "stacking_mode", "interactionMode", "interaction_mode", "outcome"))?.toLocaleLowerCase("en-US");
  const reviewed =
    boolValue(pick("reviewed", "interactionReviewed", "reviewedInteraction")) === true ||
    stringValue(pick("reviewStatus", "status"))?.toLocaleLowerCase("en-US") === "reviewed";
  const additive =
    boolValue(pick("additive", "stackable")) === true ||
    mode === "additive" ||
    mode === "stack" ||
    mode === "stackable";
  const stackingGroup = stringValue(pick("stackingGroup", "stacking_group", "group"));
  const stackWith = stringSet(pick("stackWith", "stack_with", "canStackWith", "can_stack_with", "stackWithIds", "stack_with_ids"));
  const nonStacking =
    boolValue(pick("nonStacking", "non_stacking")) === true ||
    mode === "exclusive" ||
    mode === "non_stacking" ||
    mode === "non-stacking";
  const nonStackingWith = stringSet(pick("nonStackingWith", "non_stacking_with", "nonStackingIds", "non_stacking_ids"));
  const excludes = stringSet(pick("excludes", "exclude", "exclusion", "excludeIds", "exclude_ids", "exclusionIds", "exclusion_ids"));
  const excludedBy = stringSet(pick("excludedBy", "excluded_by", "excludedByIds", "excluded_by_ids"));
  const replaces = stringSet(pick("replaces", "replace", "replacement", "replaceIds", "replace_ids"));
  const replaceGroup = stringValue(pick("replaceGroup", "replacementGroup", "replace_group"));
  const recognized = [
    "reviewed", "interactionReviewed", "reviewedInteraction", "reviewStatus", "status", "additive", "stackable",
    "mode", "stacking", "stackingMode", "stacking_mode", "interactionMode", "interaction_mode", "outcome", "stackingGroup", "stacking_group", "group", "stackWith",
    "stack_with", "canStackWith", "can_stack_with", "stackWithIds", "stack_with_ids", "nonStacking", "non_stacking", "nonStackingWith",
    "non_stacking_with", "nonStackingIds", "non_stacking_ids", "excludes", "exclude", "exclusion", "excludeIds", "exclude_ids", "exclusionIds", "exclusion_ids", "excludedBy", "excluded_by", "excludedByIds", "excluded_by_ids", "replaces", "replace",
    "replacement", "replaceIds", "replace_ids", "replaceGroup", "replacementGroup", "replace_group",
  ];
  const knownField = recognized.some((key) => source[key] !== undefined || record[key] !== undefined);
  const knownMode = mode === undefined || ["additive", "stack", "stackable", "exclusive", "non_stacking", "non-stacking", "replace", "replacement"].includes(mode);
  const known = knownField && knownMode;
  const explicit = raw !== undefined || known;

  return {
    explicit,
    known,
    reviewed,
    additive,
    stackingGroup,
    stackWith,
    nonStacking,
    nonStackingWith,
    excludes,
    excludedBy,
    replaces,
    replaceGroup,
    rawNote,
  };
}

function normalizeComponent(component: unknown): unknown {
  const record = recordValue(component);
  if (!record) return component;
  const kind = record.kind;
  if (kind !== "free" && kind !== "ad_valorem" && kind !== "specific" && kind !== "compound" && kind !== "text") {
    return component;
  }
  const normalized: Record<string, unknown> = { ...record, rateExpressionRaw: deriveRawExpression(record, kind) };
  if (kind === "compound" && Array.isArray(record.components)) {
    normalized.components = record.components.map(normalizeComponent);
  }
  return normalized;
}

function deriveRawExpression(record: AnyRecord, kind: RateKind): string {
  const rawValue = record.rateExpressionRaw ?? record.rate_expression_raw;
  const supplied = typeof rawValue === "string" && rawValue.length > 0
    ? rawValue
    : undefined;
  if (supplied) return supplied;

  if (kind === "free") return "Free";
  if (kind === "ad_valorem") {
    const percent = record.percent;
    return typeof percent !== 'string' && typeof percent !== 'number' ? "ad_valorem (percent missing)" : `${String(percent)}%`;
  }
  if (kind === "specific") {
    const amount = record.amount;
    const currency = stringValue(record.currency) ?? "";
    const unit = stringValue(record.unit) ?? "";
    return typeof amount !== 'string' && typeof amount !== 'number' ? "specific (amount missing)" : `${String(amount)} ${currency}/${unit}`.trim();
  }
  if (kind === "compound") {
    const components = Array.isArray(record.components) ? record.components : [];
    return `compound (${components.length} component${components.length === 1 ? "" : "s"})`;
  }
  return stringValue(record.text) ?? "text rate expression";
}

function normalizedText(value: string | undefined): string {
  return value?.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s_./()-]+/gu, " ").trim() ?? "";
}

function hasAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

function dateLooksValid(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function lineIsEffective(line: WorkingLine, ruleDate: string | undefined): { ok: boolean; reason?: string } {
  const from = stringValue(line.record.effectiveFrom ?? line.record.effective_from);
  const to = stringValue(line.record.effectiveTo ?? line.record.effective_to);
  if (from && to && to < from) return { ok: false, reason: "Rate effective date range is invalid; manual review required." };
  if (!ruleDate) return { ok: true };
  if (from && from > ruleDate) return { ok: false, reason: "Rate is not yet effective on the requested rule date." };
  if (to && to < ruleDate) return { ok: false, reason: "Rate expired before the requested rule date." };
  return { ok: true };
}

function countryFrom(value: string | undefined): "CN" | "US" | "CA" | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized === "CN" || normalized === "US" || normalized === "CA" ? normalized : undefined;
}

function resolveContext(lines: readonly WorkingLine[], options: EvaluateRatesOptions): CountryContext {
  const explicitCountry = countryFrom(options.country);
  const lineCountries = new Set(lines.map((line) => countryFrom(line.country)).filter((value): value is "CN" | "US" | "CA" => value !== undefined));
  const ambiguousCountry = explicitCountry === undefined && lineCountries.size > 1;
  const country = explicitCountry ?? (lineCountries.size === 1 ? [...lineCountries][0] : undefined);
  const explicitOrigin = stringValue(options.originCountry ?? options.origin);
  const lineOrigins = new Set(lines.map((line) => line.originCountry).filter((value): value is string => value !== undefined));
  const ambiguousOrigin = explicitOrigin === undefined && lineOrigins.size > 1;
  const originCountry = explicitOrigin ?? (lineOrigins.size === 1 ? [...lineOrigins][0] : undefined);
  const ruleDate = stringValue(options.ruleDate ?? options.asOf);
  return { country, originCountry, ruleDate, ambiguousCountry, ambiguousOrigin };
}

function refersTo(line: WorkingLine, target: WorkingLine, values: ReadonlySet<string>): boolean {
  return values.has(target.input.id) || (target.interaction.stackingGroup !== undefined && values.has(target.interaction.stackingGroup));
}

function explicitPairRelation(a: WorkingLine, b: WorkingLine): PairRelation | undefined {
  if (
    refersTo(a, b, a.interaction.replaces) ||
    refersTo(b, a, b.interaction.replaces)
  ) return "replace";
  if (
    refersTo(a, b, a.interaction.excludes) ||
    refersTo(b, a, b.interaction.excludes) ||
    refersTo(a, b, a.interaction.excludedBy) ||
    refersTo(b, a, b.interaction.excludedBy) ||
    refersTo(a, b, a.interaction.nonStackingWith) ||
    refersTo(b, a, b.interaction.nonStackingWith) ||
    a.interaction.nonStacking ||
    b.interaction.nonStacking
  ) return "exclude";
  if (
    (refersTo(a, b, a.interaction.stackWith) || refersTo(b, a, b.interaction.stackWith)) &&
    a.interaction.reviewed &&
    b.interaction.reviewed
  ) return "stack";
  if (
    a.interaction.stackingGroup !== undefined &&
    a.interaction.stackingGroup === b.interaction.stackingGroup &&
    a.interaction.reviewed &&
    b.interaction.reviewed &&
    a.interaction.additive &&
    b.interaction.additive
  ) return "stack";
  if (
    a.interaction.reviewed &&
    b.interaction.reviewed &&
    a.interaction.additive &&
    b.interaction.additive &&
    a.interaction.stackingGroup !== undefined &&
    b.interaction.stackingGroup !== undefined &&
    a.interaction.stackingGroup !== b.interaction.stackingGroup
  ) return "stack";
  return undefined;
}

function pairRelation(a: WorkingLine, b: WorkingLine, context: CountryContext): PairRelation {
  const explicit = explicitPairRelation(a, b);
  if (explicit) return explicit;

  // A plain base + additional duty is an additive legal shape in the generic
  // evaluator. US-origin additional measures are intentionally stricter and
  // require the reviewed interaction metadata handled by the caller.
  if (a.category !== b.category && !(context.country === "US" && (a.category === "additional_duty" || b.category === "additional_duty" || a.category === "trade_remedy" || b.category === "trade_remedy"))) {
    return "stack";
  }
  return "unknown";
}

function treatmentKind(value: string | undefined): "general" | "special" | "other" | "mfn" | "unknown" {
  const normalized = normalizedText(value);
  if (hasAny(normalized, ["mfn", "most favoured", "most favored", "most-favoured", "most-favored"])) return "mfn";
  if (normalized.includes("general")) return "general";
  if (normalized.includes("special")) return "special";
  if (normalized === "other" || normalized.startsWith("other ")) return "other";
  return "unknown";
}

function normalizeLine(input: RateInput): WorkingLine {
  const record = recordOf(input);
  const kind = input.kind;
  const raw = deriveRawExpression(record, kind);
  const normalizedComponents = kind === "compound" && Array.isArray(record.components)
    ? record.components.map(normalizeComponent)
    : undefined;
  const output = {
    ...input,
    rateExpressionRaw: raw,
    ...(normalizedComponents ? { components: normalizedComponents } : {}),
    includedInConfirmedTotal: false,
    selected: false,
    status: "excluded",
    reason: "Not evaluated",
    interactionNote: stringValue(record.interactionNote) ?? "",
  } as EvaluatedRateLine;
  return {
    input,
    output,
    record,
    category: input.category,
    kind,
    confirmed: input.confirmed,
    percent: typeof record.percent === "string" ? record.percent : undefined,
    priority: numberValue(record.priority) ?? 0,
    priorityValid: record.priority !== undefined && numberValue(record.priority) !== undefined,
    country: stringValue(record.country ?? record.ruleCountry ?? record.rule_country),
    originCountry: stringValue(record.originCountry ?? record.origin_country ?? record.origin),
    treatment: stringValue(record.treatment),
    valueBasis: stringValue(record.valueBasis ?? record.value_basis ?? record.basis),
    interaction: parseInteraction(record),
  };
}

function withLineStatus(
  line: WorkingLine,
  status: EvaluatedRateLine["status"],
  reason: string,
  selected = false,
  includedInConfirmedTotal = false,
): EvaluatedRateLine {
  return {
    ...line.output,
    status,
    reason,
    selected,
    includedInConfirmedTotal,
  };
}

/**
 * Evaluate dated, already parsed tariff components. Selection is completed
 * before arithmetic so fallback treatments, provisional replacements, and
 * interaction conflicts can never inflate a displayed percentage.
 */
export function evaluateRates(
  inputs: readonly RateInput[],
  options: EvaluateRatesOptions = {},
): RateEvaluationResult {
  const working = inputs.map(normalizeLine);
  const context = resolveContext(working, options);
  const reasons: string[] = [];
  const interactionNotes: string[] = [];
  const finalLines = new Map<string, EvaluatedRateLine>();
  const active = new Set<WorkingLine>();
  const selected = new Set<WorkingLine>();
  let conflict = false;
  let manualReview = false;

  const addReason = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const addInteractionNote = (note: string): void => {
    if (note && !interactionNotes.includes(note)) interactionNotes.push(note);
  };
  const setLine = (
    line: WorkingLine,
    status: EvaluatedRateLine["status"],
    reason: string,
    isSelected = false,
    included = false,
  ): void => {
    finalLines.set(line.input.id, withLineStatus(line, status, reason, isSelected, included));
    addInteractionNote(line.interaction.rawNote);
  };
  const markManual = (reason: string, isConflict = false): void => {
    manualReview = true;
    conflict ||= isConflict;
    addReason(reason);
  };

  if (context.ruleDate && !dateLooksValid(context.ruleDate)) {
    markManual("Requested rule date is not an ISO calendar date; manual review required.");
  }
  if (context.ambiguousCountry) {
    markManual("Multiple tariff countries are present without an explicit country context; manual review required.");
  }
  if (context.ambiguousOrigin) {
    markManual("Multiple origin countries are present without an explicit origin context; manual review required.");
  }

  // First resolve date, country, origin, and named treatment. Unconfirmed
  // lines remain visible but never become candidates for a confirmed total.
  for (const line of working) {
    if (!line.confirmed) {
      setLine(line, "excluded", "Unconfirmed or review-only rate is excluded from the confirmed total.");
      continue;
    }
    const dateCheck = lineIsEffective(line, context.ruleDate);
    if (!dateCheck.ok) {
      setLine(line, dateCheck.reason?.includes("invalid") ? "manual_review" : "excluded", dateCheck.reason ?? "Rate is not effective on the requested rule date.");
      if (dateCheck.reason?.includes("invalid")) markManual(dateCheck.reason);
      continue;
    }

    if (context.country && line.country && countryFrom(line.country) !== context.country) {
      setLine(line, "excluded", `Rate belongs to ${line.country}, not the selected ${context.country} schedule.`);
      continue;
    }
    if (context.originCountry && line.originCountry && line.originCountry.toUpperCase() !== context.originCountry.toUpperCase()) {
      setLine(line, "excluded", `Rate origin ${line.originCountry} does not match ${context.originCountry}.`);
      continue;
    }

    const treatment = treatmentKind(line.treatment);
    if (context.country === "US" && context.originCountry?.toUpperCase() === "CN" && line.category === "base_duty") {
      if (treatment === "special" || treatment === "other") {
        setLine(line, "excluded", "US General treatment is selected for China; Special/Other is not silently applied.");
        continue;
      }
      if (treatment !== "general") {
        setLine(line, "manual_review", "US base-duty treatment is not explicitly General for China.");
        markManual("US General treatment must be selected explicitly for China.");
        continue;
      }
    }
    if (context.country === "CA" && context.originCountry?.toUpperCase() === "CN" && line.category === "base_duty") {
      if (treatment !== "mfn") {
        setLine(line, "excluded", "Canada MFN is the selected treatment; preferential/other treatments are not applied.");
        continue;
      }
    }

    active.add(line);
    addInteractionNote(line.interaction.rawNote);
  }

  const custom = (): WorkingLine[] => [...active].filter((line) => CUSTOMS_DUTY_CATEGORIES.has(line.category));
  let candidates = custom();

  // A dated Chinese provisional export row replaces ordinary export duty. It
  // is a replacement, never another additive percentage line.
  if (context.country === "CN") {
    const provisional = candidates.filter((line) =>
      line.category === "provisional_export_duty" || normalizedText(line.treatment).includes("provisional"),
    );
    if (provisional.length > 0) {
      for (const line of candidates) {
        if (line.category === "export_duty" && !provisional.includes(line)) {
          active.delete(line);
          setLine(line, "excluded", "Ordinary export duty is replaced by the effective China provisional export rule.");
        }
      }
      candidates = custom();
    }
  }

  for (const line of candidates) {
    if (line.interaction.explicit && !line.interaction.known) {
      markManual(`Unknown interaction metadata on rule ${line.input.id}; manual review required.`);
      setLine(line, "manual_review", "Unknown interaction metadata; the rule cannot be safely totaled.", true);
    }
  }

  // Explicit replacement/exclusion metadata is evaluated before priority.
  for (const line of [...candidates]) {
    for (const target of [...candidates]) {
      if (line === target) continue;
      if (refersTo(line, target, line.interaction.replaces)) {
        active.delete(target);
        candidates = candidates.filter((item) => item !== target);
        setLine(target, "excluded", `Replaced by confirmed rule ${line.input.id}.`);
      }
    }
  }

  // A missing or malformed priority is not a fallback priority. Validate only
  // confirmed customs candidates that survived treatment/replacement filters;
  // tax and fee rows do not participate in this selection.
  for (const line of [...candidates]) {
    if (!line.priorityValid) {
      active.delete(line);
      candidates = candidates.filter((item) => item !== line);
      const reason = line.record.priority === undefined
        ? "Confirmed customs rule is missing priority metadata; manual review required."
        : "Confirmed customs rule has invalid priority metadata; manual review required.";
      setLine(line, "manual_review", reason, true);
      markManual(reason);
    }
  }

  // A replaceGroup is an explicit alternative set even when its members use
  // different measure categories. Resolve its dated priority before the
  // ordinary category stacking pass; equal-priority alternatives are a
  // conflict rather than an arbitrary database-order choice.
  const replaceGroups = new Map<string, WorkingLine[]>();
  for (const line of candidates) {
    const group = line.interaction.replaceGroup;
    if (!group) continue;
    const groupLines = replaceGroups.get(group) ?? [];
    groupLines.push(line);
    replaceGroups.set(group, groupLines);
  }
  for (const [group, groupLines] of replaceGroups) {
    const bestPriority = Math.min(...groupLines.map((line) => line.priority));
    const winners = groupLines.filter((line) => line.priority === bestPriority);
    if (winners.length > 1) {
      for (const line of winners) setLine(line, "manual_review", `Same-priority replaceGroup ${group} alternatives require manual review.`, true);
      markManual(`Same-priority replaceGroup ${group} alternatives overlap.`, true);
      continue;
    }
    const winner = winners[0]!;
    for (const line of groupLines) {
      if (line === winner) continue;
      active.delete(line);
      candidates = candidates.filter((item) => item !== line);
      setLine(line, "excluded", `Replaced by priority ${bestPriority} rule ${winner.input.id} in replaceGroup ${group}.`);
    }
  }

  // Pick the lowest (highest legal) priority within each measure category.
  // Same-priority alternatives remain a conflict unless the source reviewed
  // them as an additive stacking group.
  const byCategory = new Map<string, WorkingLine[]>();
  for (const line of candidates) {
    const list = byCategory.get(line.category) ?? [];
    list.push(line);
    byCategory.set(line.category, list);
  }
  for (const list of byCategory.values()) {
    const bestPriority = Math.min(...list.map((line) => line.priority));
    const winners = list.filter((line) => line.priority === bestPriority);
    for (const line of list) {
      if (line.priority > bestPriority) {
        active.delete(line);
        setLine(line, "excluded", `Lower-priority rule is superseded by priority ${bestPriority}.`);
      }
    }
    if (winners.length === 1) {
      selected.add(winners[0]!);
      continue;
    }
    for (const winner of winners) selected.add(winner);
    for (let index = 0; index < winners.length; index += 1) {
      for (let next = index + 1; next < winners.length; next += 1) {
        const a = winners[index]!;
        const b = winners[next]!;
        const relation = pairRelation(a, b, context);
        if (relation === "stack") continue;
        if (relation === "exclude" || relation === "replace") {
          // Equal priority makes an explicit exclusion ambiguous rather than
          // silently picking the first database row.
          markManual(`Same-priority rules ${a.input.id} and ${b.input.id} explicitly exclude/replace one another.`, true);
          continue;
        }
        markManual(`Overlapping same-priority rules ${a.input.id} and ${b.input.id} require manual review.`, true);
      }
    }
  }

  const selectedArray = (): WorkingLine[] => [...selected].filter((line) => active.has(line));

  // Check interactions across categories (base + additional, base + remedy,
  // and so on) and remove explicitly excluded lower-priority rules.
  const current = selectedArray();
  for (let index = 0; index < current.length; index += 1) {
    for (let next = index + 1; next < current.length; next += 1) {
      const a = current[index]!;
      const b = current[next]!;
      if (a.category === b.category) continue;
      const relation = pairRelation(a, b, context);
      if (relation === "stack") continue;
      if (relation === "exclude" || relation === "replace") {
        if (a.priority === b.priority) {
          markManual(`Same-priority rules ${a.input.id} and ${b.input.id} cannot be resolved after exclusion metadata.`, true);
          continue;
        }
        const lower = a.priority < b.priority ? b : a;
        active.delete(lower);
        selected.delete(lower);
        setLine(lower, "excluded", `Excluded by a higher-priority interaction with ${lower === a ? b.input.id : a.input.id}.`);
        continue;
      }
      if (context.country === "US" && (a.category === "additional_duty" || b.category === "additional_duty" || a.category === "trade_remedy" || b.category === "trade_remedy")) {
        markManual(`US additional-duty interaction between ${a.input.id} and ${b.input.id} is not reviewed.`, true);
      } else if (
        (a.interaction.explicit && !a.interaction.known) ||
        (b.interaction.explicit && !b.interaction.known) ||
        (relation === "unknown" && (a.interaction.explicit || b.interaction.explicit))
      ) {
        markManual(`Unknown interaction metadata between ${a.input.id} and ${b.input.id}.`, true);
      }
    }
  }

  // US additional measures and trade remedies are included only when their
  // interaction metadata explicitly records a reviewed additive decision.
  for (const line of selectedArray()) {
    if (line.category === "trade_remedy" && !(line.interaction.reviewed && line.interaction.additive)) {
      selected.delete(line);
      markManual(`Confirmed trade-remedy rule ${line.input.id} is not reviewed as additive.`, true);
      setLine(line, "manual_review", "Trade-remedy inclusion requires a reviewed additive interaction.", true);
    } else if (
      context.country === "US" &&
      (line.category === "additional_duty" || line.category === "trade_remedy") &&
      !(line.interaction.reviewed && (line.interaction.additive || line.interaction.stackWith.size > 0 || line.interaction.stackingGroup !== undefined))
    ) {
      selected.delete(line);
      markManual(`US additional rule ${line.input.id} lacks reviewed stacking metadata.`, true);
      setLine(line, "manual_review", "US additional-duty inclusion requires reviewed stacking metadata.", true);
    }
  }

  const percentageValues: DecimalInput[] = [];
  const percentageLines: WorkingLine[] = [];
  let unsupportedConfirmedComponent = false;

  for (const line of selectedArray()) {
    if (line.kind === "specific" || line.kind === "compound") {
      unsupportedConfirmedComponent = true;
      const amountType = line.kind === "specific" ? typeof line.record.amount : "string";
      const reason = amountType !== "string" && line.record.amount !== undefined
        ? "Specific-duty amount must be a decimal string; numeric values are not coerced."
        : "A confirmed specific or compound component prevents a single percentage total.";
      setLine(line, "manual_review", reason, true);
      continue;
    }
    if (line.kind === "text") {
      markManual(`Text-only rate ${line.input.id} requires manual review.`);
      setLine(line, "manual_review", "Text-only rate expression requires manual review.", true);
      continue;
    }
    if (line.record.percent !== undefined && typeof line.record.percent !== "string") {
      markManual(`Ad-valorem rate ${line.input.id} has a non-string percentage; it is not coerced.`);
      setLine(line, "manual_review", "Ad-valorem percentage must be a decimal string; numeric values are not coerced.", true);
      continue;
    }
    if (line.kind === "free") {
      percentageValues.push("0");
      percentageLines.push(line);
      setLine(line, "included", "Confirmed free customs-duty line.", true);
      continue;
    }
    if (line.percent === undefined) {
      markManual(`Ad-valorem rate ${line.input.id} is missing its percentage; it is not treated as zero.`);
      setLine(line, "manual_review", "Ad-valorem rate is missing its percentage; it is not treated as zero.", true);
      continue;
    }
    percentageValues.push(line.percent);
    percentageLines.push(line);
    setLine(line, "included", "Confirmed additive ad-valorem customs-duty line.", true);
  }

  // Every confirmed tax/fee line is visible but cannot contribute to the
  // customs-duty percentage. This is intentionally done after selection so a
  // fee with a priority number cannot suppress a duty.
  for (const line of working) {
    if (!line.confirmed) continue;
    if (NON_DUTY_CATEGORIES.has(line.category)) {
      setLine(line, "excluded", "Tax and fee lines remain outside the customs-duty percentage total.");
    } else if (!CUSTOMS_DUTY_CATEGORIES.has(line.category) && !finalLines.has(line.input.id)) {
      setLine(line, "excluded", "Non-customs rate category is outside the customs-duty percentage total.");
    }
  }

  const valueBases = new Set(percentageLines.map((line) => line.valueBasis).filter((value): value is string => value !== undefined));
  if (percentageLines.some((line) => line.valueBasis === undefined) || valueBases.size !== 1) {
    markManual("Confirmed percentage lines must all provide the same explicit value basis; no combined total is shown.");
  }

  let confirmedTotalPercent: string | null = null;
  if (unsupportedConfirmedComponent) {
    markManual("A confirmed specific or compound duty is present; no all-in percentage is shown.");
  } else if (!manualReview && percentageValues.length > 0) {
    try {
      confirmedTotalPercent = sumConfirmedPercent(percentageValues);
    } catch (error) {
      markManual(error instanceof Error ? error.message : "Invalid decimal rate value; manual review required.");
    }
  } else if (percentageValues.length === 0) {
    markManual(
      context.country === "CN"
        ? "No confirmed China export rate is available; missing China rates are not treated as zero."
        : "No confirmed additive customs-duty ad-valorem line is available; missing rates are not treated as zero.",
    );
  }

  if (manualReview || conflict) {
    confirmedTotalPercent = null;
    for (const line of percentageLines) {
      const currentLine = finalLines.get(line.input.id);
      if (currentLine) {
        finalLines.set(line.input.id, {
          ...currentLine,
          includedInConfirmedTotal: false,
          status: "manual_review",
          reason: "Percentage total suppressed pending manual review.",
        });
      }
    }
  } else {
    for (const line of percentageLines) {
      const currentLine = finalLines.get(line.input.id);
      if (currentLine) finalLines.set(line.input.id, { ...currentLine, includedInConfirmedTotal: true, status: "included" });
    }
  }

  return {
    status: manualReview || conflict ? "manual_review" : "confirmed",
    conflict,
    confirmedTotalPercent,
    lines: working.map((line) => finalLines.get(line.input.id) ?? line.output),
    reasons,
    interactionNotes,
  };
}
