export const CONFIG_SCHEMA_VERSION = "2026-08-31.v1";
export const CONFIG_API_ROOT = "/admin/api/v1/config";
export const CONFIG_FIELD_KINDS = Object.freeze([
  "integer",
  "boolean",
  "enum",
  "secret_slot",
]);

const CONFIG_SPEC_REQUIRED_KEYS = ["spec_id", "version", "scope", "restart_policy", "fields"];
const CONFIG_SPEC_OPTIONAL_KEYS = [
  "approval_policy",
  "validation_policy",
  "readback_policy",
  "rollback_policy",
];
const CONFIG_FIELD_REQUIRED_KEYS = ["field_id", "kind", "label"];
const CONFIG_FIELD_OPTIONAL_KEYS = ["description", "unit", "minimum", "maximum", "options", "required"];
const CONFIG_OPTION_KEYS = ["id", "label"];
const CONFIG_VALUE_KEYS = ["field_id", "kind", "value"];
const CONFIG_CURRENT_KEYS = ["revision", "config_digest", "module_generation", "values"];
const CONFIG_STATE_REQUIRED_KEYS = [
  "schema_version",
  "module_id",
  "actor_ref",
  "config_spec",
  "current",
  "status",
  "reason_codes",
  "checked_at",
  "allowed_actions",
];
const CONFIG_STATE_OPTIONAL_KEYS = ["latest_preview", "latest_approval", "latest_readback", "readback"];
const CONFIG_READBACK_KEYS = [
  "revision",
  "config_digest",
  "module_generation",
  "status",
  "reason_codes",
  "checked_at",
];
const CONFIG_READBACK_OPTIONAL_KEYS = ["release_id"];
const CONFIG_PREVIEW_KEYS = [
  "preview_ref",
  "creator_actor_ref",
  "revision",
  "config_digest",
  "module_generation",
  "expires_at",
  "status",
];
const CONFIG_APPROVAL_KEYS = [
  "approval_id",
  "preview_ref",
  "approver_actor_ref",
  "decision",
  "status",
];
const CONFIG_ENVELOPE_KEYS = [
  "schema_version",
  "request_id",
  "trace_id",
  "audit_id",
  "status",
  "data",
  "reason_codes",
  "readback",
];
const CONFIG_ENVELOPE_READBACK_KEYS = ["status", "revision", "config_digest", "module_generation"];
const CONFIG_STATUSES = new Set([
  "success",
  "needs_input",
  "readback_verified",
  "active_verified",
  "pending",
  "validated",
  "previewed",
  "approved",
  "published_pending_apply",
  "restarting",
  "manual_review",
  "blocked",
  "unavailable",
  "unknown",
]);
const CONFIG_ACTIONS = new Set([
  "validate",
  "validate_draft",
  "preview",
  "create_preview",
  "approve",
  "publish",
  "reconcile",
  "rollback",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const RFC3339_PATTERN = /^(?:(?:[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8])))|(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29))T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:[.][0-9]{1,9})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/;
const UNSAFE_REFERENCE_PATTERN = /(?:https?:\/\/|ftp:\/\/|\b(?:bearer|token|password|secret|api[_ -]?key|private[_ -]?key|dsn)\b\s*[:=])/i;
const MAX_FIELDS = 64;
const MAX_OPTIONS = 64;
const MAX_VALUES = 64;
const MAX_REASON_CODES = 32;
const MAX_ACTIONS = 16;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, required, optional, label) {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} 包含未知字段。`);
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} 字段不完整。`);
  }
}

