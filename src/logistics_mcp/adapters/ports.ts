import type {
  CalculationStep,
  EnvelopeData,
  EnvelopeStatus,
  Notice,
  ReviewStatus,
  SourceRef,
} from "../platform/envelope";
import type { ExecutionContext } from "../platform/context";

export interface AdapterResult<TData extends EnvelopeData = EnvelopeData> {
  readonly status: EnvelopeStatus;
  readonly data: TData;
  readonly sourceRefs: readonly SourceRef[];
  readonly assumptions?: readonly Notice[];
  readonly warnings?: readonly Notice[];
  readonly blockers?: readonly Notice[];
  readonly calculationTrace?: readonly CalculationStep[];
  readonly reviewStatus?: ReviewStatus;
}
export interface FixtureInput {
  readonly fixture: string;
}

export interface QuoteAdapter {
  calculate(input: Record<string, unknown> | FixtureInput): Promise<AdapterResult>;
  previewDraft(input: Record<string, unknown>): Promise<AdapterResult>;
  commitDraft(input: Record<string, unknown>, signal?: AbortSignal): Promise<AdapterResult>;
  readDraft(input: Record<string, unknown>): Promise<AdapterResult>;
}

export interface CustomsAdapter {
  getStatus(
    input: Record<string, unknown> | FixtureInput,
    context?: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<AdapterResult>;
  search(
    input: Record<string, unknown> | FixtureInput,
    context?: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<AdapterResult>;
  estimate(
    input: Record<string, unknown> | FixtureInput,
    context?: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<AdapterResult>;
}

export interface KnowledgeAdapter {
  searchCurated(input: Record<string, unknown> | FixtureInput): Promise<AdapterResult>;
}

export interface StatusAdapter {
  getDataStatus(input: Record<string, unknown> | FixtureInput): Promise<AdapterResult>;
}

export interface ReviewAdapter {
  previewTask(input: Record<string, unknown>): Promise<AdapterResult>;
  commitTask(input: Record<string, unknown>, signal?: AbortSignal): Promise<AdapterResult>;
  readTask(input: Record<string, unknown>): Promise<AdapterResult>;
}

export interface FixtureAdapters {
  readonly quote: QuoteAdapter;
  readonly customs: CustomsAdapter;
  readonly knowledge: KnowledgeAdapter;
  readonly status: StatusAdapter;
  readonly review: ReviewAdapter;
}
