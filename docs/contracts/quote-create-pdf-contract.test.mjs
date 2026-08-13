import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";

const contractsDir = fileURLToPath(new URL("./", import.meta.url));
const schemasDir = join(contractsDir, "schemas");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
for (const file of readdirSync(schemasDir).filter((name) => name.endsWith(".json"))) {
  ajv.addSchema(readJson(join(schemasDir, file)));
}

const requestSchemaId =
  "https://schemas.example.invalid/logistics-mcp/2026-08-14/quote-create-pdf-request.schema.json";
const writeResultV1SchemaId =
  "https://schemas.example.invalid/logistics-mcp/2026-08-11/write-result.schema.json";
const writeResultV2SchemaId =
  "https://schemas.example.invalid/logistics-mcp/2026-08-13/write-result-v2.schema.json";
const envelopeV1SchemaId =
  "https://schemas.example.invalid/logistics-mcp/2026-08-11/envelope.schema.json";
const quotePdfEnvelopeSchemaId =
  "https://schemas.example.invalid/logistics-mcp/2026-08-13/quote-create-pdf-envelope.schema.json";

const validate = (schemaId, value) => {
  const validator = ajv.getSchema(schemaId);
  assert.ok(validator, `missing schema ${schemaId}`);
  assert.equal(validator(value), true, ajv.errorsText(validator.errors));
};

const rejects = (schemaId, value) => {
  const validator = ajv.getSchema(schemaId);
  assert.ok(validator, `missing schema ${schemaId}`);
  assert.equal(validator(value), false, `expected ${schemaId} to reject the value`);
};

const quoteRequest = readJson(join(contractsDir, "examples", "v2", "quote-request.json"));
const previewIdempotencyKey = "idem-preview-key-001";
const commitIdempotencyKey = "idem-commit-key-001";
const writeContext = {
  idempotency_key: previewIdempotencyKey,
  operation_mode: "preview",
  preview_ref: null,
  approval: { required: false, status: "not_required", approval_id: null },
};

const request = {
  schema_version: "2026-08-11.v1",
  version: "quote-create-pdf-request@2026-08-14.v1",
  quote_request: quoteRequest,
  presentation: { customer_display_name: "Example Customer" },
  write_context: writeContext,
};

validate(requestSchemaId, request);

const commitRequest = structuredClone(request);
commitRequest.write_context.operation_mode = "commit";
commitRequest.write_context.idempotency_key = commitIdempotencyKey;
commitRequest.write_context.preview_ref = "preview:quote-pdf:001";
commitRequest.write_context.approval = {
  required: true,
  status: "approved",
  approval_id: "approval:quote-pdf:001",
};
validate(requestSchemaId, commitRequest);
assert.notEqual(previewIdempotencyKey, commitIdempotencyKey);
const commitRetryRequest = structuredClone(commitRequest);
assert.equal(commitRetryRequest.write_context.idempotency_key, commitIdempotencyKey);
assert.equal(commitRequest.write_context.idempotency_key, commitIdempotencyKey);

const previewWithRef = structuredClone(request);
previewWithRef.write_context.preview_ref = "preview:quote-pdf:unexpected";
rejects(requestSchemaId, previewWithRef);

for (const approval of [
  { required: true, status: "not_required", approval_id: null },
  { required: false, status: "pending", approval_id: null },
  { required: false, status: "not_required", approval_id: "approval:preview:unexpected" },
]) {
  const invalid = structuredClone(request);
  invalid.write_context.approval = approval;
  rejects(requestSchemaId, invalid);
}

const commitWithoutPreview = structuredClone(commitRequest);
commitWithoutPreview.write_context.preview_ref = null;
rejects(requestSchemaId, commitWithoutPreview);

const commitUnapproved = structuredClone(commitRequest);
commitUnapproved.write_context.approval.status = "pending";
rejects(requestSchemaId, commitUnapproved);

for (const field of ["total", "line_items", "logo", "path", "html", "url"]) {
  const invalid = structuredClone(request);
  invalid.quote_request[field] = field === "line_items" ? [] : "forbidden";
  rejects(requestSchemaId, invalid);
}

const invalidPresentation = structuredClone(request);
invalidPresentation.presentation.logo = "forbidden";
rejects(requestSchemaId, invalidPresentation);

