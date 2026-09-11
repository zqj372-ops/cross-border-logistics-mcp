import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutreachService, OutreachError } from "../../services/logistics-outreach/service.js";
import { createFixturePorts } from "../../services/logistics-outreach/fixtures.js";

export type TestRegistrar = (name: string, run: () => void | Promise<void>) => unknown;
const actor = { tenantId: "tenant_fixture", actorId: "sales_fixture" };
const other = { tenantId: "tenant_other", actorId: "sales_fixture" };

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "outreach-"));
  const ports = createFixturePorts();
  const path = join(directory, "outreach.sqlite");
  const service = new OutreachService(path, ports);
  return { service, ports, path, close() { service.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function lead(service: OutreachService) {
  const preview = await service.research(actor, "capture_fixture");
  return service.importLead(actor, { capture_ref: "capture_fixture", email: "sales@example.invalid", preview_ref: preview.preview_ref, idempotency_key: "import_1" });
}
async function draft(service: OutreachService) {
  const item = await lead(service);
  return service.prepareDraft(actor, { lead_ref: item.lead_ref, idempotency_key: "draft_1", preview_ref: service.previewDraft(actor, item.lead_ref).preview_ref });
}
function sync(service: OutreachService, key = "sync_1") {
  return service.syncInbox(actor, { preview_ref: service.previewInbox(actor).preview_ref, idempotency_key: key });
}
async function queue(service: OutreachService) {
  const d = await draft(service);
  const input = { draft_ref: d.draft_ref, approval_ref: "approval_fixture", digest: d.digest, idempotency_key: "queue_1" };
  const preview = await service.previewQueue(actor, input);
  return service.queue(actor, { ...input, preview_ref: preview.preview_ref });
}
function code(expected: string) {
  return (error: unknown) => error instanceof OutreachError && error.code === expected;
}

export function registerOutreachCases(test: TestRegistrar): void {
  test("research extracts only observed addresses and keeps China demand unknown", async () => {
    const f = setup(); try {
      const p = await f.service.research(actor, "capture_fixture");
      assert.deepEqual(p.emails, ["sales@example.invalid"]);
      assert.equal(p.china_import_status, "unknown");
      assert.equal(f.service.listLeads(actor).length, 0);
    } finally { f.close(); }
  });
  test("a preview cannot be replayed across tenants or actors", async () => {
    const f = setup(); try {
      const p = await f.service.research(actor, "capture_fixture");
      await assert.rejects(f.service.importLead(other, { capture_ref: "capture_fixture", email: "sales@example.invalid", preview_ref: p.preview_ref, idempotency_key: "import_1" }), code("preview_invalid"));
      await assert.rejects(f.service.importLead({ ...actor, actorId: "another_actor" }, { capture_ref: "capture_fixture", email: "sales@example.invalid", preview_ref: p.preview_ref, idempotency_key: "import_1" }), code("preview_invalid"));
    } finally { f.close(); }
  });
  test("lead import is idempotent, normalized and tenant-scoped", async () => {
    const f = setup(); try {
      const first = await lead(f.service); assert.deepEqual(await lead(f.service), first);
      assert.equal(f.service.listLeads(actor).length, 1);
      assert.equal(f.service.listLeads(other).length, 0);
      assert.throws(() => f.service.getLead(other, first.lead_ref), code("not_found"));
    } finally { f.close(); }
  });
  test("addresses not observed in the capture cannot be imported", async () => {
    const f = setup(); try {
      const p = await f.service.research(actor, "capture_fixture");
      await assert.rejects(f.service.importLead(actor, { capture_ref: "capture_fixture", email: "guessed@example.invalid", preview_ref: p.preview_ref, idempotency_key: "import_1" }), code("email_not_observed"));
    } finally { f.close(); }
  });
  test("drafts contain sender identity and reply-based unsubscribe", async () => {
    const f = setup(); try {
      const d = await draft(f.service); const text = f.service.getDraft(actor, d.draft_ref);
      assert.match(text.body, /unsubscribe/); assert.match(text.body, /Fixture Logistics/);
      assert.equal(text.generation, "template"); assert.equal(text.status, "pending_review");
    } finally { f.close(); }
  });
  test("published email alone does not authorize dispatch", async () => {
    const f = setup(); try {
      f.ports.state.consentAllowed = false;
      await assert.rejects(queue(f.service), code("contact_not_approved"));
      assert.equal(f.ports.state.sent.length, 0);
    } finally { f.close(); }
  });
  test("a draft creator cannot approve their own message", async () => {
    const f = setup(); try {
      f.ports.state.reviewerId = actor.actorId;
      await assert.rejects(queue(f.service), code("approval_invalid"));
    } finally { f.close(); }
  });
  test("changed content digest invalidates send approval", async () => {
    const f = setup(); try {
      const d = await draft(f.service);
      await assert.rejects(f.service.previewQueue(actor, { draft_ref: d.draft_ref, approval_ref: "approval_fixture", digest: "0".repeat(64) }), code("digest_mismatch"));
    } finally { f.close(); }
  });
  test("sending is disabled by default and queued is not sent", async () => {
    const f = setup(); try {
      const j = await queue(f.service); assert.equal(j.state, "queued");
      await assert.rejects(f.service.dispatchOne(actor.tenantId), code("sending_disabled"));
      assert.equal(f.ports.state.sent.length, 0);
    } finally { f.close(); }
  });
  test("fixture dispatch requires exact readback and is labelled simulated", async () => {
    const f = setup(); try {
      const j = await queue(f.service); f.ports.state.sendEnabled = true;
      await f.service.dispatchOne(actor.tenantId);
      assert.equal(f.service.getJob(actor, j.job_ref).state, "simulated");
      assert.equal(f.ports.state.sent.length, 1);
      await f.service.dispatchOne(actor.tenantId);
      assert.equal(f.ports.state.sent.length, 1);
    } finally { f.close(); }
  });
  test("provider timeout leaves an uncertain attempt and never blindly resends", async () => {
    const f = setup(); try {
      const j = await queue(f.service); f.ports.state.sendEnabled = true; f.ports.state.throwAfterSend = true;
      await f.service.dispatchOne(actor.tenantId); await f.service.dispatchOne(actor.tenantId);
      assert.equal(f.service.getJob(actor, j.job_ref).state, "manual_review");
      assert.equal(f.ports.state.sent.length, 1);
    } finally { f.close(); }
  });
  test("mismatched provider readback is not success", async () => {
    const f = setup(); try {
      const j = await queue(f.service); f.ports.state.sendEnabled = true; f.ports.state.badReadback = true;
      await f.service.dispatchOne(actor.tenantId);
      assert.equal(f.service.getJob(actor, j.job_ref).state, "manual_review");
    } finally { f.close(); }
  });
  test("revoked contact approval is checked again at dispatch", async () => {
    const f = setup(); try {
      const j = await queue(f.service); f.ports.state.sendEnabled = true; f.ports.state.consentAllowed = false;
      await f.service.dispatchOne(actor.tenantId);
      assert.equal(f.service.getJob(actor, j.job_ref).state, "cancelled");
      assert.equal(f.ports.state.sent.length, 0);
    } finally { f.close(); }
  });
  test("unsubscribe suppresses the contact and cancels queued messages", async () => {
    const f = setup(); try {
      const j = await queue(f.service);
      f.ports.state.inbox.push({ message_ref: "incoming_1", from: "SALES@example.invalid", body: "Please unsubscribe me.", auto_submitted: false });
      await sync(f.service);
      assert.equal(f.service.getJob(actor, j.job_ref).state, "cancelled");
      assert.equal(f.service.listLeads(actor)[0]?.suppressed, true);
    } finally { f.close(); }
  });
  test("any reply pauses cold follow-ups; duplicate inbox events are ignored", async () => {
    const f = setup(); try {
      const j = await queue(f.service);
      f.ports.state.inbox.push({ message_ref: "incoming_1", from: "sales@example.invalid", body: "We may ship next month.", auto_submitted: false });
      assert.equal((await sync(f.service)).imported, 1);
      assert.equal((await sync(f.service, "sync_2")).imported, 0);
      assert.equal(f.service.getJob(actor, j.job_ref).state, "cancelled");
    } finally { f.close(); }
  });
  test("reply preparation does not send and uses the same reviewed path", async () => {
    const f = setup(); try {
      await lead(f.service);
      f.ports.state.inbox.push({ message_ref: "incoming_1", from: "sales@example.invalid", body: "Please quote my shipment.", auto_submitted: false });
      await sync(f.service);
      const d = await f.service.prepareReply(actor, { message_ref: "incoming_1", idempotency_key: "reply_1", preview_ref: f.service.previewReply(actor, "incoming_1").preview_ref });
      assert.equal(f.service.getDraft(actor, d.draft_ref).status, "pending_review");
      assert.equal(f.ports.state.sent.length, 0);
    } finally { f.close(); }
  });
  test("automated messages never trigger reply generation", async () => {
    const f = setup(); try {
      await lead(f.service);
      f.ports.state.inbox.push({ message_ref: "auto_1", from: "sales@example.invalid", body: "Out of office", auto_submitted: true });
      await sync(f.service);
      await assert.rejects(f.service.prepareReply(actor, { message_ref: "auto_1", idempotency_key: "r", preview_ref: "not_allowed" }), code("reply_blocked"));
    } finally { f.close(); }
  });
  test("lead and queue state survive a service restart", async () => {
    const f = setup(); try {
      const j = await queue(f.service); f.service.close();
      const reopened = new OutreachService(f.path, f.ports);
      try { assert.equal(reopened.listLeads(actor).length, 1); assert.equal(reopened.getJob(actor, j.job_ref).state, "queued"); }
      finally { reopened.close(); }
    } finally { f.close(); }
  });
}
