import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { AnySchema, ValidateFunction } from "ajv";
import api from "../../apps/console/openapi.json";

type Schema = Record<string, unknown>;
type Operation = { requestBody: { content: { "application/json": { schema: Schema } } }; responses: Record<string, { content: { "application/json": { schema: Schema } } }> };
const paths = api.paths as unknown as Record<string, { post: Operation }>;
const components = api.components.schemas as unknown as Record<string, Schema>;
export interface Command { name: string; description: string; path: string; kind: "tool" | "business"; responseVersion: string }
export const commands: readonly Command[] = [
  { name: "cargo calculate", description: "货物体积、重量与分泡计算", path: "/api/v2/tools/cargo.calculate", kind: "tool", responseVersion: "2026-08-11.v1" },
  { name: "container plan", description: "装柜容量与装载摘要", path: "/api/v2/tools/container.plan_summary", kind: "tool", responseVersion: "2026-08-11.v1" },
  { name: "agent context", description: "读取已授权的 Agent 标准上下文", path: "/api/v2/tools/system.agent_context.get", kind: "tool", responseVersion: "2026-08-11.v1" },
  { name: "customs query", description: "关税与归类查询", path: "/api/v2/business/customs/query", kind: "business", responseVersion: "portal-customs@2026-09-05.v1" },
  { name: "customs tax", description: "单项税费估算", path: "/api/v2/business/customs/tax-estimate", kind: "business", responseVersion: "portal-tax@2026-09-05.v1" },
  { name: "customs tax-batch", description: "批量税费估算，最多20项", path: "/api/v2/business/customs/tax-estimates/batch", kind: "business", responseVersion: "portal-tax@2026-09-05.v1" },
  { name: "quote zone", description: "加拿大尾程报价预览", path: "/api/v2/business/quote/zone-preview", kind: "business", responseVersion: "portal-quote@2026-09-05.v1" },
  { name: "quote extract", description: "从询价文字提取输入并预览", path: "/api/v2/business/quote/ai-extract-preview", kind: "business", responseVersion: "portal-quote@2026-09-05.v1" },
  { name: "quote freightcom", description: "Freightcom LTL 询价预览", path: "/api/v2/business/quote/freightcom-ltl-preview", kind: "business", responseVersion: "portal-freightcom-rate@2026-09-05.v1" },
];

// Export only reachable published schemas. There is no runtime contract download.
function standalone(schema: Schema): Schema {
  const definitions: Record<string, unknown> = {};
  function rewrite(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    const result: Schema = {};
    for (const [key, child] of Object.entries(value)) {
      if (key !== "$ref") { result[key] = rewrite(child); continue; }
      if (typeof child !== "string") throw new Error("cli_contract_reference_invalid");
      const match = /^#\/components\/schemas\/([^/]+)(.*)$/u.exec(child);
      if (!match?.[1] || !components[match[1]]) throw new Error("cli_contract_reference_invalid");
      const name = match[1];
      if (!Object.hasOwn(definitions, name)) { definitions[name] = true; definitions[name] = rewrite(components[name]); }
      result[key] = `#/$defs/${name}${match[2] ?? ""}`;
    }
    return result;
  }
  const root = rewrite(schema) as Schema;
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...root, ...(Object.keys(definitions).length ? { $defs: definitions } : {}) };
}

export function inputSchema(command: Command): Schema {
  const schema = paths[command.path]!.post.requestBody.content["application/json"].schema;
  return standalone(command.kind === "business" ? (schema.properties as Record<string, Schema>).input! : schema);
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
const validators = new Map<string, ValidateFunction>();
function validator(key: string, schema: () => Schema): ValidateFunction {
  let result = validators.get(key);
  if (!result) { result = ajv.compile(schema() as AnySchema); validators.set(key, result); }
  return result;
}
export function validateInput(command: Command, input: unknown): boolean { return validator(`${command.name}:input`, () => inputSchema(command))(input); }
export function validateResponse(command: Command, httpStatus: number, input: unknown): boolean {
  const response = paths[command.path]!.post.responses;
  const code = Object.hasOwn(response, String(httpStatus)) ? String(httpStatus) : httpStatus >= 200 && httpStatus < 300 ? "200" : "400";
  if (!validator(`${command.name}:response:${code}`, () => standalone(response[code]!.content["application/json"].schema))(input)) return false;
  // The published envelope covers multiple tools; also enforce this tool's data type.
  const dataSchema = command.name === "cargo calculate" ? "DomainCargoResult" : command.name === "container plan" ? "DomainContainerPlan" : undefined;
  const data = (input as { data: unknown }).data;
  return !dataSchema || data === null || validator(`${command.name}:data`, () => standalone({ $ref: `#/components/schemas/${dataSchema}` }))(data);
}
