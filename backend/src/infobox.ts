import { config } from "./config";
import { USER_AGENT } from "./fact-verifier";

/**
 * Plain facts from the infobox of the article a song's captions are written
 * from: who wrote or produced a song, the album it's on, when it came out; who
 * made a game, its composers, its platforms. No AI writes them: each is a fixed
 * English sentence filled from one infobox field, so it can only be wrong when
 * the field is, or when the article is the wrong one. The article has already
 * passed the lookup's relevance checks before this is asked.
 */

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const MAX_NAMES = 3;
const NEGATIVE_TTL_MS = 30 * 60 * 1000;

export interface BoxFact {
  text: string;
  /** "field: value as the infobox gives it", for the dashboard and for checking. */
  evidence: string;
  /** The names, titles and years the sentence states, to tell when another caption already said them. */
  values: string[];
}

export interface Infobox {
  /** "song", "video game", "album"... lower case, as after "{{Infobox ". */
  type: string;
  fields: Record<string, string>;
}

/** The text between a template's opening "{{" and its matching "}}". */
function balanced(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text.startsWith("{{", i)) { depth++; i++; } else if (text.startsWith("}}", i)) {
      depth--;
      i++;
      if (depth === 0) return text.slice(start + 2, i - 1);
    }
  }
  return "";
}

/** Splits on "|" outside nested templates and links. */
function topLevel(body: string, sep = "|"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "{{" || two === "[[") { depth++; cur += two; i++; continue; }
    if ((two === "}}" || two === "]]") && depth > 0) { depth--; cur += two; i++; continue; }
    if (body[i] === sep && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += body[i];
  }
  parts.push(cur);
  return parts;
}

/** The article's first infobox, or null. */
export function parseInfobox(wikitext: string): Infobox | null {
  const text = wikitext.replace(/<!--[\s\S]*?-->/g, "");
  const m = /\{\{\s*Infobox[ _]+([^|\n}]+)/i.exec(text);
  if (!m) return null;
  const body = balanced(text, m.index);
  if (!body) return null;
  const fields: Record<string, string> = {};
  for (const part of topLevel(body).slice(1)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase().replace(/[_\s]+/g, " ");
    const value = part.slice(eq + 1).trim();
    if (key && value) fields[key] = value;
  }
  return { type: m[1].trim().toLowerCase().replace(/_/g, " "), fields };
}

/** Templates that only hold a list of items: {{hlist|a|b}}, {{plainlist|* a * b}}, {{ubl|a|b}}. */
const LIST_TEMPLATE = /^(hlist|flatlist|plainlist|plain list|unbulleted list|ubl|ubil|bulleted list|blist|startflatlist|endflatlist|nowrap|nobr|vgy|small)$/i;

/** One field's items as plain text: links resolved, references and notes dropped. */
export function items(raw: string): string[] {
  let v = raw
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/\{\{\s*(efn|refn|sfn|r|ref label|nbsp|citation needed|cn|clarify|when|who|dubious|according to whom|abbr)\b[^{}]*\}\}/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(small|span|div|i|b|sup|sub)[^>]*>/gi, "");
  // List templates become their items, one per line, inside out.
  for (let i = 0; i < 5; i++) {
    const before = v;
    v = v.replace(/\{\{\s*([^{}|]+?)\s*\|([^{}]*)\}\}/g, (all, name: string, args: string) =>
      LIST_TEMPLATE.test(name.trim()) ? "\n" + topLevel(args).filter((a) => !/^\s*\w+\s*=/.test(a)).join("\n") + "\n" : all
    );
    v = v.replace(/\{\{\s*(plainlist|plain list|flatlist|startflatlist|endflatlist)\s*\}\}/gi, "\n");
    if (v === before) break;
  }
  if (/\{\{/.test(v)) return []; // anything else templated (release-date tables, notes) isn't read as names
  v = v
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\S+\s([^\]]*)\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  return v
    .split(/\n|\s*\*\s*|;\s*|,\s*(?![^()]*\))/)
    .map((s) => s.replace(/\s+/g, " ").replace(/^[\s:•·-]+|[\s:•·]+$/g, "").trim())
    .filter((s) => s && !/^(and|various|n\/?a|none|uncredited|see below|see list|tba|tbd)$/i.test(s) && !/=/.test(s));
}

