import type { CaseService } from '../access-gateway/portal/cases';
import type { PortalContext } from '../access-gateway/portal/contracts';
import { PortalError } from '../access-gateway/portal/contracts';
import type { FclRateAdminView, NativeAdminService } from '../access-gateway/portal/native-admin';
import { z } from 'zod';
import {
  fclQuoteMatchRequestSchema,
  fclQuoteResponseSchema,
  FCL_QUOTE_WORKFLOW_VERSION,
  type FclRateDataset,
  type FclRatePublication,
} from './fcl-contracts';
export {
  FCL_QUOTE_WORKFLOW_VERSION,
  fclQuoteMatchRequestSchema,
  fclQuoteResponseSchema,
} from './fcl-contracts';

type FclCaseView = ReturnType<CaseService['getFclCase']>;
type FclQuoteMatchRequest = ReturnType<typeof fclQuoteMatchRequestSchema.parse>;
type FclQuoteResponse = ReturnType<typeof fclQuoteResponseSchema.parse>;
type FclQuoteCandidate = FclQuoteResponse['data']['candidates'][number];
type FclQuoteSelectedSnapshot = NonNullable<FclQuoteResponse['data']['selected']>;
type FclQuoteTraceStep = FclQuoteResponse['data']['calculation_trace'][number];

export type FclCaseReader = Pick<CaseService, 'getFclCase'>;
export type FclRateReader = Pick<NativeAdminService, 'get'>;
export type FclQuoteServiceOptions = {
  caseReader: FclCaseReader;
  rateReader: FclRateReader;
  now: () => string;
};

type MatchInput = {
  request: FclQuoteMatchRequest;
  caseView: FclCaseView;
  rateView: FclRateAdminView;
  now: string;
};

const caseBinding = (caseView: FclCaseView) => ({
  case_ref: caseView.case_id,
  case_version: caseView.case_version,
  latest_customer_supplement_ref: caseView.review_context.latest_customer_supplement_ref,
});

const buildData = (
  caseView: FclCaseView,
  overrides: Partial<FclQuoteResponse['data']> = {},
): FclQuoteResponse['data'] => ({
  case_binding: caseBinding(caseView),
  candidates: [],
  selected: null,
  missing_fields: [],
  source_refs: [],
  assumptions: [],
  warnings: [],
  blockers: [],
  calculation_trace: [],
  ...overrides,
});

const trace = (step: string, detail: string): FclQuoteTraceStep => ({ step, detail });

const missingFields = (input: FclCaseView['current_input']): string[] => {
  const missing: string[] = [];
  if (input.pol === null) missing.push('/pol');
  if (input.pod === null) missing.push('/pod');
  if (input.containers.length === 0) missing.push('/containers');
  input.containers.forEach((container, index) => {
    if (container.quantity === null) missing.push(`/containers/${index}/quantity`);
  });
  if (input.cargo_ready_date === null) missing.push('/cargo_ready_date');
  return missing;
};

const candidateFromRate = (release: FclRatePublication, rate: FclRatePublication['input']['rates'][number]): FclQuoteCandidate => ({
  rate_id: rate.rate_id,
  release_id: release.release_id,
  release_version: release.version,
  dataset_digest: release.digest,
  source_ref: rate.source_ref,
  source_version: rate.source_version,
  valid_from: rate.valid_from,
  valid_until: rate.valid_until,
  rate,
});

const rateMatches = (input: FclCaseView['current_input'], rate: FclRateDataset['rates'][number]): boolean => {
  if (input.pol !== rate.pol || input.pod !== rate.pod || input.cargo_ready_date === null) return false;
  if (input.cargo_ready_date < rate.valid_from || input.cargo_ready_date > rate.valid_until) return false;
  const containers = new Set(rate.items.map((item) => item.container_type));
  return input.containers.every((container) => containers.has(container.type));
};

