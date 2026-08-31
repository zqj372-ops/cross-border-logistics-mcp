const REQUEST_TIMEOUT_MS = 15_000;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export async function assertCandidateSyntheticWriteTarget(input: Readonly<{
  baseUrl: URL;
  fetchImpl?: FetchImplementation;
}>): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL("access/v1/readyz", input.baseUrl), {
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Synthetic deployment target readiness could not be verified.");
  }
  let payload: Readonly<Record<string, unknown>> | null = null;
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().startsWith("application/json")) {
      payload = record(await response.json());
    }
  } catch {
    payload = null;
  }
  const data = record(payload?.data);
  if (
    response.status !== 200 ||
    payload?.status !== "manual_review" ||
    data?.profile !== "single-node-candidate" ||
    data.operational_ready !== true ||
    data.production_eligible !== false
  ) {
    throw new Error("Synthetic deployment writes are forbidden for this target.");
  }
}
