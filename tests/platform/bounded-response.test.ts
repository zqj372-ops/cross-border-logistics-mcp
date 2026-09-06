import { describe, expect, it, vi } from "vitest";
import { readBoundedResponse, ResponseSizeError } from "../../src/logistics_mcp/platform/bounded-response";

describe("bounded upstream response", () => {
  it.each([undefined, "1"])("stops actual bytes despite content-length %s", async (length) => {
    let pulls = 0;
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(10)); }, cancel,
    }), length ? { headers: { "content-length": length } } : {});
    await expect(readBoundedResponse(response, 20)).rejects.toBeInstanceOf(ResponseSizeError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(4);
  });

  it("cancels a declared oversized body without reading it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-length": "50" } });
    await expect(readBoundedResponse(response, 20)).rejects.toBeInstanceOf(ResponseSizeError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains exact-limit bytes across chunk boundaries", async () => {
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); controller.close();
    } }));
    expect(await readBoundedResponse(response, 3)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("aborts a stalled body without waiting for cancellation", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const pending = readBoundedResponse(new Response(new ReadableStream({ cancel })), 20, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
