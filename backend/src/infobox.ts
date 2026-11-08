import { artistNames, loadWikitext, mentionsName, namesLoosely, normalizeTitle, wikitextOf } from "./fact-verifier";
import { COMMENT, removeAll, withoutRefsAndComments } from "./text";

// Facts from the article's infobox: a fixed sentence filled from one field, no AI, so wrong
// only when the field or the article is (ARCHITECTURE.md: Where structured facts come from)

const NEGATIVE_TTL_MS = 30 * 60 * 1000; // ms an article with no facts stays cached

export interface BoxFact {
  text: string;
  /** "field: value as the infobox gives it", for the dashboard and checks */
  evidence: string;
  /** Names, titles and years stated, to tell when a caption already said them */
  values: string[];
  /** What the infobox describes, checked against the request (boxMisfit) */
  about?: BoxSubject;
}

/** The work an infobox describes; artists for an album */
export interface BoxSubject {
  kind: "song" | "game" | "album";
  name: string;
  artists: string[];
}

export interface Infobox {
  /** "song", "video game", "album"..., lower case, as after "{{Infobox " */
  type: string;
  fields: Record<string, string>;
}

/** Text between a template's "{{" and its matching "}}" */
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

/** Splits on "|" outside nested templates and links */
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

/** The article's first infobox, or null */
export function parseInfobox(wikitext: string): Infobox | null {
  const text = removeAll(wikitext, COMMENT);
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

// Templates that only hold a list: {{hlist|a|b}}, {{plainlist|* a * b}}, {{ubl|a|b}}
const LIST_TEMPLATE = /^(hlist|flatlist|plainlist|plain list|unbulleted list|ubl|ubil|bulleted list|blist|startflatlist|endflatlist|nowrap|nobr|vgy|small)$/i;

/** One field's items as plain text: links resolved, references and notes dropped */
export function items(raw: string): string[] {
  let v = withoutRefsAndComments(raw)
    .replace(/\{\{\s*(efn|refn|sfn|r|ref label|nbsp|citation needed|cn|clarify|when|who|dubious|according to whom|abbr)\b[^{}]*\}\}/gi, "")
    .replace(/<br\s*\/?>/gi, "\n");
  v = removeAll(v, /<\/?(small|span|div|i|b|sup|sub)[^>]*>/gi);
  // List templates become their items, one per line, inside out
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

/** A field's names, when every item is a clean name (no notes, roles or brackets) */
function nameList(raw: string | undefined): string[] {
  if (!raw) return [];
  const list = items(raw);
  const clean = list.every((n) => n.length <= 60 && !/[()[\]{}<>"|:]|\b(and|with|feat\.?|featuring|uncredited|original|arranged|additional|remix|remake|port|version)\b/i.test(n) && /\p{L}/u.test(n));
  return clean ? [...new Set(list)] : [];
}

/** "A", "A and B", "A, B and C": every name; a sentence too long for a bubble drops whole */
function joinNames(list: string[]): string {
  return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** Earliest year in a release field, plain or in {{Start date}} and release templates */
export function earliestYear(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = withoutRefsAndComments(raw);
  const years = [...v.matchAll(/(?<![\d#])(19[0-9]{2}|20[0-4][0-9])(?![\d])/g)].map((m) => m[1]).sort();
  return years[0] ?? null;
}

// A title's disambiguation: "(video game)", "(Moth Choir song)", "(1997 video game)"
const DISAMBIGUATION = /\s*\((?:[^()]*\b(?:song|single|album|EP|video game|game|soundtrack|composition)|\d{4})\)\s*$/i;

/**
 * The name viewers know, from the page title ("Pokémon Gold and Silver", not the version an
 * infobox lists first); an album's from its infobox, since its page may be "Music of <game>"
 */
export function subjectName(page: string, box: Infobox): string {
  const named = ALBUM_BOX.test(box.type) ? items(box.fields.name ?? "") : [];
  if (named.length === 1 && named[0].length <= 80) return named[0];
  return page.replace(DISAMBIGUATION, "").trim();
}

const SONG_BOX = /^(song|single|musical composition)$/;
const GAME_BOX = /^video game$/;
const ALBUM_BOX = /^album$/;

/** Sentences from a song's, game's or album's infobox, best first; other kinds give none */
export function factsFromInfobox(page: string, box: Infobox): BoxFact[] {
  const f = box.fields;
  const name = subjectName(page, box);
  const out: BoxFact[] = [];
  const kind = SONG_BOX.test(box.type) ? "song" : GAME_BOX.test(box.type) ? "game" : "album";
  const about: BoxSubject = { kind, name, artists: kind === "game" ? [] : items(f.artist ?? "") };
  const add = (text: string, field: string, values: string[]) => out.push({ text, evidence: `${field}: ${items(f[field] ?? "").join(", ") || f[field]}`, values, about });

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
    // "Include", as listed: not "usually", and not two of three passed off as all
    const genres = nameList(f.genre).map((g) => (/^[A-Z][a-z]/.test(g) ? g[0].toLowerCase() + g.slice(1) : g)).slice(0, 3);
    if (genres.length) add(`The genres of ${q} include ${joinNames(genres)}.`, "genre", genres);
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
    // One platform only: a longer list mixes in later ports and remakes, read as the original's
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

/** Infobox facts for an article, [] when none worth reading. Never throws */
export async function infoboxFacts(page: string): Promise<BoxFact[]> {
  if (!page) return [];
  const hit = cache.get(page);
  if (hit && (hit.facts.length || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.facts;
  try {
    const wikitext = await loadWikitext(page);
    const box = parseInfobox(wikitext);
    let facts = box ? factsFromInfobox(page, box) : [];
    // A single's year for a song its album put out earlier isn't when the song came out
    const year = box && SONG_BOX.test(box.type) ? boxYear(box) : null;
    const album = year ? await albumYear(box as Infobox) : null;
    if (year && album && album < year) facts = facts.filter((f) => !/^(released|published|composed|year):/.test(f.evidence));
    console.log(`[Infobox] "${page}": ${box ? box.type : "none"}, ${facts.length} facts`);
    cache.set(page, { facts, at: Date.now() });
    return facts;
  } catch (err) {
    console.warn(`[Infobox] Lookup failed for "${page}": ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/** Whether a caption already says every value a data fact states */
export function alreadySaid(values: string[], captions: string[]): boolean {
  const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const said = captions.map(norm);
  return values.length > 0 && values.every((v) => said.some((c) => ` ${c} `.includes(` ${norm(v)} `)));
}

/** Names and years a fixed sentence states, outside the quoted title */
export function valuesIn(text: string): string[] {
  const rest = text.replace(/"[^"]*"/g, " ").replace(/^\s*\S+/, " ");
  const years = rest.match(/\b(?:1[89]|20)\d{2}\b/g) ?? [];
  const names = (rest.replace(/\b(?:1[89]|20)\d{2}\b/g, " ").match(/[\p{Lu}\p{N}][\p{L}\p{N}'’.&-]*(?:\s+(?:of|the|de|von|van|&|[\p{Lu}\p{N}][\p{L}\p{N}'’.&-]*))*/gu) ?? [])
    .map((n) => n.replace(/[.]+$/, "").trim())
    .filter((n) => n.length > 1 && !/^(The|And|An?)$/.test(n));
  return [...years, ...names];
}

/** Same title, ignoring case, punctuation, spacing, "&" or "and", a leading "the" ("Dont" is "Don't") */
export function sameTitle(a: string, b: string): boolean {
  const key = (s: string) => normalizeTitle(s).split(" ").filter((w) => w && w !== "and" && w !== "the").join("");
  return Boolean(key(a)) && key(a) === key(b);
}

// A film's or show's soundtrack: "Some Quest: Original Motion Picture Soundtrack"
const SCREEN_SOUNDTRACK = /\b(motion picture|film|movie|television|tv series)\b/i;

// A game with its platform in the artist field: "Some Quest (GB)", "Some Quest (Arcade)"
export const PLATFORM_TAG = /\((?:GB|GBC|GBA|NES|SNES|SFC|FC|N64|GC|DS|3DS|PS[1-5]?|PSX|PSP|Genesis|MD|SMS|GG|PCE|TG-?16|Arcade|Saturn|DC|Dreamcast|Wii|Wii U|Switch|Xbox|C64|Amiga|DOS|MSX|PC)\)\s*$/i;

/**
 * Why an infobox is about another work than the request, or "" (#256; ARCHITECTURE.md: "Another work's
 * infobox"). `performer`: MusicBrainz has the song by an artist of the game's name; `gameTrack`: the
 * artist field has a platform tag, so a film's or show's soundtrack album is another work
 */
export function boxMisfit(about: BoxSubject, request: { game: string; titles: string[]; gameTrack?: boolean }, performer = false): string {
  const names = artistNames(request.game);
  const name = normalizeTitle(about.name);
  if (about.kind === "song") return request.titles.some((t) => sameTitle(t, about.name)) ? "" : `a song's infobox for "${about.name}", another title`;
  if (about.kind === "game") {
    if (performer) return `a game's infobox, and ${request.game} is a performer`;
    const spaced = (s: string) => ` ${s.replace(/\band\b/g, " ").replace(/\s+/g, " ").trim()} `;
    return names.some((n) => spaced(name).endsWith(spaced(n))) ? "" : `the infobox is about ${about.name}, not ${request.game}`;
  }
  if (request.gameTrack && SCREEN_SOUNDTRACK.test(about.name)) return `a film's or a show's soundtrack album, ${about.name}, for a game's track`;
  const byArtist = about.artists.some((a) => namesLoosely(normalizeTitle(a), names));
  return byArtist || mentionsName(name, names) ? "" : `an album's infobox for ${about.name}, not ${request.game}'s`;
}

/**
 * The article's first infobox if a song's, else null; null too when it names an artist not in
 * `artists` (normalized): a cover's page redirecting to the original's. Never throws
 */
export async function songBoxOf(page: string, artists: string[] = []): Promise<Infobox | null> {
  const box = page ? parseInfobox(await wikitextOf(page)) : null;
  if (!box || !SONG_BOX.test(box.type)) return null;
  const named = items(box.fields.artist ?? "");
  return artists.length && named.length && !named.some((a) => namesLoosely(normalizeTitle(a), artists)) ? null : box;
}

/** Writers in a song's infobox (writer, composer, lyricist fields): [] for none, null when not names */
export function boxWriters(box: Infobox): string[] | null {
  return creditFields(box, ["writer", "writers", "songwriter", "songwriters", "composer", "composers", "lyricist", "lyricists", "lyrics"]);
}

/** Producers in a song's infobox: [] for none, null when not names */
export function boxProducers(box: Infobox): string[] | null {
  return creditFields(box, ["producer", "producers"]);
}

function creditFields(box: Infobox, keys: string[]): string[] | null {
  const found: string[] = [];
  for (const k of keys) {
    if (!box.fields[k]) continue;
    const list = nameList(box.fields[k]);
    if (!list.length) return null;
    found.push(...list);
  }
  return [...new Set(found)];
}

/** The year a song's infobox says it came out, or null */
export function boxYear(box: Infobox): string | null {
  const f = box.fields;
  return earliestYear(f.released ?? f.published ?? f.composed ?? f.year);
}

/** The single before or after in a song's infobox, or null */
export function boxNeighbor(box: Infobox, side: "prev" | "next"): string | null {
  return items(box.fields[`${side} title`] ?? "")[0]?.replace(/^["“]|["”]$/g, "") ?? null;
}

/** Year of the album a song's infobox links to, from its own infobox, or null; a later year is the single's. Never throws */
export async function albumYear(box: Infobox): Promise<string | null> {
  const link = /\[\[([^|\]#]+)/.exec(withoutRefsAndComments(box.fields.album ?? ""))?.[1]?.trim();
  if (!link) return null;
  const album = parseInfobox(await wikitextOf(link));
  return album && ALBUM_BOX.test(album.type) ? earliestYear(album.fields.released) : null;
}

/** Whether an artist infobox's origin or birthplace backs Wikidata's place; true with no such field */
export function boxBacksPlace(box: Infobox | null, place: string, person: boolean): boolean {
  const raw = box?.fields[person ? "birth place" : "origin"];
  if (!raw) return true;
  const text = normalizeTitle(items(raw).join(" ") || withoutRefsAndComments(raw).replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1"));
  return mentionsName(text, [normalizeTitle(place)]);
}

/** Whether an artist infobox's birth date or first year active backs Wikidata's year; true with no such field */
export function boxBacksYear(box: Infobox | null, year: string, person: boolean): boolean {
  const told = earliestYear(box?.fields[person ? "birth date" : "years active"]);
  return !told || told === year;
}

/** An article's first infobox of any kind, or null. Never throws */
export async function anyBoxOf(page: string): Promise<Infobox | null> {
  return page ? parseInfobox(await wikitextOf(page)) : null;
}

/** Whether two credit lists name the same people, each a letter or two off at most */
export function sameCredits(a: string[], b: string[]): boolean {
  const same = (x: string, y: string) => namesLoosely(normalizeTitle(x), [normalizeTitle(y)]) && namesLoosely(normalizeTitle(y), [normalizeTitle(x)]);
  return a.length === b.length && a.every((x) => b.some((y) => same(x, y))) && b.every((y) => a.some((x) => same(x, y)));
}

export function clearInfoboxCache(): void {
  cache.clear();
}
