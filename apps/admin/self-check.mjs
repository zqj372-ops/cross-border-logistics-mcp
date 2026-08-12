import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixtureSnapshot } from "./fixture-data.js";
import { architectureNodeStatus, deriveArchitectureModel, validateSnapshot } from "./app.js";

const files = {
  html: await readFile(new URL("./index.html", import.meta.url), "utf8"),
  css: await readFile(new URL("./styles.css", import.meta.url), "utf8"),
  app: await readFile(new URL("./app.js", import.meta.url), "utf8"),
  build: await readFile(new URL("../../deploy/scripts/build.mjs", import.meta.url), "utf8"),
};

assert.match(files.html, /<main[^>]+id="main-content"/);
assert.match(files.html, /skip-link/);
assert.match(files.html, /<dialog[^>]+aria-labelledby/);
assert.match(files.html, /<script type="module" src="\.\/app\.js"><\/script>/);
assert.match(files.app, /fetch\("\/admin\/api\/v1\/snapshot"/);
assert.match(files.app, /get\("fixture"\) === "1"/);
assert.match(files.app, /import\("\.\/fixture-data\.js"\)/);
assert.match(files.html, /data-view="architecture"/);
assert.match(files.app, /export function deriveArchitectureModel/);
assert.match(files.app, /name\.split\("\."\)/);
assert.match(files.app, /静态结构图/);
assert.match(files.app, /不证明真实网络连通/);
assert.match(files.app, /未知工具\/未分类/);
assert.match(files.app, /readback\/rollback/);
assert.match(files.app, /display\(safeOpaqueReference/);
assert.match(files.app, /class="sr-only">层：/);
assert.doesNotMatch(files.app, /data-architecture-id="\$\{escapeHtml\(node\.id\)\}"[^>]*aria-label/);
assert.match(files.css, /\.architecture-relation[\s\S]*font-size: 16px/);
assert.doesNotMatch(files.html, /style\s*=/i);
assert.doesNotMatch(files.app, /style\s*=/i);
assert.doesNotMatch(files.css, /linear-gradient|radial-gradient/i);
assert.doesNotMatch(files.app, /ROLE_ORDER|ROLE_LABELS/);
assert.equal(validateSnapshot(fixtureSnapshot), fixtureSnapshot);
assert.throws(() => validateSnapshot({ ...fixtureSnapshot, roles: undefined }), /roles/);
assert.throws(
  () => validateSnapshot({
    ...fixtureSnapshot,
    approvals: { ...fixtureSnapshot.approvals, changes: {} },
  }),
  /approvals\.changes/,
);
assert.throws(() => validateSnapshot({ ...fixtureSnapshot, tenant: [] }), /tenant/);
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
assert.ok(fixtureSnapshot.sources.every((source) => source.secret_ref.startsWith("secret_ref:")));
assert.ok(!JSON.stringify(fixtureSnapshot).match(/eyJ|Bearer\s|sk-[A-Za-z0-9]/));

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
assert.equal(architecture.approvalLifecycle.find((stage) => stage.key === "publish").status, "empty");
assert.equal(architecture.approvalLifecycle.find((stage) => stage.key === "approval").status, "blocked");
assert.ok(architecture.approvalLifecycle.every((stage) => stage.kind === "approval"));
assert.ok(architecture.clients.length > 0 && architecture.sources.length > 0);
assert.match(architectureNodeStatus({ kindLabel: "read", invalidName: false }, "tool"), /只读/);
assert.match(architectureNodeStatus({ kindLabel: "write", invalidName: false }, "tool"), /受控写入/);
assert.match(architectureNodeStatus({ kindLabel: "", invalidName: false }, "tool"), /kind 未返回/);
assert.match(architectureNodeStatus({ kindLabel: "query", invalidName: false }, "tool"), /kind 未知/);

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
assert.throws(() => deriveArchitectureModel({ ...fixtureSnapshot, clients: null }), /clients/);

console.log("admin console self-check: PASS");
