import type { CustomsAdapter, AdapterResult } from "../../adapters/ports";
import type { ExecutionContext } from "../../platform/context";
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
  context?: ExecutionContext,
  signal?: AbortSignal,
): Promise<AdapterResult> {
  return adapter.estimate(input, context, signal);
}
