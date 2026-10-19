// Replays the captions a streamer pressed Wrong on as test cases: would
// BubbleFacts still show each one today?
//
//   npm run build
//   node scripts/wrong-cases.mjs [WRONG_LOG] [--pace MS]
//
// WRONG_LOG is the `wrong-log.jsonl` in the app's data folder (one JSON line
// per Wrong press; the default is $BUBBLEFACTS_DATA_DIR/wrong-log.jsonl). For
// each line the song is looked up again, with no Wrong blocks, and the caption
// is screened against the article found now. A line passes when
//   - the lookup finds a different article than the one blocked (or none), or
//   - the same article is found but the screening now drops the caption.
// A line that fails ("STILL SHOWS") is a fact-checking gap worth fixing. Lines
// whose caption didn't come from a Wikipedia article are skipped. Needs the
// internet for the lookups (Wikipedia); offline, every line reports "no
// article found", which says nothing about the screening. The track is left
// out of the screening, so a caption that only a track-aware check would drop
// can still show here. The log is private: don't commit it or paste it into
// an issue. Exits 1 when any caption still shows.

import fs from "fs";
import os from "os";
import path from "path";

const args = process.argv.slice(2);
const paceAt = args.indexOf("--pace");
const PACE_MS = paceAt >= 0 ? Number(args.splice(paceAt, 2)[1]) : 2000;
const logFile = args[0] ?? path.join(process.env.BUBBLEFACTS_DATA_DIR ?? "", "wrong-log.jsonl");
if (!fs.existsSync(logFile) || fs.statSync(logFile).isDirectory()) {
  console.error("Usage: node scripts/wrong-cases.mjs [WRONG_LOG] [--pace MS]\nNo wrong-log.jsonl at: " + logFile);
  process.exit(2);
}

// The fact server reads these at import; nothing here connects to a song list.
process.env.SSL_ACCESS_TOKEN ??= "unused";
process.env.SSL_STREAMER_NAME ??= "unused";
process.env.AI_PROVIDER ??= "none";
// An empty data folder, so no earlier Wrong block hides the lookup the song would get fresh.
process.env.BUBBLEFACTS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-wrong-cases-"));

const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../dist/backend");
const verifier = await import(path.join(dist, "fact-verifier.js"));
const { STRUCTURED } = await import(path.join(dist, "fact-generator.js"));

const cases = [];
for (const text of fs.readFileSync(logFile, "utf8").split("\n")) {
  try {
    const c = JSON.parse(text);
    if (c?.song?.title && typeof c.caption === "string") cases.push(c);
  } catch {
    // A blank or cut-short line.
  }
}

const real = { log: console.log, warn: console.warn };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let still = 0, ok = 0, skipped = 0, nothing = 0;
for (const [i, c] of cases.entries()) {
  const name = `${c.song.title} (${c.song.artist ?? ""})`;
  if (!c.article || c.article === STRUCTURED) {
    skipped++;
    real.log(`skip   ${name}: the caption didn't come from an article`);
    continue;
  }
  const song = { title: c.song.title, artist: c.song.artist ?? "", ...(c.song.songId ? { songId: c.song.songId } : {}), ...(c.song.videoId ? { videoId: c.song.videoId } : {}) };
  let context = "";
  console.log = console.warn = () => undefined;
  try {
    context = await verifier.fetchGrounding(song);
  } catch {
    // Treated as no article.
  }
  console.log = real.log;
  console.warn = real.warn;
  const now = context ? context.split("\n")[0] : "";
  if (!now) {
    nothing++;
    ok++;
    real.log(`ok     ${name}: no article found now`);
  } else if (now !== c.article) {
    ok++;
    real.log(`ok     ${name}: now from "${now}", not "${c.article}"`);
  } else {
    const { track } = verifier.resolveGameAndTrack(song);
    const { kept, rejected } = verifier.screenClaims([c.caption], context, { otherParts: verifier.otherParts(context, track), artists: verifier.artistNames(song.artist) });
    if (kept.length) {
      still++;
      real.log(`STILL SHOWS  ${name}, "${c.article}": ${c.caption}`);
    } else {
      ok++;
      real.log(`ok     ${name}: now dropped (${rejected[0]?.reason ?? "screened"})`);
    }
  }
  if (i < cases.length - 1) await sleep(PACE_MS);
}
real.log(`\n${cases.length} lines: ${ok} ok, ${still} still show, ${skipped} skipped.`);
if (cases.length && nothing === cases.length - skipped && nothing > 0) real.log("No lookup found an article. Offline? The result says nothing about the screening.");
process.exit(still ? 1 : 0);
