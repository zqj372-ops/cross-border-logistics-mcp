import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_FREIGHTCOM_TEST_BASE_URL,
  FreightcomTestClientError,
  createFreightcomTestRateClient,
} from "../../src/logistics_mcp/adapters/quote/freightcom-test-client.ts";
import { freightcomRateRequestSchema } from "../../src/logistics_mcp/adapters/quote/freightcom-rate-adapter.ts";
import { PostalLookupError, createPostalLookup } from "./postal-lookup.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 56570;
const MAX_BODY_BYTES = 96 * 1024;
const REQUEST_HANDLE_TTL_MS = 15 * 60 * 1000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LOOPBACK_WORKBENCH_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const STATIC_ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/freight-class.mjs", ["freight-class.mjs", "text/javascript; charset=utf-8"]],
  ["/form-model.mjs", ["form-model.mjs", "text/javascript; charset=utf-8"]],
  ["/origin-presets.mjs", ["origin-presets.mjs", "text/javascript; charset=utf-8"]],
  ["/polling.mjs", ["polling.mjs", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function rateWriteBoundaryResponse(request, url) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  let originUrl;
  try {
    originUrl = origin === null ? null : new URL(origin);
  } catch {
    originUrl = null;
  }
  if (
    !LOOPBACK_WORKBENCH_HOSTS.has(url.hostname) ||
    originUrl === null ||
    originUrl.origin !== url.origin ||
    (fetchSite !== null && fetchSite !== "same-origin")
  ) {
    return json(403, {
      status: "blocked",
      code: "CROSS_ORIGIN_REQUEST_BLOCKED",
      message: "测试询价只接受本地页面发起的同源请求。",
    });
  }
  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return json(415, {
      status: "blocked",
      code: "JSON_CONTENT_TYPE_REQUIRED",
      message: "测试询价只接受 application/json 请求。",
    });
  }
  return null;
}

function sourceRefs(data) {
  return data.sourceRef === undefined ? [] : [data.sourceRef];
}

function errorResponse(error) {
  if (!(error instanceof FreightcomTestClientError)) {
    return json(503, {
      status: "unavailable",
      code: "FREIGHTCOM_TEST_UPSTREAM_UNAVAILABLE",
      message: "测试接口当前不可用。",
    });
  }
  if (error.code === "freightcom.test_request_invalid") {
    return json(422, {
      status: "needs_input",
      code: "FREIGHTCOM_TEST_REQUEST_INVALID",
      message: "LTL pallet 请求字段未通过校验。",
    });
  }
  if (error.code === "freightcom.test_auth_failed") {
    return json(502, {
      status: "unavailable",
      code: "FREIGHTCOM_TEST_AUTH_FAILED",
      message: "Freightcom 测试环境拒绝了服务端配置的认证。",
    });
  }
  if (error.code === "freightcom.test_request_rejected") {
    return json(422, {
      status: "needs_input",
      code: "FREIGHTCOM_TEST_REQUEST_REJECTED",
      message: "Freightcom 测试环境拒绝了询价字段，请核对地址、货物描述、重量、尺寸和货运等级。",
      upstream_status: error.status,
    });
  }
  if (error.code === "freightcom.test_poll_response_invalid") {
    return json(502, {
      status: "manual_review",
      code: "FREIGHTCOM_TEST_POLL_RESPONSE_INVALID",
      message: "测试接口返回结构未通过已验证 Schema，需要人工复核。",
    });
  }
  if (error.status === 400) {
    return json(400, {
      status: "blocked",
      code: "FREIGHTCOM_TEST_REQUEST_ID_INVALID",
      message: "请求标识无效。",
    });
  }
  return json(503, {
    status: "unavailable",
    code: "FREIGHTCOM_TEST_UPSTREAM_UNAVAILABLE",
    message: "测试接口当前不可用。",
  });
}

function validationResponse(parsed) {
  return json(422, {
    status: "needs_input",
    code: "FREIGHTCOM_TEST_REQUEST_INVALID",
    message: "请补齐 Freightcom 文档要求的 LTL pallet 字段。",
    errors: parsed.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    })),
  });
}

function postalLookupErrorResponse(error) {
  if (error instanceof PostalLookupError) {
    return json(error.status, {
      status: error.status === 422 ? "needs_input" : error.status === 404 ? "blocked" : "unavailable",
      code: error.code,
      message: error.message,
    });
  }
  return json(503, {
    status: "unavailable",
    code: "POSTAL_LOOKUP_UNAVAILABLE",
    message: "邮编自动识别服务暂时不可用。",
  });
}

