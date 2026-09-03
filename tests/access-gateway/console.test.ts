import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const consoleDirectory = fileURLToPath(new URL("../../apps/access-console/", import.meta.url));

describe("narrow Access Console boundary", () => {
  it("adds a redacted operations overview and Agent onboarding without widening T0 authority", () => {
    const html = readFileSync(`${consoleDirectory}/index.html`, "utf8");
    const app = readFileSync(`${consoleDirectory}/app.js`, "utf8");
    const styles = readFileSync(`${consoleDirectory}/styles.css`, "utf8");
    const combined = `${html}\n${app}\n${styles}`;
    expect(html).toMatch(/租户/u);
    expect(html).toMatch(/密钥/u);
    expect(html).toMatch(/工具权限/u);
    expect(html).toMatch(/操作回读/u);
    expect(html).toMatch(/运营概览/u);
    expect(html).toMatch(/最近异常/u);
    expect(html).toMatch(/Agent 接入/u);
    expect(html).toMatch(/认证验收/u);
    expect(html).toMatch(/3 个工具[\s\S]*5 个资源/u);
    expect(html).toMatch(/id="credential-readback"/u);
    expect(html).toMatch(/id="readback-api-key"[^>]*type="password"[^>]*autocomplete="off"/u);
    expect(html).toMatch(/id="readback-results"[^>]*aria-live="polite"/u);
    expect(html).toMatch(/class="skip-link"/u);
    expect(html).toMatch(/class="console-shell"/u);
    expect(html).toMatch(/class="control-rail"/u);
    expect(html).toMatch(/id="access-route"/u);
    expect(html).toMatch(/长期 Key[\s\S]*短期 JWT[\s\S]*MCP/u);
    expect(html).toMatch(/待真实 staging 验证/iu);
    expect(combined).not.toMatch(/模块|适配器|报价|关务|Freightcom|审批|发布|generic_write|任意 JSON|arbitrary JSON/iu);
    expect(combined).not.toMatch(/localStorage|sessionStorage|document\.cookie|location\.search|location\.hash/iu);
    expect(styles).toMatch(/#0b222b/iu);
    expect(styles).toMatch(/#e9672b/iu);
    expect(styles).toMatch(/\.manifest-strip/iu);
    expect(styles).toMatch(/:focus-visible/iu);
    expect(styles).toMatch(/prefers-reduced-motion/iu);
    expect(styles).not.toMatch(/font-family:\s*Inter/iu);
    expect(styles).not.toMatch(/border-radius:\s*999(?:px|9px)/iu);
    expect(app).toMatch(/API_ROOT\s*=\s*["']\/admin\/api\/v1\/access["']/iu);
    expect(app).toMatch(/api\(["']\/state["']/iu);
    expect(app).toMatch(/api\(["']\/overview["']/iu);
    expect(app).toMatch(/\/access\/v1\/readyz/iu);
    expect(app).toMatch(/\/access\/v1\/token\/exchange/iu);
    expect(app).toMatch(/authorization:\s*`ApiKey \$\{apiKey\}`/u);
    expect(app).toMatch(/requested_tool_names:\s*T0_TOOLS/u);
    expect(app).toMatch(/method:\s*["']initialize["']/u);
    expect(app).toMatch(/method:\s*["']resources\/list["']/u);
    expect(app).toMatch(/method:\s*["']resources\/read["']/u);
    expect(app).toMatch(/method:\s*["']tools\/list["']/u);
    expect(app).toMatch(/method:\s*["']tools\/call["']/u);
    expect(app).toMatch(/sessionId\.length\s*===\s*0\s*\?\s*["']stateless["']\s*:\s*["']stateful["']/u);
    expect(app).not.toMatch(/throw new ReadbackError\(["']mcp_session_missing["']\)/u);
    expect(app).toMatch(/logistics:\/\/agent\/bootstrap/u);
    expect(app).toMatch(/logistics:\/\/standards\/index/u);
    expect(app).toMatch(/logistics:\/\/contracts\/envelope\/current/u);
    expect(app).toMatch(/logistics:\/\/modules\/catalog/u);
    expect(app).toMatch(/logistics:\/\/agent\/profiles/u);
    expect(app).toMatch(/readbackApiKey\.value\s*=\s*["']["']/u);
    expect(app).toMatch(/apiKey\s*=\s*["']["'];/u);
    expect(app).toMatch(/2026-08-27\.v1/iu);
    expect(app).toMatch(/Idempotency-Key/iu);
    expect(app).toMatch(/acknowledge-delivery|rotate|revoke/iu);
    expect(app).toMatch(/tool_names/iu);
    expect(app).toMatch(/operation_id/iu);
    expect(app).toMatch(/readback_not_verified/iu);
    expect(app).toMatch(
      /async function acknowledgeDelivery[\s\S]*await post[\s\S]*payload !== null[\s\S]*pendingCredentialId === credentialId[\s\S]*hideOneTimeKey\(\)/u,
    );
    expect(app).toMatch(/total_audit_events/iu);
    expect(app).toMatch(/recent_issues/iu);
    expect(app).toMatch(/supported_clients/iu);
    expect(html).not.toMatch(/7776000|90 天/iu);
  });

  it("implements a state-driven credential lifecycle instead of one-click record mutations", () => {
    const html = readFileSync(`${consoleDirectory}/index.html`, "utf8");
    const app = readFileSync(`${consoleDirectory}/app.js`, "utf8");

    expect(html).toMatch(/id="access-workbench"/u);
    expect(html).toMatch(/id="tenant-context"/u);
    expect(html).toMatch(/id="lifecycle-track"/u);
    expect(html).toMatch(/id="next-action"/u);
    expect(html).toMatch(/id="write-progress"[^>]*aria-live="polite"/u);
    expect(html).toMatch(/id="action-dialog"/u);
    expect(html).toMatch(/id="rotation-tools"/u);
    expect(html).toMatch(/id="delivery-acknowledgement"/u);
    expect(html).toMatch(/id="ack-and-verify"/u);
    expect(html).toMatch(/id="discard-key"/u);
    expect(html).toMatch(/id="client-config-preview"/u);
    expect(html).toMatch(/接入清单不是可直接导入的凭证配置/u);

    expect(app).toMatch(/function renderAccessWorkbench/u);
    expect(app).toMatch(/function verifyWriteReadback/u);
    expect(app).toMatch(/operation\.status\s*!==\s*["']success["']/u);
    expect(app).toMatch(/expected\.credentialId/u);
    expect(app).toMatch(/exactCatalog\(credential\.tool_names, expected\.toolNames\)/u);
    expect(app).toMatch(/function setWriteBusy/u);
    expect(app).toMatch(/function openActionDialog/u);
    expect(app).toMatch(/function openRotationDialog/u);
    expect(app).toMatch(/credential\.tool_names/u);
    expect(app).toMatch(/pendingApiKey\s*=\s*["']["']/u);
    expect(app).toMatch(/runCredentialReadback\(apiKey\)/u);
    expect(app).toMatch(/LOGISTICS_MCP_BEARER_TOKEN/u);
    expect(app).not.toMatch(/按当前勾选权限轮换/u);
    expect(app).not.toMatch(/rotateCredential\(credential\.credential_id\)[\s\S]{0,200}selectedTools\(\)/u);
  });
});
