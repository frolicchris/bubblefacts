// Builds facts-data/dyk-hooks.json: Wikipedia "Did you know" hooks about music articles
// (songs, singles, albums, soundtracks, compositions), keyed by the article's current title.
// The fact writer reads a song's hooks only when its own article is the hooked one (dyk-hooks.ts).
//
//   npm i --no-save hyparquet
//   node scripts/build-dyk-hooks.mjs PARQUET_DIR [--no-redirects]
//
// PARQUET_DIR holds the dyk_YYYY.parquet files of the Hugging Face dataset
// derenrich/enwiki-did-you-know (CC BY 3.0; the hooks are English Wikipedia text, CC BY-SA 4.0).
// Old titles are followed to the article's current title through the Wikipedia API (one request
// per 50 titles), unless --no-redirects.

import fs from "fs";
import path from "path";

const [dir, ...rest] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: node scripts/build-dyk-hooks.mjs PARQUET_DIR [--no-redirects]");
  process.exit(2);
}
const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../facts-data/dyk-hooks.json");
const USER_AGENT = "BubbleFacts-research/1.0 (https://github.com/frolicchris/bubblefacts)";
let parquetReadObjects;
try {
  ({ parquetReadObjects } = await import("hyparquet"));
} catch {
  console.error("Needs hyparquet: npm i --no-save hyparquet");
  process.exit(2);
}

