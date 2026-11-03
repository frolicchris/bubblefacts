import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { liteKeep, liteManifest, liteNotices } from "./dist-lite.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const full = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lite = liteManifest(full);
const engine = (s) => /node-llama-cpp/.test(s);

test("Lite leaves the AI engine out of the app", () => {
  assert.equal(lite.dependencies["node-llama-cpp"], undefined);
  // Everything else the app needs is still there.
  for (const dep of Object.keys(full.dependencies).filter((d) => !engine(d))) assert.equal(lite.dependencies[dep], full.dependencies[dep]);
  // No pattern copies the engine in, and two keep it out.
  assert.deepEqual(lite.build.files.filter((f) => engine(f) && !f.startsWith("!")), []);
  assert.ok(lite.build.files.includes("!node_modules/node-llama-cpp{,/**/*}"));
  assert.ok(lite.build.files.includes("!node_modules/@node-llama-cpp{,/**/*}"));
  assert.ok((lite.build.asarUnpack ?? []).every((f) => !engine(f)));
  // The app's own files are all still copied, the notices as Lite's own under the same name.
  for (const f of full.build.files.filter((f) => !engine(f) && f !== "THIRD-PARTY-NOTICES.md")) assert.ok(lite.build.files.includes(f), f);
  assert.ok(!lite.build.files.includes("THIRD-PARTY-NOTICES.md"));
  assert.deepEqual(lite.build.files.find((f) => typeof f === "object"), { from: "build-lite", to: ".", filter: ["THIRD-PARTY-NOTICES.md"] });
});

test("Lite says it's Lite, keeps everything else the app reads, and is the same app to the system", () => {
  assert.equal(lite.bubblefacts.edition, "lite");
  for (const [key, value] of Object.entries(full.bubblefacts)) assert.deepEqual(lite.bubblefacts[key], value);
  // Same app ID and name: Lite and the full app install over each other and share settings.
  assert.equal(lite.build.appId, full.build.appId);
  assert.equal(lite.build.productName, full.build.productName);
  assert.equal(lite.name, full.name);
  assert.equal(lite.version, full.version);
  // No Node.js shipped for the engine on Linux.
  assert.equal(lite.build.linux.extraResources, undefined);
});

test("Lite's installers have -lite in their names, the names the in-app update looks for", () => {
  assert.equal(lite.build.directories.output, "release-lite");
  assert.equal(lite.build.mac.artifactName, "BubbleFacts-${version}-lite-mac-${arch}.${ext}");
  assert.equal(lite.build.win.artifactName, "BubbleFacts-${version}-lite-windows-${arch}.${ext}");
  assert.equal(lite.build.appImage.artifactName, "BubbleFacts-${version}-lite-linux-x86_64.${ext}");
  assert.equal(lite.build.deb.artifactName, "bubblefacts-lite_${version}_amd64.${ext}");
  // The full names are the same with "-lite" taken out (desktop/src/updater.ts, assetName).
  for (const key of ["mac", "win", "appImage"]) assert.equal(lite.build[key].artifactName.replace("-lite-", "-"), full.build[key].artifactName);
});

test("the full package.json is left as it was", () => {
  assert.equal(full.bubblefacts.edition, undefined);
  assert.ok(full.dependencies["node-llama-cpp"]);
  assert.notEqual(full.build.directories.output, "release-lite");
});

test("Lite ships only the packages reached without the AI engine", () => {
  const tree = {
    dependencies: {
      express: { version: "4.0.0", dependencies: { "shared-lib": { version: "1.0.0" } } },
      "node-llama-cpp": { version: "3.0.0", dependencies: { "engine-only": { version: "2.0.0" }, "shared-lib": { version: "1.0.0" } } },
      "@node-llama-cpp/linux-x64": { version: "3.0.0" },
    },
  };
  assert.deepEqual([...liteKeep(tree)].sort(), ["express", "shared-lib"]);
});

test("follows a package's dependencies wherever npm printed them, even under the engine", () => {
  // npm printed on-finished in full under the engine first, and only as "deduped" under express.
  const tree = {
    dependencies: {
      "node-llama-cpp": { version: "3.0.0", dependencies: { "on-finished": { version: "2.4.1", dependencies: { "ee-first": { version: "1.1.1" } } } } },
      express: { version: "4.0.0", dependencies: { "on-finished": { version: "2.4.1" } } },
    },
  };
  assert.deepEqual([...liteKeep(tree)].sort(), ["ee-first", "express", "on-finished"]);
});

test("Lite's notices leave out the AI engine, the models and the Linux Node.js, and keep the rest", () => {
  const notices = fs.readFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), "utf8");
  const names = [...notices.matchAll(/^### (\S+) /gm)].map((m) => m[1]);
  const keep = new Set(names.filter((n) => !engine(n) && n !== "ipull"));
  const out = liteNotices(notices, keep);
  assert.doesNotMatch(out, /^### (?:node-llama-cpp|@node-llama-cpp\/|ipull) /m);
  assert.doesNotMatch(out, /\*\*llama\.cpp\*\*|\*\*Llama 3\.[12] |\*\*Node\.js\*\*/);
  assert.match(out, /^### express /m);
  assert.match(out, /\*\*Electron\*\*/);
  assert.match(out, /\*\*Facts\*\*/);
  assert.match(out, /BubbleFacts Lite: it has no AI engine/);
  // The count matches what's listed, and license texts with headings of their own come through whole.
  const listed = [...out.matchAll(/^### /gm)].length;
  assert.match(out, new RegExp(`^## npm packages \\(${listed}\\)$`, "m"));
  assert.ok(out.includes("# Blue Oak Model License") === notices.includes("# Blue Oak Model License") || !keep.size);
});

test("runs npm through a shell on Windows, where it is npm.cmd", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "dist-lite.mjs"), "utf8");
  const call = source.slice(source.indexOf('execFileSync("npm"'));
  assert.match(call.slice(0, call.indexOf("\n")), /shell: process\.platform === "win32"/);
});