function nonEmptyString(value, label, pattern = null) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} 必须是非空文本。`);
  if (pattern !== null && !pattern.test(value)) throw new Error(`${label} 格式无效。`);
  return value;
}

function safeText(value, label) {
  nonEmptyString(value, label);
  if (UNSAFE_REFERENCE_PATTERN.test(value)) throw new Error(`${label} 不得包含地址或凭证内容。`);
  return value;
}

function safeIdentifier(value, label) {
  nonEmptyString(value, label, IDENTIFIER_PATTERN);
  if (UNSAFE_REFERENCE_PATTERN.test(value)) throw new Error(`${label} 不得包含地址或凭证内容。`);
  return value;
}

function safeVersion(value, label) {
  return nonEmptyString(value, label, VERSION_PATTERN);
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值。`);
  return value;
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} 必须是安全整数。`);
  return value;
}

function nonNegativeInteger(value, label) {
  safeInteger(value, label);
  if (value < 0) throw new Error(`${label} 必须是非负整数。`);
  return value;
}

function validateTimestamp(value, label) {
  return nonEmptyString(value, label, RFC3339_PATTERN);
}

function validateReasonCodes(value, label) {
  if (!Array.isArray(value) || value.length > MAX_REASON_CODES) {
    throw new Error(`${label} 必须是有限原因代码数组。`);
  }
  const seen = new Set();
  value.forEach((item, index) => {
    safeIdentifier(item, `${label}[${index}]`);
    if (seen.has(item)) throw new Error(`${label} 不得包含重复项。`);
    seen.add(item);
  });
  return value;
}

function validateOption(value, label) {
  exactKeys(value, CONFIG_OPTION_KEYS, [], label);
  safeIdentifier(value.id, `${label}.id`);
  safeText(value.label, `${label}.label`);
  return value;
}

function validateOptions(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPTIONS) {
    throw new Error(`${label} 必须是 1 到 ${MAX_OPTIONS} 项。`);
  }
  const seen = new Set();
  value.forEach((option, index) => {
    validateOption(option, `${label}[${index}]`);
    if (seen.has(option.id)) throw new Error(`${label} 不得包含重复选项。`);
    seen.add(option.id);
  });
  return value;
}

function validateConfigField(value, index) {
  const label = `config_spec.fields[${index}]`;
  exactKeys(value, CONFIG_FIELD_REQUIRED_KEYS, CONFIG_FIELD_OPTIONAL_KEYS, label);
  safeIdentifier(value.field_id, `${label}.field_id`);
  if (!CONFIG_FIELD_KINDS.includes(value.kind)) throw new Error(`${label}.kind 无效。`);
  safeText(value.label, `${label}.label`);
  if (Object.hasOwn(value, "description")) safeText(value.description, `${label}.description`);
  if (Object.hasOwn(value, "unit")) safeText(value.unit, `${label}.unit`);
  if (Object.hasOwn(value, "required")) booleanValue(value.required, `${label}.required`);

  const hasMinimum = Object.hasOwn(value, "minimum");
  const hasMaximum = Object.hasOwn(value, "maximum");
  if (hasMinimum) safeInteger(value.minimum, `${label}.minimum`);
  if (hasMaximum) safeInteger(value.maximum, `${label}.maximum`);
  if (hasMinimum && hasMaximum && value.minimum > value.maximum) {
    throw new Error(`${label} 的数值范围无效。`);
  }

  if (value.kind === "integer") {
    if (Object.hasOwn(value, "options")) throw new Error(`${label}.integer 不得带 options。`);
  } else if (value.kind === "boolean") {
    if (hasMinimum || hasMaximum || Object.hasOwn(value, "options")) {
      throw new Error(`${label}.boolean 不得带数值范围或 options。`);
    }
  } else {
    if (hasMinimum || hasMaximum) throw new Error(`${label}.${value.kind} 不得带数值范围。`);
    validateOptions(value.options, `${label}.options`);
  }
  return value;
}

export function validateConfigSpec(value) {
  if (value === null) return null;
  exactKeys(value, CONFIG_SPEC_REQUIRED_KEYS, CONFIG_SPEC_OPTIONAL_KEYS, "config_spec");
  safeIdentifier(value.spec_id, "config_spec.spec_id");
  safeVersion(value.version, "config_spec.version");
  if (value.scope !== "deployment") throw new Error("config_spec.scope 必须是 deployment。" );
  if (value.restart_policy !== "none" && value.restart_policy !== "controlled_restart") {
    throw new Error("config_spec.restart_policy 无效。" );
  }
  if (!Array.isArray(value.fields) || value.fields.length > MAX_FIELDS) {
    throw new Error(`config_spec.fields 必须是 0 到 ${MAX_FIELDS} 项。`);
  }
  const seen = new Set();
  value.fields.forEach((field, index) => {
    validateConfigField(field, index);
    if (seen.has(field.field_id)) throw new Error("config_spec.fields 不得包含重复 field_id。" );
    seen.add(field.field_id);
  });
  for (const policy of CONFIG_SPEC_OPTIONAL_KEYS) {
    if (Object.hasOwn(value, policy)) safeText(value[policy], `config_spec.${policy}`);
  }
  return value;
}

function validateConfigValueAgainstField(value, field, label) {
  if (value.kind !== field.kind) throw new Error(`${label}.kind 与 ConfigSpec 不匹配。`);
  if (field.kind === "integer") {
    safeInteger(value.value, `${label}.value`);
    if (Object.hasOwn(field, "minimum") && value.value < field.minimum) throw new Error(`${label}.value 低于最小值。`);
    if (Object.hasOwn(field, "maximum") && value.value > field.maximum) throw new Error(`${label}.value 高于最大值。`);
  } else if (field.kind === "boolean") {
    booleanValue(value.value, `${label}.value`);
  } else {
    safeIdentifier(value.value, `${label}.value`);
    if (!field.options.some((option) => option.id === value.value)) {
      throw new Error(`${label}.value 不在服务端允许选项内。`);
    }
  }
}

function validateConfigValueShape(value, label) {
  exactKeys(value, CONFIG_VALUE_KEYS, [], label);
  safeIdentifier(value.field_id, `${label}.field_id`);
  if (!CONFIG_FIELD_KINDS.includes(value.kind)) throw new Error(`${label}.kind 无效。`);
  if (value.kind === "integer") safeInteger(value.value, `${label}.value`);
  else if (value.kind === "boolean") booleanValue(value.value, `${label}.value`);
  else safeIdentifier(value.value, `${label}.value`);
  return value;
}

function validateConfigValueArrayShape(values, label) {
  if (!Array.isArray(values) || values.length > MAX_VALUES) {
    throw new Error(`${label} 必须是 0 到 ${MAX_VALUES} 项。`);
  }
  const seen = new Set();
  values.forEach((value, index) => {
    validateConfigValueShape(value, `${label}[${index}]`);
    if (seen.has(value.field_id)) throw new Error(`${label} 不得包含重复 field_id。`);
    seen.add(value.field_id);
  });
  return values;
}

export function validateConfigValues(values, spec, label = "config.values") {
  const validatedSpec = validateConfigSpec(spec);
  if (!Array.isArray(values) || values.length > MAX_VALUES) {
    throw new Error(`${label} 必须是 0 到 ${MAX_VALUES} 项。`);
  }
  if (validatedSpec === null) {
    if (values.length !== 0) throw new Error("没有 ConfigSpec 时不得提交配置值。" );
    return values;
  }
  const fields = new Map(validatedSpec.fields.map((field) => [field.field_id, field]));
  const seen = new Set();
  values.forEach((value, index) => {
    const itemLabel = `${label}[${index}]`;
    exactKeys(value, CONFIG_VALUE_KEYS, [], itemLabel);
    safeIdentifier(value.field_id, `${itemLabel}.field_id`);
    const field = fields.get(value.field_id);
    if (field === undefined) throw new Error(`${itemLabel} 不是 ConfigSpec allowlist 字段。`);
    if (seen.has(value.field_id)) throw new Error(`${label} 不得包含重复 field_id。`);
    seen.add(value.field_id);
    validateConfigValueAgainstField(value, field, itemLabel);
  });
  for (const field of validatedSpec.fields) {
    if (field.required === true && !seen.has(field.field_id)) {
      throw new Error(`${label} 缺少必填字段 ${field.field_id}。`);
    }
  }
  return values;
}

function validateConfigCurrent(value, spec) {
  exactKeys(value, CONFIG_CURRENT_KEYS, [], "config_state.current");
  nonNegativeInteger(value.revision, "config_state.current.revision");
  safeIdentifier(value.config_digest, "config_state.current.config_digest");
  safeIdentifier(value.module_generation, "config_state.current.module_generation");
  validateConfigValues(value.values, spec, "config_state.current.values");
  return value;
}

function validateConfigStatus(value, label) {
  if (typeof value !== "string" || !CONFIG_STATUSES.has(value)) throw new Error(`${label} 无效。`);
  return value;
}

function validateConfigReadback(value, label) {
  exactKeys(value, CONFIG_READBACK_KEYS, CONFIG_READBACK_OPTIONAL_KEYS, label);
  if (Object.hasOwn(value, "release_id")) safeIdentifier(value.release_id, `${label}.release_id`);
  nonNegativeInteger(value.revision, `${label}.revision`);
  safeIdentifier(value.config_digest, `${label}.config_digest`);
  safeIdentifier(value.module_generation, `${label}.module_generation`);
  validateConfigStatus(value.status, `${label}.status`);
  validateReasonCodes(value.reason_codes, `${label}.reason_codes`);
  validateTimestamp(value.checked_at, `${label}.checked_at`);
  return value;
}

function validateConfigPreview(value, label) {
  exactKeys(value, CONFIG_PREVIEW_KEYS, [], label);
  safeIdentifier(value.preview_ref, `${label}.preview_ref`);
  safeIdentifier(value.creator_actor_ref, `${label}.creator_actor_ref`);
  nonNegativeInteger(value.revision, `${label}.revision`);
  safeIdentifier(value.config_digest, `${label}.config_digest`);
  safeIdentifier(value.module_generation, `${label}.module_generation`);
  validateTimestamp(value.expires_at, `${label}.expires_at`);
  validateConfigStatus(value.status, `${label}.status`);
  return value;
}

function validateConfigApproval(value, label) {
  exactKeys(value, CONFIG_APPROVAL_KEYS, [], label);
  safeIdentifier(value.approval_id, `${label}.approval_id`);
  safeIdentifier(value.preview_ref, `${label}.preview_ref`);
  safeIdentifier(value.approver_actor_ref, `${label}.approver_actor_ref`);
  if (value.decision !== "approve" && value.decision !== "reject") throw new Error(`${label}.decision 无效。`);
  validateConfigStatus(value.status, `${label}.status`);
  return value;
}

function validateAllowedActions(value, label) {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) throw new Error(`${label} 数量无效。`);
  const seen = new Set();
  value.forEach((action, index) => {
    safeIdentifier(action, `${label}[${index}]`);
    if (!CONFIG_ACTIONS.has(action)) throw new Error(`${label}[${index}] 不是受支持的服务端动作。`);
    if (seen.has(action)) throw new Error(`${label} 不得包含重复动作。`);
    seen.add(action);
  });
  return value;
}

export function validateConfigState(value) {
  exactKeys(value, CONFIG_STATE_REQUIRED_KEYS, CONFIG_STATE_OPTIONAL_KEYS, "config_state");
  if (value.schema_version !== CONFIG_SCHEMA_VERSION) throw new Error("config_state.schema_version 无效。" );
  safeIdentifier(value.module_id, "config_state.module_id");
  safeIdentifier(value.actor_ref, "config_state.actor_ref");
  const spec = validateConfigSpec(value.config_spec);
  validateConfigCurrent(value.current, spec);
  validateConfigStatus(value.status, "config_state.status");
  validateReasonCodes(value.reason_codes, "config_state.reason_codes");
  validateTimestamp(value.checked_at, "config_state.checked_at");
  validateAllowedActions(value.allowed_actions, "config_state.allowed_actions");
  if (Object.hasOwn(value, "latest_preview")) {
    if (value.latest_preview !== null) validateConfigPreview(value.latest_preview, "config_state.latest_preview");
  }
  if (Object.hasOwn(value, "latest_approval")) {
    if (value.latest_approval !== null) validateConfigApproval(value.latest_approval, "config_state.latest_approval");
  }
  if (Object.hasOwn(value, "latest_readback")) {
    if (value.latest_readback !== null) validateConfigReadback(value.latest_readback, "config_state.latest_readback");
  }
  if (Object.hasOwn(value, "readback")) {
    if (value.readback !== null) validateConfigReadback(value.readback, "config_state.readback");
  }
  return value;
}

function validateConfigActionData(value, expectedKind = null) {
  if (!isRecord(value)) throw new Error("config action data 必须是对象。" );
  const kind = value.kind;
  if (typeof kind !== "string") throw new Error("config action data.kind 缺失。" );
  if (expectedKind !== null && kind !== expectedKind) throw new Error("config action data.kind 不匹配。" );
  if (kind === "config_state") {
    const { kind: _kind, ...state } = value;
    void _kind;
    return validateConfigState(state);
  }
  if (kind === "config_validation") {
    exactKeys(value, ["kind", "status", "reason_codes"], ["validation_ref"], "config_validation");
    validateConfigStatus(value.status, "config_validation.status");
    validateReasonCodes(value.reason_codes, "config_validation.reason_codes");
    if (Object.hasOwn(value, "validation_ref")) safeIdentifier(value.validation_ref, "config_validation.validation_ref");
    return value;
  }
  if (kind === "config_preview") {
    exactKeys(value, ["kind", ...CONFIG_PREVIEW_KEYS], [], "config_preview");
    const { kind: _kind, ...preview } = value;
    void _kind;
    validateConfigPreview(preview, "config_preview");
    return value;
  }
  if (kind === "config_approval") {
    exactKeys(value, ["kind", ...CONFIG_APPROVAL_KEYS], [], "config_approval");
    const { kind: _kind, ...approval } = value;
    void _kind;
    validateConfigApproval(approval, "config_approval");
    return value;
  }
  if (kind === "config_release") {
    exactKeys(value, ["kind", "release_id", "revision", "config_digest", "module_generation", "status"], [], "config_release");
    safeIdentifier(value.release_id, "config_release.release_id");
    nonNegativeInteger(value.revision, "config_release.revision");
    safeIdentifier(value.config_digest, "config_release.config_digest");
    safeIdentifier(value.module_generation, "config_release.module_generation");
    validateConfigStatus(value.status, "config_release.status");
    return value;
  }
  if (kind === "config_reconcile") {
    exactKeys(value, ["kind", "release_id", "revision", "config_digest", "module_generation", "status", "reason_codes", "checked_at"], [], "config_reconcile");
    safeIdentifier(value.release_id, "config_reconcile.release_id");
    nonNegativeInteger(value.revision, "config_reconcile.revision");
    safeIdentifier(value.config_digest, "config_reconcile.config_digest");
    safeIdentifier(value.module_generation, "config_reconcile.module_generation");
    validateConfigStatus(value.status, "config_reconcile.status");
    validateReasonCodes(value.reason_codes, "config_reconcile.reason_codes");
    validateTimestamp(value.checked_at, "config_reconcile.checked_at");
    return value;
  }
  throw new Error("config action data.kind 无效。" );
}

function validateConfigEnvelopeReadback(value) {
  exactKeys(value, CONFIG_ENVELOPE_READBACK_KEYS, [], "config_envelope.readback");
  if (value.status === "not_applicable") {
    if (value.revision !== null || value.config_digest !== null || value.module_generation !== null) {
      throw new Error("config_envelope.readback not_applicable 分支无效。" );
    }
    return value;
  }
  validateConfigStatus(value.status, "config_envelope.readback.status");
  nonNegativeInteger(value.revision, "config_envelope.readback.revision");
  safeIdentifier(value.config_digest, "config_envelope.readback.config_digest");
  safeIdentifier(value.module_generation, "config_envelope.readback.module_generation");
  return value;
}

function validateConfigEnvelope(value, expectedKind = null) {
  exactKeys(value, CONFIG_ENVELOPE_KEYS, [], "config_envelope");
  if (value.schema_version !== CONFIG_SCHEMA_VERSION) throw new Error("config_envelope.schema_version 无效。" );
  safeIdentifier(value.request_id, "config_envelope.request_id");
  safeIdentifier(value.trace_id, "config_envelope.trace_id");
  safeIdentifier(value.audit_id, "config_envelope.audit_id");
  validateConfigStatus(value.status, "config_envelope.status");
  validateReasonCodes(value.reason_codes, "config_envelope.reason_codes");
  validateConfigEnvelopeReadback(value.readback);
  if (value.data !== null) {
    if (expectedKind === "config_state" && value.data.kind === undefined) validateConfigState(value.data);
    else validateConfigActionData(value.data, expectedKind);
  }
  return value;
}

function validateDraftRequest(value, label) {
  exactKeys(value, ["schema_version", "module_id", "base_revision", "values"], [], label);
  if (value.schema_version !== CONFIG_SCHEMA_VERSION) throw new Error(`${label}.schema_version 无效。` );
  safeIdentifier(value.module_id, `${label}.module_id`);
  nonNegativeInteger(value.base_revision, `${label}.base_revision`);
  validateConfigValueArrayShape(value.values, `${label}.values`);
  return value;
}

export function validateConfigDraftRequest(value) {
  return validateDraftRequest(value, "config_draft");
}

function validateApprovalRequest(value) {
  exactKeys(value, ["schema_version", "preview_ref", "decision", "reason_code"], [], "config_approval_request");
  if (value.schema_version !== CONFIG_SCHEMA_VERSION) throw new Error("config_approval_request.schema_version 无效。" );
  safeIdentifier(value.preview_ref, "config_approval_request.preview_ref");
  if (value.decision !== "approve" && value.decision !== "reject") throw new Error("config_approval_request.decision 无效。" );
  safeIdentifier(value.reason_code, "config_approval_request.reason_code");
  return value;
}

function validatePublishRequest(value) {
  exactKeys(value, ["schema_version", "preview_ref", "approval_id"], [], "config_publish_request");
  if (value.schema_version !== CONFIG_SCHEMA_VERSION) throw new Error("config_publish_request.schema_version 无效。" );
  safeIdentifier(value.preview_ref, "config_publish_request.preview_ref");
  safeIdentifier(value.approval_id, "config_publish_request.approval_id");
  return value;
}

function validateReconcileRequest(value) {
  exactKeys(value, ["schema_version", "release_id"], [], "config_reconcile_request");
  if (value.schema_version !== CONFIG_SCHEMA_VERSION) throw new Error("config_reconcile_request.schema_version 无效。" );
  safeIdentifier(value.release_id, "config_reconcile_request.release_id");
  return value;
}

function randomId(prefix) {
  const uuid = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${uuid}`;
}

