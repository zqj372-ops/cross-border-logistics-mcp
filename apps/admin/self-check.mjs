import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixtureSnapshot } from "./fixture-data.js";
import { validateSnapshot } from "./app.js";

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

console.log("admin console self-check: PASS");