for (const [field, value] of [
  ["tenant_context", { tenant_id: "tenant_demo", actor_id: "actor_sales" }],
  ["tenant_id", "tenant_must_be_server_injected"],
  ["actor_id", "actor_must_be_server_injected"],
  ["client_id", "client_must_be_server_injected"],
  ["session_id", "session_must_be_server_injected"],
]) {
  const invalid = structuredClone(request);
  invalid.write_context[field] = value;
  rejects(requestSchemaId, invalid);
}

const invalidTopLevel = structuredClone(request);
invalidTopLevel.tenant_id = "tenant_must_be_server_injected";
rejects(requestSchemaId, invalidTopLevel);

const writeResult = {
  version: "write-result@2026-08-13.v2",
  operation: "quote.create_pdf",
  operation_status: "committed",
  record_id: "pdf-document-001",
  preview_ref: "preview:quote-pdf:001",
  readback_evidence: {
    target_system: "quote-pdf-api",
    record_id: "pdf-document-001",
    observed_version: "quote-pdf@2",
    observed_at: "2026-08-13T00:00:00Z",
    verified: true,
    source_ref_ids: ["src:pdf:readback:001"],
  },
  idempotency_key: commitIdempotencyKey,
  approval: {
    required: true,
    status: "approved",
    approval_id: "approval:quote-pdf:001",
  },
};
validate(writeResultV2SchemaId, writeResult);
rejects(writeResultV1SchemaId, writeResult);

const previewResult = structuredClone(writeResult);
previewResult.operation_status = "previewed";
previewResult.record_id = null;
previewResult.readback_evidence = null;
previewResult.idempotency_key = previewIdempotencyKey;
previewResult.approval = { required: false, status: "not_required", approval_id: null };
validate(writeResultV2SchemaId, previewResult);

for (const approval of [
  { required: true, status: "not_required", approval_id: null },
  { required: false, status: "pending", approval_id: null },
  { required: false, status: "not_required", approval_id: "approval:preview:unexpected" },
]) {
  const invalid = structuredClone(previewResult);
  invalid.approval = approval;
  rejects(writeResultV2SchemaId, invalid);
}

const alreadyCommittedResult = structuredClone(writeResult);
alreadyCommittedResult.operation_status = "already_committed";
validate(writeResultV2SchemaId, alreadyCommittedResult);

const committedPendingApproval = structuredClone(writeResult);
committedPendingApproval.approval.status = "pending";
rejects(writeResultV2SchemaId, committedPendingApproval);

const committedWithoutRecord = structuredClone(writeResult);
delete committedWithoutRecord.record_id;
rejects(writeResultV2SchemaId, committedWithoutRecord);

const committedWithoutReadback = structuredClone(writeResult);
delete committedWithoutReadback.readback_evidence;
rejects(writeResultV2SchemaId, committedWithoutReadback);

const unverifiedCommitted = structuredClone(writeResult);
unverifiedCommitted.readback_evidence.verified = false;
rejects(writeResultV2SchemaId, unverifiedCommitted);

validate(
  writeResultV1SchemaId,
  readJson(join(contractsDir, "examples", "success-quote-save-draft.json")).data,
);
validate(
  envelopeV1SchemaId,
  readJson(join(contractsDir, "examples", "success-quote-save-draft.json")),
);

const sourceRefs = [
  {
    source_id: "src:quote:authority:001",
    source_type: "internal_system",
    system: "ai-quote-api",
    locator: "quotes/zone-preview/quote-001",
    version: "quote-result@2026-08-13.v2",
    retrieved_at: "2026-08-13T00:00:00Z",
    authority: "authoritative",
  },
  {
    source_id: "src:pdf:readback:001",
    source_type: "internal_system",
    system: "quote-pdf-api",
    locator: "v2/quote-pdfs/pdf-document-001",
    version: "quote-pdf@2",
    retrieved_at: "2026-08-13T00:00:00Z",
    authority: "authoritative",
  },
];
const successEnvelope = {
  schema_version: "2026-08-11.v1",
  request_id: "req_quote_create_pdf_001",
  status: "success",
  data: writeResult,
  source_refs: sourceRefs,
  assumptions: [],
  warnings: [{
    code: "quote.pdf.sendable_false",
    message: "PDF 草稿固定不可发送。",
    severity: "info",
    field: null,
  }],
  blockers: [],
  calculation_trace: [{
    step_id: "step:quote-create-pdf:projection",
    operation: "project_authoritative_quote_to_pdf",
    inputs: [],
    result: "PDF readback verified",
    source_ref_ids: sourceRefs.map(({ source_id }) => source_id),
  }],
  review_status: "not_required",
  audit_id: "audit_quote_create_pdf_001",
};
validate(quotePdfEnvelopeSchemaId, successEnvelope);

