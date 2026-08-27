import { fileURLToPath } from "node:url";

import { readRegisteredText } from "./registry";

const requiredTools = [
  "cargo.calculate",
  "container.plan_summary",
  "system.agent_context.get",
] as const;
const requiredContextTool = "system.agent_context.get";
const requiredResources = [
  "logistics://agent/bootstrap",
  "logistics://standards/index",
  "logistics://contracts/envelope/current",
  "logistics://modules/catalog",
  "logistics://agent/profiles",
] as const;
const forbiddenCapabilityMarkers = [
  "quote.",
  "customs.",
  "freightcom",
  "save_draft",
  "create_task",
  "knowledge.search_curated",
  "system.get_data_status",
  "write_tools",
] as const;

export interface AgentAdapterValidationReport {
  readonly adapterCount: number;
  readonly failures: readonly string[];
}

function rootDefault(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

function read(rootDir: string, path: string): string {
  return readRegisteredText(rootDir, path);
}

function hasExactValues(values: readonly unknown[], expected: readonly string[]): boolean {
  return values.length === expected.length &&
    new Set(values).size === expected.length &&
    expected.every((value) => values.includes(value));
}

function validateToolAllowlist(
  value: unknown,
  path: string,
  failures: string[],
): void {
  if (!Array.isArray(value) || !hasExactValues(value, requiredTools)) {
    failures.push(`${path}: allowed tool set must be exactly the T0 runtime tools`);
  }
}

function validateResourceAllowlist(
  value: unknown,
  path: string,
  failures: string[],
): void {
  if (!Array.isArray(value) || !hasExactValues(value, requiredResources)) {
    failures.push(`${path}: fixed resource allowlist must be exactly the five T0 resources`);
  }
}

function validateT0ClientText(path: string, content: string, failures: string[]): void {
  if (!content.includes("短期 JWT")) failures.push(`${path}: missing short-lived JWT declaration`);
  if (!content.includes("待真实 staging 适配验证")) failures.push(`${path}: missing staging verification caveat`);
  for (const marker of forbiddenCapabilityMarkers) {
    if (content.includes(marker)) failures.push(`${path}: contains non-T0 capability ${marker}`);
  }
}

function validateJsonAdapter(rootDir: string, path: string, failures: string[]): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(read(rootDir, path)) as Record<string, unknown>;
  } catch {
    failures.push(`${path}: invalid JSON`);
    return;
  }
  validateToolAllowlist(parsed.allowed_tools, path, failures);
  const agentAccess = parsed.agent_access;
  if (typeof agentAccess !== "object" || agentAccess === null || Array.isArray(agentAccess)) {
    failures.push(`${path}: missing agent_access declaration`);
  } else {
    const record = agentAccess as Record<string, unknown>;
    if (record.profile !== "runtime-caller" || record.context_tool !== requiredContextTool) {
      failures.push(`${path}: invalid runtime-caller context declaration`);
    }
    validateResourceAllowlist(record.resources, path, failures);
  }
  const content = read(rootDir, path);
  if (/(?:-----BEGIN|sk-|ghp_|AIza|Bearer\s+[A-Za-z0-9_-]{20,}|tenant_id\s*[:=])/i.test(content)) {
    failures.push(`${path}: contains credential or client-supplied identity material`);
  }
  validateT0ClientText(path, content, failures);
}

export function validateAgentAdapters(rootDir = rootDefault()): AgentAdapterValidationReport {
  const failures: string[] = [];
  const codex = read(rootDir, "deploy/clients/codex.example.toml");
  if (!codex.includes("[mcp_servers.cross_border_logistics]")) failures.push("codex: missing server section");
  const enabledToolsMatch = /^enabled_tools\s*=\s*\[([\s\S]*?)\]/m.exec(codex);
  const enabledTools = enabledToolsMatch === null
    ? null
    : [...enabledToolsMatch[1]!.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((match) => match[1]!);
  if (enabledTools === null || !hasExactValues(enabledTools, requiredTools)) {
    failures.push("codex: allowed tool set must be exactly the T0 runtime tools");
  }
  for (const uri of requiredResources) {
    if (!codex.includes(uri)) failures.push(`codex: missing resource ${uri}`);
  }
  if (/(?:tenant_id|actor_id|client_id)\s*=/.test(codex)) failures.push("codex: contains client-supplied identity");
  validateT0ClientText("deploy/clients/codex.example.toml", codex, failures);
  validateJsonAdapter(rootDir, "deploy/clients/chatgpt.example.json", failures);
  validateJsonAdapter(rootDir, "deploy/clients/enterprise-assistant.example.json", failures);
  const onboarding = read(rootDir, "docs/runbooks/client-onboarding.md");
  if (!onboarding.includes(requiredContextTool) || !requiredResources.every((uri) => onboarding.includes(uri))) {
    failures.push("client-onboarding: Agent tool/resource contract is incomplete");
  }
  return { adapterCount: 3, failures };
}
