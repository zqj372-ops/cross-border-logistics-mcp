import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";

const contractsDir = fileURLToPath(new URL("./", import.meta.url));
const schemasDir = join(contractsDir, "schemas");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
for (const file of readdirSync(schemasDir).filter((name) => name.endsWith(".json"))) {
  ajv.addSchema(readJson(join(schemasDir, file)));
}

function validate(schemaId, value) {
  const validator = ajv.getSchema(schemaId);
  assert.ok(validator, `missing schema ${schemaId}`);
  assert.equal(validator(value), true, ajv.errorsText(validator.errors));
}

function rejects(schemaId, value) {
  const validator = ajv.getSchema(schemaId);
  assert.ok(validator, `missing schema ${schemaId}`);
  assert.equal(validator(value), false, `expected ${schemaId} to reject the value`);
}

const requestSchemaId =
  "https://schemas.example.invalid/logistics-mcp/2026-08-13/quote-request-v2.schema.json";
const resultSchemaId =
  "https://schemas.example.invalid/logistics-mcp/2026-08-13/quote-result-v2.schema.json";
const v2ResultVersion = "quote-result@2026-08-13.v2";
const commonSchema = readJson(join(schemasDir, "common.schema.json"));
assert.equal(commonSchema.$defs.Date, undefined);

const request = readJson(join(contractsDir, "examples", "v2", "quote-request.json"));
const result = readJson(join(contractsDir, "examples", "v2", "manual-review-quote.json"));
const manualReviewEnvelopeExample = readJson(join(contractsDir, "examples", "v2", "manual-review-quote-envelope.json"));
const zeroCallManualReviewEnvelopeExample = readJson(join(contractsDir, "examples", "v2", "manual-review-zero-call-envelope.json"));
const calculatedEnvelopeExample = readJson(join(contractsDir, "examples", "v2", "success-calculated-quote-envelope.json"));
const unavailableEnvelopeExample = readJson(join(contractsDir, "examples", "v2", "unavailable-quote-envelope.json"));

const v1EnvelopeSchemaId =
  "https://schemas.example.invalid/logistics-mcp/2026-08-11/envelope.schema.json";
const v2EnvelopeSchemaId =
  "https://schemas.example.invalid/logistics-mcp/2026-08-13/quote-envelope-v2.schema.json";
const quoteSourceRef = {
  source_id: "src:quote:preview:demo-001",
  source_type: "fixture",
  system: "quote-v2-contract-test",
  locator: "fixture://quote-v2/demo-001",
  version: "quote-preview-fixture@2026-08-13",
  retrieved_at: "2026-08-13T00:00:00Z",
  authority: "supporting",
};
const envelopeResult = (status, data) => ({
  schema_version: "2026-08-11.v1",
  request_id: `req_quote_v2_${status}`,
  status,
  data,
  source_refs: [quoteSourceRef],
  assumptions: [],
  warnings: [],
  blockers: [],
  calculation_trace: status === "success" ? [{
    step_id: "step:quote:v2:preview",
    operation: "project_upstream_quote_result",
    inputs: [],
    result: "fixture projection",
    source_ref_ids: [quoteSourceRef.source_id],
  }] : [],
  review_status: status === "success" ? "not_required" : "manual_review",
  audit_id: `audit_quote_v2_${status}`,
});

function hasEnvelopeSourceRefs(value) {
  if (value.data?.version !== v2ResultVersion) return true;
  const dataSourceIds = value.data.source_ref_ids;
  const lineItemSourceIds = value.data.line_items.flatMap((lineItem) => lineItem.source_ref_ids);
  const traceSourceIds = value.calculation_trace.flatMap((step) => step.source_ref_ids);
  const referencedIds = [...new Set([...dataSourceIds, ...lineItemSourceIds, ...traceSourceIds])].sort();
  const envelopeIds = [...new Set(value.source_refs.map((source) => source.source_id))].sort();
  return JSON.stringify(referencedIds) === JSON.stringify(envelopeIds);
}

function validateV2Envelope(value) {
  validate(v2EnvelopeSchemaId, value);
  assert.ok(hasEnvelopeSourceRefs(value), "v2 source_ref_ids must be present in envelope source_refs");
}

validate(requestSchemaId, request);
validate(resultSchemaId, result);
validateV2Envelope(manualReviewEnvelopeExample);
validateV2Envelope(zeroCallManualReviewEnvelopeExample);
validateV2Envelope(calculatedEnvelopeExample);
validateV2Envelope(unavailableEnvelopeExample);
assert.equal(zeroCallManualReviewEnvelopeExample.status, "manual_review");
assert.equal(zeroCallManualReviewEnvelopeExample.data, null);
assert.deepEqual(zeroCallManualReviewEnvelopeExample.source_refs, []);
assert.deepEqual(zeroCallManualReviewEnvelopeExample.calculation_trace, []);
assert.equal(unavailableEnvelopeExample.status, "unavailable");
assert.equal(unavailableEnvelopeExample.data, null);
assert.equal(request.origin.warehouse_code === result.origin, false);
assert.equal(result.ready, true);
assert.equal(result.test_data, false);
assert.equal(result.release_hash, result.snapshot_hash);

