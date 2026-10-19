import { config } from "./config";
import { artistNames, mentionsName, normalizeTitle, resolveGameAndTrack, USER_AGENT } from "./fact-verifier";
import { SSLSong } from "./types";
import { escapeRe } from "./text";

/**
 * Plain facts from Wikidata, for songs with no Wikipedia article (issue #23).
 *
 * Wikidata's structured data is public domain (CC0), so these sentences are
 * built directly from it: release year, composers, lyricists, producers,
 * album or soundtrack, awards and charts. No AI writes them, so there is
 * nothing to screen: each fact is a template filled from one statement.
 *
 * A song only matches when its label is the song's title and its
 * description names the artist or game ("2021 single by Lil Nas X",
 * "track #100 in the Undertale Soundtrack"). A same-named song by someone
 * else ("Lost Boy", single by Ruth B) never matches.
 */

const API = "https://www.wikidata.org/w/api.php";
/** A description that says the item is a piece of music. */
const MUSIC_ITEM = /\b(song|single|track|instrumental|composition|recording|theme|piece|anthem)\b|楽曲|シングル|ソング|노래|싱글|歌曲|单曲|песня|сингл/i;

/**
 * The language to search in for a title written in another script, so
 * 「紅蓮華」 finds LiSA's song by its real name instead of a guessed
 * transliteration ("Gurenge"). Latin-script titles search in English.
 */
export function searchLanguage(title: string): string {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title)) return "ja";
  if (/\p{Script=Hangul}/u.test(title)) return "ko";
  if (/\p{Script=Han}/u.test(title)) return "ja"; // kanji-only titles are most often Japanese on music streams
  if (/\p{Script=Cyrillic}/u.test(title)) return "ru";
  return "en";
}

/** A Latin-script name in text of any script: "LiSA" in "LiSAの楽曲", but not "Sia" in "Asia". */
function namesArtist(text: string, names: string[]): boolean {
  const t = normalizeTitle(text);
  return names.some((n) => new RegExp(`(^|[^\\p{Script=Latin}\\p{N}])${escapeRe(n)}($|[^\\p{Script=Latin}\\p{N}])`, "u").test(t));
}
const MAX_NAMES = 3;
const NEGATIVE_TTL_MS = 30 * 60 * 1000;

interface Entity {
  id: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, Claim[]>;
}

const cache = new Map<string, { facts: string[]; at: number }>();