function cleanupHandles(handles, now = Date.now()) {
  for (const [requestId, expiresAt] of handles.entries()) {
    if (expiresAt <= now) handles.delete(requestId);
  }
}

async function parseJsonBody(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
      throw new FreightcomTestClientError("freightcom.test_request_body_too_large", "Request body is too large.", 413);
    }
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new FreightcomTestClientError("freightcom.test_request_body_too_large", "Request body is too large.", 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FreightcomTestClientError("freightcom.test_request_invalid_json", "Request body is not valid JSON.", 400);
  }
}

export function createQuoteApiHandler(options) {
  const handles = options.requestHandles ?? new Map();
  const baseUrl = options.baseUrl;
  const client = options.client;
  const postalLookup = options.postalLookup ?? createPostalLookup();

  return async function quoteApiHandler(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    cleanupHandles(handles);

    if (path === "/api/postal-lookup") {
      if (request.method !== "GET") return json(405, { status: "blocked", code: "METHOD_NOT_ALLOWED" });
      try {
        const location = await postalLookup(url.searchParams.get("postal") ?? "");
        return json(200, { status: "success", data: location });
      } catch (error) {
        return postalLookupErrorResponse(error);
      }
    }

    if (path === "/api/freightcom-test/config") {
      if (request.method !== "GET") return json(405, { status: "blocked", code: "METHOD_NOT_ALLOWED" });
      const endpoint = new URL(baseUrl);
      return json(200, {
        status: "success",
        data: {
          environment: "test",
          endpoint: endpoint.origin,
          token_configured: options.tokenConfigured === true,
          display_currency: "USD",
          currency_policy: "cad-numeric-relabel-to-usd",
          conversion_applied: false,
          relabel_applied: true,
        },
      });
    }

    if (path === "/api/freightcom-test/rate") {
      if (request.method !== "POST") return json(405, { status: "blocked", code: "METHOD_NOT_ALLOWED" });
      const boundaryFailure = rateWriteBoundaryResponse(request, url);
      if (boundaryFailure !== null) return boundaryFailure;
      if (options.tokenConfigured !== true) {
        return json(503, {
          status: "unavailable",
          code: "FREIGHTCOM_TEST_TOKEN_NOT_CONFIGURED",
          message: "服务端尚未配置 FREIGHTCOM_TEST_API_TOKEN。",
        });
      }
      let body;
      try {
        body = await parseJsonBody(request);
      } catch (error) {
        return errorResponse(error);
      }
      const parsed = freightcomRateRequestSchema.safeParse(body);
      if (!parsed.success) return validationResponse(parsed);
      try {
        const accepted = await client.submitRate(parsed.data);
        handles.set(accepted.requestId, Date.now() + REQUEST_HANDLE_TTL_MS);
        return json(202, {
          status: "success",
          data: {
            environment: "test",
            request_id: accepted.requestId,
            poll_url: `/api/freightcom-test/rate/${encodeURIComponent(accepted.requestId)}`,
          },
        });
      } catch (error) {
        return errorResponse(error);
      }
    }

    const match = /^\/api\/freightcom-test\/rate\/([^/]+)$/u.exec(path);
    if (match !== null) {
      if (request.method !== "GET") return json(405, { status: "blocked", code: "METHOD_NOT_ALLOWED" });
      const requestId = decodeURIComponent(match[1]);
      if (!REQUEST_ID_PATTERN.test(requestId) || !handles.has(requestId)) {
        return json(404, {
          status: "blocked",
          code: "FREIGHTCOM_REQUEST_HANDLE_UNKNOWN",
          message: "请求标识未由当前测试页面签发或已过期。",
        });
      }
      try {
        const result = await client.pollRate(requestId);
        const done = result.status.done;
        return json(200, {
          status: done ? "manual_review" : "success",
          data: {
            environment: "test",
            request_id: requestId,
            status: result.status,
            rates: result.rates,
            retrieved_at: result.retrievedAt,
            source_refs: sourceRefs(result),
            display_currency: "USD",
            currency_policy: "cad-numeric-relabel-to-usd",
            conversion_applied: false,
            relabel_applied: true,
          },
          ...(done ? {
            warnings: [{
              code: "FREIGHTCOM_TEST_PROVIDER_RESULT",
              message: "这是 Freightcom 测试环境 provider 结果，不是已发布的正式 MCP 报价。",
              severity: "warning",
            }],
          } : {}),
        });
      } catch (error) {
        return errorResponse(error);
      }
    }

    return json(404, { status: "blocked", code: "ROUTE_NOT_FOUND" });
  };
}