const selectedSnapshot = (
  candidate: FclQuoteCandidate,
  caseView: FclCaseView,
  now: string,
): FclQuoteSelectedSnapshot => ({
  ...candidate,
  selected_at: now,
  case_ref: caseView.case_id,
  case_version: caseView.case_version,
  latest_customer_supplement_ref: caseView.review_context.latest_customer_supplement_ref,
});

export function preflightFclMatch(request: FclQuoteMatchRequest, caseView: FclCaseView): FclQuoteResponse | null {
  const baseTrace: FclQuoteTraceStep[] = [
    trace('case_binding_checked', `Case ${caseView.case_id} version ${caseView.case_version}`),
  ];
  if (request.expected_case_version !== caseView.case_version) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'blocked',
      data: buildData(caseView, { blockers: ['fcl_case_version_conflict'], calculation_trace: baseTrace }),
      reason_codes: ['fcl_case_version_conflict'],
    });
  }
  if (request.expected_customer_supplement_ref !== caseView.review_context.latest_customer_supplement_ref) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'blocked',
      data: buildData(caseView, { blockers: ['fcl_customer_supplement_conflict'], calculation_trace: baseTrace }),
      reason_codes: ['fcl_customer_supplement_conflict'],
    });
  }
  if (caseView.case_status === 'closed' || caseView.case_status === 'cancelled') {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'blocked',
      data: buildData(caseView, { blockers: ['fcl_case_closed'], calculation_trace: baseTrace }),
      reason_codes: ['fcl_case_closed'],
    });
  }
  const missing = missingFields(caseView.current_input);
  if (missing.length > 0) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'needs_input',
      data: buildData(caseView, {
        missing_fields: missing,
        blockers: ['fcl_case_input_incomplete'],
        calculation_trace: [...baseTrace, trace('missing_fields_collected', missing.join(', '))],
      }),
      reason_codes: ['fcl_case_input_incomplete'],
    });
  }
  if (caseView.case_status === 'submitted' || caseView.case_status === 'needs_input' || caseView.review_context.review_required) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'manual_review',
      data: buildData(caseView, { blockers: ['fcl_case_review_required'], calculation_trace: baseTrace }),
      reason_codes: ['fcl_case_review_required'],
    });
  }
  return null;
}

