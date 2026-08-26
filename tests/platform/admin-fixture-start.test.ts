import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createFixtureAuthenticatorFromEnvironment } from "../../src/logistics_mcp/server/start";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const FIXTURE_TOKEN_NAMES = [
  "MCP_FIXTURE_TOKEN",
  "MCP_FIXTURE_APPROVER_TOKEN",
] as const;

interface FixtureIdentity {
  readonly actor: string;
  readonly role: "admin";
  readonly token: string;
}

function frontendFixtureIdentities(): readonly FixtureIdentity[] {
  const source = readFileSync(resolve(REPOSITORY_ROOT, "apps/admin/control-plane.js"), "utf8");
  const identitiesBlock = source.match(
    /export const FIXTURE_IDENTITIES\s*=\s*Object\.freeze\(\[(?<entries>[\s\S]*?)\]\);/,
  )?.groups?.entries;
  if (identitiesBlock === undefined) {
    throw new Error("Frontend FIXTURE_IDENTITIES declaration is missing.");
  }

  const identityPattern = /Object\.freeze\(\{\s*actor:\s*"([^"]+)",\s*label:\s*"[^"]*",\s*role:\s*"(admin)",\s*token:\s*"([^"]+)"\s*\}\)/g;
  const identities = Array.from(identitiesBlock.matchAll(identityPattern), (match): FixtureIdentity => {
    const actor = match[1];
    const role = match[2];
    const token = match[3];
    if (actor === undefined || role !== "admin" || token === undefined) {
      throw new Error("Frontend fixture identity declaration is malformed.");
    }
    return { actor, role, token };
  });
  const unparsedContent = identitiesBlock.replace(identityPattern, "").replace(/[\s,]/g, "");
  if (identities.length !== 2 || unparsedContent !== "") {
    throw new Error("Frontend FIXTURE_IDENTITIES must contain exactly two strict identities.");
  }
  return identities;
}

function startScriptAssignment(startScript: string, name: string): string {
  const match = startScript.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)`));
  if (match?.[1] === undefined) {
    throw new Error(`start:fixture is missing ${name}.`);
  }
  return match[1];
}

describe("local Admin fixture identity contract", () => {
  it("keeps start:fixture tokens aligned with frontend and server identities", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(REPOSITORY_ROOT, "package.json"), "utf8"),
    ) as { readonly scripts?: Record<string, string> };
    const startScript = packageJson.scripts?.["start:fixture"];
    if (typeof startScript !== "string") {
      throw new Error("package.json is missing start:fixture.");
    }

    expect(startScript).toContain("MCP_DATA_MODE=fixtures");
    const configuredApplicantToken = startScriptAssignment(startScript, FIXTURE_TOKEN_NAMES[0]);
    const configuredApproverToken = startScriptAssignment(startScript, FIXTURE_TOKEN_NAMES[1]);
    const frontendIdentities = new Map<string, FixtureIdentity>(
      frontendFixtureIdentities().map((identity) => [identity.actor, identity]),
    );
    const applicant = frontendIdentities.get("local_operator");
    const approver = frontendIdentities.get("local_approver");

    if (applicant === undefined || approver === undefined) {
      throw new Error("Frontend fixture identities are missing applicant or approver.");
    }

    expect(configuredApplicantToken).toBe(applicant.token);
    expect(configuredApproverToken).toBe(approver.token);
    expect(configuredApplicantToken).not.toBe(configuredApproverToken);
    expect(applicant.actor).not.toBe(approver.actor);
    expect(applicant.role).toBe("admin");
    expect(approver.role).toBe("admin");

    const previous = new Map(FIXTURE_TOKEN_NAMES.map((name) => [name, process.env[name]]));
    try {
      process.env.MCP_FIXTURE_TOKEN = configuredApplicantToken;
      process.env.MCP_FIXTURE_APPROVER_TOKEN = configuredApproverToken;
      const authenticate = createFixtureAuthenticatorFromEnvironment("tenant_fixture");
      const applicantClaims = authenticate(configuredApplicantToken);
      const approverClaims = authenticate(configuredApproverToken);

      expect(applicantClaims).toMatchObject({
        tenant_id: "tenant_fixture",
        actor_id: applicant.actor,
        actor_role: applicant.role,
        client_id: "local_fixture_applicant_client",
        session_id: "local_fixture_applicant_session",
      });
      expect(approverClaims).toMatchObject({
        tenant_id: "tenant_fixture",
        actor_id: approver.actor,
        actor_role: approver.role,
        client_id: "local_fixture_approver_client",
        session_id: "local_fixture_approver_session",
      });
      expect(new Set([applicantClaims.actor_id, approverClaims.actor_id]).size).toBe(2);
      expect(new Set([applicantClaims.client_id, approverClaims.client_id]).size).toBe(2);
      expect(new Set([applicantClaims.session_id, approverClaims.session_id]).size).toBe(2);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