async function staticResponse(pathname) {
  const asset = STATIC_ASSETS.get(pathname);
  if (asset === undefined) return null;
  const [filename, contentType] = asset;
  const filePath = resolve(MODULE_DIR, filename);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    const body = await readFile(filePath);
    return new Response(body, {
      status: 200,
      headers: {
        ...JSON_HEADERS,
        "content-type": contentType,
      },
    });
  } catch {
    return json(503, { status: "unavailable", code: "STATIC_ASSET_UNAVAILABLE" });
  }
}

async function nodeRequest(request, body) {
  const protocol = "http";
  const host = request.headers.host ?? "127.0.0.1";
  return new Request(`${protocol}://${host}${request.url ?? "/"}`, {
    method: request.method ?? "GET",
    headers: request.headers,
    ...(body === undefined ? {} : { body, duplex: "half" }),
  });
}

async function readIncomingBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(value);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function writeResponse(response, nodeResponse) {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, name) => nodeResponse.setHeader(name, value));
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
}

function testEndpointConfig() {
  const baseUrl = (process.env.FREIGHTCOM_TEST_API_BASE_URL ?? DEFAULT_FREIGHTCOM_TEST_BASE_URL).trim();
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname !== new URL(DEFAULT_FREIGHTCOM_TEST_BASE_URL).hostname
  ) {
    throw new Error("FREIGHTCOM_TEST_API_BASE_URL must be the Freightcom test HTTPS host.");
  }
  return {
    baseUrl: parsed.toString().replace(/\/$/u, ""),
    allowedHosts: [parsed.hostname],
  };
}

export function createQuoteServer(options = {}) {
  const endpoint = options.endpoint ?? testEndpointConfig();
  const token = options.token ?? (process.env.FREIGHTCOM_TEST_API_TOKEN ?? "").trim();
  const tokenConfigured = token.length > 0;
  const client = options.client ?? (tokenConfigured
    ? createFreightcomTestRateClient({
        baseUrl: endpoint.baseUrl,
        allowedHosts: endpoint.allowedHosts,
        token,
      })
    : {
        submitRate: async () => { throw new FreightcomTestClientError("freightcom.test_token_missing", "Token is not configured."); },
        pollRate: async () => { throw new FreightcomTestClientError("freightcom.test_token_missing", "Token is not configured."); },
      });
  const apiHandler = createQuoteApiHandler({
    client,
    tokenConfigured,
    baseUrl: endpoint.baseUrl,
    ...(options.requestHandles === undefined ? {} : { requestHandles: options.requestHandles }),
    ...(options.postalLookup === undefined ? {} : { postalLookup: options.postalLookup }),
  });
  const port = options.port ?? Number.parseInt(process.env.FREIGHTCOM_QUOTE_PORT ?? String(DEFAULT_PORT), 10);
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? "/").split("?", 1)[0];
      if (path.startsWith("/api/")) {
        let body;
        try {
          body = request.method === "GET" || request.method === "HEAD" ? undefined : await readIncomingBody(request);
        } catch {
          await writeResponse(json(413, { status: "blocked", code: "REQUEST_BODY_TOO_LARGE" }), response);
          return;
        }
        await writeResponse(await apiHandler(await nodeRequest(request, body)), response);
        return;
      }
      const asset = await staticResponse(path);
      await writeResponse(asset ?? json(404, { status: "blocked", code: "ROUTE_NOT_FOUND" }), response);
    })().catch(() => {
      if (!response.headersSent) response.end();
    });
  });
  return { server, port, host, endpoint: endpoint.baseUrl, tokenConfigured };
}

export function startQuoteServer(options = {}) {
  const runtime = createQuoteServer(options);
  runtime.server.listen(runtime.port, runtime.host);
  return runtime;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const runtime = startQuoteServer();
  runtime.server.once("listening", () => {
    console.log(`Freightcom test quote workbench: http://${runtime.host}:${runtime.port}/`);
    console.log(`Freightcom test endpoint: ${new URL(runtime.endpoint).origin}`);
    console.log(`Freightcom test token configured: ${runtime.tokenConfigured ? "yes" : "no"}`);
  });
  const shutdown = () => runtime.server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
