import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { liteManifest } from "./dist-lite.mjs";

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
  // The app's own files are all still copied.
  for (const f of full.build.files.filter((f) => !engine(f))) assert.ok(lite.build.files.includes(f), f);
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