export function matchFclRateSources({ request, caseView, rateView, now }: MatchInput): FclQuoteResponse {
  const preflight = preflightFclMatch(request, caseView);
  if (preflight) return preflight;
  const baseTrace: FclQuoteTraceStep[] = [
    trace('case_binding_checked', `Case ${caseView.case_id} version ${caseView.case_version}`),
  ];
  if (!rateView.active_release) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'unavailable',
      data: buildData(caseView, {
        blockers: ['fcl_rate_source_unavailable'],
        calculation_trace: [...baseTrace, trace('active_rate_checked', 'No active FCL rate release')],
      }),
      reason_codes: ['fcl_rate_source_unavailable'],
    });
  }

  const release = rateView.active_release;
  const candidates = release.input.rates
    .filter((rate) => rateMatches(caseView.current_input, rate))
    .map((rate) => candidateFromRate(release, rate))
    .sort((left, right) => left.rate_id.localeCompare(right.rate_id));
  const sourceRefs = candidates.map((candidate) => ({
    rate_id: candidate.rate_id,
    release_id: candidate.release_id,
    release_version: candidate.release_version,
    dataset_digest: candidate.dataset_digest,
    source_ref: candidate.source_ref,
    source_version: candidate.source_version,
    valid_from: candidate.valid_from,
    valid_until: candidate.valid_until,
  }));
  const matchTrace = [
    ...baseTrace,
    trace('active_rate_checked', `Release ${release.release_id} version ${release.version}`),
    trace('rates_filtered', `${candidates.length} exact candidate(s)`),
  ];

  if (candidates.length === 0) {
    if (request.selected_rate_id !== null) {
      return fclQuoteResponseSchema.parse({
        contract_version: FCL_QUOTE_WORKFLOW_VERSION,
        status: 'blocked',
        data: buildData(caseView, {
          candidates: [],
          source_refs: [],
          blockers: ['fcl_selected_rate_not_candidate'],
          calculation_trace: [...matchTrace, trace('rate_selection_rejected', 'Selected rate is not an exact candidate')],
        }),
        reason_codes: ['fcl_selected_rate_not_candidate'],
      });
    }
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'manual_review',
      data: buildData(caseView, {
        candidates: [],
        source_refs: [],
        blockers: ['fcl_rate_no_match'],
        calculation_trace: matchTrace,
      }),
      reason_codes: ['fcl_rate_no_match'],
    });
  }

  if (request.selected_rate_id === null && candidates.length > 1) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'manual_review',
      data: buildData(caseView, {
        candidates,
        source_refs: sourceRefs,
        blockers: ['fcl_rate_selection_required'],
        calculation_trace: [...matchTrace, trace('rate_selection_required', 'Multiple candidates require explicit selection')],
      }),
      reason_codes: ['fcl_rate_selection_required'],
    });
  }

  const selectedCandidate = request.selected_rate_id === null
    ? candidates[0]!
    : candidates.find((candidate) => candidate.rate_id === request.selected_rate_id);
  if (!selectedCandidate) {
    return fclQuoteResponseSchema.parse({
      contract_version: FCL_QUOTE_WORKFLOW_VERSION,
      status: 'blocked',
      data: buildData(caseView, {
        candidates,
        source_refs: sourceRefs,
        blockers: ['fcl_selected_rate_not_candidate'],
        calculation_trace: [...matchTrace, trace('rate_selection_rejected', 'Selected rate is not an exact candidate')],
      }),
      reason_codes: ['fcl_selected_rate_not_candidate'],
    });
  }

  const selected = selectedSnapshot(selectedCandidate, caseView, now);
  return fclQuoteResponseSchema.parse({
    contract_version: FCL_QUOTE_WORKFLOW_VERSION,
    status: 'success',
    data: buildData(caseView, {
      candidates,
      selected,
      source_refs: sourceRefs,
      assumptions: ['exact_pol_pod_container_ready_date_match'],
      calculation_trace: [...matchTrace, trace('rate_selected', selected.rate_id)],
    }),
    reason_codes: [],
  });
}

export class FclQuoteService {
  readonly #caseReader: FclCaseReader;
  readonly #rateReader: FclRateReader;
  readonly #now: () => string;
  constructor(options: FclQuoteServiceOptions) {
    this.#caseReader = options.caseReader;
    this.#rateReader = options.rateReader;
    this.#now = options.now;
  }
  match(ctx: PortalContext, input: unknown): FclQuoteResponse {
    let request: FclQuoteMatchRequest;
    try {
      request = fclQuoteMatchRequestSchema.parse(input);
    } catch {
      throw new PortalError('fcl_quote_input_invalid');
    }
    let caseView: FclCaseView;
    try {
      caseView = this.#caseReader.getFclCase(ctx, request.case_ref);
    } catch {
      throw new PortalError('fcl_quote_case_unavailable');
    }
    const preflight = preflightFclMatch(request, caseView);
    if (preflight) return preflight;
    let rateView: FclRateAdminView;
    try {
      const current = this.#rateReader.get(ctx, 'fcl');
      if (current.kind !== 'fcl') throw new PortalError('fcl_rate_source_unavailable');
      rateView = current;
    } catch {
      return fclQuoteResponseSchema.parse({
        contract_version: FCL_QUOTE_WORKFLOW_VERSION,
        status: 'unavailable',
        data: buildData(caseView, {
          blockers: ['fcl_rate_source_unavailable'],
          calculation_trace: [trace('active_rate_checked', 'FCL rate source unavailable')],
        }),
        reason_codes: ['fcl_rate_source_unavailable'],
      });
    }
    return matchFclRateSources({ request, caseView, rateView, now: this.#safeNow() });
  }
  #safeNow() {
    try {
      const now = this.#now();
      if (!z.iso.datetime().safeParse(now).success) throw new Error('invalid');
      return now;
    } catch {
      throw new PortalError('fcl_quote_clock_unavailable');
    }
  }
}
