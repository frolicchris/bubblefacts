// Did you know hooks (2026-11): short facts Wikipedia's editors picked for the Main Page because
// they surprise. facts-data/dyk-hooks.json (built by scripts/build-dyk-hooks.mjs) holds the hooks
// about music articles, keyed by the article's current title. A song's reference gets the hooks of
// the very article it was written from, never a near title, on a line labelled with that article
// like a companion article's line (issue #48): a caption from it is credited and linked to the
// article, and Wrong blocks it. A hook about an album or a game's music, when that is the article
// the song was matched to, brings a prompt rule to make that the caption's subject.
import fs from "fs";
import path from "path";
import { config } from "./config";
import { dryData, sourceRisk } from "./fact-ranking";
import { normalizeTitle, notForStream, resolveGameAndTrack } from "./fact-verifier";
import { SSLSong } from "./types";

type Hook = { a: string; h: string; d: string };
type Table = Record<string, Hook[]>;

const FILE = path.resolve(__dirname, "../../facts-data/dyk-hooks.json");
/** At most this many hooks join one reference. */
const MAX_HOOKS = 2;
let table: Table | null = null;

/** The hooks table, read once; empty when the file is missing or unreadable. */
function hooks(): Table {
  if (table) return table;
  try {
    table = (JSON.parse(fs.readFileSync(FILE, "utf8")) as { hooks?: Table }).hooks ?? {};
  } catch {
    table = {};
  }
  return table;
}

/** Tests: use this table instead of the bundled file (null reads the file again). */
export function setHookTable(t: Table | null): void {
  table = t;
}

/** A title as Wikipedia keys it: spaces, not underscores, and a capital first letter. */
export function titleKey(title: string): string {
  const s = title.replace(/_/g, " ").replace(/\s+/g, " ").trim().normalize("NFC");
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The hook as a plain statement: no "... that", no question mark, no "(pictured)". */
export function plainHook(text: string): string {
  return text
    .replace(/^\s*(?:\.\s*)*(?:…\s*)?that,?\s+/i, "")
    .replace(/\s*\((?:[^()]*\s)?pictured(?:\s[^()]*)?\)/gi, "")
    .replace(/\s+([,.;:!?”])/g, "$1")
    .replace(/\?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Why a hook can't be retold on stream, or null when it can: the same screens a sentence gets. */
export function hookRisk(hook: string): string | null {
  const off = notForStream(hook);
  if (off) return off;
  const dry = dryData(hook);
  if (dry) return `dry: ${dry}`;
  // Someone's words or view, or a hedge: a 3B caption loses them. A hook is short, like a lead sentence.
  const risk = sourceRisk(hook, hook, true);
  return risk.length ? risk.join(", ") : null;
}

/** The usable hooks of an article, as statements ending in a period. */
export function articleHooks(page: string): string[] {
  const list = hooks()[titleKey(page)] ?? [];
  const out: string[] = [];
  // The build kept only hooks whose bolded words name their article; `a` is that article's title
  // when hooked, which a redirect may have changed since.
  for (const { h } of list) {
    const text = plainHook(h);
    if (text.length < 20 || hookRisk(text)) continue;
    const whole = text[0].toUpperCase() + text.slice(1); // "the music video ..." starts a sentence of its own
    const line = /[.!”"]$/.test(whole) ? whole : `${whole}.`;
    if (!out.includes(line)) out.push(line);
    if (out.length >= MAX_HOOKS) break;
  }
  return out;
}

/** Pages whose hooks were about the article's whole subject (an album, a game's music), not the song. */
const subjectPages = new Set<string>();

/**
 * Whether the reference has a hook about the matched article's whole subject, not about the song
 * playing: an album's or a game's music article the song was matched to.
 */
export function hasSubjectHook(context: string): boolean {
  const page = context.split("\n")[0];
  return subjectPages.has(page) && context.includes(`From the article "${page}": `);
}

export const HOOK_SUBJECT_RULE = ` A statement about the album or the game music the song is part of is about that whole work: make the work the subject of your caption and name it, like "Its album TITLE was ...", with the real title from the text. Never write it as if it were about the song playing now.`;

/**
 * The reference with the article's Did you know hooks on a line labelled
 * `From the article "Title": ` right after the title line; the reference as it is
 * with FUN_HOOKS=off, no hook for this article, or the article blocked for the song.
 */
export function withHooks(context: string, song: SSLSong, usable: (title: string) => boolean): string {
  if (!config.funHooks || !context) return context;
  const [page, ...rest] = context.split("\n");
  if (!page || !usable(page)) return context;
  const found = articleHooks(page).filter((h) => !context.includes(h.replace(/\.$/, "")));
  if (!found.length) return context;
  const { track } = resolveGameAndTrack(song);
  const base = normalizeTitle(page.replace(/\s*\([^)]*\)$/, ""));
  if (track && base !== normalizeTitle(track)) subjectPages.add(page);
  else subjectPages.delete(page);
  console.log(`[FunHooks] "${page}": ${found.length} Did you know hook${found.length === 1 ? "" : "s"}`);
  return `${page}\nFrom the article "${page}": ${found.join(" ")}\n\n${rest.join("\n")}`;
}
