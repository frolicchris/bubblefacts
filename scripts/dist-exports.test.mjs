import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// check-song-list.mjs and wrong-cases.mjs import the compiled server, so a rename there breaks them quietly.
// The fact server reads these at import; nothing here connects to a song list.
process.env.SSL_ACCESS_TOKEN ??= "unused";
process.env.SSL_STREAMER_NAME ??= "unused";
process.env.AI_PROVIDER ??= "none";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-dist-exports-"));
process.env.BUBBLEFACTS_DATA_DIR = data;

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/backend");
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);

test("the compiled server exports what the scripts import (after npm run build)", async () => {
  const verifier = await load("fact-verifier.js");
  const generator = await load("fact-generator.js");
  for (const name of ["artistNames", "fetchGrounding", "looksLikeArtistName", "normalizeTitle", "otherParts", "resolveGameAndTrack", "screenClaims"]) {
    assert.equal(typeof verifier[name], "function", `fact-verifier.js: ${name}`);
  }
  assert.equal(typeof generator.generateFacts, "function", "fact-generator.js: generateFacts");
  assert.equal(typeof generator.STRUCTURED, "string", "fact-generator.js: STRUCTURED");
  fs.rmSync(data, { recursive: true, force: true });
});