async function get<T>(params: Record<string, string>): Promise<T> {
  const url = `${API}?${new URLSearchParams({ format: "json", ...params })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(config.groundingTimeoutMs), headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function entities(ids: string[], props: string, languages = "en"): Promise<Record<string, Entity>> {
  if (!ids.length) return {};
  const data = await get<{ entities?: Record<string, Entity> }>({ action: "wbgetentities", ids: ids.join("|"), props, languages });
  return data.entities ?? {};
}

const label = (e: Entity | undefined) => e?.labels?.en?.value ?? "";
/** The English label, else the one for every language ("mul"), which many names now have instead. */
const anyLabel = (e: Entity | undefined) => e?.labels?.en?.value ?? e?.labels?.mul?.value ?? "";
type Claim = { rank?: string; mainsnak?: { datavalue?: { value?: unknown } } };

/**
 * The statements Wikidata stands behind: deprecated ones are known to be
 * wrong, and when any is marked preferred, only those count.
 * https://www.wikidata.org/wiki/Help:Ranking
 */
export function rankedClaims(e: Entity, prop: string): Claim[] {
  const usable = (e.claims?.[prop] ?? []).filter((c) => c.rank !== "deprecated");
  const preferred = usable.filter((c) => c.rank === "preferred");
  return preferred.length ? preferred : usable;
}

const itemIds = (e: Entity, prop: string): string[] =>
  rankedClaims(e, prop)
    .map((c) => (c.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id)
    .filter((id): id is string => typeof id === "string");

function year(e: Entity, prop = "P577"): string | null {
  const times = rankedClaims(e, prop)
    .map((c) => (c.mainsnak?.datavalue?.value as { time?: string } | undefined)?.time)
    .filter((t): t is string => typeof t === "string")
    .map((t) => /^\+(\d{4})/.exec(t)?.[1])
    .filter((y): y is string => Boolean(y))
    .sort();
  return times[0] ?? null;
}

function names(list: string[]): string {
  const n = list.filter(Boolean).slice(0, MAX_NAMES);
  return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** The song's item: its label is the title, and its description is music naming the artist or game. */
export function pickSong(
  hits: Array<{ id: string; label?: string; description?: string }>,
  title: string,
  artist: string
): string | null {
  const want = normalizeTitle(title);
  const names = artistNames(artist);
  if (!want || !names.length) return null;
  const hit = hits.find((h) => {
    const desc = h.description ?? "";
    return normalizeTitle(h.label ?? "") === want && MUSIC_ITEM.test(desc) && (mentionsName(normalizeTitle(desc), names) || namesArtist(desc, names));
  });
  return hit?.id ?? null;
}

/** Sentences from one song item, each naming the song so it reads on its own. */
export function factsFromEntity(song: Entity, labels: Record<string, Entity>, title: string): string[] {
  const named = (prop: string) => itemIds(song, prop).map((id) => label(labels[id])).filter(Boolean);
  const facts: string[] = [];
  const q = `"${title}"`;

  const composers = named("P86");
  const lyricists = named("P676");
  if (composers.length && composers.join() === lyricists.join()) facts.push(`${q} was written by ${names(composers)}.`);
  else {
    if (composers.length) facts.push(`${q} was composed by ${names(composers)}.`);
    if (lyricists.length) facts.push(`The lyrics of ${q} are by ${names(lyricists)}.`);
  }
  const y = year(song);
  if (y) facts.push(`${q} came out in ${y}.`);
  const partOf = named("P361");
  if (partOf.length) facts.push(`${q} appears on ${partOf[0]}.`);
  const producers = named("P162");
  if (producers.length) facts.push(`${q} was produced by ${names(producers)}.`);
  for (const award of named("P166").slice(0, 2)) facts.push(`${q} received the ${award}.`);
  const charts = named("P2291");
  if (charts.length) facts.push(`${q} made the ${names(charts.slice(0, 2))}.`);
  return facts;
}

/** Facts for a song from Wikidata, or [] when no item clearly matches. Never throws. */
export async function wikidataFacts(song: SSLSong): Promise<string[]> {
  const { game, track } = resolveGameAndTrack(song);
  const title = track || game;
  const key = `${normalizeTitle(game)}\0${normalizeTitle(title)}`;
  const hit = cache.get(key);
  if (hit && (hit.facts.length || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.facts;

  try {
    const search = await get<{ search?: Array<{ id: string; label?: string; description?: string }> }>({
      action: "wbsearchentities", search: title, language: searchLanguage(title), uselang: searchLanguage(title), type: "item", limit: "10",
    });
    const id = pickSong(search.search ?? [], title, game);
    if (!id) {
      console.log(`[Wikidata] No song item for "${title}" by ${game}`);
      cache.set(key, { facts: [], at: Date.now() });
      return [];
    }
    const item = (await entities([id], "claims|labels|descriptions"))[id];
    const refs = ["P86", "P676", "P361", "P162", "P166", "P2291"].flatMap((p) => itemIds(item, p));
    const labels = await entities([...new Set(refs)].slice(0, 50), "labels");
    const facts = factsFromEntity(item, labels, title);
    console.log(`[Wikidata] "${title}" -> ${id}: ${facts.length} facts`);
    cache.set(key, { facts, at: Date.now() });
    return facts;
  } catch (err) {
    // Not cached: Wikidata may just be slow right now.
    console.warn(`[Wikidata] Lookup failed for "${title}": ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/** A description that says the item is a performer: "American singer-songwriter", "Australian rock band". */
const PERFORMER_ITEM = /\b(band|singer|singer-songwriter|rapper|musician|composer|songwriter|duo|trio|quartet|group|DJ|producer|vocalist|pianist|guitarist|drummer|violinist|arranger|conductor|orchestra|ensemble)\b/i;
/** One video game, not a series of them: "1988 NES game", "1993 videogame". */
const GAME_ITEM = /\b(?:video ?game|game)s?\b/i;
const SERIES_ITEM = /\b(series|franchise)\b/i;
const artistCache = new Map<string, { facts: string[]; at: number }>();

/** Up to two plain facts about a performer or a game from its Wikidata item. */
export function artistFactsFromEntity(e: Entity, labels: Record<string, Entity>): string[] {
  const name = anyLabel(e);
  if (!name) return [];
  const named = (prop: string) => itemIds(e, prop).map((id) => anyLabel(labels[id]).replace(/\.$/, "")).filter(Boolean);
  const facts: string[] = [];
  if (GAME_ITEM.test(e.descriptions?.en?.value ?? "")) {
    const composers = named("P86");
    if (composers.length) facts.push(`The music of ${name} is by ${names(composers)}.`);
    const developers = named("P178");
    if (developers.length) facts.push(`${name} was developed by ${names(developers)}.`);
    const y = year(e);
    if (y) facts.push(`${name} came out in ${y}.`);
    return facts.slice(0, 2);
  }
  const person = itemIds(e, "P31").includes("Q5");
  const when = year(e, person ? "P569" : "P571");
  const where = named(person ? "P19" : "P740")[0];
  const verb = person ? "was born" : "formed";
  if (when || where) facts.push(`${name} ${verb}${where ? ` in ${where}` : ""}${when ? ` in ${when}` : ""}.`);
  const genres = named("P136").slice(0, 2);
  if (genres.length) facts.push(`${name}'s genres include ${names(genres)}.`);
  const labelsOf = named("P264").slice(0, 2);
  if (labelsOf.length) facts.push(`${name}'s record labels include ${names(labelsOf)}.`);
  return facts.slice(0, 2);
}

/**
 * Facts about the artist, or the game in the artist field, for a song whose
 * article may be about another work (issue #255): never AI, and only from an
 * item named exactly so whose description says it is a performer or one video
 * game. [] when none clearly matches. Never throws.
 */
export async function artistFacts(name: string): Promise<string[]> {
  const clean = name.replace(/\s*[([][^)\]]*[)\]]\s*$/, "").trim();
  const want = normalizeTitle(clean);
  if (!want) return [];
  const hit = artistCache.get(want);
  if (hit && (hit.facts.length || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.facts;
  try {
    const search = await get<{ search?: Array<{ id: string; label?: string; description?: string }> }>({
      action: "wbsearchentities", search: clean, language: "en", uselang: "en", type: "item", limit: "10",
    });
    const item = (search.search ?? []).find((h) => {
      const desc = h.description ?? "";
      // The name itself, not an alias: "Some Game: An Epilogue" may be an alias of the whole edition.
      return normalizeTitle(h.label ?? "") === want && (PERFORMER_ITEM.test(desc) || (GAME_ITEM.test(desc) && !SERIES_ITEM.test(desc)));
    });
    if (!item) {
      console.log(`[Wikidata] No artist or game item for "${clean}"`);
      artistCache.set(want, { facts: [], at: Date.now() });
      return [];
    }
    const e = (await entities([item.id], "claims|labels|descriptions", "en|mul"))[item.id];
    const refs = ["P86", "P178", "P19", "P740", "P136", "P264"].flatMap((p) => itemIds(e, p));
    const labels = await entities([...new Set(refs)].slice(0, 50), "labels", "en|mul");
    const facts = artistFactsFromEntity({ ...e, descriptions: { en: { value: item.description ?? "" } } }, labels);
    console.log(`[Wikidata] "${clean}" -> ${item.id}: ${facts.length} facts about the artist or game`);
    artistCache.set(want, { facts, at: Date.now() });
    return facts;
  } catch (err) {
    console.warn(`[Wikidata] Artist lookup failed for "${clean}": ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// --- Classical works (issue #260) -----------------------------------------

/** Wikidata asked us to slow down, or didn't answer: a miss says nothing, so nothing is cached. */
export class WikidataBusy extends Error {}

/** Time between Wikidata requests for classical works: its full-text search is rate-limited hard. Tests set 0. */
export const classicalPace = { ms: 1000 };
let lastClassical = 0;

async function pacedGet<T>(params: Record<string, string>): Promise<T> {
  const wait = lastClassical + classicalPace.ms - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastClassical = Date.now();
  const url = `${API}?${new URLSearchParams({ format: "json", ...params })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(config.groundingTimeoutMs), headers: { "User-Agent": USER_AGENT } });
  if (res.status === 429) throw new WikidataBusy("Wikidata rate-limited");
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    // "You are making too many requests to the API." comes back as plain text.
    throw new WikidataBusy("Wikidata rate-limited");
  }
}

type Hit = { id: string; label?: string; description?: string; match?: { text?: string } };

/** A person in the artist field, as Wikidata knows them. */
export interface Person {
  id: string;
  label: string;
  /** Wikidata lists composer among their occupations. */
  composer: boolean;
  /** A composer born before 1920, or with no birth date: whose name in the artist field means their own piece. */
  historic: boolean;
  /** Plays classical music: a pianist, a violinist, a conductor, an orchestra. */
  classicalPerformer: boolean;
}

/** Descriptions of people and groups who play classical pieces: "Chinese pianist", "South Korean pianist and composer". */
const CLASSICAL_PERFORMER = /\b(pianist|violinist|cellist|violist|organist|harpsichordist|conductor|orchestra|string quartet|ensemble|classical guitarist)s?\b/i;
/** A pop act that also plays the piano ("singer-songwriter and pianist"): its songs are looked up the usual way. */
const POP_ACT = /\b(singer|songwriter|rapper|band|DJ|rock|pop|YouTuber|record producer)\b/i;
const PERSON_ITEM = /\b(composer|pianist|violinist|cellist|violist|organist|harpsichordist|conductor|orchestra|quartet|ensemble|guitarist|musician)\b/i;
const COMPOSER = "Q36834";

/**
 * The search hit that is the person named, and whether only by a surname
 * ("Rachmaninoff" is Sergei Rachmaninoff): by label, an alias, or the end of
 * the label.
 */
export function pickPerson(hits: Hit[], name: string): { hit: Hit; bySurname: boolean } | null {
  const want = normalizeTitle(name);
  if (!want) return null;
  for (const h of hits) {
    if (!PERSON_ITEM.test(h.description ?? "")) continue;
    const label = normalizeTitle(h.label ?? "");
    if (label === want || normalizeTitle(h.match?.text ?? "") === want) return { hit: h, bySurname: false };
    if (label.endsWith(` ${want}`)) return { hit: h, bySurname: true };
  }
  return null;
}

/** Wikipedias with an article about a person named only by a surname: a famous composer has dozens, a namesake a few. */
const FAMOUS_SITELINKS = 30;

const personCache = new Map<string, { person: Person | null; at: number }>();

/** What Wikidata says the artist is, when the artist is a composer or a classical performer, from the cache only. */
export function knownPerson(name: string): Person | null | undefined {
  return personCache.get(normalizeTitle(name))?.person;
}

type PersonEntity = Entity & { sitelinks?: Record<string, unknown> };

/** A person from their item: a composer (P106) of the past, or of our time; a classical performer by their description. */
export function personFrom(e: PersonEntity, description: string, fallback: string): Person {
  const composer = itemIds(e, "P106").includes(COMPOSER);
  const born = year(e, "P569");
  return {
    id: e.id,
    label: anyLabel(e) || fallback,
    composer,
    historic: composer && (!born || Number(born) < 1920),
    classicalPerformer: CLASSICAL_PERFORMER.test(description) && !POP_ACT.test(description),
  };
}

/**
 * The composer or classical performer in the artist field, or null. Wikidata's
 * name search finds a label's start, so a surname alone ("Bizet") is also
 * searched among composers. Throws WikidataBusy when throttled.
 */
export async function personItem(name: string): Promise<Person | null> {
  const want = normalizeTitle(name);
  const hit = personCache.get(want);
  if (hit && (hit.person || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.person;
  const search = await pacedGet<{ search?: Hit[] }>({ action: "wbsearchentities", search: name, language: "en", uselang: "en", type: "item", limit: "10" });
  let picked = pickPerson(search.search ?? [], name);
  let entity: PersonEntity | undefined;
  const fetchOne = async (id: string) =>
    (await pacedGet<{ entities?: Record<string, PersonEntity> }>({ action: "wbgetentities", ids: id, props: "claims|labels|descriptions|sitelinks", languages: "en|mul" })).entities?.[id];
  if (!picked && !/\s/.test(name.trim())) {
    const found = await pacedGet<{ query?: { search?: Array<{ title: string }> } }>({
      action: "query", list: "search", srnamespace: "0", srlimit: "3", srsearch: `haswbstatement:P106=${COMPOSER} ${name}`,
    });
    const id = found.query?.search?.[0]?.title;
    entity = id && /^Q\d+$/.test(id) ? await fetchOne(id) : undefined;
    picked = entity ? pickPerson([{ id: entity.id, label: anyLabel(entity), description: entity.descriptions?.en?.value ?? "composer" }], name) : null;
  } else if (picked) entity = await fetchOne(picked.hit.id);
  let person: Person | null = null;
  // A surname alone is only a famous composer's: "Kirby" isn't a namesake with three wikis.
  const famous = !!entity && (!picked?.bySurname || Object.keys(entity.sitelinks ?? {}).length >= FAMOUS_SITELINKS);
  if (picked && entity && famous) person = personFrom(entity, picked.hit.description ?? "", picked.hit.label || name);
  console.log(`[Wikidata] "${name}" ${person ? `is ${person.label} (${person.id}${person.historic ? ", a composer of the past" : person.composer ? ", a composer" : ""}${person.classicalPerformer ? ", a classical performer" : ""})` : "is no composer or classical performer"}`);
  personCache.set(want, { person, at: Date.now() });
  return person;
}

/** A musical work's item, cut down to what choosing it needs. */
export interface WorkItem {
  id: string;
  label: string;
  /** Its label, aliases and nicknames (P1449), in English and for every language. */
  names: string[];
  /** Catalog codes (P528): "1007", "331/300i", "L. 75". */
  catalogs: string[];
  /** Composers (P86) and parent works (P361), as item ids. */
  composers: string[];
  parents: string[];
  /** Its English Wikipedia article, or "". */
  page: string;
}

const stringClaims = (e: Entity, prop: string): string[] =>
  rankedClaims(e, prop)
    .map((c) => c.mainsnak?.datavalue?.value)
    .map((v) => (typeof v === "string" ? v : (v as { text?: string } | undefined)?.text))
    .filter((v): v is string => typeof v === "string");

type FullEntity = Entity & { aliases?: Record<string, Array<{ value: string }>>; sitelinks?: { enwiki?: { title?: string } } };

/** A work's item from wbgetentities. */
export function workItem(e: FullEntity): WorkItem {
  const names = [
    ...["en", "mul"].map((l) => e.labels?.[l]?.value ?? ""),
    ...["en", "mul"].flatMap((l) => (e.aliases?.[l] ?? []).map((a) => a.value)),
    ...stringClaims(e, "P1449"),
  ].filter(Boolean);
  return {
    id: e.id,
    label: anyLabel(e),
    names: [...new Set(names)],
    catalogs: stringClaims(e, "P528"),
    composers: itemIds(e, "P86"),
    parents: itemIds(e, "P361"),
    page: e.sitelinks?.enwiki?.title ?? "",
  };
}

/** Items by id, with what a work needs. Throws WikidataBusy when throttled. */
export async function workItems(ids: string[]): Promise<WorkItem[]> {
  if (!ids.length) return [];
  const data = await pacedGet<{ entities?: Record<string, FullEntity> }>({
    action: "wbgetentities", ids: ids.join("|"), props: "labels|aliases|claims|sitelinks", languages: "en|mul", sitefilter: "enwiki",
  });
  return ids.map((id) => data.entities?.[id]).filter((e): e is FullEntity => !!e && !!e.id).map(workItem);
}

/**
 * Works matching a search, by one composer (P86) or, with none, by anyone:
 * Wikidata's full-text search over labels and aliases, so a nickname
 * ("Moonlight Sonata") finds the work it names. Throws WikidataBusy when throttled.
 */
export async function searchWorks(query: string, composer: string | null, limit = 5): Promise<WorkItem[]> {
  const filter = composer ? `haswbstatement:P86=${composer}` : "haswbstatement:P86";
  const data = await pacedGet<{ query?: { search?: Array<{ title: string }> } }>({
    action: "query", list: "search", srnamespace: "0", srlimit: String(limit), srsearch: `${filter} ${query}`,
  });
  return workItems((data.query?.search ?? []).map((h) => h.title).filter((t) => /^Q\d+$/.test(t)));
}

/** Works that list this one as a part (P527): "The Four Seasons" for its first concerto, when the concerto doesn't say. */
export async function wholesOf(id: string): Promise<WorkItem[]> {
  const data = await pacedGet<{ query?: { search?: Array<{ title: string }> } }>({
    action: "query", list: "search", srnamespace: "0", srlimit: "3", srsearch: `haswbstatement:P527=${id}`,
  });
  return workItems((data.query?.search ?? []).map((h) => h.title).filter((t) => /^Q\d+$/.test(t)));
}

/** English labels for items, by id. Throws WikidataBusy when throttled. */
export async function itemLabels(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const data = await pacedGet<{ entities?: Record<string, Entity> }>({ action: "wbgetentities", ids: ids.slice(0, 20).join("|"), props: "labels", languages: "en|mul" });
  return Object.fromEntries(Object.entries(data.entities ?? {}).map(([id, e]) => [id, anyLabel(e)]));
}

export function clearClassicalCache(): void {
  personCache.clear();
  lastClassical = 0;
}
