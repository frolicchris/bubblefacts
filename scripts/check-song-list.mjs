// Checks a whole song list the way BubbleFacts would see it, to find wrong
// articles and wrong facts before musicians do.
//
//   npm run build
//   node scripts/check-song-list.mjs LIST.json OUT_DIR [--facts N] [--seed S] [--pace MS]
//
// LIST.json is an array of {title, artist} (other fields are kept). Every
// song gets the Wikipedia article BubbleFacts would use (no AI). With
// --facts N, a random sample of N songs also gets facts written by the AI
// set in the environment (AI_PROVIDER, as for the server), for a person to
// review. Writes OUT_DIR/articles.csv, OUT_DIR/facts.md and OUT_DIR/summary.md.
// Song lists are the streamer's own: keep them and the results out of the repository.

import fs from "fs";
import path from "path";

const [listFile, outDir, ...rest] = process.argv.slice(2);
if (!listFile || !outDir) {
  console.error("Usage: node scripts/check-song-list.mjs LIST.json OUT_DIR [--facts N] [--seed S]");
  process.exit(2);
}
const opt = (name, fallback) => {
  const i = rest.indexOf(name);
  return i >= 0 ? Number(rest[i + 1]) : fallback;
};
const sampleSize = opt("--facts", 0);
/** Time between songs: each takes several Wikipedia requests, and one list is thousands. */
const PACE_MS = opt("--pace", 2000);
let seed = opt("--seed", 1);
// The fact server reads these at import; nothing here connects to a song list.
process.env.SSL_ACCESS_TOKEN ??= "unused";
process.env.SSL_STREAMER_NAME ??= "unused";
process.env.AI_PROVIDER ??= "none";
process.env.BUBBLEFACTS_DATA_DIR ??= fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "bubblefacts-check-"));

const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../dist/backend");
const verifier = await import(path.join(dist, "fact-verifier.js"));
const generator = await import(path.join(dist, "fact-generator.js"));

const songs = JSON.parse(fs.readFileSync(listFile, "utf8")).filter((s) => s && typeof s.title === "string" && s.title.trim());
fs.mkdirSync(outDir, { recursive: true });

// The server's own log lines, kept per song for the report instead of on screen.
let captured = [];
const quiet = (...a) => captured.push(a.map(String).join(" "));
const real = { log: console.log, warn: console.warn };

const words = (s) => verifier.normalizeTitle(s ?? "").split(" ").filter((w) => w.length > 2);
/** Why an article looks wrong for a song, or "" when nothing stands out. */
function suspicion(song, article) {
  if (!article) return "";
  const a = new Set(words(article));
  const shared = [...words(song.title), ...words(song.artist)].filter((w) => a.has(w));
  if (!shared.length) return "shares no words with the title or artist";
  if (/\b(video game|game)\)?$/i.test(article) && verifier.looksLikeArtistName(song.artist ?? "")) return "a game, for what looks like an artist";
  return "";
}

const csv = [["title", "artist", "game", "track", "article", "chars", "suspect", "log"].join(",")];
const cell = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/\s+/g, " ")}"`;
let found = 0, none = 0, suspect = 0;
const suspects = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const throttled = () => captured.some((l) => /rate-limited/.test(l));
for (const [i, song] of songs.entries()) {
  let text = "";
  // Wikipedia asks heavy readers to slow down (HTTP 429). A throttled miss isn't a real
  // answer, so wait and ask again, longer each time.
  for (let wait = 60_000; ; wait = Math.min(wait * 2, 600_000)) {
    captured = [];
    console.log = console.warn = quiet;
    try {
      text = await verifier.fetchGrounding({ title: song.title, artist: song.artist ?? "" });
    } catch (err) {
      captured.push(`error: ${err?.message ?? err}`);
    }
    console.log = real.log; console.warn = real.warn;
    if (!throttled()) break;
    real.log(`Wikipedia asked us to slow down; waiting ${wait / 1000} s`);
    await sleep(wait);
  }
  const article = text ? text.split("\n")[0] : "";
  const why = suspicion(song, article);
  if (article) found++; else none++;
  if (why) { suspect++; suspects.push({ song, article, why }); }
  const { game, track } = verifier.resolveGameAndTrack({ title: song.title, artist: song.artist ?? "" });
  const pick = captured.filter((l) => /\[Grounding\]/.test(l)).slice(-1)[0] ?? "";
  csv.push([song.title, song.artist, game, track, article, text.length, why, pick].map(cell).join(","));
  if ((i + 1) % 25 === 0) real.log(`${i + 1}/${songs.length} songs, ${found} with an article, ${suspect} suspect`);
  // Be gentle with Wikipedia: the server looks up one song at a time, minutes apart.
  await sleep(PACE_MS);
}
fs.writeFileSync(path.join(outDir, "articles.csv"), csv.join("\n") + "\n");

// A reproducible random sample (seeded), for facts a person reads one by one.
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const sample = songs.map((s) => [rand(), s]).sort((a, b) => a[0] - b[0]).slice(0, sampleSize).map(([, s]) => s);
const md = [`# Facts for ${sample.length} sampled songs`, "", `AI: ${process.env.AI_PROVIDER}. Each fact is what would show on stream; check it against its source.`, ""];
for (const song of sample) {
  captured = [];
  console.log = console.warn = quiet;
  let facts = [];
  try {
    facts = await generator.generateFacts({ title: song.title, artist: song.artist ?? "" });
  } catch (err) {
    captured.push(`error: ${err?.message ?? err}`);
  }
  console.log = real.log; console.warn = real.warn;
  md.push(`## ${song.title} (${song.artist})`, "");
  if (!facts.length) md.push("_No facts: nothing showed._", "");
  for (const f of facts) md.push(`- ${f.text}  \n  _${f.source ?? "?"}_`);
  const dropped = captured.filter((l) => /\[Screen\]|dropped/i.test(l));
  if (dropped.length) md.push("", ...dropped.map((l) => `> ${l}`));
  md.push("");
  real.log(`facts: ${song.title}: ${facts.length}`);
}
if (sample.length) fs.writeFileSync(path.join(outDir, "facts.md"), md.join("\n"));

const summary = [
  `# Song list check`,
  "",
  `- Songs: ${songs.length}`,
  `- With an article: ${found} (${Math.round((100 * found) / songs.length)}%)`,
  `- No article (facts from music databases or nothing): ${none}`,
  `- Article looks wrong: ${suspect}`,
  "",
  "## Articles that look wrong",
  "",
  ...suspects.map((s) => `- ${s.song.title} (${s.song.artist}) -> ${s.article}: ${s.why}`),
  "",
];
fs.writeFileSync(path.join(outDir, "summary.md"), summary.join("\n"));
real.log(summary.slice(0, 7).join("\n"));
process.exit(0);
