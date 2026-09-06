import assert from "node:assert/strict";
import { validateBusinessEntrypoints, renderBusinessService, renderBusinessHome } from "./business-services.js";

const empty = {
  schema_version: "business-entrypoints@2026-09-05.v1", status: "success",
  data: {
    quote: { configured: false, sales: null, ai_quote: null, operations: null },
    customs: { configured: false, search: null, calculator: null },
  },
  reason_codes: ["quote_entrypoint_unconfigured", "customs_entrypoint_unconfigured"],
};
const configured = structuredClone(empty);
configured.data.quote = { configured: true, sales: "https://quote.example.invalid/quote", ai_quote: "https://quote.example.invalid/ai-quote", operations: "https://quote.example.invalid/ops" };
configured.data.customs = { configured: true, search: "https://customs.example.invalid/", calculator: "https://customs.example.invalid/calculator" };
configured.reason_codes = [];
assert.equal(validateBusinessEntrypoints(empty), empty);
assert.equal(validateBusinessEntrypoints(configured), configured);
for (const value of ["javascript:alert(1)", "https://user:password@quote.example.invalid/quote", "https://quote.example.invalid/quote?token=secret", "https://quote.example.invalid/quote#secret", "https://other.example.invalid/ops", "//quote.example.invalid/ops", "http://public.example.invalid/ops"]) {
  const unsafe = structuredClone(configured);
  unsafe.data.quote.operations = value;
  assert.throws(() => validateBusinessEntrypoints(unsafe));
  assert.doesNotMatch(renderBusinessService("inquiries", null, { entries: unsafe, entryStatus: "ready" }), /href="https:\/\/quote\.example/);
}
for (const mutate of [
  (value) => { value.schema_version = "unknown"; },
  (value) => { value.data.quote.configured = false; },
  (value) => { value.data.quote.sales = null; },
  (value) => { value.data.customs.extra = "https://evil.invalid/"; },
  (value) => { value.reason_codes = ["untrusted-secret-text"]; },
]) {
  const invalid = structuredClone(configured); mutate(invalid);
  assert.throws(() => validateBusinessEntrypoints(invalid));
}
for (const view of ["customs", "inquiries", "calculator"]) {
  const unavailable = renderBusinessService(view, null, { entries: empty, entryStatus: "ready" });
  assert.doesNotMatch(unavailable, /<form|<textarea|<input|disabled/);
  assert.match(unavailable, /查看接入说明/);
  const html = renderBusinessService(view, null, { entries: configured, entryStatus: "ready" });
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /访问状态未验证/);
  assert.doesNotMatch(html, /生产已就绪|正式查询成功|已报价|<form|<textarea/);
}
const home = renderBusinessHome(null, { entries: configured, entryStatus: "ready" });
for (const label of ["开始询价", "查询关务", "估算进口税费"]) assert.match(home, new RegExp(label));
assert.match(home, /https:\/\/quote\.example\.invalid\/quote/);
assert.match(home, /https:\/\/customs\.example\.invalid\/calculator/);
assert.match(renderBusinessHome(null, { entryStatus: "error" }), /重新读取入口/);
assert.doesNotMatch(renderBusinessHome({ sources: [{ label: '<img src=x onerror="alert(1)">', business_key: "quote", readiness: "ready" }] }, { entries: empty, entryStatus: "ready" }), /<img|生产已就绪/);
console.log("Business entrypoint frontend checks: PASS");
