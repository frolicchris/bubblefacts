// Tests for bump-version.mjs: `npm run test:scripts` (part of `npm run check`).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addChangelogStub, bumpBetaForm, bumpBugForm, bumpOverlay, changelogId, checkVersion } from "./bump-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const date = new Date(2026, 9, 3);

test("accepts only versions", () => {
  assert.equal(checkVersion("2.0.0-beta.12"), "2.0.0-beta.12");
  assert.equal(checkVersion("2.0.1"), "2.0.1");
  for (const bad of [undefined, "", "v2.0.0", "2.0", "2.0.0 beta"]) assert.throws(() => checkVersion(bad));
});

test("sets the overlay header's version, and only that line", () => {
  const text = "/* BubbleFacts\n *\n * v2.0.0-beta.11\n *\n * Shows 2.0.0-beta.11 facts\n */\n";
  const out = bumpOverlay(text, "2.0.0-beta.12");
  assert.equal(out, text.replace(" * v2.0.0-beta.11", " * v2.0.0-beta.12"));
  assert.equal(bumpOverlay(out, "2.0.0-beta.12"), out);
  assert.match(bumpOverlay(read("frontend/obs/obs-overlay.js"), "9.9.9"), /^ \* v9\.9\.9$/m);
});

test("adds the version at the top of the beta form's list, once", () => {
  const form = read(".github/ISSUE_TEMPLATE/beta_test.yml");
  const once = bumpBetaForm(form, "9.9.9-beta.1");
  assert.match(once, /options:\n {8}- 9\.9\.9-beta\.1\n {8}- \d/);
  assert.equal(once.split("- 9.9.9-beta.1").length, 2);
  assert.equal(bumpBetaForm(once, "9.9.9-beta.1"), once);
  // Only the version list changes: the other dropdowns keep their options.
  assert.equal(once.replace("        - 9.9.9-beta.1\n", ""), form);
  const crlf = form.replace(/\n/g, "\r\n");
  assert.equal(bumpBetaForm(crlf, "9.9.9-beta.1"), once.replace(/\n/g, "\r\n"));
});

test("sets the bug form's example version", () => {
  const out = bumpBugForm(read(".github/ISSUE_TEMPLATE/bug_report.yml"), "9.9.9-rc.2");
  assert.match(out, /for example 9\.9\.9-rc\.2\. The app/);
  assert.equal(bumpBugForm(out, "9.9.9-rc.2"), out);
});

test("names changelog entries the way the page does", () => {
  assert.equal(changelogId("2.0.0-beta.11"), "v2-beta11");
  assert.equal(changelogId("2.0.0"), "v2");
  assert.equal(changelogId("1.0.0"), "v1");
  assert.equal(changelogId("2.0.0-rc.1"), "v2-rc1");
  assert.equal(changelogId("2.0.1"), "v2-0-1");
  assert.equal(changelogId("2.1.0-beta.1"), "v2-1-beta1");
});

test("adds a dated changelog entry to fill in, above the newest, once", () => {
  const page = read("site/changelog.html");
  const out = addChangelogStub(page, "3.0.0-beta.1", date);
  assert.match(out, /<h2 id="v3-beta1">Version 3\.0\.0-beta\.1 <span class="tag">Beta, October 3, 2026<\/span><\/h2>/);
  assert.ok(out.indexOf('id="v3-beta1"') < out.indexOf('<article class="rpg release" aria-labelledby="v2'));
  assert.equal((out.match(/FILL IN/g) ?? []).length, 4);
  assert.equal(addChangelogStub(out, "3.0.0-beta.1", date), out);
  assert.match(addChangelogStub(page, "9.9.9-rc.1", date), /Release candidate, October 3, 2026/);
  assert.match(addChangelogStub(page, "9.9.9", date), /<span class="tag">October 3, 2026<\/span>/);
  // A version the page already has, such as 2.0.0 ("Coming soon"), keeps its entry.
  assert.equal(addChangelogStub(page, "2.0.0", date), page);
});

test("the changelog has no lines left to fill in", () => {
  assert.doesNotMatch(read("site/changelog.html"), /FILL IN/);
});
