import type { CustomsAdapter, AdapterResult } from "../../adapters/ports";
import {
  customsAssessmentSchema,
  customsEstimateInputSchema,
  outputValidator,
} from "../../adapters/contracts";

export { customsEstimateInputSchema };
export const customsEstimateOutputValidator = outputValidator(customsAssessmentSchema);

export async function estimateCanadaCustoms(
  adapter: CustomsAdapter,
  input: Record<string, unknown>,
): Promise<AdapterResult> {
  return adapter.estimate(input);
}
