export class ResponseSizeError extends Error {
  constructor() {
    super("response_too_large");
    this.name = "ResponseSizeError";
  }
}

/** Bounds actual network bytes, including chunked bodies and dishonest lengths. */
export async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new RangeError("invalid_response_limit");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximumBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw new ResponseSizeError();
  }
  signal?.throwIfAborted();
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) throw new ResponseSizeError();
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    // Cleanup must not wait for an unresponsive upstream's cancellation promise.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
