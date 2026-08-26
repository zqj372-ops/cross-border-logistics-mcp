const CONTROL_API_ROOT = "/admin/api/v1/control";
export const CONTROL_SCHEMA_VERSION = "2026-08-22.v1";
const CONTROL_STATE_KEYS = [
  "kind",
  "activation",
  "inventory_modules",
  "latest_preview",
  "latest_approval",
  "latest_readback",
  "release_history",
  "events",
  "events_truncated",
];
const MODULE_REF_KEYS = ["module_id", "version", "descriptor_digest"];
const INVENTORY_MODULE_KEYS = [
  "module_id",
  "version",
  "risk_level",
  "descriptor_digest",
  "evidence_level",
  "production_eligible",
  "tool_names",
  "standard_ids",
  "registration",
];
const ACTIVATION_KEYS = ["state", "release_id", "revision", "active_modules"];
const PREVIEW_BASE_KEYS = [
  "preview_ref",
  "canonical_hash",
  "base_release_id",
  "base_revision",
  "desired_modules",
  "diff",
  "validation",
  "creator_actor_ref",
  "created_at",
  "expires_at",
  "consumed",
  "intent",
];
const PREVIEW_DIFF_KEYS = ["added", "removed", "retained"];
const PREVIEW_VALIDATION_KEYS = [
  "base_matches",
  "desired_modules_valid",
  "inventory_matches",
  "minimum_active_modules",
  "reason_codes",
];
const APPROVAL_KEYS = [
  "approval_id",
  "preview_ref",
  "reason_code",
  "approver_actor_ref",
  "decided_at",
  "decision",
  "consumed",
];
const READBACK_BASE_KEYS = [
  "release_id",
  "revision",
  "readback_ref",
  "applied_modules",
  "checked_at",
  "status",
  "reason_codes",
];
const RELEASE_BASE_KEYS = [
  "release_id",
  "revision",
  "desired_modules",
  "previous_release_id",
  "preview_ref",
  "approval_id",
  "publisher_actor_ref",
  "created_at",
  "intent",
  "status",
  "published_at",
  "readback_ref",
  "reason_codes",
  "superseded_by_release_id",
];
const EVENT_KEYS = [
  "sequence",
  "event_id",
  "actor_ref",
  "object_ref",
  "reason_codes",
  "occurred_at",
  "action",
  "kind",
  "status",
];
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const RFC3339_PATTERN = /^(?:(?:[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8])))|(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29))T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:[.][0-9]{1,9})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/;
const PREVIEW_CANONICAL_HASH_PATTERN = /^mcp-control-hash\/v1\/preview\/sha256:[a-f0-9]{64}$/;
const RISK_LEVELS = new Set(["T0", "T1", "T2", "T3"]);
const CONTROL_STATE_MAX_RELEASE_HISTORY = 128;
const CONTROL_STATE_MAX_EVENTS = 256;
const CONTROL_STATE_MAX_REASON_CODES = 32;
const CONTROL_EVENT_ACTIONS = new Set([
  "packages.register",
  "deployments.preview",
  "approvals.decide",
  "deployments.publish",
  "deployments.reconcile",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.some((key) => !expected.has(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} 字段不完整或包含未知字段。`);
  }
}

function nonEmptyString(value, label, pattern) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} 必须是非空文本。`);
  if (pattern && !pattern.test(value)) throw new Error(`${label} 格式无效。`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数。`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数。`);
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值。`);
  return value;
}

function validateNullableIdentifier(value, label) {
  if (value === null) return value;
  return nonEmptyString(value, label, IDENTIFIER_PATTERN);
}

function validateIdentifierArray(value, label, maximumItems) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} 必须是 0 到 ${maximumItems} 项的数组。`);
  }
  const seen = new Set();
  value.forEach((item, index) => {
    nonEmptyString(item, `${label}[${index}]`, IDENTIFIER_PATTERN);
    if (seen.has(item)) throw new Error(`${label} 不得包含重复项。`);
    seen.add(item);
  });
  return value;
}

