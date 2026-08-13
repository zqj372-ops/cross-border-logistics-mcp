import type { QuoteAdapter } from "../../adapters/ports";
import type { AdapterResult } from "../../adapters/ports";
import type { ExecutionContext } from "../../platform/context";
import {
  canadaFinalMileInputSchema,
  quoteResultSchema,
  outputValidator,
} from "../../adapters/contracts";

export { canadaFinalMileInputSchema };
export const canadaFinalMileOutputValidator = outputValidator(quoteResultSchema);

export async function calculateCanadaFinalMile(
  adapter: QuoteAdapter,
  input: Record<string, unknown>,
  context?: ExecutionContext,
  signal?: AbortSignal,
): Promise<AdapterResult> {
  return adapter.calculate(input, context, signal);
}
