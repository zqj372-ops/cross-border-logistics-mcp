import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixtureSnapshot } from "./fixture-data.js";
import {
  architectureNodeStatus,
  deriveArchitectureModel,
  escapeHtml,
  safeOpaqueReference,
  toChineseDisplayText,
  validateSnapshot,
} from "./app.js";
import {
  CONTROL_SCHEMA_VERSION,
  FIXTURE_IDENTITIES,
  actionAvailability,
  deriveDesiredDraftDiff,
  deriveReleaseStages,
  isFixtureIdentityVisible,
  redactReference,
  validateControlState,
} from "./control-plane.js";

const files = {
  html: await readFile(new URL("./index.html", import.meta.url), "utf8"),
  css: await readFile(new URL("./styles.css", import.meta.url), "utf8"),
  app: await readFile(new URL("./app.js", import.meta.url), "utf8"),
  controlPlane: await readFile(new URL("./control-plane.js", import.meta.url), "utf8"),
  build: await readFile(new URL("../../deploy/scripts/build.mjs", import.meta.url), "utf8"),
};

assert.match(files.html, /<main[^>]+id="main-content"/);
assert.match(files.html, /skip-link/);
assert.match(files.html, /<dialog[^>]+aria-labelledby/);
assert.match(files.html, /<script type="module" src="\.\/app\.js"><\/script>/);
assert.doesNotMatch(files.html, />[^<]*(?:MCP|JavaScript)[^<]*</);
assert.doesNotMatch(files.app, /<code>|class="[^"]*codeish/);
assert.doesNotMatch(files.css, /\.codeish|(?:^|,)\s*code\s*[{,]/m);
assert.match(files.app, /fetch\("\/admin\/api\/v1\/snapshot"/);
assert.match(files.app, /get\("fixture"\) === "1"/);
assert.match(files.app, /import\("\.\/fixture-data\.js"\)/);
assert.match(files.html, /data-view="architecture"/);
assert.match(files.app, /export function deriveArchitectureModel/);
assert.match(files.app, /name\.split\("\."\)/);
assert.match(files.app, /静态结构图/);
assert.match(files.app, /不证明真实网络连通/);
assert.match(files.app, /未知工具\/未分类/);
assert.match(files.app, /读回或回滚/);
assert.match(files.app, /display\(safeOpaqueReference/);
assert.match(files.app, /category === "business_api"/);
assert.match(files.app, /source-api-card/);
assert.match(files.app, /source\.adapter_contract_version/);
assert.match(files.app, /source\.business_version_evidence/);
assert.match(files.app, /source\.last_checked_at/);
assert.match(files.app, /source\.last_success_at/);
assert.match(files.app, /source\.affected_tools/);
assert.match(files.app, /renderModuleCenter/);
assert.match(files.app, /createControlPlaneClient/);
assert.match(files.app, /data-control-action/);
assert.match(files.app, /manual_review/);
assert.match(files.app, /运行时状态只在发布并精确读回后变化/);
assert.match(files.app, /未获生产资格/);
assert.match(files.app, /不写入存储、地址栏、页面文本或日志/);
assert.match(files.app, /本地演示申请人/);
assert.match(files.app, /本地演示审批人/);
assert.match(files.html, /data-view="modules"/);
assert.match(files.html, /模块中心/);
assert.match(files.html, /Agent 接入/);
assert.match(files.html, /适配器状态/);
assert.match(files.html, /审批与发布/);
assert.match(files.html, /审计日志/);
assert.match(files.app, /报价、关务与客户数据仍由外部权威系统管理/);
assert.match(files.html, /id="identity-dialog"/);
assert.match(files.html, /id="identity-token"[^>]+type="password"/);
assert.match(files.css, /--navy:/);
assert.match(files.css, /prefers-reduced-motion/);
assert.match(files.css, /overflow-x: auto/);
assert.doesNotMatch(files.css, /linear-gradient|radial-gradient|backdrop-filter/i);
assert.doesNotMatch(files.controlPlane, /\b(?:localStorage|sessionStorage|document|window|console)\b/);
assert.match(files.controlPlane, /authorization/);
assert.match(files.controlPlane, /CONTROL_API_ROOT/);
assert.equal(CONTROL_SCHEMA_VERSION, "2026-08-22.v1");
assert.equal(isFixtureIdentityVisible("?fixture=1"), true);
assert.equal(isFixtureIdentityVisible("?fixture=0"), false);
assert.equal(isFixtureIdentityVisible("?fixture=1&other=ok"), true);
assert.equal(isFixtureIdentityVisible(""), false);
assert.equal(FIXTURE_IDENTITIES.length, 2);
assert.ok(FIXTURE_IDENTITIES.every((identity) => identity.role === "admin" && identity.token.length > 0));
assert.equal(redactReference("actor-secret-ref"), "已记录（具体内容隐藏）");
assert.equal(redactReference(undefined), "未返回");
assert.match(files.app, /一个业务接口不可达/);
assert.match(files.app, /affected_tools/);
assert.match(files.app, /metricCard\("发布就绪"/);
assert.match(files.app, /本地确定性执行/);
assert.match(files.app, /外部接口调用/);
assert.match(files.app, /不缓存、不轮询/);
assert.match(files.app, /source\.registration_status/);
assert.match(files.app, /未返回/);
assert.match(files.app, /class="sr-only">层：/);
assert.doesNotMatch(files.app, /data-architecture-id="\$\{escapeHtml\(node\.id\)\}"[^>]*aria-label/);
assert.match(files.css, /\.architecture-relation[\s\S]*font-size: 16px/);
assert.doesNotMatch(files.html, /style\s*=/i);
assert.doesNotMatch(files.app, /style\s*=/i);
assert.doesNotMatch(files.css, /linear-gradient|radial-gradient/i);
assert.doesNotMatch(files.app, /ROLE_ORDER|ROLE_LABELS/);
assert.doesNotMatch(files.app, /display\(client\.(?:client_id|issuer|audience)/);
assert.doesNotMatch(files.app, /display\(tool\.(?:name|permission)/);
assert.doesNotMatch(files.app, /display\(change\.path/);
assert.doesNotMatch(files.app, /display\(entry\.(?:actor|tenant|action|config_version|trace_id)/);
assert.equal(validateSnapshot(fixtureSnapshot), fixtureSnapshot);
assert.equal(escapeHtml(`<img src=x onerror="leak">`), "&lt;img src=x onerror=&quot;leak&quot;&gt;");
assert.equal(toChineseDisplayText("ChatGPT"), "对话助手");
assert.equal(toChineseDisplayText("AI 报价 API"), "智能报价服务");
assert.equal(toChineseDisplayText("RiskCustoms API"), "关务查询服务");
assert.equal(toChineseDisplayText("quote.save_draft"), "技术信息已隐藏");
assert.equal(toChineseDisplayText("已通过中文校验"), "已通过中文校验");
assert.equal(
  safeOpaqueReference("endpoint_ref:https://internal.invalid/api", "endpoint_ref"),
  "已配置（具体内容隐藏）",
);
assert.equal(safeOpaqueReference("secret_ref:Bearer secret-token", "secret_ref"), "已配置（具体内容隐藏）");
assert.equal(safeOpaqueReference("endpoint_ref:knowledge/curated", "endpoint_ref"), "已配置（具体内容隐藏）");
assert.equal(safeOpaqueReference(undefined, "secret_ref"), "未返回");

const controlDescriptorDigest = `sha256:${"b".repeat(64)}`;
const controlState = {
  kind: "control_state",
  activation: {
    state: "active",
    release_id: "release-1",
    revision: 1,
    active_modules: [{
      module_id: "cargo",
      version: "1.0.0",
      descriptor_digest: controlDescriptorDigest,
    }],
  },
  inventory_modules: [{
    module_id: "cargo",
    version: "1.0.0",
    risk_level: "T0",
    descriptor_digest: controlDescriptorDigest,
    evidence_level: "local_build",
    production_eligible: false,
    tool_names: ["cargo.calculate"],
    standard_ids: ["cargo.contract.v1"],
    registration: {
      registered_by_actor_ref: "actor-1",
      registered_at: "2026-08-26T00:00:00Z",
    },
  }],
  latest_preview: null,
  latest_approval: null,
  latest_readback: null,
  release_history: [],
  events: [],
  events_truncated: false,
};
assert.equal(validateControlState(controlState), controlState);
assert.deepEqual(deriveReleaseStages(controlState).map((stage) => stage.status), ["complete", "empty", "empty", "empty"]);
const controlDiff = deriveDesiredDraftDiff(controlState.activation.active_modules, []);
assert.deepEqual([controlDiff.added.length, controlDiff.removed.length, controlDiff.retained.length], [0, 1, 0]);
const availableControlActions = actionAvailability({
  state: controlState,
  draftModules: controlState.activation.active_modules,
  actorRole: "admin",
  actorRef: "actor-1",
  environment: "fixture",
});
assert.equal(availableControlActions.saveDraft, true);
assert.equal(availableControlActions.generatePreview, true);
assert.equal(availableControlActions.publish, false);
assert.equal(availableControlActions.reconcile, false);
assert.equal(availableControlActions.rollback, false);
assert.throws(
  () => validateControlState({ ...controlState, inventory_modules: [{ ...controlState.inventory_modules[0], production_eligible: true }] }),
  /production_eligible/,
);
assert.throws(() => validateSnapshot({ ...fixtureSnapshot, roles: undefined }), /角色/);
assert.throws(
  () => validateSnapshot({
    ...fixtureSnapshot,
    approvals: { ...fixtureSnapshot.approvals, changes: {} },
  }),
  /差异记录/,
);
assert.throws(() => validateSnapshot({ ...fixtureSnapshot, tenant: [] }), /租户/);
assert.match(files.app, /disabled title="未连接正式后台/);
assert.match(files.app, /不会回退到演示数据/);
assert.match(files.app, /activeElement/);
assert.match(files.app, /\.focus\(\)/);
assert.doesNotMatch(files.build, /adminBundleSetting|admin.*bundle/i);
for (const asset of ["index.html", "styles.css", "app.js", "fixture-data.js"]) {
  assert.match(files.build, new RegExp(asset.replace(".", "\\.")));
}
assert.match(files.build, /statSync/);
const distCleanup = files.build.indexOf('rmSync("dist"');
const assetValidation = files.build.indexOf("statSync(path)");
assert.ok(distCleanup >= 0 && distCleanup < assetValidation, "build must clear dist before asset validation");
assert.equal(fixtureSnapshot.roles.length, 7);
assert.equal(fixtureSnapshot.tools.length, 9);
assert.ok(fixtureSnapshot.tools.every((tool) => tool.kind === "read" || tool.kind === "write"));
const businessSources = fixtureSnapshot.sources.filter((source) => source.category === "business_api");
assert.deepEqual(
  businessSources.map((source) => source.label),
  ["智能报价服务", "关务查询服务", "报价单服务"],
);
assert.equal(businessSources.length, 3);
assert.equal(businessSources.find((source) => source.business_key === "quote").adapter_contract_version, "quote-zone-api.v1");
assert.match(businessSources.find((source) => source.business_key === "quote").business_version_evidence, /规则版本.*数据版本.*生效期/);
assert.match(businessSources.find((source) => source.business_key === "quote").blocker, /副作用/);
assert.equal(businessSources.find((source) => source.business_key === "quote").readiness, "unavailable");
assert.match(businessSources.find((source) => source.business_key === "quote").reason, /专项审查.*生产接口约定受阻/);
assert.match(businessSources.find((source) => source.business_key === "quote").blocker, /体积.*始发地.*业务版本.*有效期/);
assert.equal(businessSources.find((source) => source.business_key === "quote").registration_status, "工具约定已注册，接口连接未启用");
assert.equal(businessSources.find((source) => source.business_key === "customs").readiness, "unavailable");
assert.match(businessSources.find((source) => source.business_key === "customs").business_version_evidence, /发布版本标识.*真实查询响应/);
assert.deepEqual(businessSources.find((source) => source.business_key === "customs").affected_tools, ["customs.ca.search", "customs.ca.estimate"]);
assert.equal(businessSources.find((source) => source.business_key === "customs").registration_status, "工具约定已注册，接口连接未启用");
assert.match(businessSources.find((source) => source.business_key === "customs").reason, /当前接口未提供正式税额估算/);
assert.equal(businessSources.find((source) => source.business_key === "pdf").registration_status, "未注册");
assert.match(businessSources.find((source) => source.business_key === "pdf").blocker, /接口说明/);
assert.match(fixtureSnapshot.tools.find((tool) => tool.name === "quote.canada_final_mile.calculate").description, /请求智能报价服务/);
assert.match(fixtureSnapshot.tools.find((tool) => tool.name === "quote.canada_final_mile.calculate").description, /不可用.*失败闭合/);
assert.doesNotMatch(fixtureSnapshot.tools.find((tool) => tool.name === "quote.canada_final_mile.calculate").description, /已版本化规则/);
assert.match(fixtureSnapshot.tools.find((tool) => tool.name === "customs.ca.estimate").description, /固定不可用/);
assert.match(fixtureSnapshot.tools.find((tool) => tool.name === "customs.ca.estimate").description, /不发起网络请求/);
assert.match(fixtureSnapshot.tools.find((tool) => tool.name === "quote.save_draft").description, /固定不可用/);
assert.match(fixtureSnapshot.tools.find((tool) => tool.name === "quote.save_draft").description, /写后读回/);
assert.equal(fixtureSnapshot.tools.find((tool) => tool.name === "quote.canada_final_mile.calculate").availability, "unavailable");
assert.equal(fixtureSnapshot.tools.find((tool) => tool.name === "customs.ca.estimate").availability, "unavailable");
assert.equal(fixtureSnapshot.tools.find((tool) => tool.name === "quote.save_draft").availability, "unavailable");
assert.ok(fixtureSnapshot.sources.filter((source) => source.secret_ref).every((source) => source.secret_ref.startsWith("secret_ref:")));
assert.ok(!JSON.stringify(fixtureSnapshot).match(/eyJ|Bearer\s|sk-[A-Za-z0-9]/));
const visibleFixtureText = [
  fixtureSnapshot.tenant.name,
  fixtureSnapshot.actor.name,
  ...fixtureSnapshot.blockers,
  ...fixtureSnapshot.clients.flatMap((client) => [client.name, client.check.detail]),
  ...fixtureSnapshot.roles.flatMap((role) => [role.label, role.description]),
  ...fixtureSnapshot.tools.flatMap((tool) => [tool.label, tool.description]),
  ...fixtureSnapshot.sources.flatMap((source) => [
    source.label,
    source.type,
    source.business_version_evidence,
    source.update_mode,
    source.registration_status,
    source.reason,
    source.blocker,
  ]),
  fixtureSnapshot.approvals.draft.persistence,
  fixtureSnapshot.approvals.validation.summary,
  ...fixtureSnapshot.approvals.changes.flatMap((change) => [change.before, change.after]),
  ...fixtureSnapshot.approvals.chain.flatMap((step) => [step.label, step.detail]),
  ...fixtureSnapshot.audit.map((entry) => entry.reason),
  ...fixtureSnapshot.status_legend.flatMap((item) => [item.label, item.detail]),
].filter(Boolean);
assert.ok(visibleFixtureText.every((value) => toChineseDisplayText(value) !== "技术信息已隐藏"));

const architecture = deriveArchitectureModel(fixtureSnapshot);
assert.deepEqual(
  architecture.tools.map((tool) => tool.name),
  fixtureSnapshot.tools.map((tool) => tool.name),
  "architecture tools preserve snapshot order",
);
assert.deepEqual(
  architecture.toolGroups.find((group) => group.key === "billing").tools.map((tool) => tool.name),
  ["cargo.calculate", "quote.canada_final_mile.calculate", "quote.save_draft"],
);
assert.deepEqual(
  architecture.toolGroups.find((group) => group.key === "platform").tools.map((tool) => tool.name),
  ["knowledge.search_curated", "system.get_data_status", "review.create_task"],
);
assert.deepEqual(
  architecture.executionGroups.find((group) => group.key === "local").tools.map((tool) => tool.name),
  ["cargo.calculate", "container.plan_summary"],
);
assert.deepEqual(
  architecture.executionGroups.find((group) => group.key === "external").tools.map((tool) => tool.name),
  ["quote.canada_final_mile.calculate", "customs.ca.search", "customs.ca.estimate"],
);
assert.deepEqual(
  architecture.supportingTools.map((tool) => tool.name),
  ["knowledge.search_curated", "system.get_data_status", "quote.save_draft", "review.create_task"],
);
assert.equal(architecture.tools.find((tool) => tool.name === "quote.canada_final_mile.calculate").sourceBusinessKey, "quote");
assert.equal(architecture.tools.find((tool) => tool.name === "quote.canada_final_mile.calculate").sourceReadiness, "unavailable");
assert.equal(architecture.tools.find((tool) => tool.name === "quote.canada_final_mile.calculate").availability, "unavailable");
assert.equal(architecture.tools.find((tool) => tool.name === "customs.ca.search").sourceReadiness, "unavailable");
assert.equal(architecture.tools.find((tool) => tool.name === "quote.save_draft").executionKey, "");
assert.equal(architecture.tools.find((tool) => tool.name === "quote.save_draft").sourceBusinessKey, "");
assert.equal(architecture.tools.find((tool) => tool.name === "quote.save_draft").sourceReadiness, "");
assert.equal(architecture.tools.find((tool) => tool.name === "quote.save_draft").availability, "unavailable");
assert.match(architectureNodeStatus(architecture.tools.find((tool) => tool.name === "quote.save_draft"), "tool"), /不可用/);
assert.equal(architecture.sources.find((source) => source.businessKey === "pdf").readiness, "unavailable");
assert.equal(architecture.sources.find((source) => source.businessKey === "pdf").registrationStatus, "未注册");
assert.ok(!fixtureSnapshot.tools.some((tool) => tool.name.startsWith("pdf.")));
assert.equal(architecture.approvalLifecycle.find((stage) => stage.key === "publish").status, "empty");
assert.equal(architecture.approvalLifecycle.find((stage) => stage.key === "approval").status, "blocked");
assert.ok(architecture.approvalLifecycle.every((stage) => stage.kind === "approval"));
assert.ok(architecture.clients.length > 0 && architecture.sources.length > 0);
assert.match(architectureNodeStatus({ kindLabel: "read", invalidName: false }, "tool"), /只读/);
assert.match(architectureNodeStatus({ kindLabel: "write", invalidName: false }, "tool"), /受控写入/);
assert.match(architectureNodeStatus({ kindLabel: "read", invalidName: true, availability: "ready" }, "tool"), /名称异常/);
assert.doesNotMatch(architectureNodeStatus({ kindLabel: "read", invalidName: true, availability: "ready" }, "tool"), /已就绪/);
assert.match(architectureNodeStatus({ kindLabel: "", invalidName: false }, "tool"), /操作类型未返回/);
assert.match(architectureNodeStatus({ kindLabel: "query", invalidName: false }, "tool"), /操作类型未知/);
assert.equal(deriveArchitectureModel({ ...fixtureSnapshot, tools: [{ name: "custom.preview", kind: "read" }] }).tools[0].availability, "");

const unknownTools = [
  { name: "custom.preview", label: "报价", permission: "quote:calculate", roles: ["admin"], kind: "read" },
  { name: "", label: "空名称", kind: "read" },
  { name: 42, label: "异常名称", kind: "read" },
];
const unknownArchitecture = deriveArchitectureModel({ ...fixtureSnapshot, tools: unknownTools });
assert.deepEqual(
  unknownArchitecture.toolGroups.find((group) => group.key === "unknown").tools.map((tool) => tool.name),
  ["custom.preview", "", 42],
);
assert.equal(unknownArchitecture.toolGroups.find((group) => group.key === "unknown").tools.length, 3);
assert.ok(unknownArchitecture.toolGroups.find((group) => group.key === "unknown").tools[2].invalidName);

const emptyArchitecture = deriveArchitectureModel({
  ...fixtureSnapshot,
  clients: [],
  tools: [],
  sources: [],
  approvals: { ...fixtureSnapshot.approvals, chain: [] },
});
assert.equal(emptyArchitecture.clients.length, 0);
assert.equal(emptyArchitecture.tools.length, 0);
assert.equal(emptyArchitecture.sources.length, 0);
assert.equal(emptyArchitecture.approvalLifecycle.length, 0);
assert.throws(() => deriveArchitectureModel({ ...fixtureSnapshot, clients: null }), /客户端/);

const legacySource = { ...fixtureSnapshot.sources[0] };
for (const field of [
  "category",
  "business_key",
  "environment",
  "adapter_contract_version",
  "business_version_evidence",
  "update_mode",
  "last_checked_at",
  "last_success_at",
  "affected_tools",
  "registration_status",
  "blocker",
]) delete legacySource[field];
const legacySnapshot = { ...fixtureSnapshot, sources: [legacySource] };
assert.equal(validateSnapshot(legacySnapshot), legacySnapshot);
const legacyArchitecture = deriveArchitectureModel(legacySnapshot);
assert.equal(legacyArchitecture.sources[0].adapterContractVersion, "");
assert.equal(legacyArchitecture.sources[0].affectedTools.length, 0);

const missingSourceArchitecture = deriveArchitectureModel({ ...fixtureSnapshot, sources: [{ name: "source_without_status" }] });
assert.equal(missingSourceArchitecture.sources[0].readiness, "empty");
assert.match(architectureNodeStatus(missingSourceArchitecture.sources[0], "source"), /暂无记录/);

console.log("admin console self-check: PASS");
