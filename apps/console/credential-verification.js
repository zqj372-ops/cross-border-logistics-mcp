import { cargoExample } from './api-examples.js';

const statusValues = new Set(['success', 'needs_input', 'manual_review', 'blocked', 'unavailable']);
const known = Object.freeze({
  t0: Object.freeze(['cargo.calculate', 'container.plan_summary', 'system.agent_context.get']),
  business: Object.freeze(['quote.zone_preview', 'customs.query', 'customs.tax.estimate', 'quote.ai_extract_preview', 'quote.freightcom_ltl.preview']),
});
const samples = Object.freeze({
  'cargo.calculate': Object.freeze({ path: '/api/v2/tools/cargo.calculate', fixturePath: '/api/fixture/v1/tools/cargo.calculate', input: cargoExample }),
  'quote.zone_preview': Object.freeze({ path: '/api/v2/business/quote/zone-preview', input: Object.freeze({ postal_code: 'M1B 5W9', city: 'Toronto', province: 'ON', cbm: '1.2', weight_kg: '300', piece_count: 2, packaging_type: 'carton', address_type: 'commercial', requires_liftgate: false, requires_pallet_jack: false, requires_appointment: false, explicit_pallet_count: null, is_stackable: null, detention_minutes: 0 }) }),
  'customs.query': Object.freeze({ path: '/api/v2/business/customs/query', input: Object.freeze({ query: '不锈钢水杯', ruleDate: new Date().toLocaleDateString('en-CA'), codeCountry: 'CN', attributes: Object.freeze({ originCountry: 'CN', material: '不锈钢', use: '日常饮水' }) }) }),
  'customs.tax.estimate': Object.freeze({ path: '/api/v2/business/customs/tax-estimate', input: Object.freeze({ ruleDate: new Date().toLocaleDateString('en-CA'), lineId: 'item_1', description: '不锈钢水杯', hsCode: '732393', destinationCountry: 'CA', declaredValue: '1000', currency: 'CAD', attributes: Object.freeze({ originCountry: 'CN', material: '不锈钢' }) }) }),
});