const manualReviewEnvelope = envelopeResult("manual_review", result);
validateV2Envelope(manualReviewEnvelope);

const calculatedResult = structuredClone(result);
calculatedResult.quote_status = "calculated";
calculatedResult.total = { amount: "100.00", currency: "USD" };
calculatedResult.billing_pallets = 2;
calculatedResult.line_items = [
  {
    line_id: "line:quote:base",
    label: "Canada final-mile base price",
    amount: { amount: "100.00", currency: "USD" },
    pricing_basis: "upstream base price",
    source_ref_ids: ["src:quote:preview:demo-001"],
  },
];
const calculatedEnvelope = envelopeResult("success", calculatedResult);
validateV2Envelope(calculatedEnvelope);

const calculatedEnvelopeWithoutTrace = structuredClone(calculatedEnvelope);
calculatedEnvelopeWithoutTrace.calculation_trace = [];
rejects(v2EnvelopeSchemaId, calculatedEnvelopeWithoutTrace);

const notCalculableResult = structuredClone(result);
notCalculableResult.quote_status = "not_calculable";
validateV2Envelope(envelopeResult("manual_review", notCalculableResult));

const successWithManualReviewData = envelopeResult("success", result);
rejects(v2EnvelopeSchemaId, successWithManualReviewData);

const manualReviewWithCalculatedData = envelopeResult("manual_review", calculatedResult);
rejects(v2EnvelopeSchemaId, manualReviewWithCalculatedData);

const unavailableWithCalculatedData = envelopeResult("unavailable", calculatedResult);
rejects(v2EnvelopeSchemaId, unavailableWithCalculatedData);

const blockedWithManualReviewData = envelopeResult("blocked", result);
rejects(v2EnvelopeSchemaId, blockedWithManualReviewData);

const needsInputWithManualReviewData = envelopeResult("needs_input", result);
rejects(v2EnvelopeSchemaId, needsInputWithManualReviewData);

const missingEnvelopeSourceRef = envelopeResult("manual_review", result);
missingEnvelopeSourceRef.source_refs = [];
rejects(v2EnvelopeSchemaId, missingEnvelopeSourceRef);

const zeroCallManualReviewWithSourceRef = structuredClone(zeroCallManualReviewEnvelopeExample);
zeroCallManualReviewWithSourceRef.source_refs = [quoteSourceRef];
rejects(v2EnvelopeSchemaId, zeroCallManualReviewWithSourceRef);

const zeroCallManualReviewWithTrace = structuredClone(zeroCallManualReviewEnvelopeExample);
zeroCallManualReviewWithTrace.calculation_trace = [{
  step_id: "step:quote:v2:blocked",
  operation: "upstream_call_blocked",
  inputs: [],
  result: "manual review",
  source_ref_ids: [],
}];
rejects(v2EnvelopeSchemaId, zeroCallManualReviewWithTrace);

const mismatchedEnvelopeSourceRef = envelopeResult("manual_review", result);
mismatchedEnvelopeSourceRef.source_refs = structuredClone(mismatchedEnvelopeSourceRef.source_refs);
mismatchedEnvelopeSourceRef.source_refs[0].source_id = "src:quote:other";
assert.throws(
  () => validateV2Envelope(mismatchedEnvelopeSourceRef),
  /v2 source_ref_ids must be present in envelope source_refs/,
);

const missingLineItemSourceRef = structuredClone(calculatedEnvelope);
missingLineItemSourceRef.data.line_items[0].source_ref_ids = ["src:quote:line-item-only"];
assert.throws(
  () => validateV2Envelope(missingLineItemSourceRef),
  /v2 source_ref_ids must be present in envelope source_refs/,
);

const calculatedEnvelopeWithoutTotal = envelopeResult("success", {
  ...calculatedResult,
  total: null,
});
rejects(v2EnvelopeSchemaId, calculatedEnvelopeWithoutTotal);

const manualReviewEnvelopeWithTotal = envelopeResult("manual_review", {
  ...result,
  total: { amount: "100.00", currency: "USD" },
});
rejects(v2EnvelopeSchemaId, manualReviewEnvelopeWithTotal);

const readyFalseEnvelope = envelopeResult("unavailable", {
  ...result,
  ready: false,
});
rejects(v2EnvelopeSchemaId, readyFalseEnvelope);

