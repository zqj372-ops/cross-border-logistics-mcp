import { describe, expect, it, vi } from "vitest";

import { CollectorRuntimeError } from "../../../services/maritime/schedule-collector/errors";
import { createControlledHttpTransport } from "../../../services/maritime/schedule-collector/transport/http";
import { selectPublicIpv4Address } from "../../../services/maritime/schedule-collector/transport/node-connector";
import {
  type ApprovedTarget,
  type TransportPolicy,
} from "../../../services/maritime/schedule-collector/transport/config";
import type {
  TrustedConnector,
  TrustedConnectorResponse,
} from "../../../services/maritime/schedule-collector/transport/http";

const target: ApprovedTarget = {
  carrier: "OOCL",
  host: "example.invalid",
  port: 443,
  methods: ["GET", "POST"],
  path: "/exact/path",
  allowedQueryKeys: ["id"],
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
  maxRequestsPerRun: 10,
  maxRetries: 1,
};

function okResponse(): TrustedConnectorResponse {
  return {
    status: 200,
    url: "https://example.invalid/exact/path?id=1",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode('{"ok":true}'),
  };
}

describe("controlled HTTP transport", () => {
  it("selects a public IPv4 A record when DNS also contains AAAA records", () => {
    expect(
      selectPublicIpv4Address([
        { address: "2001:4860:4860::8888", family: 6 },
        { address: "59.37.89.108", family: 4 },
        { address: "2001:4860:4860::8844", family: 6 },
      ]),
    ).toEqual({ address: "59.37.89.108", family: 4 });
    expect(() =>
      selectPublicIpv4Address([
        { address: "2001:4860:4860::8888", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).toThrow();
  });

  it("accepts normalized default HTTPS port and bounds one request", async () => {
    const connect = vi.fn<TrustedConnector["connect"]>(() => Promise.resolve(okResponse()));
    const transport = createControlledHttpTransport({
      policy,
      connector: { connect },
    });
    const response = await transport.request({
      carrier: "OOCL",
      method: "GET",
      path: "/exact/path",
      query: { id: "1" },
    });
    expect(response.status).toBe(200);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("does not call the connector when the caller is already aborted", async () => {
    const connect = vi.fn<TrustedConnector["connect"]>(() => Promise.resolve(okResponse()));
    const transport = createControlledHttpTransport({
      policy,
      connector: { connect },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport.request({
        carrier: "OOCL",
        method: "GET",
        path: "/exact/path",
        query: { id: "1" },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects redirects and unapproved headers", async () => {
    const redirect = vi.fn<TrustedConnector["connect"]>(() =>
      Promise.resolve({
        ...okResponse(),
        status: 302,
        headers: { location: "https://private.invalid/" },
      }),
    );
    const transport = createControlledHttpTransport({
      policy,
      connector: { connect: redirect },
    });
    await expect(
      transport.request({
        carrier: "OOCL",
        method: "GET",
        path: "/exact/path",
        query: { id: "1" },
      }),
    ).rejects.toMatchObject({ code: "access_restricted" });
    await expect(
      transport.request({
        carrier: "OOCL",
        method: "GET",
        path: "/exact/path",
        query: { id: "1" },
        headers: { authorization: "secret" },
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      transport.request({
        carrier: "OOCL",
        method: "GET",
        path: "/exact/path",
        query: { id: "1" },
        headers: { "x-csrf-token": "not-approved-here" },
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("rejects targets that are not exact or approved", async () => {
    const transport = createControlledHttpTransport({
      policy,
      connector: { connect: () => Promise.resolve(okResponse()) },
    });
    await expect(
      transport.request({
        carrier: "OOCL",
        method: "GET",
        path: "/other/path",
        query: { id: "1" },
      }),
    ).rejects.toBeInstanceOf(CollectorRuntimeError);
    await expect(
      transport.request({
        carrier: "OOCL",
        method: "GET",
        path: "/exact/path",
        query: { id: "1", extra: "2" },
      }),
    ).rejects.toMatchObject({ code: "live_not_approved" });
  });

  it("keeps HMM session cookies in memory and parses multiple Set-Cookie values", async () => {
    const sessionTarget: ApprovedTarget = {
      ...target,
      carrier: "HMM",
      sessionCookieHost: "example.invalid",
      allowedRequestHeaders: ["x-csrf-token"],
    };
    const connect = vi.fn<TrustedConnector["connect"]>()
      .mockResolvedValueOnce({
        ...okResponse(),
        headers: {
          "content-type": "application/json",
          "set-cookie":
            "session=one; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, csrf=two; Path=/",
        },
      })
      .mockResolvedValueOnce(okResponse());
    const transport = createControlledHttpTransport({
      policy: { ...policy, approvedTargets: [sessionTarget] },
      connector: { connect },
    });
    await transport.request({
      carrier: "HMM",
      method: "POST",
      path: "/exact/path",
      query: { id: "1" },
      headers: { "x-csrf-token": "synthetic" },
    });
    await transport.request({
      carrier: "HMM",
      method: "POST",
      path: "/exact/path",
      query: { id: "2" },
      headers: { "x-csrf-token": "synthetic" },
    });
    expect(connect.mock.calls[1]?.[0].headers.cookie).toBe(
      "session=one; csrf=two",
    );
    expect(connect.mock.calls[1]?.[0].headers["x-csrf-token"]).toBe(
      "synthetic",
    );
  });
});
