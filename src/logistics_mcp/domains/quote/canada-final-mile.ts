import type { QuoteAdapter } from "../../adapters/ports";
import type { AdapterResult } from "../../adapters/ports";
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
): Promise<AdapterResult> {
  return adapter.calculate(input);
}