const successAlreadyCommitted = structuredClone(successEnvelope);
successAlreadyCommitted.data = alreadyCommittedResult;
validate(quotePdfEnvelopeSchemaId, successAlreadyCommitted);

const previewEnvelope = {
  schema_version: "2026-08-11.v1",
  request_id: "req_quote_create_pdf_preview_001",
  status: "success",
  data: previewResult,
  source_refs: [sourceRefs[0]],
  assumptions: [],
  warnings: [{
    code: "quote.preview.candidate_hash",
    message: "稳定 preview_ref 已生成，未执行外部写入。",
    severity: "info",
    field: null,
  }],
  blockers: [],
  calculation_trace: [{
    step_id: "step:quote-create-candidate",
    operation: "hash_authoritative_quote_candidate",
    inputs: [],
    result: "preview_ref created; no external write dispatched",
    source_ref_ids: [sourceRefs[0].source_id],
  }],
  review_status: "not_required",
  audit_id: "audit_quote_create_pdf_preview_001",
};
validate(quotePdfEnvelopeSchemaId, previewEnvelope);
const previewEvidenceJson = JSON.stringify({
  source_refs: previewEnvelope.source_refs,
  calculation_trace: previewEnvelope.calculation_trace,
}).toLowerCase();
for (const forbidden of ["pdf", "readback", "document"]) {
  assert.equal(previewEvidenceJson.includes(forbidden), false, `preview evidence contains ${forbidden}`);
}
assert.deepEqual(
  previewEnvelope.source_refs.map(({ source_id }) => source_id).filter((id) => id.includes("pdf")),
  [],
);
assert.ok(successEnvelope.source_refs.some(({ source_id }) => source_id === "src:pdf:readback:001"));
assert.ok(successEnvelope.calculation_trace.some(({ source_ref_ids }) => source_ref_ids.includes("src:pdf:readback:001")));

const successWithPendingApproval = structuredClone(successEnvelope);
successWithPendingApproval.data.approval.status = "pending";
rejects(quotePdfEnvelopeSchemaId, successWithPendingApproval);

const successWithoutData = structuredClone(successEnvelope);
successWithoutData.data = null;
rejects(quotePdfEnvelopeSchemaId, successWithoutData);

const successWithoutSourceRefs = structuredClone(successEnvelope);
successWithoutSourceRefs.source_refs = [];
rejects(quotePdfEnvelopeSchemaId, successWithoutSourceRefs);

const successWithoutTrace = structuredClone(successEnvelope);
successWithoutTrace.calculation_trace = [];
rejects(quotePdfEnvelopeSchemaId, successWithoutTrace);

const successWithBlocker = structuredClone(successEnvelope);
successWithBlocker.blockers = [successEnvelope.warnings[0]];
rejects(quotePdfEnvelopeSchemaId, successWithBlocker);

const successWithRejectedOperation = structuredClone(successEnvelope);
successWithRejectedOperation.data.operation_status = "rejected";
rejects(quotePdfEnvelopeSchemaId, successWithRejectedOperation);

const successWithMismatchedPreview = structuredClone(successEnvelope);
successWithMismatchedPreview.data.operation_status = "previewed";
rejects(quotePdfEnvelopeSchemaId, successWithMismatchedPreview);

const successWithUnknownField = structuredClone(successEnvelope);
successWithUnknownField.unexpected = true;
rejects(quotePdfEnvelopeSchemaId, successWithUnknownField);

for (const status of ["needs_input", "manual_review", "blocked", "unavailable"]) {
  const validFailure = structuredClone(successEnvelope);
  validFailure.status = status;
  validFailure.data = null;
  validFailure.blockers = [successEnvelope.warnings[0]];
  validate(quotePdfEnvelopeSchemaId, validFailure);

  const nonNullFailure = structuredClone(validFailure);
  nonNullFailure.data = writeResult;
  rejects(quotePdfEnvelopeSchemaId, nonNullFailure);

  const missingBlocker = structuredClone(validFailure);
  missingBlocker.blockers = [];
  rejects(quotePdfEnvelopeSchemaId, missingBlocker);
}

console.log("quote.create_pdf contract checks passed");