const envelopeWithInvalidV2Data = envelopeResult("manual_review", result);
envelopeWithInvalidV2Data.data = { ...result, quote_status: "draft_saved" };
rejects(v2EnvelopeSchemaId, envelopeWithInvalidV2Data);

const unknownPalletCount = structuredClone(request);
unknownPalletCount.cargo.explicit_pallet_count = 0;
rejects(requestSchemaId, unknownPalletCount);

const nullablePalletCount = structuredClone(request);
nullablePalletCount.cargo.explicit_pallet_count = null;
validate(requestSchemaId, nullablePalletCount);

for (const field of ["longest_side", "weight_kg", "total_volume"]) {
  for (const zero of ["0", "0.0", "0.000"]) {
    const zeroMeasurement = structuredClone(request);
    zeroMeasurement.cargo[field].value = zero;
    rejects(requestSchemaId, zeroMeasurement);
  }
}

for (const packageTypes of [["pallet", "carton"], ["pallet", "crate"]]) {
  const multiplePackageTypes = structuredClone(request);
  multiplePackageTypes.cargo.package_types = packageTypes;
  rejects(requestSchemaId, multiplePackageTypes);
}

const missingRequired = structuredClone(request);
delete missingRequired.cargo.longest_side;
rejects(requestSchemaId, missingRequired);

const unknownField = structuredClone(request);
unknownField.tenant_id = "tenant-must-be-server-injected";
rejects(requestSchemaId, unknownField);

const legacyBillingPallets = structuredClone(request);
legacyBillingPallets.cargo.billing_pallets = 2;
rejects(requestSchemaId, legacyBillingPallets);

const missingReleaseField = structuredClone(result);
delete missingReleaseField.release_id;
rejects(resultSchemaId, missingReleaseField);

const readyFalseData = structuredClone(result);
readyFalseData.ready = false;
rejects(resultSchemaId, readyFalseData);

const numericMoney = structuredClone(result);
numericMoney.total = { amount: 123.45, currency: "USD" };
rejects(resultSchemaId, numericMoney);

for (const field of ["effective_date", "valid_from", "valid_to"]) {
  const dateTime = structuredClone(result);
  dateTime[field] = "2026-08-13T00:00:00Z";
  rejects(resultSchemaId, dateTime);
}

for (const field of ["valid_from", "valid_to"]) {
  const missingDate = structuredClone(result);
  missingDate[field] = null;
  rejects(resultSchemaId, missingDate);
}

const calculated = structuredClone(result);
calculated.quote_status = "calculated";
calculated.total = { amount: "100.00", currency: "USD" };
calculated.billing_pallets = 2;
calculated.line_items = [
  {
    line_id: "line:quote:base",
    label: "Canada final-mile base price",
    amount: { amount: "100.00", currency: "USD" },
    pricing_basis: "upstream base price",
    source_ref_ids: ["src:quote:preview:demo-001"],
  },
];
validate(resultSchemaId, calculated);

const draftSaved = structuredClone(result);
draftSaved.quote_status = "draft_saved";
rejects(resultSchemaId, draftSaved);

const draftSavedWithTotal = structuredClone(calculated);
draftSavedWithTotal.quote_status = "draft_saved";
rejects(resultSchemaId, draftSavedWithTotal);

const calculatedWithoutTotal = structuredClone(calculated);
calculatedWithoutTotal.total = null;
rejects(resultSchemaId, calculatedWithoutTotal);

const calculatedWithoutLineItems = structuredClone(calculated);
calculatedWithoutLineItems.line_items = [];
rejects(resultSchemaId, calculatedWithoutLineItems);

const manualReviewWithTotal = structuredClone(result);
manualReviewWithTotal.total = { amount: "100.00", currency: "USD" };
rejects(resultSchemaId, manualReviewWithTotal);

const notCalculableWithTotal = structuredClone(result);
notCalculableWithTotal.quote_status = "not_calculable";
notCalculableWithTotal.total = { amount: "100.00", currency: "USD" };
rejects(resultSchemaId, notCalculableWithTotal);

const legacyEnvelope = readJson(join(contractsDir, "examples", "manual-review-quote.json"));
validate(
  v1EnvelopeSchemaId,
  legacyEnvelope,
);
const legacyDraftEnvelope = readJson(join(contractsDir, "examples", "success-quote-save-draft.json"));
validate(v1EnvelopeSchemaId, legacyDraftEnvelope);
validate(
  "https://schemas.example.invalid/logistics-mcp/2026-08-11/quote-result.schema.json",
  legacyEnvelope.data,
);

const catalog = readFileSync(join(contractsDir, "tool-catalog.md"), "utf8");
assert.ok(catalog.includes("v1（历史兼容）"));
assert.ok(catalog.includes("production_eligible=false"));

console.log("quote v2 contract checks passed");
