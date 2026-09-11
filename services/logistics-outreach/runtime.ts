import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { FetchImplementation } from "../../src/logistics_mcp/adapters/http-client.js";
import { OutreachService } from "./service.js";
import { OutreachError, type OutreachPorts } from "./types.js";
import { createHttpCapturePort, HttpCaptureCollector } from "./providers/http-capture.js";
import { createHttpMailPort } from "./providers/http-mail.js";
import { createOpenAiCompatibleGenerator } from "./providers/openai-model.js";

export interface OutreachRuntimeDependencies {
  readonly sender: OutreachPorts["sender"];
  readonly sendEnabled: OutreachPorts["sendEnabled"];
  readonly mayDispatch: OutreachPorts["mayDispatch"];
  readonly contactReview: OutreachPorts["contactReview"];
  readonly draftApproval: OutreachPorts["draftApproval"];
  readonly now?: () => number;
  readonly fetchImpl?: FetchImplementation;
  readonly readSecretFile?: (path: string) => string;
}

export interface OutreachRuntime {
  readonly service: OutreachService;
  readonly collector: HttpCaptureCollector;
  readonly ports: OutreachPorts;
  close(): void;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new OutreachError("runtime_config_invalid");
  return value;
}

function allowedHost(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name).toLowerCase().replace(/\.$/u, "");
  if (value.includes(",") || value.includes("/") || value.includes(":")) throw new OutreachError("runtime_config_invalid");
  return value;
}

function httpsBaseUrl(environment: NodeJS.ProcessEnv, name: string, host: string): string {
  const raw = required(environment, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutreachError("runtime_config_invalid");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || url.hostname.toLowerCase().replace(/\.$/u, "") !== host
  ) {
    throw new OutreachError("runtime_config_invalid");
  }
  return raw;
}

function readPrivateSecret(path: string): string {
  if (!isAbsolute(path)) throw new OutreachError("runtime_secret_invalid");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > 8192 || (stat.mode & 0o077) !== 0) {
      throw new OutreachError("runtime_secret_invalid");
    }
    const buffer = Buffer.alloc(8193);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead < 1 || bytesRead > 8192) throw new OutreachError("runtime_secret_invalid");
    const value = buffer.subarray(0, bytesRead).toString("utf8").trim();
    if (value.length < 16) throw new OutreachError("runtime_secret_invalid");
    return value;
  } catch (error: unknown) {
    if (error instanceof OutreachError) throw error;
    throw new OutreachError("runtime_secret_invalid");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new OutreachError("runtime_config_invalid");
  return value;
}

export function createOutreachRuntimeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: OutreachRuntimeDependencies,
): OutreachRuntime | undefined {
  if (environment.MCP_OUTREACH_ENABLED?.trim().toLowerCase() !== "true") return undefined;

  const statePath = required(environment, "MCP_OUTREACH_STATE_DB_PATH");
  if (!isAbsolute(statePath)) throw new OutreachError("runtime_config_invalid");
  const readSecretFile = dependencies.readSecretFile ?? readPrivateSecret;
  let previewKeyValue: string;
  let captureToken: string;
  let modelToken: string;
  let mailToken: string;
  try {
    previewKeyValue = readSecretFile(required(environment, "MCP_OUTREACH_PREVIEW_KEY_FILE"));
    captureToken = readSecretFile(required(environment, "MCP_OUTREACH_CAPTURE_TOKEN_FILE"));
    modelToken = readSecretFile(required(environment, "MCP_OUTREACH_MODEL_API_KEY_FILE"));
    mailToken = readSecretFile(required(environment, "MCP_OUTREACH_MAIL_TOKEN_FILE"));
  } catch (error: unknown) {
    if (error instanceof OutreachError) throw error;
    throw new OutreachError("runtime_secret_invalid");
  }
  const previewKey = Buffer.byteLength(previewKeyValue, "utf8") >= 32 ? Buffer.from(previewKeyValue, "utf8") : null;
  if (previewKey === null) throw new OutreachError("runtime_secret_invalid");

  const captureHost = allowedHost(environment, "MCP_OUTREACH_CAPTURE_ALLOWED_HOST");
  const modelHost = allowedHost(environment, "MCP_OUTREACH_MODEL_ALLOWED_HOST");
  const mailHost = allowedHost(environment, "MCP_OUTREACH_MAIL_ALLOWED_HOST");
  const timeoutMs = positiveInteger(environment, "MCP_OUTREACH_PROVIDER_TIMEOUT_MS", 15_000);
  const common = {
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    timeoutMs,
  };
  const captureOptions = {
    ...common,
    baseUrl: httpsBaseUrl(environment, "MCP_OUTREACH_CAPTURE_BASE_URL", captureHost),
    allowedHosts: [captureHost],
    token: captureToken,
  };
  const modelOptions = {
    ...common,
    baseUrl: httpsBaseUrl(environment, "MCP_OUTREACH_MODEL_BASE_URL", modelHost),
    allowedHosts: [modelHost],
    token: modelToken,
  };
  const mailOptions = {
    ...common,
    baseUrl: httpsBaseUrl(environment, "MCP_OUTREACH_MAIL_BASE_URL", mailHost),
    allowedHosts: [mailHost],
    token: mailToken,
  };
  const capture = createHttpCapturePort(captureOptions);
  const ports: OutreachPorts = {
    previewKey,
    now: dependencies.now ?? Date.now,
    capture,
    sender: dependencies.sender,
    sendEnabled: dependencies.sendEnabled,
    mayDispatch: dependencies.mayDispatch,
    contactReview: dependencies.contactReview,
    draftApproval: dependencies.draftApproval,
    generate: createOpenAiCompatibleGenerator({
      ...modelOptions,
      model: required(environment, "MCP_OUTREACH_MODEL_NAME"),
    }),
    mail: createHttpMailPort(mailOptions),
  };
  const collector = new HttpCaptureCollector(captureOptions);
  const service = new OutreachService(statePath, ports);
  return {
    service,
    collector,
    ports,
    close() { service.close(); },
  };
}
