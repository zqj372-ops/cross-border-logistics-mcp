import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  exchangeCredential,
  FREIGHTCLAW_ORIGIN,
  FREIGHTCLAW_T0_TOOLS,
} from "./freightclaw-auth-headers.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 56_572;
const MAX_BODY_BYTES = 8 * 1024;
const OPERATION_TIMEOUT_MS = 30_000;
const MCP_URL = "https://www.freightclaw.net/mcp";
const API_KEY_PATTERN = /^lmcpk_[A-Za-z0-9._:-]+_[A-Za-z0-9_-]{43}$/u;
const MANAGED_START = "# >>> FreightClaw managed MCP >>>";
const MANAGED_END = "# <<< FreightClaw managed MCP <<<";
const KEYCHAIN_ACCOUNT = "JHT LOGISTICS CO., LTD.";
const KEYCHAIN_SERVICE = "freightclaw-mcp-client-v1";
const T0_RESOURCES = Object.freeze([
  "logistics://agent/bootstrap",
  "logistics://agent/profiles",
  "logistics://contracts/envelope/current",
  "logistics://modules/catalog",
  "logistics://standards/index",
]);

export class FreightClawSetupError extends Error {
  constructor(code) {
    super(`FreightClaw Codex setup failed (${code}).`);
    this.name = "FreightClawSetupError";
    this.code = code;
  }
}

function exactCatalog(actual, expected) {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== "string")) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function tomlString(value) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new FreightClawSetupError("helper_path_invalid");
  }
  return JSON.stringify(value);
}

export function renderManagedCodexBlock(helperPath) {
  return `${MANAGED_START}
[mcp_servers.freightclaw]
url = "${MCP_URL}"
http_headers_helper = ${tomlString(helperPath)}
enabled = true
required = true
startup_timeout_sec = 30
tool_timeout_sec = 60
enabled_tools = [
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
]
${MANAGED_END}`;
}

function managedRange(content) {
  const start = content.indexOf(MANAGED_START);
  const end = content.indexOf(MANAGED_END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new FreightClawSetupError("codex_config_conflict");
  }
  if (start === -1) return null;
  const duplicateStart = content.indexOf(MANAGED_START, start + MANAGED_START.length);
  const duplicateEnd = content.indexOf(MANAGED_END, end + MANAGED_END.length);
  if (duplicateStart !== -1 || duplicateEnd !== -1) {
    throw new FreightClawSetupError("codex_config_conflict");
  }
  return { start, end: end + MANAGED_END.length };
}