export class ConfigPlaneError extends Error {
  constructor(message, { status = "unavailable", reasonCodes = [], data = null } = {}) {
    super(message);
    this.name = "ConfigPlaneError";
    this.status = status;
    this.reasonCodes = Array.isArray(reasonCodes) ? reasonCodes.filter((item) => typeof item === "string") : [];
    this.data = data;
  }
}

function actionKind(action) {
  return {
    state: "config_state",
    validate: "config_validation",
    preview: "config_preview",
    approve: "config_approval",
    publish: "config_release",
    reconcile: "config_reconcile",
  }[action] ?? null;
}

function actionStatus(value, fallback) {
  if (value === "success") return "success";
  if (value === "needs_input") return "needs_input";
  if (value === "manual_review") return "manual_review";
  if (value === "blocked") return "blocked";
  if (value === "unavailable") return "unavailable";
  return fallback;
}

function responseData(payload, { action, responseOk }) {
  const expectedKind = actionKind(action);
  try {
    if (isRecord(payload) && Object.hasOwn(payload, "data") && Object.hasOwn(payload, "readback")) {
      const envelope = validateConfigEnvelope(payload, expectedKind);
      const status = actionStatus(envelope.status, responseOk ? "success" : "blocked");
      if (!responseOk || status !== "success") {
        throw new ConfigPlaneError("配置控制操作未完成。", {
          status,
          reasonCodes: envelope.reason_codes,
          data: envelope.data,
        });
      }
      if (envelope.data === null) throw new Error("配置控制成功响应缺少 data。" );
      return envelope.data;
    }

    if (action === "state") return validateConfigState(payload);
    if (isRecord(payload) && payload.kind === "config_state") return validateConfigActionData(payload, expectedKind);
    return validateConfigActionData(payload, expectedKind);
  } catch (error) {
    if (error instanceof ConfigPlaneError) throw error;
    throw new ConfigPlaneError("配置控制返回格式无效。", {
      status: responseOk ? "unavailable" : "blocked",
    });
  }
}

