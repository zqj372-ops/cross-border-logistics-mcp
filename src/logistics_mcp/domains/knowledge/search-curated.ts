import type { AdapterResult, KnowledgeAdapter } from "../../adapters/ports";
import {
  knowledgeSearchInputSchema,
  knowledgeSearchResultSchema,
  outputValidator,
} from "../../adapters/contracts";

export { knowledgeSearchInputSchema };
export const knowledgeSearchOutputValidator = outputValidator(knowledgeSearchResultSchema);

export async function searchCuratedKnowledge(
  adapter: KnowledgeAdapter,
  input: Record<string, unknown>,
): Promise<AdapterResult> {
  return adapter.searchCurated(input);
}