function validateReasonCodes(value, label, mode = "any") {
  if (!Array.isArray(value) || value.length > CONTROL_STATE_MAX_REASON_CODES) {
    throw new Error(`${label} 必须是 0 到 ${CONTROL_STATE_MAX_REASON_CODES} 项的数组。`);
  }
  value.forEach((item, index) => {
    nonEmptyString(item, `${label}[${index}]`, IDENTIFIER_PATTERN);
  });
  if (mode === "empty" && value.length !== 0) throw new Error(`${label} 必须为空数组。`);
  if (mode === "nonempty" && value.length === 0) throw new Error(`${label} 不得为空。`);
  return value;
}

function validateModuleRef(value, label) {
  exactKeys(value, MODULE_REF_KEYS, label);
  nonEmptyString(value.module_id, `${label}.module_id`, IDENTIFIER_PATTERN);
  nonEmptyString(value.version, `${label}.version`, VERSION_PATTERN);
  nonEmptyString(value.descriptor_digest, `${label}.descriptor_digest`, DIGEST_PATTERN);
  return value;
}

function validateModuleRefs(value, label, allowEmpty = true) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 64) {
    throw new Error(`${label} 必须是 0 到 64 项的模块数组。`);
  }
  const logicalKeys = new Set();
  value.forEach((item, index) => {
    validateModuleRef(item, `${label}[${index}]`);
    const logicalKey = `${item.module_id}\u0000${item.version}`;
    if (logicalKeys.has(logicalKey)) throw new Error(`${label} 不得包含重复模块。`);
    logicalKeys.add(logicalKey);
  });
  return value;
}

function validateActivation(value) {
  exactKeys(value, ACTIVATION_KEYS, "activation");
  if (value.state === "inactive") {
    if (value.release_id !== null || value.revision !== 0) {
      throw new Error("inactive activation 的 release_id/revision 无效。");
    }
    validateModuleRefs(value.active_modules, "activation.active_modules");
    if (value.active_modules.length !== 0) throw new Error("inactive activation 不得包含 active_modules。");
    return value;
  }
  if (value.state !== "active") throw new Error("activation.state 无效。");
  nonEmptyString(value.release_id, "activation.release_id", IDENTIFIER_PATTERN);
  positiveInteger(value.revision, "activation.revision");
  validateModuleRefs(value.active_modules, "activation.active_modules", false);
  return value;
}

function validateRegistration(value, label) {
  if (value === null) return value;
  exactKeys(value, ["registered_by_actor_ref", "registered_at"], label);
  nonEmptyString(value.registered_by_actor_ref, `${label}.registered_by_actor_ref`, IDENTIFIER_PATTERN);
  nonEmptyString(value.registered_at, `${label}.registered_at`, RFC3339_PATTERN);
  return value;
}

function validateInventoryModule(value, index) {
  const label = `inventory_modules[${index}]`;
  exactKeys(value, INVENTORY_MODULE_KEYS, label);
  nonEmptyString(value.module_id, `${label}.module_id`, IDENTIFIER_PATTERN);
  nonEmptyString(value.version, `${label}.version`, VERSION_PATTERN);
  if (!RISK_LEVELS.has(value.risk_level)) throw new Error(`${label}.risk_level 无效。`);
  nonEmptyString(value.descriptor_digest, `${label}.descriptor_digest`, DIGEST_PATTERN);
  if (value.evidence_level !== "local_build") throw new Error(`${label}.evidence_level 必须是 local_build。`);
  if (value.production_eligible !== false) throw new Error(`${label}.production_eligible 必须是 false。`);
  validateIdentifierArray(value.tool_names, `${label}.tool_names`, 128);
  validateIdentifierArray(value.standard_ids, `${label}.standard_ids`, 64);
  validateRegistration(value.registration, `${label}.registration`);
  return value;
}

