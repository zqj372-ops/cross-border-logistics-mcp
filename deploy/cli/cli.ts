import { runWorkspace } from "./workspace";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";
import metadata from "./package.json";
import { commands, inputSchema, validateInput, validateResponse } from "./contracts";
import type { Command } from "./contracts";

const MAX_INPUT = 32 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const exitCodes: Readonly<Record<string, number>> = { success: 0, needs_input: 3, manual_review: 4, blocked: 5, unavailable: 6 };
class CliError extends Error {
  constructor(readonly code: string, readonly exitCode: number, message: string) { super(message); }
}
export interface CliIO {
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  fetch?: typeof fetch;
}
const help = `FreightClaw CLI ${metadata.version}

用法：freightclaw <命令> [选项]

  workspace --help         人员登录、询价管理与渠道配置
  status                   检查 Portal 就绪状态（不证明业务数据已就绪）
  commands                 查看本版本支持的命令（不代表账号已经获权）
  schema <命令>            输出该命令的输入 JSON Schema
${commands.map(command => `  ${command.name.padEnd(24)} ${command.description}`).join("\n")}

选项：
  --input, -i <文件|->      业务输入 JSON；- 表示标准输入
  --key-file <私有文件>     从文件读取既有统一 API Key；也可使用 FREIGHTCLAW_API_KEY
  --endpoint <origin>       默认 https://www.freightclaw.net；仅 HTTPS 或本机 HTTP
  --timeout <秒>            网络及标准输入等待上限，1–60，默认15
  --json                    紧凑 JSON；默认使用缩进 JSON
  --help, -h                显示帮助
  --version, -v             显示 CLI 版本

不接受命令行明文 Key，不保存 Key 或业务响应，不跟随重定向，不自动重试。
业务输入不需要包装成 {schema_version,input}；CLI 按现有 API 合同包装。
人员后台功能逐步通过 workspace 命令接入，同网页权限；API Key 不代替人员身份。
退出码：0成功，1网络/响应错误，2参数/输入/凭证配置错误，3需补输入，4人工复核，5被阻止，6不可用。
`;

function endpoint(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CliError("endpoint_invalid", 2, "服务地址必须是完整的 HTTPS origin。"); }
  const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (raw.includes("\\") || url.username || url.password || url.href !== `${url.origin}/` || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new CliError("endpoint_invalid", 2, "服务地址只允许 HTTPS origin 或本机 HTTP，不能包含路径、账号、查询或片段。");
  }
  return url;
}

async function readFileBounded(filename: string, maximum: number, secret = false): Promise<Buffer> {
  let file;
  try { file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK); } catch { throw new CliError("file_unreadable", 2, "无法读取指定文件。"); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new CliError("file_invalid", 2, "文件必须是大小受限的普通文件。");
    if (secret && process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new CliError("key_file_permissions", 2, "Key 文件必须归当前用户所有，且仅允许本人访问（权限600）。");
    const buffer = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximum) throw new CliError("file_too_large", 2, "文件超过输入大小上限。");
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}

async function readStdin(stream: Readable, timeout: number): Promise<Buffer> {
  if (stream.readableEnded) return Buffer.alloc(0);
  if (stream.destroyed) throw new CliError("input_unreadable", 2, "无法读取标准输入。");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const timer = setTimeout(() => finish(new CliError("input_timeout", 2, "等待标准输入超时。")), timeout);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); stream.off("data", data); stream.off("end", end); stream.off("error", failed); stream.off("close", failed); stream.pause();
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: unknown) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : null;
      if (!buffer) { finish(new CliError("input_invalid", 2, "标准输入必须是 UTF-8 JSON。")); return; }
      size += buffer.length;
      if (size > MAX_INPUT) { finish(new CliError("input_too_large", 2, "输入不能超过32 KiB。")); return; }
      chunks.push(buffer);
    };
    const end = () => finish();
    const failed = () => finish(new CliError("input_unreadable", 2, "无法读取标准输入。"));
    stream.on("data", data); stream.once("end", end); stream.once("error", failed); stream.once("close", failed);
  });
}
function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new CliError("input_json_invalid", 2, "输入必须是有效的 UTF-8 JSON。"); }
}
async function credential(env: NodeJS.ProcessEnv, filename: string | undefined): Promise<string> {
  if (filename !== undefined && env.FREIGHTCLAW_API_KEY !== undefined) throw new CliError("key_source_ambiguous", 2, "请只选择环境变量或 Key 文件中的一种凭证来源。");
  let value = env.FREIGHTCLAW_API_KEY;
  if (filename !== undefined) {
    const bytes = await readFileBounded(filename, 4096, true);
    try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/u, ""); }
    catch { throw new CliError("api_key_invalid", 2, "统一 API Key 文件必须为 UTF-8 文本。"); }
  }
  if (!value) throw new CliError("api_key_missing", 2, "请通过 FREIGHTCLAW_API_KEY 或 --key-file 提供已开通服务的统一 Key。");
  if (!/^flcbk_bkey_[a-f0-9]{24}_[A-Za-z0-9_-]{20,256}$/u.test(value)) throw new CliError("api_key_invalid", 2, "统一 API Key 格式不正确。");
  return value;
}