export function upsertManagedCodexConfig(content, helperPath) {
  if (typeof content !== "string") throw new FreightClawSetupError("codex_config_invalid");
  const block = renderManagedCodexBlock(helperPath);
  const range = managedRange(content);
  const unmanagedContent = range === null
    ? content
    : `${content.slice(0, range.start)}${content.slice(range.end)}`;
  if (/^\s*\[mcp_servers\.freightclaw\]\s*$/mu.test(unmanagedContent)) {
    throw new FreightClawSetupError("codex_config_conflict");
  }
  if (range !== null) {
    return `${content.slice(0, range.start)}${block}${content.slice(range.end)}`;
  }
  if (content.length === 0) return `${block}\n`;
  const separator = content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${block}\n`;
}

function parseMcpPayload(body, contentType) {
  try {
    if (contentType.includes("text/event-stream")) {
      const values = body
        .split(/\r?\n\r?\n/u)
        .map((event) => event
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n"))
        .filter((value) => value.length > 0 && value !== "[DONE]")
        .map((value) => JSON.parse(value));
      const payload = values.at(-1);
      if (payload === undefined) throw new Error("missing event");
      return payload;
    }
    return JSON.parse(body);
  } catch {
    throw new FreightClawSetupError("mcp_response_invalid");
  }
}

async function mcpPost(accessToken, connection, request, responseExpected = true, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? OPERATION_TIMEOUT_MS);
  let response;
  try {
    response = await (options.fetchImpl ?? fetch)(MCP_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Origin: FREIGHTCLAW_ORIGIN,
        ...(connection.sessionId.length === 0
          ? {}
          : { "Mcp-Session-Id": connection.sessionId }),
      },
      body: JSON.stringify(request),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new FreightClawSetupError("mcp_unavailable");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new FreightClawSetupError(`mcp_http_${response.status}`);
  connection.sessionId = response.headers.get("mcp-session-id") ?? connection.sessionId;
  if (!responseExpected) return null;
  const payload = parseMcpPayload(
    await response.text(),
    (response.headers.get("content-type") ?? "").toLowerCase(),
  );
  if (payload?.error !== undefined || payload?.result === undefined) {
    throw new FreightClawSetupError("mcp_rpc_failed");
  }
  return payload.result;
}

async function closeMcpSession(accessToken, sessionId, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? OPERATION_TIMEOUT_MS);
  try {
    await (options.fetchImpl ?? fetch)(MCP_URL, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Mcp-Session-Id": sessionId,
        Origin: FREIGHTCLAW_ORIGIN,
      },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    // Session cleanup is best-effort and cannot change a completed exact readback.
  } finally {
    clearTimeout(timer);
  }
}

function cargoReadbackArguments() {
  return {
    schema_version: "2026-08-11.v1",
    version: "cargo.calculate@codex-setup-v1",
    cargo_lines: [{
      version: "cargo-line@codex-setup-v1",
      line_id: "line_codex_setup_1",
      description: "synthetic carton",
      quantity: 2,
      quantity_unit: "carton",
      package_type: "carton",
      unit_weight: { value: "12.5", unit: "kg" },
      dimensions: [{
        length: { value: "60", unit: "cm" },
        width: { value: "50", unit: "cm" },
        height: { value: "40", unit: "cm" },
        quantity: 2,
      }],
      stackable: true,
      fragile: false,
      sensitive: false,
      source_ref_ids: ["src_codex_setup_input_1"],
    }],
    dimensional_divisor: null,
    bubble_rule: {
      channel: "CAQ-HP",
      mode: "full",
      ratio: null,
      rule_version: "CAQ-HP@codex-setup-v1",
      source_ref_ids: ["src_codex_setup_rule_1"],
      density: { value: "1000", unit: "kg_per_cbm" },
      unit: "kg",
      rounding: { mode: "none", decimals: 6 },
    },
    channel_code: "CAQ-HP",
    source_refs: [
      {
        source_id: "src_codex_setup_input_1",
        source_type: "fixture",
        system: "codex-setup",
        locator: "fixture://codex-setup/cargo/input",
        version: "codex-setup-v1",
        retrieved_at: "2026-09-03T00:00:00Z",
        authority: "user_provided",
        content_hash: "sha256:codexsetupcargoinput000001",
      },
      {
        source_id: "src_codex_setup_rule_1",
        source_type: "fixture",
        system: "codex-setup",
        locator: "fixture://codex-setup/cargo/rule",
        version: "CAQ-HP@codex-setup-v1",
        retrieved_at: "2026-09-03T00:00:00Z",
        authority: "authoritative",
        content_hash: "sha256:codexsetupcargorule0000001",
      },
    ],
  };
}

function containerReadbackArguments() {
  return {
    schema_version: "2026-08-11.v1",
    version: "container-profile@codex-setup-v1",
    plan_id: "plan_codex_setup_1",
    container_type: "40HQ",
    physical_capacity: { value: "76", unit: "cbm" },
    operational_target: { value: "75", unit: "cbm" },
    max_payload: { value: "26000", unit: "kg" },
    source_ref_ids: ["src:container:codex-setup"],
    cargo_metrics: {
      version: "cargo-metrics@codex-setup-v1",
      line_count: 1,
      total_quantity: 2,
      total_volume: { value: "60", unit: "cbm" },
      actual_weight: { value: "18000", unit: "kg" },
      volumetric_weight: { value: "60000", unit: "kg" },
      weight_evidence: "line_total_weight",
      derived_from_line_ids: ["line_codex_setup_1"],
    },
    loading_constraints: {
      sensitive_at_head: true,
      declaration_at_tail: true,
      fifo_for_other: true,
      customer_priority: null,
    },
    loading_lines: [{
      line_id: "line_codex_setup_1",
      sensitive: false,
      customer_priority: null,
      declaration_required: false,
    }],
  };
}

function toolReadbackArguments(toolName) {
  if (toolName === "cargo.calculate") return cargoReadbackArguments();
  if (toolName === "container.plan_summary") return containerReadbackArguments();
  return { profile_id: "runtime-caller", module_id: "cargo" };
}

export async function verifyFreightClawReadback(apiKey, options = {}) {
  const exchange = await exchangeCredential({
    apiKey,
    fetchImpl: options.fetchImpl,
    requestIdFactory: options.requestIdFactory,
    timeoutMs: options.timeoutMs,
  });
  const connection = { sessionId: "" };
  let transportMode = "stateless";
  try {
    await mcpPost(exchange.accessToken, connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "freightclaw-codex-setup", version: "1.0.0" },
      },
    }, true, options);
    transportMode = connection.sessionId.length === 0 ? "stateless" : "stateful";
    if (transportMode === "stateful") {
      await mcpPost(exchange.accessToken, connection, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }, false, options);
    }

    const resourceCatalog = await mcpPost(exchange.accessToken, connection, {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/list",
      params: {},
    }, true, options);
    const resourceUris = resourceCatalog?.resources?.map((resource) => resource?.uri);
    if (!exactCatalog(resourceUris, T0_RESOURCES)) {
      throw new FreightClawSetupError("resource_catalog_mismatch");
    }
    for (const [index, uri] of T0_RESOURCES.entries()) {
      const result = await mcpPost(exchange.accessToken, connection, {
        jsonrpc: "2.0",
        id: 10 + index,
        method: "resources/read",
        params: { uri },
      }, true, options);
      if (!Array.isArray(result?.contents) || result.contents.length === 0) {
        throw new FreightClawSetupError("resource_readback_invalid");
      }
      const hasContent = result.contents.some((entry) =>
        (typeof entry?.text === "string" && entry.text.length > 0)
        || (typeof entry?.blob === "string" && entry.blob.length > 0));
      if (!hasContent) throw new FreightClawSetupError("resource_readback_invalid");
    }

    const toolCatalog = await mcpPost(exchange.accessToken, connection, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    }, true, options);
    const toolNames = toolCatalog?.tools?.map((tool) => tool?.name);
    if (!exactCatalog(toolNames, FREIGHTCLAW_T0_TOOLS)) {
      throw new FreightClawSetupError("tool_catalog_mismatch");
    }
    for (const [index, name] of FREIGHTCLAW_T0_TOOLS.entries()) {
      const result = await mcpPost(exchange.accessToken, connection, {
        jsonrpc: "2.0",
        id: 20 + index,
        method: "tools/call",
        params: { name, arguments: toolReadbackArguments(name) },
      }, true, options);
      if (result?.structuredContent?.status !== "success") {
        throw new FreightClawSetupError("tool_readback_not_success");
      }
    }
    return {
      toolCount: FREIGHTCLAW_T0_TOOLS.length,
      resourceCount: T0_RESOURCES.length,
      transportMode,
    };
  } finally {
    if (connection.sessionId.length > 0) {
      await closeMcpSession(exchange.accessToken, connection.sessionId, options);
    }
  }
}

function setupPaths(options = {}) {
  const codexDirectory = options.codexDirectory ?? resolve(homedir(), ".codex");
  const installDirectory = options.installDirectory ?? resolve(codexDirectory, "freightclaw");
  return {
    installDirectory,
    configPath: options.configPath ?? resolve(codexDirectory, "config.toml"),
    helperPath: resolve(installDirectory, "freightclaw-auth-headers.mjs"),
    keychainHelperPath: resolve(installDirectory, "freightclaw-keychain-helper"),
  };
}

function sourcePath(name) {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

async function installLocalHelpers(paths) {
  await mkdir(paths.installDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.installDirectory, 0o700);
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const helperTemporary = `${paths.helperPath}.${suffix}`;
  const keychainTemporary = `${paths.keychainHelperPath}.${suffix}`;
  let compileFailed = false;
  try {
    if (/\s/u.test(process.execPath)) throw new Error("node path cannot be used in a shebang");
    const helperSource = await readFile(sourcePath("freightclaw-auth-headers.mjs"), "utf8");
    const executableSource = helperSource.replace(/^#![^\n]*\n/u, `#!${process.execPath}\n`);
    if (executableSource === helperSource) throw new Error("helper shebang is missing");
    await writeFile(helperTemporary, executableSource, { encoding: "utf8", mode: 0o700 });
    await chmod(helperTemporary, 0o700);
    try {
      await execFileAsync(
        "/usr/bin/xcrun",
        ["swiftc", sourcePath("freightclaw-keychain-helper.swift"), "-o", keychainTemporary],
        { timeout: OPERATION_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      );
    } catch {
      compileFailed = true;
      throw new Error("keychain helper compilation failed");
    }
    await chmod(keychainTemporary, 0o700);
    await rename(helperTemporary, paths.helperPath);
    await rename(keychainTemporary, paths.keychainHelperPath);
  } catch {
    await Promise.all([
      unlink(helperTemporary).catch(() => undefined),
      unlink(keychainTemporary).catch(() => undefined),
    ]);
    throw new FreightClawSetupError(
      compileFailed ? "keychain_helper_build_failed" : "helper_install_failed",
    );
  }
}

