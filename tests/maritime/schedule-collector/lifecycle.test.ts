import { getEventListeners } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createControlledHttpTransport } from "../../../services/maritime/schedule-collector/transport/http";
import type {
  TrustedConnector,
  TrustedConnectorRequest,
  TrustedConnectorResponse,
} from "../../../services/maritime/schedule-collector/transport/http";
import type { ApprovedTarget, TransportPolicy } from "../../../services/maritime/schedule-collector/transport/config";

const target: ApprovedTarget = {
  carrier: "OOCL",
  host: "example.invalid",
  port: 443,
  methods: ["GET"],
  path: "/exact",
  allowedQueryKeys: [],
  allowedBodyKeys: [],
  sourcePermissionRef: "source-ref",
  livePolicyApprovalRef: "policy-ref",
  expiresAt: "2099-01-01T00:00:00Z",
};

const policy: TransportPolicy = {
  approvedTargets: [target],
  timeoutMs: 1000,
  maxResponseBytes: 1024,
  maxRequestBodyBytes: 1024,
  maxRequestsPerRun: 2,
  maxRetries: 1,
};

describe("collector lifecycle", () => {
  it("propagates caller cancellation to a pending connector", async () => {
    const received: { signal?: AbortSignal } = {};
    const connector: TrustedConnector = {
      connect(input: TrustedConnectorRequest): Promise<TrustedConnectorResponse> {
        received.signal = input.signal;
        return new Promise((_, reject) => {
          input.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      },
    };
    const transport = createControlledHttpTransport({ policy, connector });
    const controller = new AbortController();
    const pending = transport.request({
      carrier: "OOCL",
      method: "GET",
      path: "/exact",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(received.signal).toBeDefined();
    expect(received.signal?.aborted).toBe(true);
  });

  it("uses the request budget for actual connector attempts", async () => {
    let calls = 0;
    const connector: TrustedConnector = {
      connect(): Promise<TrustedConnectorResponse> {
        calls += 1;
        return Promise.resolve({
          status: 200,
          url: "https://example.invalid/exact",
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode("{}"),
        });
      },
    };
    const transport = createControlledHttpTransport({
      policy: { ...policy, maxRequestsPerRun: 1, maxRetries: 1 },
      connector,
    });
    await transport.request({ carrier: "OOCL", method: "GET", path: "/exact" });
    await expect(
      transport.request({ carrier: "OOCL", method: "GET", path: "/exact" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(calls).toBe(1);
  });

  it("clears the request timer and abort listener after completion", async () => {
    const transport = createControlledHttpTransport({
      policy,
      connector: {
        connect: () =>
          Promise.resolve({
            status: 200,
            url: "https://example.invalid/exact",
            headers: { "content-type": "application/json" },
            body: new TextEncoder().encode("{}"),
          }),
      },
    });
    const controller = new AbortController();
    await transport.request({
      carrier: "OOCL",
      method: "GET",
      path: "/exact",
      signal: controller.signal,
    });
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("does not schedule a retry timer when cancellation wins first", async () => {
    vi.useFakeTimers();
    try {
      const transport = createControlledHttpTransport({
        policy: { ...policy, maxRetries: 1 },
        connector: {
          connect: () => Promise.reject(new Error("temporary failure")),
        },
      });
      const controller = new AbortController();
      const pending = transport.request({
        carrier: "OOCL",
        method: "GET",
        path: "/exact",
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "timeout" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