function result(value) { return Object.freeze(value); }
function safeText(value, secrets) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) return null;
  if (/^(?:flcbk|lmcpk)_/u.test(value)) return null;
  return secrets.some((secret) => secret && value.includes(secret)) ? null : value;
}
function safeReasons(value, secrets) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => safeText(item, secrets)).filter(Boolean))].slice(0, 12);
}
function selectedOperation(kind, allowedNames) {
  if (!Array.isArray(allowedNames)) return null;
  const allowed = new Set(allowedNames.filter((value) => typeof value === 'string'));
  return (kind === 'unified' ? [...known.t0, ...known.business] : known[kind]).find((name) => allowed.has(name)) || null;
}
function exchangeRequest(kind, operation, mode) {
  if (kind === 'unified') return known.business.includes(operation) ? exchangeRequest('business', operation, mode) : { path: '/access/v2/application/token/exchange', body: { schema_version: 'application-exchange@2026-09-06.v1', requested_tool_names: [operation] } };
  if (kind === 'business') return { path: '/access/v2/business/token/exchange', body: { schema_version: 'business-exchange@2026-09-05.v1', requested_operations: [operation] } };
  return { path: mode === 'fixtures' ? '/access/v1/token/exchange' : '/access/v2/tools/token/exchange', body: { schema_version: '2026-08-27.v1', requested_tool_names: [operation] } };
}
function sampleRequest(kind, operation, mode) {
  const sample = samples[operation]; if (!sample) return null;
  if (kind === 'business') return { path: sample.path, body: { schema_version: 'business-call@2026-09-05.v1', input: sample.input } };
  return { path: mode === 'fixtures' ? sample.fixturePath : sample.path, body: mode === 'fixtures' ? { input: sample.input } : sample.input };
}
function requestSignal(signal, milliseconds) { const timeout = AbortSignal.timeout(milliseconds); return signal ? AbortSignal.any([signal, timeout]) : timeout; }
async function responseJson(response) { try { const value = await response.json(); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
function interruption(input, stage, operation, exchangeVerified, sampleCalled) {
  const cancelled = input.signal?.aborted === true;
  return result({ status: 'unavailable', stage, verification: cancelled ? 'cancelled' : 'connection_unavailable', operation, exchange_verified: exchangeVerified, sample_called: sampleCalled, http_status: null, request_id: null, reason_codes: [cancelled ? 'verification_cancelled' : 'connection_unavailable'], summary: cancelled ? '自动验证已取消，凭证状态没有被判定为成功。' : '自动验证请求未完成，请检查连接后重试。' });
}

export async function verifyCredentialAfterDelivery(input) {
  const secrets = { key: typeof input?.key === 'string' ? input.key : '', token: null };
  try {
    const kind = input?.kind; const mode = input?.mode; const fetchImpl = input?.fetchImpl || fetch;
    if (!['t0', 'business', 'unified'].includes(kind) || !['fixtures', 'production'].includes(mode) || !secrets.key || typeof fetchImpl !== 'function') return result({ status: 'blocked', stage: 'token_exchange', verification: 'scope_unavailable', operation: null, exchange_verified: false, sample_called: false, http_status: null, request_id: null, reason_codes: ['verification_input_invalid'], summary: '没有可安全验证的凭证范围。' });
    const operation = selectedOperation(kind, input.allowedNames);
    if (!operation) return result({ status: 'blocked', stage: 'token_exchange', verification: 'scope_unavailable', operation: null, exchange_verified: false, sample_called: false, http_status: null, request_id: null, reason_codes: ['verification_scope_unavailable'], summary: '当前凭证没有可验证的已知权限。' });
    if (input.signal?.aborted) return interruption(input, 'token_exchange', operation, false, false);
    if (kind === 'unified' && samples[operation]) {
      const sample = sampleRequest(known.business.includes(operation) ? 'business' : 't0', operation, 'production');
      let response;
      try { response = await fetchImpl(sample.path, { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${secrets.key}` }, body: JSON.stringify(sample.body), signal: requestSignal(input.signal, 45000) }); }
      catch { return interruption(input, 'sample_call', operation, false, true); }
      const value = await responseJson(response);
      const status = [401, 403].includes(response.status) ? 'blocked' : (!response.ok && value.status === 'success') ? 'unavailable' : statusValues.has(value.status) ? value.status : response.status === 400 ? 'needs_input' : 'unavailable';
      const verification = { success: 'call_success', unavailable: 'source_unavailable', manual_review: 'source_requires_review', needs_input: 'input_required', blocked: 'call_blocked' }[status];
      const summary = { success: '只读样例调用已完成，API Key 可用于这项服务。', unavailable: '服务返回暂不可用，请核对连接或来源数据发布状态。', manual_review: '接口已返回结果，需要按提示完成业务复核。', needs_input: '接口要求补充资料，请按返回内容完善输入。', blocked: '调用未通过，请核对 Key、交付状态和当前服务权限。' }[status];
      return result({ status, stage: 'sample_call', verification, operation, exchange_verified: false, sample_called: true, http_status: response.status, request_id: safeText(value.request_id || value.data?.requestId, [secrets.key]), reason_codes: safeReasons(value.reason_codes, [secrets.key]), summary });
    }
    const exchangeSpec = exchangeRequest(kind, operation, mode);
    let exchangeResponse;
    try { exchangeResponse = await fetchImpl(exchangeSpec.path, { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${secrets.key}` }, body: JSON.stringify(exchangeSpec.body), signal: requestSignal(input.signal, 15000) }); }
    catch { return interruption(input, 'token_exchange', operation, false, false); }
    const exchangeValue = await responseJson(exchangeResponse); secrets.token = exchangeValue.data?.access_token || exchangeValue.access_token || null;
    const exchangeSecrets = [secrets.key, typeof secrets.token === 'string' ? secrets.token : ''];
    if (!exchangeResponse.ok || exchangeValue.status !== 'success' || typeof secrets.token !== 'string' || !secrets.token) {
      return result({ status: 'blocked', stage: 'token_exchange', verification: 'exchange_failed', operation, exchange_verified: false, sample_called: false, http_status: exchangeResponse.status, request_id: safeText(exchangeValue.request_id, exchangeSecrets), reason_codes: safeReasons(exchangeValue.reason_codes || exchangeValue.error?.reason_codes, exchangeSecrets), summary: '凭证兑换未通过，请核对交付状态、有效期与授权范围。' });
    }
    secrets.key = '';
    const sample = sampleRequest(kind, operation, mode);
    if (!sample) return result({ status: 'success', stage: 'token_exchange', verification: 'exchange_only', operation, exchange_verified: true, sample_called: false, http_status: exchangeResponse.status, request_id: safeText(exchangeValue.request_id, [secrets.token]), reason_codes: [], summary: '凭证兑换已通过；当前权限没有安全的自动样例，因此未发起业务调用。' });
    let callResponse;
    try { callResponse = await fetchImpl(sample.path, { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secrets.token}` }, body: JSON.stringify(sample.body), signal: requestSignal(input.signal, 45000) }); }
    catch { return interruption(input, 'sample_call', operation, true, true); }
    const callValue = await responseJson(callResponse); const protectedValues = [secrets.token]; const callStatus = statusValues.has(callValue.status) ? callValue.status : null;
    if (!callResponse.ok || !callStatus) {
      const status = callResponse.status === 400 ? 'needs_input' : [401, 403].includes(callResponse.status) ? 'blocked' : 'unavailable';
      return result({ status, stage: 'sample_call', verification: 'call_failed', operation, exchange_verified: true, sample_called: true, http_status: callResponse.status, request_id: safeText(callValue.request_id || callValue.data?.requestId, protectedValues), reason_codes: safeReasons(callValue.reason_codes, protectedValues), summary: '接口调用没有返回可确认的业务状态，请按原因检查连接或输入。' });
    }
    const verification = callStatus === 'success' ? 'call_success' : callStatus === 'manual_review' ? 'source_requires_review' : callStatus === 'unavailable' ? 'source_unavailable' : callStatus === 'needs_input' ? 'input_required' : 'call_blocked';
    const summaries = { success: '安全样例调用已完成；业务使用时仍需核对实际输入和来源。', manual_review: '接口已连接，但样例结果需要人工复核，不能视为业务成功。', unavailable: '接口已连接，但来源服务当前不可用。', needs_input: '接口已连接，但样例仍需要补充资料。', blocked: '换票已通过，但样例调用被当前授权或服务状态阻止。' };
    return result({ status: callStatus, stage: 'sample_call', verification, operation, exchange_verified: true, sample_called: true, http_status: callResponse.status, request_id: safeText(callValue.request_id || callValue.data?.requestId, protectedValues), reason_codes: safeReasons(callValue.reason_codes, protectedValues), summary: summaries[callStatus] });
  } finally { secrets.key = ''; secrets.token = null; }
}
