import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  initializeSqliteControlState,
} from "../../src/logistics_mcp/control-plane/sqlite-control-store";
import { startRuntime } from "../../src/logistics_mcp/server/start";

const roots: string[] = [];
const ENVIRONMENT_NAMES = [
  "MCP_DATA_MODE",
  "MCP_ADMIN_UI_ENABLED",
  "MCP_ADMIN_CONTROL_ENABLED",
  "MCP_INSTANCE_ID",
  "MCP_ADMIN_TENANT_ID",
  "MCP_FIXTURE_TOKEN",
  "MCP_FIXTURE_APPROVER_TOKEN",
  "MCP_ALLOWED_ORIGINS",
  "MCP_ALLOWED_HOSTS",
  "MCP_ALLOWED_OUTBOUND_HOSTS",
  "MCP_FREIGHTCOM_TEST_ENABLED",
] as const;

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("managed fixture plugin configuration startup", () => {
  it("fails closed when the explicitly initialized plugin state is missing", async () => {
    const applicationRoot = realpathSync(mkdtempSync(join(tmpdir(), "mcp-plugin-config-startup-")));
    roots.push(applicationRoot);
    const previous = new Map(ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]));
    try {
      for (const name of ENVIRONMENT_NAMES) delete process.env[name];
      process.env.MCP_DATA_MODE = "fixtures";
      process.env.MCP_ADMIN_UI_ENABLED = "false";
      process.env.MCP_ADMIN_CONTROL_ENABLED = "true";
      process.env.MCP_INSTANCE_ID = "instance_fixture_001";
      process.env.MCP_ADMIN_TENANT_ID = "tenant_fixture";
      process.env.MCP_FIXTURE_TOKEN = "fixture-applicant-token";
      process.env.MCP_FIXTURE_APPROVER_TOKEN = "fixture-approver-token";
      process.env.MCP_ALLOWED_OUTBOUND_HOSTS = "fixture.example.invalid";
      process.env.MCP_FREIGHTCOM_TEST_ENABLED = "true";

      await initializeSqliteControlState({
        applicationRoot,
        instanceId: "instance_fixture_001",
        managementTenantId: "tenant_fixture",
      });

      await expect(startRuntime({
        applicationRoot,
        listen: () => {
          throw new Error("listen must not be reached without plugin config state");
        },
      })).rejects.toMatchObject({
        code: "state_missing",
      });
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
