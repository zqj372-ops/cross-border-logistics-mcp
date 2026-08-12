import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixtureSnapshot } from "./fixture-data.js";

const files = {
  html: await readFile(new URL("./index.html", import.meta.url), "utf8"),
  css: await readFile(new URL("./styles.css", import.meta.url), "utf8"),
  app: await readFile(new URL("./app.js", import.meta.url), "utf8"),
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
assert.match(files.app, /disabled title="未连接正式后台/);
assert.match(files.app, /不会回退到演示数据/);
assert.equal(fixtureSnapshot.roles.length, 7);
assert.equal(fixtureSnapshot.tools.length, 9);
assert.ok(fixtureSnapshot.tools.every((tool) => tool.kind === "read" || tool.kind === "write"));
assert.ok(fixtureSnapshot.sources.every((source) => source.secret_ref.startsWith("secret_ref:")));
assert.ok(!JSON.stringify(fixtureSnapshot).match(/eyJ|Bearer\s|sk-[A-Za-z0-9]/));

console.log("admin console self-check: PASS");