async function readResponse(response: Response): Promise<string> {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") || !response.body) {
    await response.body?.cancel(); throw new CliError("response_not_json", 1, "服务未返回预期的 JSON 响应；原始页面或错误正文已隐藏。");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE)) {
    await response.body.cancel(); throw new CliError("response_too_large", 1, "响应超过2 MiB上限。");
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new CliError("response_too_large", 1, "响应超过2 MiB上限。"); }
      chunks.push(item.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function responseCode(command: Command | undefined, httpStatus: number, payload: unknown): number {
  if (!record(payload) || typeof payload.status !== "string" || !Object.hasOwn(exitCodes, payload.status)) throw new CliError("response_invalid", 1, "服务响应不符合已知状态合同。");
  if (command) {
    const allowed = [command.responseVersion, ...(command.kind === "business" ? ["portal-business@2026-09-05.v1", "business-access@2026-09-05.v1"] : ["portal-t0-rest@2026-09-05.v1"])];
    if (!validateResponse(command, httpStatus, payload) || !allowed.includes(String(payload.schema_version))) throw new CliError("response_invalid", 1, "服务响应不符合当前命令的合同。");
    if (payload.status === "success" && payload.data === null) throw new CliError("response_invalid", 1, "成功响应缺少业务结果。");
    if (payload.status === "success" && record(payload.data) && (payload.data.testData === true || (record(payload.data.dataStatus) && payload.data.dataStatus.ready === false))) throw new CliError("response_not_ready", 1, "来源未就绪或返回测试数据，不能判定为业务成功。");
  } else {
    if (!record(payload.data) || payload.data.service !== "freightclaw-portal" || typeof payload.data.ready !== "boolean" || typeof payload.data.build_id !== "string" || typeof payload.data.release_id !== "string" || !record(payload.data.checks) || !Object.keys(payload.data.checks).length || Object.values(payload.data.checks).some(value => typeof value !== "boolean")) throw new CliError("response_invalid", 1, "服务就绪响应不完整。");
    if (payload.status === "success" && (!payload.data.ready || Object.values(payload.data.checks).some(value => !value))) throw new CliError("response_invalid", 1, "就绪响应的状态与检查结果冲突。");
  }
  if ((httpStatus < 200 || httpStatus >= 300) && payload.status === "success") throw new CliError("response_invalid", 1, "HTTP 状态与业务成功状态冲突。");
  return exitCodes[payload.status]!;
}

export async function runCli(args: string[], io: CliIO = {}): Promise<number> {
  const stdout = io.stdout ?? (value => { process.stdout.write(value); });
  const stderr = io.stderr ?? (value => { process.stderr.write(value); });
  if(args[0] === "workspace") return runWorkspace(args.slice(1),io,{endpoint,readFileBounded,readStdin,parseJson,readResponse});
  let compact = false;
  try {
    let parsed;
    try { parsed = parseArgs({ args, allowPositionals: true, strict: true, tokens: true, options: {
      help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" }, json: { type: "boolean" },
      input: { type: "string", short: "i" }, endpoint: { type: "string" }, "key-file": { type: "string" }, timeout: { type: "string" },
    } }); } catch { throw new CliError("arguments_invalid", 2, "命令或选项不正确；使用 --help 查看帮助。不要将明文 Key 放入命令参数。"); }
    const names = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
    if (new Set(names).size !== names.length) throw new CliError("arguments_invalid", 2, "同一选项只能指定一次。");
    const { values, positionals } = parsed; compact = values.json === true;
    const output = (value: unknown) => stdout(JSON.stringify(value, null, compact ? undefined : 2) + "\n");
    if (values.help || args.length === 0) { stdout(help); return 0; }
    if (values.version) { stdout(metadata.version + "\n"); return 0; }
    const label = positionals.join(" ");
    if (label === "commands") { output({ cli_version: metadata.version, availability: "not_checked", commands: commands.map(({ name, description, path }) => ({ command: name, description, path })) }); return 0; }
    if (positionals[0] === "schema") {
      const command = commands.find(item => item.name === positionals.slice(1).join(" "));
      if (!command) throw new CliError("command_unknown", 2, "未知命令；使用 commands 查看支持范围。");
      output(inputSchema(command)); return 0;
    }
    const command = commands.find(item => item.name === label);
    if (!command && label !== "status") throw new CliError("command_unknown", 2, "未知命令；个人历史、保存和审核使用网页登录。");
    if (!command && (values.input !== undefined || values["key-file"] !== undefined)) throw new CliError("arguments_invalid", 2, "status 不读取业务输入或凭证。");
    const env = io.env ?? process.env;
    const base = endpoint(values.endpoint ?? env.FREIGHTCLAW_ENDPOINT ?? "https://www.freightclaw.net");
    const timeoutSeconds = values.timeout ?? "15";
    if (!/^(?:[1-9]|[1-5][0-9]|60)$/u.test(timeoutSeconds)) throw new CliError("timeout_invalid", 2, "超时必须为1到60秒的整数。");
    const timeout = Number(timeoutSeconds) * 1000;
    let body: string | undefined, key: string | undefined;
    if (command) {
      if (!values.input) throw new CliError("input_missing", 2, "请用 --input 指定 JSON 文件，或用 --input - 读取标准输入。");
      const bytes = values.input === "-" ? await readStdin(io.stdin ?? process.stdin, timeout) : await readFileBounded(values.input, MAX_INPUT);
      const input = parseJson(bytes);
      if (!validateInput(command, input)) throw new CliError("input_schema_invalid", 2, `输入不符合 ${command.name} 合同；可用 schema ${command.name} 查看字段、单位和金额格式。`);
      body = JSON.stringify(command.kind === "business" ? { schema_version: "business-call@2026-09-05.v1", input } : input);
      if (Buffer.byteLength(body) > MAX_INPUT) throw new CliError("input_too_large", 2, "完整 API 请求不能超过32 KiB。");
      key = await credential(env, values["key-file"]);
    }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await (io.fetch ?? fetch)(new URL(command?.path ?? "/console/readyz", base), {
        method: command ? "POST" : "GET", redirect: "error", credentials: "omit", signal: controller.signal,
        headers: { accept: "application/json", "user-agent": `FreightClaw-CLI/${metadata.version}`, ...(key ? { authorization: `ApiKey ${key}`, "content-type": "application/json" } : {}) },
        ...(body === undefined ? {} : { body }),
      });
      const text = await readResponse(response);
      if (key && text.includes(key)) throw new CliError("credential_reflected", 1, "响应包含凭证，已隐藏全部响应。");
      let payload: unknown;
      try { payload = JSON.parse(text) as unknown; } catch { throw new CliError("response_invalid", 1, "服务返回的 JSON 无法解析。"); }
      if (key && JSON.stringify(payload).includes(key)) throw new CliError("credential_reflected", 1, "响应包含凭证，已隐藏全部响应。");
      const code = responseCode(command, response.status, payload); output(payload); return code;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(controller.signal.aborted ? "request_timeout" : "request_failed", 1, controller.signal.aborted ? "请求超时，未自动重试。" : "请求失败或被重定向；请检查地址和网络。原始异常已隐藏。");
    } finally { clearTimeout(timer); }
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError("cli_failed", 1, "CLI 未能完成请求；原始异常已隐藏。");
    stderr(JSON.stringify({ cli_error: { code: failure.code, message: failure.message } }, null, compact ? undefined : 2) + "\n");
    return failure.exitCode;
  }
}
