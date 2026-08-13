import type {
  DomainToolHandler,
  ToolContract,
} from "../server/tool-registry";
import type { FixtureAdapters } from "./ports";
import { createFixtureAdapters } from "./fixture-client";
import {
  canadaFinalMileInputSchema,
  canadaFinalMileOutputValidator,
} from "../domains/quote/canada-final-mile";
import {
  customsEstimateInputSchema,
  customsEstimateOutputValidator,
} from "../domains/customs/ca-estimate";
import {
  customsSearchInputSchema,
  customsSearchOutputValidator,
} from "../domains/customs/ca-search";
import {
  knowledgeSearchInputSchema,
  knowledgeSearchOutputValidator,
} from "../domains/knowledge/search-curated";
import {
  dataStatusInputSchema,
  dataStatusOutputValidator,
} from "../domains/status/data-status";
import {
  reviewCreateTaskInputSchema,
  reviewCreateTaskOutputValidator,
} from "../domains/review/create-task";
import {
  quoteSaveDraftInputSchema,
  writeResultSchema,
} from "./contracts";
import { calculateCanadaFinalMile } from "../domains/quote/canada-final-mile";
import { estimateCanadaCustoms } from "../domains/customs/ca-estimate";
import { searchCanadaCustoms } from "../domains/customs/ca-search";
import { searchCuratedKnowledge } from "../domains/knowledge/search-curated";
import { getSystemDataStatus } from "../domains/status/data-status";
import { createReviewTask } from "../domains/review/create-task";

export const phase1ToolNames = [
  "knowledge.search_curated",
  "system.get_data_status",
  "quote.canada_final_mile.calculate",
  "customs.ca.search",
  "customs.ca.estimate",
  "quote.save_draft",
  "review.create_task",
] as const;

export type Phase1ToolName = (typeof phase1ToolNames)[number];

export type ToolHandlerMap = {
  readonly [Name in Phase1ToolName]: DomainToolHandler;
};

export type ToolContractMap = {
  readonly [Name in Phase1ToolName]: ToolContract;
};

export interface Phase1Bundle {
  readonly handlers: ToolHandlerMap;
  readonly contracts: ToolContractMap;
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("The tool input must be an object after contract validation.");
  }
  return input as Record<string, unknown>;
}

function contract(
  inputSchema: ToolContract["inputSchema"],
  validateOutput: ToolContract["validateOutput"],
): ToolContract {
  return { inputSchema, validateOutput };
}

export function createPhase1Bundle(adapters: FixtureAdapters): Phase1Bundle {
  const handlers: ToolHandlerMap = {
    "knowledge.search_curated": (input) =>
      searchCuratedKnowledge(adapters.knowledge, inputRecord(input)),
    "system.get_data_status": (input) =>
      getSystemDataStatus(adapters.status, inputRecord(input)),
    "quote.canada_final_mile.calculate": (input) =>
      calculateCanadaFinalMile(adapters.quote, inputRecord(input)),
    "customs.ca.search": (input, context, signal) =>
      searchCanadaCustoms(adapters.customs, inputRecord(input), context, signal),
    "customs.ca.estimate": (input, context, signal) =>
      estimateCanadaCustoms(adapters.customs, inputRecord(input), context, signal),
    "quote.save_draft": (input, _context, signal) => {
      const value = inputRecord(input);
      const writeContext = value.write_context;
      const writeContextRecord =
        typeof writeContext === "object" &&
        writeContext !== null &&
        !Array.isArray(writeContext)
          ? (writeContext as Record<string, unknown>)
          : null;
      const mode =
        writeContextRecord?.operation_mode === "preview"
          ? "preview"
          : "commit";
      return mode === "preview"
        ? adapters.quote.previewDraft(value)
        : adapters.quote.commitDraft(value, signal);
    },
    "review.create_task": (input, _context, signal) =>
      createReviewTask(adapters.review, inputRecord(input), signal),
  };

  const contracts: ToolContractMap = {
    "knowledge.search_curated": contract(
      knowledgeSearchInputSchema,
      knowledgeSearchOutputValidator,
    ),
    "system.get_data_status": contract(
      dataStatusInputSchema,
      dataStatusOutputValidator,
    ),
    "quote.canada_final_mile.calculate": contract(
      canadaFinalMileInputSchema,
      canadaFinalMileOutputValidator,
    ),
    "customs.ca.search": contract(
      customsSearchInputSchema,
      customsSearchOutputValidator,
    ),
    "customs.ca.estimate": contract(
      customsEstimateInputSchema,
      customsEstimateOutputValidator,
    ),
    "quote.save_draft": contract(
      quoteSaveDraftInputSchema,
      (data) => writeResultSchema.parse(data),
    ),
    "review.create_task": contract(
      reviewCreateTaskInputSchema,
      reviewCreateTaskOutputValidator,
    ),
  };

  return { handlers, contracts };
}

const defaultBundle = createPhase1Bundle(createFixtureAdapters());

export const phase1ToolHandlers = defaultBundle.handlers;
export const phase1ToolContracts = defaultBundle.contracts;
