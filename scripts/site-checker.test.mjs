// The download page's file checker (site/assets/site.js), run against a
// stand-in page and a stand-in GitHub release list.
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { Blob } from "node:buffer";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TextEncoder } from "node:util";
import vm from "node:vm";

const source = readFileSync(new URL("../site/assets/site.js", import.meta.url), "utf8");

const sha = (text) => createHash("sha256").update(text).digest("hex");
const release = (tag, prerelease, files) => ({
  draft: false,
  prerelease,
  tag_name: tag,
  assets: Object.entries(files).map(([name, text]) => ({ name, digest: "sha256:" + sha(text) })),
});

function element() {
  const handlers = {};
  return {
    hidden: true,
    className: "",
    textContent: "",
    value: "",
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) { handlers[type] = fn; },
    fire(type) { handlers[type](); },
  };
}

/** What the checker says about a file with this name and contents */
async function verdict(releases, name, text) {
  const ids = { checker: element(), "check-file": element(), "check-drop": element(), "check-result": element(), "check-nojs": element() };
  const document = {
    documentElement: element(),
    getElementById: (id) => ids[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = { crypto: webcrypto, Blob, Promise, fetch: true, addEventListener() {}, sessionStorage: { getItem: () => null, setItem() {} } };
  const fetch = async () => ({ ok: true, json: async () => releases });
  vm.runInNewContext(source, { window, document, navigator: {}, location: { hash: "" }, fetch, Blob, Promise, Uint8Array, Date, JSON });
  ids["check-file"].files = [{ name, arrayBuffer: async () => new TextEncoder().encode(text).buffer }];
  ids["check-file"].fire("change");
  for (let i = 0; i < 50 && /^Checking/.test(ids["check-result"].textContent); i++) await new Promise((r) => setTimeout(r, 5));
  return ids["check-result"];
}

// GitHub lists by date: a full release published after a beta comes first.
const releases = [
  release("v7.2.2", false, { "BubbleFacts-7.2.2-windows-x64.exe": "full 7.2.2" }),
  release("v7.3.0-beta.2", true, { "BubbleFacts-7.3.0-beta.2-windows-x64.exe": "beta 2" }),
  release("v7.3.0-beta.1", true, { "BubbleFacts-7.3.0-beta.1-windows-x64.exe": "beta 1" }),
  release("v7.2.1", false, { "BubbleFacts-7.2.1-windows-x64.exe": "full 7.2.1" }),
];

test("the newest full release matches, with nothing newer to mention", async () => {
  const said = await verdict(releases, "BubbleFacts-7.2.2-windows-x64.exe", "full 7.2.2");
  assert.equal(said.className, "check-result check-ok");
  assert.equal(said.textContent, "✓ This file matches BubbleFacts-7.2.2-windows-x64.exe on GitHub.");
});

test("the newest beta is not called older than a full release published after it", async () => {
  const said = await verdict(releases, "BubbleFacts-7.3.0-beta.2-windows-x64.exe", "beta 2");
  assert.equal(said.textContent, "✓ This file matches BubbleFacts-7.3.0-beta.2-windows-x64.exe on GitHub.");
});

test("an older full release is pointed to the newest full release, not a beta", async () => {
  const said = await verdict(releases, "BubbleFacts-7.2.1-windows-x64.exe", "full 7.2.1");
  assert.match(said.textContent, /matches BubbleFacts-7\.2\.1-windows-x64\.exe on GitHub\. A newer version is out: 7\.2\.2\.$/);
});

test("an older beta is pointed to the newest beta", async () => {
  const said = await verdict(releases, "BubbleFacts-7.3.0-beta.1-windows-x64.exe", "beta 1");
  assert.match(said.textContent, /A newer version is out: 7\.3\.0-beta\.2\.$/);
});

test("a renamed download still matches by its fingerprint", async () => {
  const said = await verdict(releases, "BubbleFacts-7.2.2-windows-x64 (1).exe", "full 7.2.2");
  assert.match(said.textContent, /matches BubbleFacts-7\.2\.2-windows-x64\.exe on GitHub/);
});

test("a changed file fails, without a claim about every release ever made", async () => {
  const said = await verdict(releases, "BubbleFacts-7.2.2-windows-x64.exe", "full 7.2.2 plus one byte");
  assert.equal(said.className, "check-result check-bad");
  assert.match(said.textContent, /doesn't match any recent BubbleFacts download\. Don't open it\./);
});

test("a match never claims more than the fingerprint shows", async () => {
  const said = await verdict(releases, "BubbleFacts-7.2.2-windows-x64.exe", "full 7.2.2");
  assert.doesNotMatch(said.textContent, /genuine/i);
});
