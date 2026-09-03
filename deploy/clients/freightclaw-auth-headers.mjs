#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FREIGHTCLAW_SCHEMA_VERSION = "2026-08-27.v1";
export const FREIGHTCLAW_EXCHANGE_URL = "https://www.freightclaw.net/access/v1/token/exchange";
export const FREIGHTCLAW_ORIGIN = "https://www.freightclaw.net";
export const FREIGHTCLAW_T0_TOOLS = Object.freeze([
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
]);

const DEFAULT_ACCOUNT = "JHT LOGISTICS CO., LTD.";
const DEFAULT_SERVICE = "freightclaw-mcp-client-v1";
const API_KEY_PATTERN = /^lmcpk_[A-Za-z0-9._:-]+_[A-Za-z0-9_-]{43}$/u;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{8,128}$/u;
const SESSION_REF_PATTERN = /^auth_[A-Za-z0-9_-]{8,128}$/u;
const REQUEST_TIMEOUT_MS = 15_000;
const KEYCHAIN_TIMEOUT_MS = 10_000;

export class FreightClawAuthorizationError extends Error {
  constructor(code) {
    super(`FreightClaw authorization failed (${code}).`);
    this.name = "FreightClawAuthorizationError";
    this.code = code;
  }
}

function exactCatalog(actual, expected) {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== "string")) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function defaultRequestId() {
  return `req_codex_${randomUUID().replaceAll("-", "")}`;
}

function defaultKeychainHelperPath() {
  return fileURLToPath(new URL("./freightclaw-keychain-helper", import.meta.url));
}

export async function readKeychainCredential(options = {}) {
  try {
    const result = await execFileAsync(
      options.helperPath ?? defaultKeychainHelperPath(),
      ["read", options.account ?? DEFAULT_ACCOUNT, options.service ?? DEFAULT_SERVICE],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        timeout: options.timeoutMs ?? KEYCHAIN_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const credential = result.stdout.trim();
    if (!API_KEY_PATTERN.test(credential)) {
      throw new FreightClawAuthorizationError("credential_invalid");
    }
    return credential;
  } catch (error) {
    if (error instanceof FreightClawAuthorizationError) throw error;
    throw new FreightClawAuthorizationError("credential_unavailable");
  }
}

export async function exchangeCredential(options) {
  const apiKey = options?.apiKey ?? "";
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new FreightClawAuthorizationError("credential_invalid");
  }

  const requestId = (options.requestIdFactory ?? defaultRequestId)();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new FreightClawAuthorizationError("request_id_invalid");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await (options.fetchImpl ?? fetch)(FREIGHTCLAW_EXCHANGE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `ApiKey ${apiKey}`,
        "Content-Type": "application/json",
        Origin: FREIGHTCLAW_ORIGIN,
        "X-Request-Id": requestId,
      },
      body: JSON.stringify({
        schema_version: FREIGHTCLAW_SCHEMA_VERSION,
        requested_tool_names: FREIGHTCLAW_T0_TOOLS,
      }),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new FreightClawAuthorizationError("exchange_unavailable");
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new FreightClawAuthorizationError("authentication_failed");
  }
  if (response.status === 429) {
    throw new FreightClawAuthorizationError("rate_limited");
  }
  if (!response.ok) {
    throw new FreightClawAuthorizationError("exchange_unavailable");
  }
  if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new FreightClawAuthorizationError("exchange_contract_invalid");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new FreightClawAuthorizationError("exchange_contract_invalid");
  }
  const data = payload?.data;
  if (
    payload?.schema_version !== FREIGHTCLAW_SCHEMA_VERSION
    || payload?.status !== "success"
    || !Array.isArray(payload?.warnings)
    || payload.warnings.length !== 0
    || !Array.isArray(payload?.blockers)
    || payload.blockers.length !== 0
    || typeof data?.access_token !== "string"
    || !JWT_PATTERN.test(data.access_token)
    || data.token_type !== "Bearer"
    || !Number.isSafeInteger(data.expires_in)
    || data.expires_in < 60
    || data.expires_in > 900
    || !exactCatalog(data.tool_names, FREIGHTCLAW_T0_TOOLS)
    || typeof data.session_ref !== "string"
    || !SESSION_REF_PATTERN.test(data.session_ref)
    || data.request_id !== requestId
  ) {
    throw new FreightClawAuthorizationError("exchange_contract_invalid");
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    requestId: data.request_id,
    sessionRef: data.session_ref,
    toolNames: [...data.tool_names],
  };
}

export async function createCodexAuthorizationHeaders(options = {}) {
  const credential = await (options.readCredential ?? readKeychainCredential)();
  const exchange = await exchangeCredential({
    apiKey: credential,
    fetchImpl: options.fetchImpl,
    requestIdFactory: options.requestIdFactory,
    timeoutMs: options.timeoutMs,
  });
  return { Authorization: `Bearer ${exchange.accessToken}` };
}

function isMainModule() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  try {
    const headers = await createCodexAuthorizationHeaders();
    process.stdout.write(`${JSON.stringify(headers)}\n`);
  } catch (error) {
    const code = error instanceof FreightClawAuthorizationError
      ? error.code
      : "authorization_unavailable";
    process.stderr.write(`FreightClaw authorization unavailable (${code}).\n`);
    process.exitCode = 1;
  }
}