function validatePreviewDiff(value, label) {
  exactKeys(value, PREVIEW_DIFF_KEYS, label);
  validateModuleRefs(value.added, `${label}.added`);
  validateModuleRefs(value.removed, `${label}.removed`);
  validateModuleRefs(value.retained, `${label}.retained`);
  return value;
}

function validatePreviewValidation(value, label) {
  exactKeys(value, PREVIEW_VALIDATION_KEYS, label);
  booleanValue(value.base_matches, `${label}.base_matches`);
  booleanValue(value.desired_modules_valid, `${label}.desired_modules_valid`);
  booleanValue(value.inventory_matches, `${label}.inventory_matches`);
  booleanValue(value.minimum_active_modules, `${label}.minimum_active_modules`);
  validateReasonCodes(value.reason_codes, `${label}.reason_codes`);
  return value;
}

function validateLatestPreview(value) {
  if (value === null) return value;
  if (!isRecord(value)) throw new Error("latest_preview 必须是对象或 null。");
  if (value.intent !== "change" && value.intent !== "rollback") {
    throw new Error("latest_preview.intent 无效。");
  }
  exactKeys(
    value,
    value.intent === "rollback" ? [...PREVIEW_BASE_KEYS, "target_release_id"] : PREVIEW_BASE_KEYS,
    "latest_preview",
  );
  nonEmptyString(value.preview_ref, "latest_preview.preview_ref", IDENTIFIER_PATTERN);
  nonEmptyString(value.canonical_hash, "latest_preview.canonical_hash", PREVIEW_CANONICAL_HASH_PATTERN);
  validateNullableIdentifier(value.base_release_id, "latest_preview.base_release_id");
  nonNegativeInteger(value.base_revision, "latest_preview.base_revision");
  validateModuleRefs(value.desired_modules, "latest_preview.desired_modules", false);
  validatePreviewDiff(value.diff, "latest_preview.diff");
  validatePreviewValidation(value.validation, "latest_preview.validation");
  nonEmptyString(value.creator_actor_ref, "latest_preview.creator_actor_ref", IDENTIFIER_PATTERN);
  nonEmptyString(value.created_at, "latest_preview.created_at", RFC3339_PATTERN);
  nonEmptyString(value.expires_at, "latest_preview.expires_at", RFC3339_PATTERN);
  booleanValue(value.consumed, "latest_preview.consumed");
  if (value.intent === "rollback") {
    nonEmptyString(value.target_release_id, "latest_preview.target_release_id", IDENTIFIER_PATTERN);
  }
  return value;
}

function validateLatestApproval(value) {
  if (value === null) return value;
  exactKeys(value, APPROVAL_KEYS, "latest_approval");
  nonEmptyString(value.approval_id, "latest_approval.approval_id", IDENTIFIER_PATTERN);
  nonEmptyString(value.preview_ref, "latest_approval.preview_ref", IDENTIFIER_PATTERN);
  nonEmptyString(value.reason_code, "latest_approval.reason_code", IDENTIFIER_PATTERN);
  nonEmptyString(value.approver_actor_ref, "latest_approval.approver_actor_ref", IDENTIFIER_PATTERN);
  nonEmptyString(value.decided_at, "latest_approval.decided_at", RFC3339_PATTERN);
  if (value.decision !== "approve" && value.decision !== "reject") {
    throw new Error("latest_approval.decision 无效。");
  }
  booleanValue(value.consumed, "latest_approval.consumed");
  if (value.decision === "reject" && value.consumed !== false) {
    throw new Error("reject approval 不得标记为已消费。");
  }
  return value;
}

function validateObservedActivation(value, label) {
  exactKeys(value, ["release_id", "revision"], label);
  if (value.release_id === null || value.revision === null) {
    if (value.release_id !== null || value.revision !== null) {
      throw new Error(`${label} 必须同时返回 null 或完整激活标识。`);
    }
    return value;
  }
  nonEmptyString(value.release_id, `${label}.release_id`, IDENTIFIER_PATTERN);
  positiveInteger(value.revision, `${label}.revision`);
  return value;
}

