import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { factLine } from "./fact-line.mjs";

const song = { title: "Moonlit Harbor", artist: "Test Quartet" };

test("a sampled fact becomes a line shaped like a Wrong press, with its sentence", () => {
  const fact = { text: "It was recorded in a harbor.", source: "Wikipedia: Harbor Game", evidence: "The piece was recorded in a harbor.", delaySeconds: 5 };
  assert.deepEqual(factLine(song, fact, "Harbor Game"), {
    song,
    caption: "It was recorded in a harbor.",
    source: "Wikipedia: Harbor Game",
    article: "Harbor Game",
    evidence: "The piece was recorded in a harbor.",
  });
});

test("a fact with no sentence or source still makes a whole line", () => {
  assert.deepEqual(factLine({ title: "Moonlit Harbor" }, { text: "A caption." }, null), {
    song: { title: "Moonlit Harbor", artist: "" },
    caption: "A caption.",
    source: null,
    article: null,
  });
});

test("the song list check writes its sampled facts as lines", () => {
  const code = fs.readFileSync(path.join(import.meta.dirname, "check-song-list.mjs"), "utf8");
  assert.match(code, /facts\.jsonl/);
  assert.match(code, /factLine\(song, f, generator\.blockFor\(f\.source\) \?\? null\)/);
});
