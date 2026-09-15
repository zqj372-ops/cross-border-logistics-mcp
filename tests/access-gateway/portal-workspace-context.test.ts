import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import type { PortalContext } from "../../services/access-gateway/portal/contracts";
import { DocumentService, DocumentStore } from "../../services/quote-documents/service";

it("uses an explicit active enterprise membership for quote documents without opening the platform workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "portal-workspace-context-"));
  const store = new DocumentStore(join(root, "documents.sqlite"));
  const organization: PortalContext = {
    identity: { userId: "dual-role", displayName: "Dual Role", email: "dual@example.test", emailVerified: true, platformRole: "operator" },
    organizationId: "org-a",
  };
  const portal = { getState: (ctx: PortalContext) => ({ data: {
    current_organization: ctx.organizationId === "org-a" ? { organizationId: "org-a", status: "active" } : null,
    memberships: ctx.organizationId === "org-a" ? [{ organizationId: "org-a", userId: "dual-role", role: "admin", status: "active" }] : [],
  } }) };
  const service = new DocumentService(store, portal as never);
  try {
    expect(service.config(organization)).toEqual({ version: 0, input: null });
    expect(() => service.config({ ...organization, organizationId: null })).toThrow("document_organization_required");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