function validateLatestReadback(value) {
  if (value === null) return value;
  if (!isRecord(value)) throw new Error("latest_readback 必须是对象或 null。");
  const observedStatuses = new Set(["pending", "mismatch", "unknown"]);
  if (!["pending", "verified", "mismatch", "unknown"].includes(value.status)) {
    throw new Error("latest_readback.status 无效。");
  }
  exactKeys(
    value,
    observedStatuses.has(value.status) ? [...READBACK_BASE_KEYS, "observed_activation"] : READBACK_BASE_KEYS,
    "latest_readback",
  );
  nonEmptyString(value.release_id, "latest_readback.release_id", IDENTIFIER_PATTERN);
  positiveInteger(value.revision, "latest_readback.revision");
  nonEmptyString(value.readback_ref, "latest_readback.readback_ref", IDENTIFIER_PATTERN);
  validateModuleRefs(value.applied_modules, "latest_readback.applied_modules", value.status !== "verified");
  nonEmptyString(value.checked_at, "latest_readback.checked_at", RFC3339_PATTERN);
  if (value.status === "pending") {
    if (value.observed_activation !== null) throw new Error("pending readback 不得带 observed_activation。");
    validateReasonCodes(value.reason_codes, "latest_readback.reason_codes", "empty");
  } else if (value.status === "verified") {
    validateReasonCodes(value.reason_codes, "latest_readback.reason_codes", "empty");
  } else {
    validateObservedActivation(value.observed_activation, "latest_readback.observed_activation");
    validateReasonCodes(value.reason_codes, "latest_readback.reason_codes", "nonempty");
  }
  return value;
}

