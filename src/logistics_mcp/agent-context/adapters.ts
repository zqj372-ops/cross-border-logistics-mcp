import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const requiredTool = "system.agent_context.get";
const requiredResources = [
  "logistics://agent/bootstrap",
  "logistics://standards/index",
  "logistics://contracts/envelope/current",
  "logistics://modules/catalog",
  "logistics://agent/profiles",
] as const;

export interface AgentAdapterValidationReport {
  readonly adapterCount: number;
  readonly failures: readonly string[];
}

function rootDefault(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

function read(rootDir: string, path: string): string {
  return readFileSync(resolve(rootDir, path), "utf8");
}

function validateJsonAdapter(rootDir: string, path: string, failures: string[]): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(read(rootDir, path)) as Record<string, unknown>;
  } catch {
    failures.push(`${path}: invalid JSON`);
    return;
  }
  const tools = parsed.allowed_tools;
  if (!Array.isArray(tools) || !tools.includes(requiredTool)) {
    failures.push(`${path}: missing ${requiredTool}`);
  }
  const agentAccess = parsed.agent_access;
  if (typeof agentAccess !== "object" || agentAccess === null || Array.isArray(agentAccess)) {
    failures.push(`${path}: missing agent_access declaration`);
  } else {
    const record = agentAccess as Record<string, unknown>;
    if (record.profile !== "runtime-caller" || record.context_tool !== requiredTool) {
      failures.push(`${path}: invalid runtime-caller context declaration`);
    }
    const resources = record.resources;
    if (!Array.isArray(resources) || requiredResources.some((uri) => !resources.includes(uri))) {
      failures.push(`${path}: fixed resource allowlist is incomplete`);
    }
  }
  const content = read(rootDir, path);
  if (/(?:-----BEGIN|sk-|ghp_|AIza|Bearer\s+[A-Za-z0-9_-]{20,}|tenant_id\s*[:=])/i.test(content)) {
    failures.push(`${path}: contains credential or client-supplied identity material`);
  }
}

export function validateAgentAdapters(rootDir = rootDefault()): AgentAdapterValidationReport {
  const failures: string[] = [];
  const codex = read(rootDir, "deploy/clients/codex.example.toml");
  if (!codex.includes("[mcp_servers.cross_border_logistics]")) failures.push("codex: missing server section");
  if (!codex.includes(`"${requiredTool}"`)) failures.push("codex: missing Agent context tool");
  for (const uri of requiredResources) {
    if (!codex.includes(uri)) failures.push(`codex: missing resource ${uri}`);
  }
  if (/(?:tenant_id|actor_id|client_id)\s*=/.test(codex)) failures.push("codex: contains client-supplied identity");
  validateJsonAdapter(rootDir, "deploy/clients/chatgpt.example.json", failures);
  validateJsonAdapter(rootDir, "deploy/clients/enterprise-assistant.example.json", failures);
  const onboarding = read(rootDir, "docs/runbooks/client-onboarding.md");
  if (!onboarding.includes(requiredTool) || !requiredResources.every((uri) => onboarding.includes(uri))) {
    failures.push("client-onboarding: Agent tool/resource contract is incomplete");
  }
  return { adapterCount: 3, failures };
}