export function hasExactConfigReadback(expected, observed) {
  if (!isRecord(expected) || !isRecord(observed)) return false;
  const current = observed.current;
  return isRecord(current)
    && Number.isSafeInteger(expected.revision)
    && expected.revision >= 0
    && current.revision === expected.revision
    && typeof expected.config_digest === "string"
    && current.config_digest === expected.config_digest
    && typeof expected.module_generation === "string"
    && current.module_generation === expected.module_generation
    && (observed.status === "readback_verified" || observed.status === "active_verified")
    && Array.isArray(observed.reason_codes)
    && observed.reason_codes.length === 0;
}

export function createPluginConfigClient({ fetchImpl = globalThis.fetch, basePath = CONFIG_API_ROOT } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("需要提供 fetch 实现。" );
  const root = typeof basePath === "string" && basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  if (typeof root !== "string" || root === "" || (root !== CONFIG_API_ROOT && !root.startsWith(`${CONFIG_API_ROOT}/`))) {
    throw new TypeError("配置 API 必须使用固定同源前缀。" );
  }
  let bearerToken = "";

  async function request(path, { method = "GET", body, idempotencyKey, action } = {}) {
    const isPost = method === "POST";
    if (isPost && bearerToken === "") {
      throw new ConfigPlaneError("配置操作需要当前控制面身份。", {
        status: "blocked",
        reasonCodes: ["admin_identity_missing"],
      });
    }
    const headers = new Headers({ accept: "application/json" });
    if (bearerToken !== "") headers.set("authorization", `Bearer ${bearerToken}`);
    if (isPost) {
      headers.set("content-type", "application/json");
      headers.set("idempotency-key", typeof idempotencyKey === "string" && idempotencyKey.trim() !== ""
        ? idempotencyKey
        : randomId("config-ui"));
    }
    let response;
    try {
      response = await fetchImpl(`${root}/${path.replace(/^\//, "")}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      throw new ConfigPlaneError("配置控制请求不可用。", { status: "unavailable" });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ConfigPlaneError("配置控制返回格式无效。", {
        status: response.ok ? "unavailable" : "blocked",
      });
    }
    return responseData(payload, { action, responseOk: response.ok });
  }

  return Object.freeze({
    setToken(token) {
      if (typeof token !== "string" || token.trim() === "") throw new TypeError("token 必须是非空文本。" );
      bearerToken = token;
    },
    clearToken() {
      bearerToken = "";
    },
    async getState(moduleId = "freightcom-ltl") {
      safeIdentifier(moduleId, "module_id");
      const path = moduleId === "freightcom-ltl"
        ? "state"
        : `state?module_id=${encodeURIComponent(moduleId)}`;
      return request(path, { action: "state" });
    },
    async validateDraft(payload, idempotencyKey) {
      validateConfigDraftRequest(payload);
      return request("drafts/validate", {
        method: "POST",
        body: payload,
        idempotencyKey,
        action: "validate",
      });
    },
    async createPreview(payload, idempotencyKey) {
      validateConfigDraftRequest(payload);
      return request("previews", {
        method: "POST",
        body: payload,
        idempotencyKey,
        action: "preview",
      });
    },
    async decideApproval(payload, idempotencyKey) {
      validateApprovalRequest(payload);
      return request("approvals", {
        method: "POST",
        body: payload,
        idempotencyKey,
        action: "approve",
      });
    },
    async publish(payload, idempotencyKey) {
      validatePublishRequest(payload);
      return request("releases/publish", {
        method: "POST",
        body: payload,
        idempotencyKey,
        action: "publish",
      });
    },
    async reconcile(payload, idempotencyKey) {
      validateReconcileRequest(payload);
      return request("releases/reconcile", {
        method: "POST",
        body: payload,
        idempotencyKey,
        action: "reconcile",
      });
    },
  });
}