/** Names as a field lists them, when every item is a clean name (no notes, roles or brackets). */
function nameList(raw: string | undefined): string[] {
  if (!raw) return [];
  const list = items(raw);
  const clean = list.every((n) => n.length <= 60 && !/[()[\]{}<>"|:]|\b(and|with|feat\.?|featuring|uncredited|original|arranged|additional|remix|remake|port|version)\b/i.test(n) && /\p{L}/u.test(n));
  return clean ? [...new Set(list)] : [];
}

/** "A", "A and B", "A, B and C"; past MAX_NAMES, "A, B, C and others", so no one is left out silently. */
function joinNames(list: string[]): string {
  if (list.length > MAX_NAMES) return `${list.slice(0, MAX_NAMES).join(", ")} and others`;
  return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** The earliest year a release field gives, from plain text or {{Start date}} and release templates. */
export function earliestYear(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.replace(/<ref[^>]*\/>/gi, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const years = [...v.matchAll(/(?<![\d#])(19[0-9]{2}|20[0-4][0-9])(?![\d])/g)].map((m) => m[1]).sort();
  return years[0] ?? null;
}

/** A title's bracketed disambiguation: "(video game)", "(Moth Choir song)", "(1997 video game)". */
const DISAMBIGUATION = /\s*\((?:[^()]*\b(?:song|single|album|EP|video game|game|soundtrack|composition)|\d{4})\)\s*$/i;

/**
 * The subject as viewers know it, from the page title: "Super Metroid", not
 * "Super Metroid (video game)"; "Pokémon Gold and Silver", not the one version
 * an infobox title may list first. An album's own name comes from its infobox,
 * since its page may be "Music of <game>".
 */
export function subjectName(page: string, box: Infobox): string {
  const named = ALBUM_BOX.test(box.type) ? items(box.fields.name ?? "") : [];
  if (named.length === 1 && named[0].length <= 80) return named[0];
  return page.replace(DISAMBIGUATION, "").trim();
}

const SONG_BOX = /^(song|single|musical composition)$/;
const GAME_BOX = /^video game$/;
const ALBUM_BOX = /^album$/;

/**
 * Sentences from one parsed infobox, best first. Song: writers, producers,
 * album, year, label, genre. Game: composers, developer, year, publisher,
 * platform (only when it lists one). Album: year, producers, label (and its composers when it's a
 * soundtrack). Other infoboxes (artists, series, films) give none.
 */
export function factsFromInfobox(page: string, box: Infobox): BoxFact[] {
  const f = box.fields;
  const name = subjectName(page, box);
  const out: BoxFact[] = [];
  const add = (text: string, field: string, values: string[]) => out.push({ text, evidence: `${field}: ${items(f[field] ?? "").join(", ") || f[field]}`, values });

  if (SONG_BOX.test(box.type)) {
    const q = `"${name}"`;
    const writers = nameList(f.writer ?? f.writers ?? f.songwriter ?? f.songwriters);
    const composers = nameList(f.composer);
    if (writers.length) add(`${q} was written by ${joinNames(writers)}.`, f.writer ? "writer" : f.writers ? "writers" : f.songwriter ? "songwriter" : "songwriters", writers);
    else if (composers.length) add(`${q} was composed by ${joinNames(composers)}.`, "composer", composers);
    const producers = nameList(f.producer ?? f.producers);
    if (producers.length) add(`${q} was produced by ${joinNames(producers)}.`, f.producer ? "producer" : "producers", producers);
    const album = nameList(f.album)[0];
    if (album) add(`${q} appears on ${album}.`, "album", [album]);
    const year = earliestYear(f.released ?? f.published ?? f.composed ?? f.year);
    if (year) add(`${q} came out in ${year}.`, f.released ? "released" : f.published ? "published" : f.composed ? "composed" : "year", [year]);
    const labels = nameList(f.label);
    if (labels.length && labels.length <= 2) add(`${q} was released on ${joinNames(labels)}.`, "label", labels);
    const genres = nameList(f.genre).map((g) => (/^[A-Z][a-z]/.test(g) ? g[0].toLowerCase() + g.slice(1) : g)).slice(0, 2);
    if (genres.length) add(`${q} is usually filed under ${joinNames(genres)}.`, "genre", genres);
  } else if (GAME_BOX.test(box.type)) {
    const composers = nameList(f.composer ?? f.composers);
    if (composers.length) add(`The music of ${name} is by ${joinNames(composers)}.`, f.composer ? "composer" : "composers", composers);
    const devs = nameList(f.developer ?? f.developers);
    if (devs.length && devs.length <= 3) add(`${name} was developed by ${joinNames(devs)}.`, f.developer ? "developer" : "developers", devs);
    const year = earliestYear(f.released ?? f.release);
    if (year) add(`${name} first came out in ${year}.`, f.released ? "released" : "release", [year]);
    const pubs = nameList(f.publisher ?? f.publishers);
    if (pubs.length && pubs.length <= 3 && pubs.join() !== devs.join()) add(`${name} was published by ${joinNames(pubs)}.`, f.publisher ? "publisher" : "publishers", pubs);
    const platforms = nameList(f.platforms ?? f.platform);
    // Only a single platform: a longer list mixes in later ports and remakes, which read as the original's.
    if (platforms.length === 1) add(`${name} came out on the ${platforms[0]}.`, f.platforms ? "platforms" : "platform", platforms);
  } else if (ALBUM_BOX.test(box.type)) {
    const q = `The album ${name}`;
    const soundtrack = /soundtrack|score|video game|film/i.test(f.type ?? "");
    const artists = nameList(f.artist);
    if (soundtrack && artists.length) add(`${q} is by ${joinNames(artists)}.`, "artist", artists);
    const year = earliestYear(f.released);
    if (year) add(`${q} came out in ${year}.`, "released", [year]);
    const producers = nameList(f.producer ?? f.producers);
    if (producers.length) add(`${q} was produced by ${joinNames(producers)}.`, f.producer ? "producer" : "producers", producers);
    const labels = nameList(f.label);
    if (labels.length && labels.length <= 2) add(`${q} was released on ${joinNames(labels)}.`, "label", labels);
  }
  return out.filter((x) => x.text.length <= 160);
}

const cache = new Map<string, { facts: BoxFact[]; at: number }>();

/** Infobox facts for an article, or [] when it has none worth reading. Never throws. */
export async function infoboxFacts(page: string): Promise<BoxFact[]> {
  if (!page) return [];
  const hit = cache.get(page);
  if (hit && (hit.facts.length || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.facts;
  try {
    const url = `${WIKI_API}?${new URLSearchParams({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", titles: page, redirects: "1", format: "json", formatversion: "2" })}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(config.groundingTimeoutMs), headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { query?: { pages?: Array<{ revisions?: Array<{ slots?: { main?: { content?: string } } }> }> } };
    const wikitext = data.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content ?? "";
    const box = parseInfobox(wikitext);
    const facts = box ? factsFromInfobox(page, box) : [];
    console.log(`[Infobox] "${page}": ${box ? box.type : "none"}, ${facts.length} facts`);
    cache.set(page, { facts, at: Date.now() });
    return facts;
  } catch (err) {
    console.warn(`[Infobox] Lookup failed for "${page}": ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/** Whether a caption already says every value a data fact states. */
export function alreadySaid(values: string[], captions: string[]): boolean {
  const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const said = captions.map(norm);
  return values.length > 0 && values.every((v) => said.some((c) => ` ${c} `.includes(` ${norm(v)} `)));
}

/**
 * The names and years a fixed sentence states, outside the quoted title:
 * "Lost Boy" was written by Jane Doe and Sam Roe. -> ["Jane Doe", "Sam Roe"].
 */
export function valuesIn(text: string): string[] {
  const rest = text.replace(/"[^"]*"/g, " ").replace(/^\s*\S+/, " ");
  const years = rest.match(/\b(?:1[89]|20)\d{2}\b/g) ?? [];
  const names = (rest.replace(/\b(?:1[89]|20)\d{2}\b/g, " ").match(/[\p{Lu}\p{N}][\p{L}\p{N}'’.&-]*(?:\s+(?:of|the|de|von|van|&|[\p{Lu}\p{N}][\p{L}\p{N}'’.&-]*))*/gu) ?? [])
    .map((n) => n.replace(/[.]+$/, "").trim())
    .filter((n) => n.length > 1 && !/^(The|And|An?)$/.test(n));
  return [...years, ...names];
}

export function clearInfoboxCache(): void {
  cache.clear();
}