async function storeKeychainCredential(apiKey, helperPath) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      helperPath,
      ["store", KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE],
      { shell: false, stdio: ["pipe", "ignore", "ignore"] },
    );
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new FreightClawSetupError("keychain_update_timeout"));
    }, OPERATION_TIMEOUT_MS);
    child.once("error", () => finish(new FreightClawSetupError("keychain_update_failed")));
    child.once("close", (code) => finish(
      code === 0 ? undefined : new FreightClawSetupError("keychain_update_failed"),
    ));
    child.stdin.on("error", () => undefined);
    child.stdin.end(apiKey);
  });
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw new FreightClawSetupError("codex_config_unavailable");
  }
}

async function writeConfigAtomically(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.freightclaw-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new FreightClawSetupError("codex_config_write_failed");
  }
}

export async function completeCodexSetup(apiKey, options = {}) {
  if (!API_KEY_PATTERN.test(apiKey)) throw new FreightClawSetupError("api_key_format_invalid");
  const paths = setupPaths(options);
  const currentConfig = await readOptionalFile(paths.configPath);
  const nextConfig = upsertManagedCodexConfig(currentConfig, paths.helperPath);

  const readback = await verifyFreightClawReadback(apiKey, options);
  await installLocalHelpers(paths);
  await storeKeychainCredential(apiKey, paths.keychainHelperPath);
  await writeConfigAtomically(paths.configPath, nextConfig);
  return readback;
}

