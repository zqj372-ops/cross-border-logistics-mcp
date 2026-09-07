export interface CandidateAssistant {
  rankCandidateIds(input: {
    readonly query: string;
    readonly candidates: Array<{ readonly id: string; readonly legalNames: string[] }>;
    readonly attributes: Record<string, string | number | boolean>;
    readonly approvedQuestionIds: string[];
  }): Promise<string[]>;
  chooseQuestion(input: {
    readonly candidates: Array<{ readonly id: string; readonly legalNames: string[] }>;
    readonly answeredAttributes: string[];
    readonly approvedQuestionIds: string[];
    /** Optional context used by a configured model; the fixture ignores it. */
    readonly query?: string;
    readonly attributes?: Record<string, string | number | boolean>;
  }): Promise<string | null>;
}
