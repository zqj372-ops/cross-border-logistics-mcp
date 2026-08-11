import type { CustomsAdapter, AdapterResult } from "../../adapters/ports";
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
): Promise<AdapterResult> {
  return adapter.search(input);
}