function securityHeaders(response) {
  response.setHeader("cache-control", "no-store, max-age=0");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function html(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  securityHeaders(response);
  response.end(body);
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  securityHeaders(response);
  response.end(JSON.stringify(body));
}

function loopbackRequestOrigin(request) {
  const host = request.headers.host ?? "";
  try {
    const parsed = new URL(`http://${host}`);
    if (
      parsed.hostname !== "127.0.0.1"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function requestSecurityFailure(request) {
  const expectedOrigin = loopbackRequestOrigin(request);
  if (expectedOrigin === null) return "host_rejected";
  const suppliedOrigin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  if (
    (suppliedOrigin !== undefined && suppliedOrigin !== expectedOrigin)
    || (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none")
    || (request.method === "POST" && suppliedOrigin !== expectedOrigin)
  ) return "origin_rejected";
  return null;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new FreightClawSetupError("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function setupPage(nonce, result = null, errorCode = "") {
  const resultPanel = result === null
    ? ""
    : `<section class="result" role="status"><strong>接入完成</strong><p>已验证 ${result.toolCount} tools / ${result.resourceCount} resources · ${result.transportMode}</p><p>长期 Key 已进入 macOS Keychain，Codex 配置已写入。重启 Codex 后即可调用。</p></section>`;
  const errorPanel = errorCode.length === 0
    ? ""
    : `<section class="error" role="alert"><strong>尚未完成</strong><p>${setupErrorMessage(errorCode)}</p><p>诊断标识：${errorCode}</p></section>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>FreightClaw × Codex 接入</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#eef2f3;color:#102a32;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(620px,calc(100% - 32px));margin:64px auto;background:#fff;border:1px solid #d7e0e2;padding:32px;box-shadow:0 18px 52px rgba(16,42,50,.1)}.eyebrow{color:#dc5d27;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}h1{font-size:27px;line-height:1.2;margin:7px 0 12px}p{color:#526970;margin:0 0 18px}ol{padding-left:21px;color:#304b53}label{display:block;font-weight:700;margin:22px 0 7px}input{width:100%;height:46px;border:1px solid #aebdc1;padding:0 12px;font:inherit}input:focus{outline:3px solid rgba(233,103,43,.2);border-color:#e9672b}button{width:100%;height:46px;margin-top:16px;border:0;background:#0b5563;color:#fff;font:inherit;font-weight:800;cursor:pointer}.note{font-size:13px;margin-top:15px}.result,.error{margin:20px 0;padding:16px;border-left:4px solid #27835a;background:#edf8f2}.error{border-color:#b53d35;background:#fff1ef}.result p,.error p{margin:5px 0 0}a{color:#0b6677;font-weight:700}
  </style>
</head>
<body>
  <main class="card">
    <div class="eyebrow">Local secure setup</div>
    <h1>把 FreightClaw MCP 接入 Codex</h1>
    <p>此页面只监听本机 127.0.0.1。长期 Key 不会显示、写入 TOML、进入浏览器存储或发送给 MCP Runtime。</p>
    ${resultPanel}${errorPanel}
    <ol>
      <li>先在 <a href="https://www.freightclaw.net/admin" rel="noreferrer">Access Console</a> 创建并确认交付一个 active Key。</li>
      <li>将完整 Key 粘贴到下方；系统先真实验证 3 个工具和 5 个资源。</li>
      <li>验证通过后才写入 macOS Keychain 和 Codex 配置。</li>
    </ol>
    <form method="post" action="/save" autocomplete="off">
      <input type="hidden" name="nonce" value="${nonce}">
      <label for="api-key">长期 API Key</label>
      <input id="api-key" name="api_key" type="password" required minlength="51" maxlength="4096" autocomplete="off" autofocus>
      <button type="submit">验证并完成接入</button>
    </form>
    <p class="note">Codex 之后只通过本机助手取得短期 JWT；遇到同源 401/403 时会重新兑换一次。</p>
  </main>
</body>
</html>`;
}

function setupErrorMessage(code) {
  const messages = {
    api_key_format_invalid: "Key 格式不正确，请重新复制完整 Key。",
    authentication_failed: "Key 无效、已过期、尚未确认交付或已被吊销。",
    rate_limited: "请求过于频繁，请稍后再试。",
    exchange_unavailable: "统一凭证网关当前不可用，请稍后再试。",
    exchange_contract_invalid: "凭证网关返回内容与当前合同不一致，已停止安装。",
    mcp_unavailable: "MCP 服务当前不可访问，请稍后再试。",
    resource_catalog_mismatch: "MCP 资源目录不是预期的精确五项，已停止安装。",
    resource_readback_invalid: "至少一个 MCP 资源未能真实读回，已停止安装。",
    tool_catalog_mismatch: "MCP 工具目录不是预期的精确三项，已停止安装。",
    tool_readback_not_success: "至少一个确定性工具未返回 success，已停止安装。",
    keychain_helper_build_failed: "本机 Keychain 助手无法安装，请确认 Xcode Command Line Tools 可用。",
    helper_install_failed: "本机鉴权助手未能安全安装。",
    keychain_update_failed: "长期 Key 未能保存到 macOS Keychain。",
    keychain_update_timeout: "macOS Keychain 保存超时。",
    codex_config_conflict: "检测到现有 FreightClaw 配置，安装器不会自动覆盖，请先人工核对。",
    codex_config_unavailable: "无法读取现有 Codex 配置。",
    codex_config_write_failed: "验证已通过，但 Codex 配置未能安全写入。",
    invalid_submission: "此页面已经刷新，请在新页面中重新提交。",
  };
  return messages[code] ?? "接入暂时没有完成，请保留诊断标识后重试。";
}

export function createCredentialSetupServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  let nonce = randomBytes(24).toString("hex");
  let status = {
    configured: false,
    resource_count: 0,
    tool_count: 0,
    transport_mode: "unverified",
  };
  let setupInFlight = false;
  const completeSetup = options.completeSetup ?? ((apiKey) => completeCodexSetup(apiKey, options));
  const server = createServer(async (request, response) => {
    const securityFailure = requestSecurityFailure(request);
    if (securityFailure !== null) {
      json(response, 403, { configured: false, reason: securityFailure });
      return;
    }
    const path = (request.url ?? "/").split("?", 1)[0];
    if (request.method === "GET" && path === "/") {
      html(response, 200, setupPage(nonce));
      return;
    }
    if (request.method === "GET" && path === "/status") {
      json(response, 200, status);
      return;
    }
    if (request.method !== "POST" || path !== "/save") {
      json(response, 404, { configured: false, reason: "route_not_found" });
      return;
    }
    if (setupInFlight) {
      json(response, 409, { configured: status.configured, reason: "setup_in_progress" });
      return;
    }
    setupInFlight = true;
    try {
      const fields = new URLSearchParams(await readBody(request));
      const suppliedNonce = fields.get("nonce");
      const apiKey = fields.get("api_key") ?? "";
      const expectedNonce = nonce;
      nonce = randomBytes(24).toString("hex");
      if (suppliedNonce !== expectedNonce) {
        throw new FreightClawSetupError("invalid_submission");
      }
      if (!API_KEY_PATTERN.test(apiKey)) throw new FreightClawSetupError("api_key_format_invalid");
      const result = await completeSetup(apiKey);
      status = {
        configured: true,
        resource_count: result.resourceCount,
        tool_count: result.toolCount,
        transport_mode: result.transportMode,
      };
      if (options.closeOnSuccess === true) {
        response.once("finish", () => server.close());
      }
      html(response, 200, setupPage(nonce, result));
    } catch (error) {
      const candidateCode = error instanceof FreightClawSetupError || typeof error?.code === "string"
        ? error.code
        : "setup_unavailable";
      const code = /^[a-z0-9_]+$/u.test(candidateCode) ? candidateCode : "setup_unavailable";
      html(response, 400, setupPage(nonce, null, code));
    } finally {
      setupInFlight = false;
    }
  });
  return { server, port, origin: `http://127.0.0.1:${port}` };
}

function isMainModule() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  const parsedPort = Number.parseInt(process.env.FREIGHTCLAW_CODEX_SETUP_PORT ?? String(DEFAULT_PORT), 10);
  const port = Number.isSafeInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65_535
    ? parsedPort
    : DEFAULT_PORT;
  const created = createCredentialSetupServer({ port, closeOnSuccess: true });
  created.server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`FreightClaw Codex setup is ready at ${created.origin}\n`);
    const browser = spawn("/usr/bin/open", [created.origin], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    browser.unref();
  });
}