function validateReleaseSummary(value, index) {
  const label = `release_history[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  if (value.intent !== "change" && value.intent !== "rollback") {
    throw new Error(`${label}.intent 无效。`);
  }
  exactKeys(
    value,
    value.intent === "rollback" ? [...RELEASE_BASE_KEYS, "rollback_target_release_id"] : RELEASE_BASE_KEYS,
    label,
  );
  nonEmptyString(value.release_id, `${label}.release_id`, IDENTIFIER_PATTERN);
  positiveInteger(value.revision, `${label}.revision`);
  validateModuleRefs(value.desired_modules, `${label}.desired_modules`, false);
  validateNullableIdentifier(value.previous_release_id, `${label}.previous_release_id`);
  nonEmptyString(value.preview_ref, `${label}.preview_ref`, IDENTIFIER_PATTERN);
  nonEmptyString(value.approval_id, `${label}.approval_id`, IDENTIFIER_PATTERN);
  nonEmptyString(value.publisher_actor_ref, `${label}.publisher_actor_ref`, IDENTIFIER_PATTERN);
  nonEmptyString(value.created_at, `${label}.created_at`, RFC3339_PATTERN);
  if (value.intent === "rollback") {
    nonEmptyString(value.rollback_target_release_id, `${label}.rollback_target_release_id`, IDENTIFIER_PATTERN);
  }
  if (value.status === "published_pending_readback") {
    if (value.published_at !== null) nonEmptyString(value.published_at, `${label}.published_at`, RFC3339_PATTERN);
    if (value.readback_ref !== null || value.superseded_by_release_id !== null) {
      throw new Error(`${label} 的待读回字段无效。`);
    }
    validateReasonCodes(value.reason_codes, `${label}.reason_codes`, "empty");
  } else if (value.status === "manual_review") {
    nonEmptyString(value.published_at, `${label}.published_at`, RFC3339_PATTERN);
    nonEmptyString(value.readback_ref, `${label}.readback_ref`, IDENTIFIER_PATTERN);
    if (value.superseded_by_release_id !== null) throw new Error(`${label}.superseded_by_release_id 必须为 null。`);
    validateReasonCodes(value.reason_codes, `${label}.reason_codes`, "nonempty");
  } else if (value.status === "active_verified") {
    nonEmptyString(value.published_at, `${label}.published_at`, RFC3339_PATTERN);
    nonEmptyString(value.readback_ref, `${label}.readback_ref`, IDENTIFIER_PATTERN);
    if (value.superseded_by_release_id !== null) throw new Error(`${label}.superseded_by_release_id 必须为 null。`);
    validateReasonCodes(value.reason_codes, `${label}.reason_codes`, "empty");
  } else if (value.status === "superseded") {
    nonEmptyString(value.published_at, `${label}.published_at`, RFC3339_PATTERN);
    nonEmptyString(value.readback_ref, `${label}.readback_ref`, IDENTIFIER_PATTERN);
    nonEmptyString(value.superseded_by_release_id, `${label}.superseded_by_release_id`, IDENTIFIER_PATTERN);
    validateReasonCodes(value.reason_codes, `${label}.reason_codes`, "empty");
  } else {
    throw new Error(`${label}.status 无效。`);
  }
  return value;
}

function validateControlEvent(value, index) {
  const label = `events[${index}]`;
  exactKeys(value, EVENT_KEYS, label);
  positiveInteger(value.sequence, `${label}.sequence`);
  nonEmptyString(value.event_id, `${label}.event_id`, IDENTIFIER_PATTERN);
  nonEmptyString(value.actor_ref, `${label}.actor_ref`, IDENTIFIER_PATTERN);
  nonEmptyString(value.object_ref, `${label}.object_ref`, IDENTIFIER_PATTERN);
  validateReasonCodes(value.reason_codes, `${label}.reason_codes`);
  nonEmptyString(value.occurred_at, `${label}.occurred_at`, RFC3339_PATTERN);
  const validCombination = (
    value.kind === "registration"
      && value.action === "packages.register"
      && value.status === "registered"
  ) || (
    value.kind === "preview"
      && value.action === "deployments.preview"
      && value.status === "previewed"
  ) || (
    value.kind === "approval"
      && value.action === "approvals.decide"
      && (value.status === "approved" || value.status === "rejected")
  ) || (
    value.kind === "release"
      && value.action === "deployments.publish"
      && ["published_pending_readback", "manual_review", "active_verified", "superseded"].includes(value.status)
  ) || (
    value.kind === "reconciliation"
      && (value.action === "deployments.publish" || value.action === "deployments.reconcile")
      && ["pending", "verified", "mismatch", "unknown"].includes(value.status)
  ) || (
    value.kind === "idempotency"
      && CONTROL_EVENT_ACTIONS.has(value.action)
      && ["reserved", "domain_committed", "completed"].includes(value.status)
  );
  if (!validCombination) throw new Error(`${label} 的 action/kind/status 组合无效。`);
  return value;
}

export function validateControlState(value) {
  exactKeys(value, CONTROL_STATE_KEYS, "control_state");
  if (value.kind !== "control_state") throw new Error("control_state.kind 无效。");
  validateActivation(value.activation);
  if (!Array.isArray(value.inventory_modules) || value.inventory_modules.length > 64) {
    throw new Error("inventory_modules 必须是 0 到 64 项的数组。");
  }
  const inventoryKeys = new Set();
  value.inventory_modules.forEach((item, index) => {
    validateInventoryModule(item, index);
    const key = `${item.module_id}\u0000${item.version}`;
    if (inventoryKeys.has(key)) throw new Error("inventory_modules 不得包含重复模块。");
    inventoryKeys.add(key);
  });
  validateLatestPreview(value.latest_preview);
  validateLatestApproval(value.latest_approval);
  validateLatestReadback(value.latest_readback);
  if (!Array.isArray(value.release_history) || value.release_history.length > CONTROL_STATE_MAX_RELEASE_HISTORY) {
    throw new Error(`release_history 必须是 0 到 ${CONTROL_STATE_MAX_RELEASE_HISTORY} 项的数组。`);
  }
  value.release_history.forEach((release, index) => validateReleaseSummary(release, index));
  if (!Array.isArray(value.events) || value.events.length > CONTROL_STATE_MAX_EVENTS) {
    throw new Error(`events 必须是 0 到 ${CONTROL_STATE_MAX_EVENTS} 项的数组。`);
  }
  value.events.forEach((event, index) => validateControlEvent(event, index));
  if (typeof value.events_truncated !== "boolean") throw new Error("events_truncated 必须是布尔值。");
  return value;
}

export function abbreviateDigest(value, visiblePrefix = 13, visibleSuffix = 8) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) return "未返回";
  if (value.length <= visiblePrefix + visibleSuffix + 1) return value;
  return `${value.slice(0, visiblePrefix)}…${value.slice(-visibleSuffix)}`;
}

export function redactReference(value, fallback = "未返回") {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return "已记录（具体内容隐藏）";
}

function matchesExactModuleRef(module, target) {
  return isRecord(target)
    && module.module_id === target.module_id
    && module.version === target.version
    && module.descriptor_digest === target.descriptor_digest;
}

function approvalMatchesPreview(preview, approval) {
  return preview !== null
    && approval !== null
    && preview.preview_ref === approval.preview_ref;
}

export function isPreviewUsable(preview, nowMs = Date.now()) {
  if (
    !isRecord(preview)
    || preview.consumed !== false
    || typeof preview.expires_at !== "string"
    || !Number.isFinite(nowMs)
  ) {
    return false;
  }
  const expiresAtMs = Date.parse(preview.expires_at);
  return Number.isFinite(expiresAtMs) && nowMs < expiresAtMs;
}

export function derivePreviewPresentation(state) {
  validateControlState(state);
  const preview = state.latest_preview;
  if (preview === null) return { status: "empty", label: "暂无预览" };
  if (preview.consumed === true) {
    return state.latest_readback?.status === "verified" && state.activation.state === "active"
      ? { status: "complete", label: "已用于发布" }
      : { status: "blocked", label: "预览已消费" };
  }
  const approval = approvalMatchesPreview(preview, state.latest_approval) ? state.latest_approval : null;
  if (approval?.decision === "reject") return { status: "blocked", label: "审批未通过" };
  if (approval?.decision === "approve") return { status: "complete", label: "已审批" };
  return { status: "pending", label: "待审批" };
}

export function deriveReleaseStages(state) {
  validateControlState(state);
  const previewPresentation = derivePreviewPresentation(state);
  const approval = state.latest_approval;
  const activation = state.activation;
  const readback = state.latest_readback;
  const registrationTargets = state.latest_preview !== null
    ? (Array.isArray(state.latest_preview.desired_modules) ? state.latest_preview.desired_modules : [])
    : activation.state === "active" ? activation.active_modules : state.inventory_modules;
  const registrationStatus = state.inventory_modules.length === 0 || registrationTargets.length === 0
    ? "empty"
    : registrationTargets.every((target) => state.inventory_modules.some(
      (module) => matchesExactModuleRef(module, target) && module.registration !== null,
    )) ? "complete" : "pending";
  return [
    {
      key: "registration",
      label: "登记制品",
      status: registrationStatus,
    },
    {
      key: "preview",
      label: "生成预览",
      status: previewPresentation.status,
    },
    {
      key: "approval",
      label: "双人审批",
      status: approval === null
        ? "empty"
        : !approvalMatchesPreview(state.latest_preview, approval) ? "manual_review"
        : approval.decision === "approve" ? "complete" : approval.decision === "reject" ? "blocked" : "pending",
    },
    {
      key: "publish_readback",
      label: "发布读回",
      status: readback?.status === "verified" && activation.state === "active"
        ? "complete"
        : readback?.status === "manual_review" || readback?.status === "mismatch" ? "manual_review"
          : readback?.status === "pending" ? "pending"
            : readback?.status === "unknown" ? "unavailable" : "empty",
    },
  ];
}

function moduleKey(module) {
  return `${module.module_id}\u0000${module.version}`;
}

export function deriveDesiredDraftDiff(currentModules, desiredModules) {
  validateModuleRefs(currentModules, "current_modules");
  validateModuleRefs(desiredModules, "desired_modules");
  const current = new Map(currentModules.map((module) => [moduleKey(module), module]));
  const desired = new Map(desiredModules.map((module) => [moduleKey(module), module]));
  return {
    added: desiredModules.filter((module) => !current.has(moduleKey(module))),
    removed: currentModules.filter((module) => !desired.has(moduleKey(module))),
    retained: desiredModules.filter((module) => current.has(moduleKey(module))),
  };
}

export function isFixtureIdentityVisible(search = "") {
  if (typeof search !== "string") return false;
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("fixture") === "1";
}

export const FIXTURE_IDENTITIES = Object.freeze([
  Object.freeze({ actor: "local_operator", label: "本地演示申请人", role: "admin", token: "local-fixture-token" }),
  Object.freeze({ actor: "local_approver", label: "本地演示审批人", role: "admin", token: "local-fixture-approver-token" }),
]);

const RECONCILABLE_RELEASE_STATUSES = new Set([
  "pending",
  "published_pending_readback",
  "manual_review",
]);

export function selectReconcileReleaseId(state) {
  validateControlState(state);
  for (const release of state.release_history) {
    if (RECONCILABLE_RELEASE_STATUSES.has(release.status)) {
      return typeof release.release_id === "string" && IDENTIFIER_PATTERN.test(release.release_id)
        ? release.release_id
        : null;
    }
  }
  return state.activation.state === "active" ? state.activation.release_id : null;
}

const ROLLBACK_ELIGIBLE_RELEASE_STATUSES = new Set([
  "active_verified",
  "superseded",
]);

export function selectRollbackReleaseId(state) {
  validateControlState(state);
  if (state.activation.state !== "active") return null;
  for (const release of state.release_history) {
    if (
      !isRecord(release)
      || !ROLLBACK_ELIGIBLE_RELEASE_STATUSES.has(release.status)
      || !Number.isSafeInteger(release.revision)
      || release.revision <= 0
      || release.revision >= state.activation.revision
    ) {
      continue;
    }
    if (typeof release.release_id === "string" && IDENTIFIER_PATTERN.test(release.release_id)) {
      return release.release_id;
    }
  }
  return null;
}

export function actionAvailability({ state, draftModules, actorRole, actorRef, creatorActorRef, environment = "local", nowMs = Date.now() }) {
  validateControlState(state);
  validateModuleRefs(draftModules, "draft_modules");
  const isAdmin = actorRole === "admin";
  const preview = state.latest_preview;
  const approval = state.latest_approval;
  const readback = state.latest_readback;
  const localWrite = environment === "local" || environment === "fixture";
  const distinctApprover = typeof actorRef === "string"
    && IDENTIFIER_PATTERN.test(actorRef)
    && typeof creatorActorRef === "string"
    && IDENTIFIER_PATTERN.test(creatorActorRef)
    && actorRef !== creatorActorRef;
  const hasPendingRelease = state.release_history.some((release) => release.status === "pending" || release.status === "published_pending_readback" || release.status === "manual_review");
  const reconcileReleaseId = selectReconcileReleaseId(state);
  const rollbackReleaseId = selectRollbackReleaseId(state);
  const usablePreview = isPreviewUsable(preview, nowMs);
  const publishableApproval = approvalMatchesPreview(preview, approval)
    && approval.decision === "approve"
    && approval.consumed === false;
  const previewAlreadyDecided = approvalMatchesPreview(preview, approval);
  const draftModulesRegistered = draftModules.length > 0
    && draftModules.every((target) => state.inventory_modules.some(
      (module) => matchesExactModuleRef(module, target) && module.registration !== null,
    ));
  return {
    saveDraft: true,
    register: isAdmin && localWrite,
    generatePreview: isAdmin && localWrite && draftModulesRegistered,
    submitApproval: isAdmin && localWrite && usablePreview && distinctApprover && !previewAlreadyDecided,
    publish: isAdmin && localWrite && usablePreview && publishableApproval,
    reconcile: isAdmin && localWrite && reconcileReleaseId !== null && (readback === null ? hasPendingRelease : readback.status !== "verified"),
    rollback: isAdmin && localWrite && rollbackReleaseId !== null,
  };
}

export class ControlPlaneError extends Error {
  constructor(message, { status = "unavailable", reasonCodes = [], data = null } = {}) {
    super(message);
    this.name = "ControlPlaneError";
    this.status = status;
    this.reasonCodes = Array.isArray(reasonCodes) ? reasonCodes.filter((item) => typeof item === "string") : [];
    this.data = data;
  }
}

const CONTROL_ENVELOPE_STATUSES = new Set([
  "success",
  "needs_input",
  "manual_review",
  "blocked",
  "unavailable",
]);

function responseData(envelope, fallbackStatus, responseOk = true) {
  if (!isRecord(envelope)) {
    throw new ControlPlaneError("控制面返回格式无效。", { status: fallbackStatus });
  }
  const envelopeStatus = typeof envelope.status === "string" && CONTROL_ENVELOPE_STATUSES.has(envelope.status)
    ? envelope.status
    : fallbackStatus;
  const status = !responseOk && envelopeStatus === "success" ? fallbackStatus : envelopeStatus;
  const reasons = Array.isArray(envelope.reason_codes) ? envelope.reason_codes : [];
  if (status !== "success") {
    throw new ControlPlaneError("控制面操作未完成。", {
      status,
      reasonCodes: reasons,
      data: isRecord(envelope.data) ? envelope.data : null,
    });
  }
  return envelope.data;
}

export function createControlPlaneClient({ fetchImpl = globalThis.fetch, basePath = CONTROL_API_ROOT } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("需要提供 fetch 实现。");
  const root = typeof basePath === "string" && basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  let bearerToken = "";

  async function request(path, { method = "GET", body, idempotencyKey } = {}) {
    const headers = new Headers({ accept: "application/json" });
    if (bearerToken !== "") headers.set("authorization", `Bearer ${bearerToken}`);
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
    let response;
    try {
      response = await fetchImpl(`${root}/${path.replace(/^\//, "")}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
      });
    } catch {
      throw new ControlPlaneError("控制面请求不可用。", { status: "unavailable" });
    }
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new ControlPlaneError("控制面返回格式无效。", { status: "unavailable" });
    }
    return responseData(envelope, response.ok ? "unavailable" : "blocked", response.ok);
  }

  return Object.freeze({
    setToken(token) {
      if (typeof token !== "string" || token.trim() === "") throw new TypeError("token 必须是非空文本。");
      bearerToken = token;
    },
    clearToken() {
      bearerToken = "";
    },
    async getControlState() {
      return validateControlState(await request("state"));
    },
    async registerPackage(payload, idempotencyKey) {
      return request("packages/register", { method: "POST", body: payload, idempotencyKey });
    },
    async createPreview(payload, idempotencyKey) {
      return request("deployments/preview", { method: "POST", body: payload, idempotencyKey });
    },
    async decideApproval(payload, idempotencyKey) {
      return request("approvals", { method: "POST", body: payload, idempotencyKey });
    },
    async publish(payload, idempotencyKey) {
      return request("deployments/publish", { method: "POST", body: payload, idempotencyKey });
    },
    async reconcile(payload, idempotencyKey) {
      return request("deployments/reconcile", { method: "POST", body: payload, idempotencyKey });
    },
  });
}
