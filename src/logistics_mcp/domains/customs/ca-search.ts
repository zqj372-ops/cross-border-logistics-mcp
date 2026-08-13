import type { CustomsAdapter, AdapterResult } from "../../adapters/ports";
import type { ExecutionContext } from "../../platform/context";
import {
  customsSearchInputSchema,
  customsSearchResultSchema,
  outputValidator,
} from "../../adapters/contracts";

export { customsSearchInputSchema };
export const customsSearchOutputValidator = outputValidator(customsSearchResultSchema);

export async function searchCanadaCustoms(
  adapter: CustomsAdapter,
  input: Record<string, unknown>,
  context?: ExecutionContext,
  signal?: AbortSignal,
): Promise<AdapterResult> {
  return adapter.search(input, context, signal);
}