/** A title as Wikipedia keys it: spaces, not underscores, and a capital first letter. */
export const titleKey = (t) => {
  const s = decodeURIComponent(String(t ?? "")).replace(/_/g, " ").replace(/\s+/g, " ").trim().normalize("NFC");
  return s ? s[0].toUpperCase() + s.slice(1) : s;
};
/** Loose form for comparing the bolded words with the title. */
const loose = (s) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[‘’'"“”]/g, "").replace(/&/g, "and").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/^the /, "").trim();

/** A disambiguation that says the article is a piece of music: "Call Me (Blondie song)". */
const MUSIC_TITLE = /\((?:[^()]*\s)?(?:song|single|album|EP|soundtrack|composition|symphony|opera|hymn|anthem|carol|mixtape|instrumental|aria|ballet|march|cantata|concerto|sonata|oratorio|requiem|jingle|recording|music)\)$/i;
/** Words that put a hook about a quoted or italic title in music. */
const SONG_WORDS = /\b(?:songs?|single|track|lyrics?|sang|sung|singers?|recorded|recording|composed|composition|hit|charts?|billboard|music video|hymn|anthem|carol|ballad|melody|tune|remix|cover(?:ed)?|chorus|aria|standard|duet|premiered|released|music|musicians?|bands?|rapper|guitar|piano|album)\b/i;
/** Words that say a quoted title is surely a song, whatever else the hook mentions. */
const SURELY_SONG = /\b(?:song|single|hymn|carol|standard|track|lyrics)\b/i;
const ALBUM_WORDS = /\b(?:album|EP|LP|mixtape|soundtrack|tracks|recorded|recording|symphony|opera|concerto|sonata|suite|oratorio|cantata|requiem|ballet|score)\b/i;
/** Quoted titles that are not music. */
const NOT_MUSIC = /\b(?:episode|poem|short story|novel|sketch|essay|film|play)\b/i;

/** How the hook sets its bolded article: in quotation marks (a song) or italics (an album, a work). */
function setting(html, article) {
  const at = html.search(new RegExp(`<b\\b[^>]*>(?:(?!</b>).)*href="\\./${article.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "s"));
  if (at < 0) return "";
  const end = html.indexOf("</b>", at);
  const inner = html.slice(at, end);
  const before = html.slice(Math.max(0, at - 12), at);
  const after = html.slice(end + 4, end + 16);
  if (/["“]\s*$/.test(before) || /^\s*["”]/.test(after) || /<a\b[^>]*>\s*["“]/.test(inner)) return "quoted";
  if (/<i\b[^>]*>\s*$/.test(before) || /<i\b/.test(inner)) return "italic";
  return "";
}

function isMusic(row, title) {
  if (MUSIC_TITLE.test(title) || /^Music of /.test(title) || /\bsoundtrack\b/i.test(title)) return true;
  const how = setting(row.dyk_html ?? "", row.subject_article ?? "");
  if (how === "quoted") return SONG_WORDS.test(row.dyk_text) && (SURELY_SONG.test(row.dyk_text) || !NOT_MUSIC.test(row.dyk_text));
  if (how === "italic") return ALBUM_WORDS.test(row.dyk_text) && !/\b(?:film|novel|book|magazine|newspaper|play|painting|television|TV)\b/i.test(row.dyk_text);
  return false;
}

/** The hook as a plain statement: no "... that", no question mark, no "(pictured)". */
export function plainHook(text) {
  return String(text)
    .replace(/^\s*(?:\.\s*)*(?:…\s*)?that,?\s+/i, "")
    .replace(/\s*\((?:[^()]*\s)?pictured(?:\s[^()]*)?\)/gi, "")
    .replace(/\s+([,.;:!?”])/g, "$1")
    .replace(/“\s+/g, "“")
    .replace(/\?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const kept = new Map(); // old title -> [{a, h, d}]
let rows = 0;
for (const f of fs.readdirSync(dir).filter((x) => /^dyk_\d{4}\.parquet$/.test(x)).sort()) {
  const buf = fs.readFileSync(path.join(dir, f));
  const list = await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), columns: ["subject", "subject_article", "dyk_text", "dyk_html", "timestamp"] });
  for (const row of list) {
    rows++;
    const title = titleKey(row.subject_article);
    if (!title || !row.dyk_text || !isMusic(row, title)) continue;
    // The bolded words must name the article itself, not a phrase linked to it.
    const base = loose(title.replace(/\s*\([^)]*\)$/, ""));
    if (loose(String(row.subject ?? "")) !== base) continue;
    const h = plainHook(row.dyk_text);
    if (h.length < 20) continue;
    const d = (row.timestamp instanceof Date ? row.timestamp.toISOString() : String(row.timestamp)).slice(0, 10);
    kept.set(title, [...(kept.get(title) ?? []), { a: title, h, d }]);
  }
}

// Follow old titles to the article's current title.
const current = new Map([...kept.keys()].map((t) => [t, t]));
if (!rest.includes("--no-redirects")) {
  const titles = [...kept.keys()];
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&titles=${encodeURIComponent(batch.join("|"))}`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
    const q = (await res.json()).query ?? {};
    const map = new Map();
    for (const n of q.normalized ?? []) map.set(n.from, n.to);
    const redirect = new Map((q.redirects ?? []).map((r) => [r.from, r.to]));
    const missing = new Set((q.pages ?? []).filter((p) => p.missing).map((p) => p.title));
    for (const t of batch) {
      const n = map.get(t) ?? t;
      const to = redirect.get(n) ?? n;
      current.set(t, missing.has(to) ? null : to.split("#")[0]);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const hooks = {};
for (const [old, list] of kept) {
  const to = current.get(old);
  if (!to) continue;
  for (const e of list) (hooks[to] ??= []).some((x) => x.h === e.h) || hooks[to].push(e);
}
const sorted = Object.fromEntries(Object.keys(hooks).sort().map((k) => [k, hooks[k]]));
const out = {
  source: "English Wikipedia, Did you know (dataset derenrich/enwiki-did-you-know on Hugging Face, CC BY 3.0)",
  license: "CC BY-SA 4.0 (Wikipedia text); credit the article on English Wikipedia",
  hooks: sorted,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out) + "\n");
const n = Object.values(sorted).reduce((a, l) => a + l.length, 0);
console.log(`rows ${rows}, music hooks ${n} on ${Object.keys(sorted).length} articles, ${fs.statSync(OUT).size} bytes -> ${OUT}`);
