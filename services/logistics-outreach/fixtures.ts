import { randomBytes } from "node:crypto";
import type { Inbound, OutreachPorts, Receipt } from "./types.js";

/** Synthetic local fixtures only. No external mailbox or browser is contacted. */
export function createFixturePorts() {
  const state = {
    consentAllowed: true, reviewerId: "reviewer_fixture", sendEnabled: false,
    dispatchAllowed: true, throwAfterSend: false, badReadback: false,
    inbox: [] as Inbound[], sent: [] as Receipt[],
  };
  const receipts = new Map<string, Receipt>();
  const now = Date.parse("2026-09-11T08:00:00Z");
  const ports: OutreachPorts = {
    previewKey: randomBytes(32), now: () => now,
    capture: (_tenant, ref) => ref !== "capture_fixture" ? null : {
      capture_ref: ref, company: "Fixture Furniture", city: "Toronto",
      url: "https://example.invalid/contact", captured_at: "2026-09-11T07:00:00Z", test_data: true,
      html: '<main>Fixture Furniture <a href="mailto:SALES@example.invalid">Sales</a><a href="mailto:privacy@example.invalid">Privacy</a></main><script>"hidden@example.invalid"</script>',
    },
    sender: () => ({ company: "Fixture Logistics", name: "Fixture Sales Team", email: "outreach@example.invalid", mailing_address: "1 Fixture Road, Toronto, ON, Canada (synthetic test address)", service_description: "We coordinate China–Toronto ocean freight, including LCL and FCL shipments." }),
    sendEnabled: () => state.sendEnabled,
    mayDispatch: () => Promise.resolve(state.dispatchAllowed),
    contactReview: (_tenant, lead) => Promise.resolve({ approved: state.consentAllowed, evidence_ref: lead.evidence_ref, evidence_digest: lead.evidence_digest, valid_until: "2026-09-12T08:00:00Z" }),
    draftApproval: (_tenant, draft, ref) => Promise.resolve({ approved: ref === "approval_fixture", draft_ref: draft.draft_ref, digest: draft.digest, reviewer_id: state.reviewerId, valid_until: "2026-09-12T08:00:00Z" }),
    mail: {
      mode: "fixture",
      send: (tenant, input) => {
        const key = JSON.stringify([tenant, input.idempotency_key]);
        const receipt = receipts.get(key) ?? { message_ref: `fixture_${input.idempotency_key}`, idempotency_key: input.idempotency_key, digest: input.draft.digest, recipient: input.recipient };
        if (!receipts.has(key)) { receipts.set(key, receipt); state.sent.push(receipt); }
        return state.throwAfterSend ? Promise.reject(new Error("Synthetic uncertain provider response")) : Promise.resolve(receipt);
      },
      readSent: (tenant, key) => {
        const receipt = receipts.get(JSON.stringify([tenant, key])) ?? null;
        return Promise.resolve(receipt && state.badReadback ? { ...receipt, digest: "incorrect" } : receipt);
      },
      inbox: () => Promise.resolve([...state.inbox]),
    },
  };
  return Object.assign(ports, { state });
}
