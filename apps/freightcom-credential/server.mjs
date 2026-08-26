import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { keychainHelperPath } from "./build-helper.mjs";

const DEFAULT_PORT = 56571;
const DEFAULT_ACCOUNT = "JHT LOGISTICS CO., LTD.";
const DEFAULT_SERVICE = "freightcom-api-test-mcp-v1";
const MAX_BODY_BYTES = 8 * 1024;
const KEYCHAIN_TIMEOUT_MS = 30_000;

function securityHeaders(response) {
  response.setHeader("cache-control", "no-store, max-age=0");
  response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
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

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function storeKeychainCredential(token, options = {}) {
  const account = options.account ?? DEFAULT_ACCOUNT;
  const service = options.service ?? DEFAULT_SERVICE;
  return new Promise((resolve, reject) => {
    const child = spawn(
      keychainHelperPath,
      ["store", account, service],
      { detached: true, shell: false, stdio: ["pipe", "ignore", "ignore"] },
    );
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const terminateGroup = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    const timer = setTimeout(() => {
      terminateGroup();
      finish(new Error("Keychain update timed out."));
    }, options.timeoutMs ?? KEYCHAIN_TIMEOUT_MS);
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error("Keychain update failed."));
    });
    child.stdin.end(token);
  });
}

function page(nonce, message = "") {
  const status = message.length === 0
    ? ""
    : `<p class="status" role="status">${message}</p>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Freightcom 测试凭证</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17212b;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(520px,calc(100% - 32px));margin:72px auto;background:#fff;border:1px solid #dce2e8;border-radius:12px;padding:28px;box-shadow:0 12px 32px rgba(20,35,50,.08)}h1{font-size:22px;margin:0 0 8px}p{color:#52606d;margin:0 0 20px}label{display:block;font-weight:650;margin-bottom:7px}input{width:100%;height:44px;border:1px solid #aeb8c2;border-radius:7px;padding:0 12px;font:inherit}input:focus{outline:3px solid rgba(0,112,187,.2);border-color:#0070bb}button{width:100%;height:44px;margin-top:18px;border:0;border-radius:7px;background:#006cac;color:#fff;font:inherit;font-weight:700;cursor:pointer}.note{font-size:13px;margin-top:16px}.status{padding:12px;border-radius:7px;background:#e8f6ec;color:#176b35;font-weight:650}
  </style>
</head>
<body>
  <main class="card">
    <h1>更新 Freightcom 测试 Token</h1>
    <p>仅保存到本机 macOS Keychain。页面不显示、记录或回传已有 token。</p>
    ${status}
    <form method="post" action="/save" autocomplete="off">
      <input type="hidden" name="nonce" value="${nonce}">
      <label for="token">Test API Token</label>
      <input id="token" name="token" type="password" required minlength="16" maxlength="4096" autocomplete="new-password" autofocus>
      <button type="submit">保存到 Keychain</button>
    </form>
    <p class="note">保存后可关闭此页。真实测试仍只允许固定的 ssd-test 域名。</p>
  </main>
</body>
</html>`;
}

export function createCredentialServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const origin = `http://127.0.0.1:${port}`;
  const nonce = randomBytes(24).toString("hex");
  const storeCredential = options.storeCredential ?? ((token) => storeKeychainCredential(token, options));
  let stored = false;
  const server = createServer(async (request, response) => {
    const path = (request.url ?? "/").split("?", 1)[0];
    if (request.method === "GET" && path === "/") {
      html(response, 200, page(nonce));
      return;
    }
    if (request.method === "GET" && path === "/status") {
      json(response, 200, { stored });
      return;
    }
    if (request.method !== "POST" || path !== "/save") {
      json(response, 404, { stored: false, reason: "route_not_found" });
      return;
    }
    const host = request.headers.host ?? "";
    let loopbackHost = false;
    try {
      loopbackHost = new URL(`http://${host}`).hostname === "127.0.0.1";
    } catch {
      loopbackHost = false;
    }
    if (!loopbackHost) {
      json(response, 403, { stored: false, reason: "host_rejected" });
      return;
    }
    try {
      const fields = new URLSearchParams(await readBody(request));
      const suppliedNonce = fields.get("nonce");
      const token = fields.get("token") ?? "";
      if (suppliedNonce !== nonce || token.length < 16 || token.length > 4_096) {
        json(response, 400, { stored: false, reason: "invalid_submission" });
        return;
      }
      await storeCredential(token);
      stored = true;
      html(response, 200, page(nonce, "已保存到 Keychain。现在可以关闭此页面。"));
    } catch {
      json(response, 500, { stored: false, reason: "keychain_update_failed" });
    }
  });
  return { server, port, origin };
}

function isMainModule() {
  return process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  const port = Number.parseInt(process.env.FREIGHTCOM_CREDENTIAL_PORT ?? String(DEFAULT_PORT), 10);
  const { server } = createCredentialServer({ port });
  server.listen(port, "127.0.0.1");
}
