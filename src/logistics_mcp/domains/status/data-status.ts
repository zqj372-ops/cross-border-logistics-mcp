import type { AdapterResult, StatusAdapter } from "../../adapters/ports";
import {
  dataStatusInputSchema,
  dataStatusSchema,
  outputValidator,
} from "../../adapters/contracts";

export { dataStatusInputSchema };
export const dataStatusOutputValidator = outputValidator(dataStatusSchema);

export async function getSystemDataStatus(
  adapter: StatusAdapter,
  input: Record<string, unknown>,
): Promise<AdapterResult> {
  return adapter.getDataStatus(input);
}
