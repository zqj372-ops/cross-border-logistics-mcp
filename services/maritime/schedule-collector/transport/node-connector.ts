import { lookup } from "node:dns/promises";
import {
  request as httpsRequest,
  type RequestOptions,
} from "node:https";
import { isIP, type LookupFunction } from "node:net";

import { CollectorRuntimeError } from "../errors";
import type {
  TrustedConnector,
  TrustedConnectorRequest,
  TrustedConnectorResponse,
} from "./http";

function privateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) {
    return true;
  }
  const [a = -1, b = -1] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !privateIpv4(address);
  return false;
}

export interface DnsAddressRecord {
  readonly address: string;
  readonly family: number;
}

export function selectPublicIpv4Address(
  records: readonly DnsAddressRecord[],
): { readonly address: string; readonly family: 4 } {
  const ipv4Records = records.filter((record) => record.family === 4);
  if (ipv4Records.length === 0) {
    throw new CollectorRuntimeError(
      "access_restricted",
      "blocked",
      "collector_dns_no_ipv4_address",
    );
  }
  if (ipv4Records.some((record) => !isPublicAddress(record.address))) {
    throw new CollectorRuntimeError(
      "access_restricted",
      "blocked",
      "collector_dns_private_address_rejected",
    );
  }
  const selected = ipv4Records[0];
  if (selected === undefined) {
    throw new CollectorRuntimeError(
      "access_restricted",
      "blocked",
      "collector_dns_no_ipv4_address",
    );
  }
  return { address: selected.address, family: 4 };
}

async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new CollectorRuntimeError(
      "timeout",
      "unavailable",
      "collector_aborted",
    );
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        new CollectorRuntimeError(
          "timeout",
          "unavailable",
          "collector_aborted",
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(
          error instanceof Error ? error : new Error("collector_connector_failed"),
        );
      },
    );
  });
}

async function resolvePublicAddress(
  hostname: string,
  signal: AbortSignal,
): Promise<{ readonly address: string; readonly family: 4 }> {
  const records = await withAbort(
    lookup(hostname, { all: true, verbatim: true, family: 4 }),
    signal,
  );
  return selectPublicIpv4Address(records);
}

function responseHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      if (value === undefined) return [];
      return [[name, Array.isArray(value) ? value.join(", ") : value]];
    }),
  );
}

export interface NodePinnedConnectorOptions {
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
}

export function createNodePinnedConnector(
  options: NodePinnedConnectorOptions,
): TrustedConnector {
  return {
    async connect(input: TrustedConnectorRequest): Promise<TrustedConnectorResponse> {
      const url = new URL(input.url);
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.port !== "" && url.port !== "443" ||
        isIP(url.hostname) !== 0
      ) {
        throw new CollectorRuntimeError(
          "access_restricted",
          "blocked",
          "collector_connector_url_rejected",
        );
      }
      const resolved = await resolvePublicAddress(url.hostname, input.signal);
      if (input.signal.aborted) {
        throw new CollectorRuntimeError(
          "timeout",
          "unavailable",
          "collector_aborted",
        );
      }
      return await new Promise<TrustedConnectorResponse>((resolve, reject) => {
        const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
          const record = {
            address: resolved.address,
            family: resolved.family,
          };
          if (lookupOptions.all) callback(null, [record]);
          else callback(null, record.address, record.family);
        };
        const requestOptions = {
            protocol: "https:",
            hostname: url.hostname,
            servername: url.hostname,
            port: 443,
            path: `${url.pathname}${url.search}`,
            method: input.method,
            headers: {
              ...input.headers,
              host: url.hostname,
            },
            agent: false,
            family: 4,
            autoSelectFamily: false,
            rejectUnauthorized: true,
            lookup: pinnedLookup,
          } as RequestOptions & { readonly autoSelectFamily: false };
        const request = httpsRequest(
          requestOptions,
          (response) => {
            const contentEncoding = response.headers["content-encoding"];
            if (
              contentEncoding !== undefined &&
              contentEncoding.toLocaleLowerCase() !== "identity"
            ) {
              request.destroy(
                new CollectorRuntimeError(
                  "schema_changed",
                  "unavailable",
                  "collector_content_encoding_unsupported",
                ),
              );
              return;
            }
            const chunks: Uint8Array[] = [];
            let total = 0;
            response.on("data", (chunk: Buffer) => {
              total += chunk.byteLength;
              if (total > options.maxResponseBytes) {
                request.destroy(
                  new CollectorRuntimeError(
                    "incomplete_results",
                    "unavailable",
                    "collector_response_too_large",
                  ),
                );
                return;
              }
              chunks.push(Uint8Array.from(chunk));
            });
            response.on("error", reject);
            response.on("end", () => {
              const body = new Uint8Array(total);
              let offset = 0;
              for (const chunk of chunks) {
                body.set(chunk, offset);
                offset += chunk.byteLength;
              }
              resolve({
                status: response.statusCode ?? 0,
                url: `${url.origin}${url.pathname}${url.search}`,
                headers: responseHeaders(response.headers),
                body,
              });
            });
          },
        );
        const onAbort = (): void => {
          request.destroy(
            new CollectorRuntimeError(
              "timeout",
              "unavailable",
              "collector_aborted",
            ),
          );
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
        request.setTimeout(options.timeoutMs, () => {
          request.destroy(
            new CollectorRuntimeError(
              "timeout",
              "unavailable",
              "collector_timeout",
            ),
          );
        });
        request.on("error", (error) => {
          input.signal.removeEventListener("abort", onAbort);
          reject(
            error instanceof CollectorRuntimeError
              ? error
              : new CollectorRuntimeError(
                  "access_restricted",
                  "unavailable",
                  "collector_connection_failed",
                ),
          );
        });
        request.on("close", () => {
          input.signal.removeEventListener("abort", onAbort);
        });
        if (input.body !== null) request.write(input.body);
        request.end();
      });
    },
  };
}
