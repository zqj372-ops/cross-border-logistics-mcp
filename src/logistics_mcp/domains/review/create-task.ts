import type { AdapterResult, ReviewAdapter } from "../../adapters/ports";
import {
  reviewCreateTaskInputSchema,
  writeResultSchema,
  outputValidator,
} from "../../adapters/contracts";

export { reviewCreateTaskInputSchema };
export const reviewCreateTaskOutputValidator = outputValidator(writeResultSchema);

export async function createReviewTask(
  adapter: ReviewAdapter,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AdapterResult> {
  const writeContext = input.write_context;
  if (
    typeof writeContext === "object" &&
    writeContext !== null &&
    !Array.isArray(writeContext) &&
    (writeContext as Record<string, unknown>).operation_mode === "preview"
  ) {
    return adapter.previewTask(input);
  }
  return adapter.commitTask(input, signal);
}
