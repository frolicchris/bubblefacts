import { config } from "./config";
import { artistNames, MAX_FACT_CHARS, mentionsName, namesLoosely, normalizeTitle, resolveGameAndTrack, USER_AGENT } from "./fact-verifier";
import { SSLSong } from "./types";
import { escapeRe } from "./text";
import { fitOrSplit, packFacts } from "./data-facts";
import { albumYear, anyBoxOf, boxBacksPlace, boxBacksYear, boxNeighbor, boxProducers, boxWriters, boxYear, Infobox, sameCredits, sameTitle, songBoxOf } from "./infobox";

/**
 * Plain facts from Wikidata, for songs with no Wikipedia article (issue #23).
 *
 * Wikidata's structured data is public domain (CC0), so these sentences are
 * built directly from it: release year, composers, lyricists, producers,
 * album or soundtrack, awards, charts, what a song is based on, its
 * derivative works, the single before and after, the language of the lyrics
 * and its first performance. No AI writes them, so there is
 * nothing to screen: each fact is a template filled from one statement.
 *
 * A song only matches when its label is the song's title and its
 * description names the artist or game ("2021 single by Lil Nas X",
 * "track #100 in the Undertale Soundtrack"). A same-named song by someone
 * else ("Lost Boy", single by Ruth B) never matches.
 */

const API = "https://www.wikidata.org/w/api.php";
/** A description that says the item is a piece of music. */
const MUSIC_ITEM = /\b(song|single|track|instrumental|composition|recording|theme|piece|anthem)\b|楽曲|シングル|ソング|노래|싱글|歌曲|单曲|單曲|песня|сингл/i;

/**
 * The languages to search in, in order, for a title written in another
 * script, so 「紅蓮華」 finds LiSA's song by its real name instead of a guessed
 * transliteration ("Gurenge"). Latin-script titles search in English. A title
 * of Han characters alone could be Japanese or Chinese: Japanese first (most
 * kanji-only titles on music streams), then Chinese, then English (an item
 * with no Japanese or Chinese label shows its title as written).
 */
export function searchLanguages(title: string): string[] {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title)) return ["ja"];
  if (/\p{Script=Hangul}/u.test(title)) return ["ko"];
  if (/\p{Script=Han}/u.test(title)) return ["ja", "zh", "en"];
  if (/\p{Script=Cyrillic}/u.test(title)) return ["ru"];
  return ["en"];
}

/** The first language to search in. */
export function searchLanguage(title: string): string {
  return searchLanguages(title)[0] ?? "en";
}

/** A Latin-script name in text of any script: "LiSA" in "LiSAの楽曲", but not "Sia" in "Asia". */
function namesArtist(text: string, names: string[]): boolean {
  const t = normalizeTitle(text);
  // Han names have no spaces around them in Chinese or Japanese text: "鄧麗君演唱的歌曲".
  if (names.some((n) => /\p{Script=Han}/u.test(n) && n.replace(/\s/g, "").length >= 2 && t.includes(n))) return true;
  return names.some((n) => new RegExp(`(^|[^\\p{Script=Latin}\\p{N}])${escapeRe(n)}($|[^\\p{Script=Latin}\\p{N}])`, "u").test(t));
}
const NEGATIVE_TTL_MS = 30 * 60 * 1000;

export interface Entity {
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

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * A Wikidata time as plain words at the precision Wikidata stands behind:
 * "1987", "March 1987" or "March 3, 1987". Anything coarser than a year, a
 * year before 1000, or a month or day that isn't a real one gives null.
 */
export function plainDate(value: unknown): { text: string; sort: number } | null {
  const v = value as { time?: unknown; precision?: unknown } | undefined;
  const m = typeof v?.time === "string" ? /^\+(\d{4})-(\d{2})-(\d{2})T/.exec(v.time) : null;
  if (!m || typeof v?.precision !== "number" || v.precision < 9) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1000) return null;
  if (v.precision === 9) return { text: String(y), sort: y * 10000 };
  if (mo < 1 || mo > 12) return null;
  if (v.precision === 10) return { text: `${MONTHS[mo - 1]} ${y}`, sort: y * 10000 + mo * 100 };
  if (v.precision !== 11 || new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null;
  return { text: `${MONTHS[mo - 1]} ${d}, ${y}`, sort: y * 10000 + mo * 100 + d };
}

/** A label fit to put in a sentence: one line of text, not an item number, not a link. */
function cleanLabel(l: string): string {
  // Wikidata labels sometimes carry the disambiguation Wikipedia needs: "Always (Erasure song)".
  const t = l.replace(/\s*\([^()]*\b(?:song|single|composition|piece|album|instrumental|recording)\)\s*$/i, "").trim();
  return t && t.length <= 100 && !/^[QP]\d+$/.test(t) && !/https?:|[\n\r<>]/.test(t) ? t : "";
}

/** Values of "language of work" that say nothing about the words sung. */
const NO_LANGUAGE = /^(no linguistic content|multiple languages|undetermined|unknown|not applicable|mis|mul|und|zxx)$|sign language/i;

/** Every name: a credit cut to its first few reads as the whole list. Callers shorten lists that say "include". */
function names(list: string[]): string {
  const n = list.filter(Boolean);
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

/** Whether the item dates its earliest year no finer than the year: a rough date, often a composition's or another recording's. */
function yearOnly(e: Entity): boolean {
  const first = year(e);
  const dates = rankedClaims(e, "P577").map((c) => c.mainsnak?.datavalue?.value as { time?: string; precision?: number } | undefined);
  return !dates.some((d) => d?.time?.startsWith(`+${first}`) && (d.precision ?? 0) > 9);
}

/** The years an item's description gives: "1982 single by ...", "... released in 1999". */
const describedYears = (e: Entity): string[] => (e.descriptions?.en?.value ?? "").match(/\b(?:1[89]|20)\d\d\b/g) ?? [];

/**
 * Sentences from one song item, each naming the song so it reads on its own.
 *
 * `box`: the infobox of the item's English Wikipedia article (null when it has
 * none for a song), the fuller source to check the item against: a benchmark found a
 * composer or producer list cut to one name, and a year from before the release.
 * Undefined when the item has no English article. Writers and producers are told
 * only when the infobox lists the same people; a year only when neither the
 * infobox nor the item's description gives another, the song's album (its
 * infobox's, `album`) didn't come out earlier, and an item dated to the year alone
 * has the infobox's year behind it; the single before or after only when the
 * infobox names the same one.
 */
export function factsFromEntity(song: Entity, labels: Record<string, Entity>, title: string, box?: Infobox | null, album: string | null = null): string[] {
  const named = (prop: string) => itemIds(song, prop).map((id) => label(labels[id])).filter(Boolean);
  const facts: string[] = [];
  const q = `"${title}"`;
  const backed = (list: string[], inBox: (b: Infobox) => string[] | null) => {
    if (box === undefined || !list.length) return list;
    const want = box ? inBox(box) : null;
    return want && sameCredits(list, want) ? list : [];
  };

  const writers = backed([...new Set([...named("P86"), ...named("P676")])], boxWriters);
  // The infobox backs the people, not who wrote the words and who the music: one "written by".
  const confirmed = box !== undefined && writers.length > 0;
  const composers = writers.length && !confirmed ? named("P86") : [];
  const lyricists = writers.length && !confirmed ? named("P676") : [];
  if (confirmed) facts.push(`${q} was written by ${names(writers)}.`);
  else if (composers.length && composers.join() === lyricists.join()) facts.push(`${q} was written by ${names(composers)}.`);
  else {
    if (composers.length) facts.push(`${q} was composed by ${names(composers)}.`);
    if (lyricists.length) facts.push(`The lyrics of ${q} are by ${names(lyricists)}.`);
  }
  const described = describedYears(song);
  const told = box ? boxYear(box) : null;
  const first = year(song);
  // A later year than the song's album is a single's: the song came out with the album (`album`).
  const dated = told ? told === first : box === undefined || !yearOnly(song);
  const y = first && (!described.length || described.includes(first)) && dated && !(album && album < first) ? first : null;
  const partOf = named("P361");
  if (y && partOf.length) facts.push(...fitOrSplit(`${q} came out in ${y} and appears on ${partOf[0]}.`, [`${q} came out in ${y}.`, `${q} appears on ${partOf[0]}.`]));
  else if (y) facts.push(`${q} came out in ${y}.`);
  else if (partOf.length) facts.push(`${q} appears on ${partOf[0]}.`);
  const producers = backed(named("P162"), boxProducers);
  if (producers.length) facts.push(`${q} was produced by ${names(producers)}.`);
  for (const award of named("P166").slice(0, 2)) facts.push(`${q} received the ${award}.`);
  const charts = named("P2291");
  if (charts.length) facts.push(`${q} made the ${names(charts.slice(0, 2))}.`);

  // Other works are named by their label alone, never with an artist: the
  // original of a cover isn't the requested artist's, and neither is a cover
  // of the requested artist's song. A work with the song's own name tells
  // nothing, so it is left out.
  const sameName = (l: string) => normalizeTitle(l) === normalizeTitle(title);
  const others = (prop: string) => named(prop).map(cleanLabel).filter((l) => l && !sameName(l));
  const basedOn = others("P144");
  if (basedOn.length) facts.push(`${q} is based on "${basedOn[0]}".`);
  const derived = [...new Set(others("P4969"))].slice(0, 2);
  if (derived.length) facts.push(`Derivative works of ${q} include ${derived.map((d) => `"${d}"`).join(" and ")}.`);

  // Follows and followed by are the single before and after only when both
  // items are singles. Wikidata sometimes points a single's "follows" at the
  // earlier song it covers ("1956 song performed by ..."), which isn't one.
  // An item in two series (a duet, a charity single) has two of them, and a
  // neighbor released on the wrong side of the song is a slip: skip both.
  // The order is often wrong (a single dated by its later UK release, or the next
  // one skipped): with an English article, its infobox must name the same single.
  const isSingle = (e: Entity | undefined) => /\bsingle\b/i.test(e?.descriptions?.en?.value ?? "");
  const yearOf = (e: Entity | undefined) => Number(/^(\d{4})\b/.exec(e?.descriptions?.en?.value ?? "")?.[1]) || null;
  const inBox = (name: string, side: "prev" | "next") => box === undefined || Boolean(box && sameTitle(name, boxNeighbor(box, side) ?? ""));
  const singles = (prop: string, earlier: boolean) => {
    const ids = itemIds(song, prop);
    const mine = yearOf(song);
    const ok = ids.filter((id) => {
      const theirs = yearOf(labels[id]);
      return isSingle(labels[id]) && !(mine && theirs && (earlier ? theirs > mine : theirs < mine));
    });
    const side = earlier ? "prev" : "next";
    return isSingle(song) && ids.length === 1 && ok.length === 1 ? [cleanLabel(label(labels[ok[0]]))].filter((l) => l && !sameName(l) && inBox(l, side)) : [];
  };
  const before = singles("P155", true);
  if (before.length) facts.push(`${q} came after the single "${before[0]}".`);
  const after = singles("P156", false);
  if (after.length) facts.push(`${q} was followed by the single "${after[0]}".`);

  const languages = named("P407").map(cleanLabel).filter((l) => l && !NO_LANGUAGE.test(l));
  if (languages.length && !languages.every((l) => /english/i.test(l))) {
    facts.push(`The lyrics of ${q} are in ${names([...new Set(languages)])}.`);
  }

  const performed = rankedClaims(song, "P1191")
    .map((c) => plainDate(c.mainsnak?.datavalue?.value))
    .filter((d): d is { text: string; sort: number } => d !== null)
    .sort((a, b) => a.sort - b.sort)[0];
  if (performed) facts.push(`${q} was first performed ${performed.text.includes(",") ? "on" : "in"} ${performed.text}.`);
  // A list of every name too long for a bubble is left out, rather than cut.
  return facts.filter((f) => f.length <= MAX_FACT_CHARS);
}

/** Facts for a song from Wikidata, or [] when no item clearly matches. Never throws. */
export async function wikidataFacts(song: SSLSong): Promise<string[]> {
  const { game, track } = resolveGameAndTrack(song);
  const title = track || game;
  // No artist to match the item's description against: any "traditional folk song" would do.
  if (!game || title === game) return [];
  const key = `${normalizeTitle(game)}\0${normalizeTitle(title)}`;
  const hit = cache.get(key);
  if (hit && (hit.facts.length || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.facts;

  try {
    // The next language is tried only when the one before found no song.
    let id: string | null = null;
    for (const language of searchLanguages(title)) {
      const search = await get<{ search?: Array<{ id: string; label?: string; description?: string }> }>({
        action: "wbsearchentities", search: title, language, uselang: language, type: "item", limit: "10",
      });
      id = pickSong(search.search ?? [], title, game);
      if (id) break;
    }
    if (!id) {
      console.log(`[Wikidata] No song item for "${title}" by ${game}`);
      cache.set(key, { facts: [], at: Date.now() });
      return [];
    }
    const item = (await get<{ entities?: Record<string, Entity & { sitelinks?: { enwiki?: { title?: string } } }> }>({
      action: "wbgetentities", ids: id, props: "claims|labels|descriptions|sitelinks", languages: "en", sitefilter: "enwiki",
    })).entities?.[id] ?? { id };
    // The item's English article, when it has one, to check its credits and year against.
    const page = item.sitelinks?.enwiki?.title;
    const box = page ? await songBoxOf(page, artistNames(game)) : undefined;
    const album = box ? await albumYear(box) : null;
    // A few of the long lists, so a song with many covers doesn't crowd out the rest.
    const refs = [["P86", 50], ["P676", 50], ["P361", 50], ["P162", 50], ["P166", 50], ["P2291", 50], ["P144", 3], ["P4969", 6], ["P155", 3], ["P156", 3], ["P407", 3]]
      .flatMap(([p, n]) => itemIds(item, p as string).slice(0, n as number));
    const labels = await entities([...new Set(refs)].slice(0, 50), "labels|descriptions");
    const facts = factsFromEntity(item, labels, title, box, album);
    console.log(`[Wikidata] "${title}" -> ${id}${page ? ` (${box ? "checked against" : "no song infobox in"} "${page}")` : ""}: ${facts.length} facts`);
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
export function artistFactsFromEntity(e: Entity, labels: Record<string, Entity>, box: Infobox | null = null): string[] {
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
  // Two different years, or a group whose "work period start" is another year than its
  // "inception" (a reunion dated as the start): no year rather than the wrong one.
  const years = (prop: string) => [...new Set(rankedClaims(e, prop).map((c) => /^\+(\d{4})/.exec((c.mainsnak?.datavalue?.value as { time?: string } | undefined)?.time ?? "")?.[1]).filter(Boolean))];
  const born = years(person ? "P569" : "P571");
  const active = person ? [] : years("P2031");
  const when = born.length === 1 && (!active.length || (active.length === 1 && active[0] === born[0])) && boxBacksYear(box, born[0] as string, person) ? born[0] : null;
  // A place the artist's own article (`box`) gives otherwise is left out: Wikidata may name another city.
  const place = named(person ? "P19" : "P740").filter((p) => boxBacksPlace(box, p, person))[0];
  // "formed in the United States", not "in United States".
  const where = place && /^(United States|United Kingdom|United Arab Emirates|Netherlands|Philippines|Czech Republic|Dominican Republic|Bahamas|Gambia|Maldives)\b/.test(place) ? `the ${place}` : place;
  const verb = person ? "was born" : "formed";
  const genres = named("P136").slice(0, 2);
  const labelsOf = named("P264").slice(0, 2);
  // Packed into as few bubbles as fit, the first sentence naming the artist and the rest short.
  const parts: Array<{ full: string; short: string }> = [];
  if (when || where) {
    const origin = `${name} ${verb}${where ? ` in ${where}` : ""}${when ? ` in ${when}` : ""}.`;
    parts.push({ full: origin, short: origin });
  }
  if (genres.length) parts.push({ full: `${name}'s genres include ${names(genres)}.`, short: `Genres include ${names(genres)}.` });
  if (labelsOf.length) parts.push({ full: `${name}'s record labels include ${names(labelsOf)}.`, short: `Record labels include ${names(labelsOf)}.` });
  return packFacts(parts).slice(0, 2);
}

/**
 * The one performer or video game named exactly so (`want`, normalized): the name
 * itself, not an alias ("Some Game: An Epilogue" may be an alias of the whole edition).
 * Two of them (a band and a game both called so, a game and its remake) leave it
 * unclear which the request means: none.
 */
export function pickArtistOrGame(hits: Array<{ id: string; label?: string; description?: string }>, want: string): { id: string; description?: string } | null {
  const named = hits.filter((h) => {
    const desc = h.description ?? "";
    return normalizeTitle(h.label ?? "") === want && (PERFORMER_ITEM.test(desc) || (GAME_ITEM.test(desc) && !SERIES_ITEM.test(desc)));
  });
  return named.length === 1 ? named[0] : null;
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
    const item = pickArtistOrGame(search.search ?? [], want);
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

/** Honors worth a bubble: a lifetime's, not one competitive category ("Grammy Award for Best ..."). */
const LIFETIME_HONOR = /\b(Hall of Fame|Medal|Lifetime Achievement|Kennedy Center|Order of|Knight|Dame|Commander|Commandeur|Chevalier|Officer of|Member of the|Fellow|Person of the Year|Peace|Polar Music|Nobel|Pulitzer|Laureate|Legion)\b/;
/** A title one is made, not a prize one receives. */
const TITLE_HONOR = /^(?:Honorary )?(?:Knight|Dame|Commander|Commandeur|Chevalier|Officer|Member|Companion|Grand|Fellow)\b/;
/** Positions an artist holds for a cause, not an office. */
const CAUSE_POSITION = /\b(ambassador|envoy|patron|spokes(?:person|man|woman)|trustee)\b/i;
/** Musicians' bodies among the groups someone is a member of, not a band. */
const MUSICIANS_BODY = /\b(Union|Guild|Federation|Academy)\b/;
/** Benefit shows among the events someone took part in. */
const BENEFIT_SHOW = /\b(Aid|Benefit|Telethon)\b|^(?:The )?Concert for\b/i;

const withArticle = (s: string) => `${/^[AEIOU]/.test(s) ? "an" : "a"} ${s}`;

/**
 * The good an artist's item states, each a sentence built from one statement: a movement
 * (P135, as "associated with", which is what the statement says), a position held for a cause
 * (P39), a benefit show (P1344), a musicians' body (P463), notable students (P802), and up to
 * two lifetime honors (P166), never one competitive category. No claim of why, no year.
 */
export function artistGoodFromEntity(e: Entity, labels: Record<string, Entity>): string[] {
  const name = anyLabel(e);
  if (!name) return [];
  const named = (prop: string) => itemIds(e, prop).map((id) => cleanLabel(anyLabel(labels[id]).replace(/[\u200e\u200f]/g, "").replace(/\.$/, ""))).filter(Boolean);
  const facts = named("P135").slice(0, 2).map((m) => `${name} is associated with the movement known as ${m}.`);
  for (const p of named("P39").filter((l) => CAUSE_POSITION.test(l)).slice(0, 1)) facts.push(`${name} has served as ${p}.`);
  for (const show of named("P1344").filter((l) => BENEFIT_SHOW.test(l)).slice(0, 1)) facts.push(`${name} took part in ${show}.`);
  for (const body of named("P463").filter((l) => MUSICIANS_BODY.test(l)).slice(0, 1)) facts.push(`${name} is a member of the ${body}.`);
  const students = named("P802").slice(0, 2);
  if (students.length) facts.push(`${name}'s students include ${names(students)}.`);
  if (named("P166").some((a) => /^honorary doctor/i.test(a))) facts.push(`${name} received an honorary doctorate.`);
  const awards = named("P166").filter((a) => /^\p{Lu}/u.test(a)).map((a) => a.replace(/^The\s+/, ""));
  for (const a of awards.filter((a) => LIFETIME_HONOR.test(a)).slice(0, 2)) {
    if (/Hall of Fame/.test(a)) facts.push(`${name} was inducted into the ${a}.`);
    else if (TITLE_HONOR.test(a)) facts.push(`${name} was made ${withArticle(a)}.`);
    else facts.push(`${name} received the ${a}.`);
  }
  return facts.filter((f) => f.length <= MAX_FACT_CHARS);
}

// --- The matched article's own item (issue #256) ---------------------------

/** One piece of music: song, single, musical work, musical work/composition, composed musical work, track with vocals. */
const SONG_CLASSES = new Set(["Q7366", "Q134556", "Q2188189", "Q105543609", "Q207628", "Q55850593"]);
/** A release or a work that holds many pieces, or isn't music: album, studio album, EP, soundtrack, compilation, live album, film, video game, musical. */
const NOT_ONE_PIECE = new Set(["Q482994", "Q208569", "Q169930", "Q4176708", "Q222910", "Q209939", "Q11424", "Q7889", "Q2743"]);
/** A performer: a person, or a musical group, rock band, ensemble, duo, boy band or girl group. */
const HUMAN = "Q5";
const GROUP_CLASSES = new Set(["Q215380", "Q5741069", "Q2088357", "Q9212979", "Q216337", "Q641066"]);
/** What a song's P361 ("part of") must be for "appears on": an album, an EP, a soundtrack or a mixtape. */
const RELEASE_ITEM = /\b(album|EP|soundtrack|mixtape)\b/i;

/** What the article's item is, cut down to what its facts need. */
export type ArticleItem =
  | { kind: "song"; title: string; year: string | null; partOf: string | null; genres: string[]; albumYear?: string | null; knownBy?: string | null; yearOnly?: boolean }
  | { kind: "artist"; facts: string[] }
  | null;

/** A name in the item's label or the request's artist field, either way round and a letter or two off. */
function sameArtist(label: string, names: string[]): boolean {
  const l = normalizeTitle(label);
  return Boolean(l) && (namesLoosely(l, names) || names.some((n) => namesLoosely(n, [l])));
}

/**
 * The facts a surely matched article's item allows (issue #256). A song, single or
 * musical work gives its year, album and genres, unless it names performers and
 * none is the requested artist (the item is another performer's version). A
 * performer gives the artist facts `artistFactsFromEntity` writes, when its name
 * is the artist's. Anything else (an album, a film, a game) gives nothing.
 */
export function articleItemFrom(e: Entity, labels: Record<string, Entity>, artist: string[], titles: string[] = [], box: Infobox | null = null): ArticleItem {
  const classes = itemIds(e, "P31");
  const description = e.descriptions?.en?.value ?? "";
  const names = artist.filter(Boolean);
  if (!names.length || classes.some((c) => NOT_ONE_PIECE.has(c))) return null;
  if (classes.some((c) => SONG_CLASSES.has(c))) {
    const title = cleanLabel(anyLabel(e));
    if (!title || (/\b(album|EP)\b/.test(description) && !/\b(song|single)\b/i.test(description))) return null;
    // The item is the requested song by name, not another work the article is about.
    if (titles.length && !titles.some((t) => sameTitle(t, title))) return null;
    const performers = itemIds(e, "P175").map((id) => anyLabel(labels[id]));
    if (performers.length && !performers.some((p) => sameArtist(p, names))) return null;
    // The earliest date at a year's precision or finer. An item described with another
    // year ("1969 single by ...", "... released in 1999") dates it elsewhere: no year.
    const dates = rankedClaims(e, "P577")
      .map((c) => plainDate(c.mainsnak?.datavalue?.value))
      .filter((d): d is { text: string; sort: number } => d !== null)
      .sort((a, b) => a.sort - b.sort);
    const first = dates.length ? String(Math.floor(dates[0].sort / 10000)) : null;
    const described = describedYears(e);
    const year = first && (!described.length || described.includes(first)) ? first : null;
    const partOf = itemIds(e, "P361")
      .filter((id) => RELEASE_ITEM.test(labels[id]?.descriptions?.en?.value ?? ""))
      .map((id) => cleanLabel(anyLabel(labels[id])))
      .find(Boolean) ?? null;
    const genres = itemIds(e, "P136").map((id) => anyLabel(labels[id])).filter(Boolean).slice(0, 2);
    return { kind: "song", title, year, partOf, genres, ...(yearOnly(e) ? { yearOnly: true } : {}) };
  }
  const performer = (classes.includes(HUMAN) || classes.some((c) => GROUP_CLASSES.has(c))) && PERFORMER_ITEM.test(description);
  if (!performer || !sameArtist(anyLabel(e), names)) return null;
  const facts = artistFactsFromEntity(e, labels, box);
  return facts.length ? { kind: "artist", facts } : null;
}

/**
 * Sentences from a song's item, leaving out what MusicBrainz already says for the song
 * (`covered`): its year and whether it named an album. When the two years differ, the
 * earlier stands only if it is MusicBrainz's, which leaves out reissues, compilations and
 * live albums; when Wikidata's is earlier, neither is shown (`dropYear`). `knownBy`: the
 * earliest year the item or its infobox dates the song, kept when the two disagree and no
 * year is shown: MusicBrainz's later year (a re-recording) goes then too.
 */
export function songItemFacts(
  item: { title: string; year: string | null; partOf: string | null; genres: string[]; albumYear?: string | null; knownBy?: string | null },
  covered: { year?: string | null; album?: boolean } = {}
): { facts: string[]; dropYear: boolean } {
  const q = `"${item.title}"`;
  const earlier = (y: string | null | undefined) => Boolean(covered.year && y && y < covered.year);
  const dropYear = earlier(item.year) || earlier(item.albumYear) || earlier(item.knownBy);
  const y = covered.year ? null : item.year;
  const partOf = covered.album ? null : item.partOf;
  const basics = y && partOf
    ? fitOrSplit(`${q} came out in ${y} and appears on ${partOf}.`, [`${q} came out in ${y}.`, `${q} appears on ${partOf}.`])
    : y ? [`${q} came out in ${y}.`] : partOf ? [`${q} appears on ${partOf}.`] : [];
  const parts = basics.map((s) => ({ full: s, short: s }));
  if (item.genres.length) parts.push({ full: `The genres of ${q} include ${names(item.genres)}.`, short: `Its genres include ${names(item.genres)}.` });
  return { facts: packFacts(parts), dropYear };
}

const pageItemCache = new Map<string, { entity: Entity | null; labels: Record<string, Entity>; at: number }>();

/**
 * The item behind an English Wikipedia article, read in one request by the page's
 * title (Wikidata follows a redirect), and the labels its facts need in one more.
 * Null when the page has no item. Throws when Wikidata can't be read, so nothing is cached.
 */
async function pageItem(page: string): Promise<{ entity: Entity | null; labels: Record<string, Entity> }> {
  const hit = pageItemCache.get(page);
  if (hit && (hit.entity || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit;
  const data = await get<{ entities?: Record<string, Entity & { missing?: string }> }>({
    action: "wbgetentities", sites: "enwiki", titles: page, normalize: "1", props: "claims|labels|descriptions", languages: "en|mul",
  });
  const entity = Object.values(data.entities ?? {}).find((e) => /^Q\d+$/.test(e.id ?? "") && e.missing === undefined) ?? null;
  // P31 first: its classes' labels tell a place's item (`placeOrTeam`).
  const refs = entity ? ["P31", "P175", "P361", "P136", "P19", "P740", "P264"].flatMap((p) => itemIds(entity, p)) : [];
  const labels = await entities([...new Set(refs)].slice(0, 50), "labels|descriptions", "en|mul");
  const found = { entity, labels, at: Date.now() };
  pageItemCache.set(page, found);
  return found;
}

/**
 * The requested artist behind a surely matched article, as an item and its English article:
 * the article's own item when it is a performer of that name, else the performer the song's
 * item names (P175). Never a name search, so a same-named act can't be picked. The article's
 * match carries over to the artist. Null when neither holds. Throws when Wikidata can't be read.
 */
export async function sureArtist(page: string, artist: string[]): Promise<{ entity: Entity; page: string } | null> {
  const names = artist.filter(Boolean);
  const { entity } = await pageItem(page);
  if (!entity || !names.length) return null;
  const performer = (e: Entity) => (itemIds(e, "P31").includes(HUMAN) || itemIds(e, "P31").some((c) => GROUP_CLASSES.has(c))) && PERFORMER_ITEM.test(e.descriptions?.en?.value ?? "") && sameArtist(anyLabel(e), names);
  if (performer(entity)) return { entity, page };
  if (!itemIds(entity, "P31").some((c) => SONG_CLASSES.has(c))) return null;
  const ids = itemIds(entity, "P175").slice(0, 10);
  if (!ids.length) return null;
  const data = await get<{ entities?: Record<string, FullEntity> }>({ action: "wbgetentities", ids: ids.join("|"), props: "claims|labels|descriptions|sitelinks", languages: "en|mul", sitefilter: "enwiki" });
  const found = Object.values(data.entities ?? {}).find((e) => performer(e) && e.sitelinks?.enwiki?.title);
  return found ? { entity: found, page: found.sitelinks?.enwiki?.title as string } : null;
}

/** The labels `artistGoodFromEntity` needs. */
export async function artistGoodLabels(e: Entity): Promise<Record<string, Entity>> {
  return entities([...new Set(["P135", "P39", "P1344", "P463", "P802", "P166"].flatMap((p) => itemIds(e, p)))].slice(0, 50), "labels", "en|mul");
}

/** The MusicBrainz artist ids an article's Wikidata item names (P434). Empty when it names none or can't be read. Never throws. */
export async function pageArtistIds(page: string): Promise<string[]> {
  try {
    const { entity } = await pageItem(page);
    return entity ? rankedClaims(entity, "P434").map((c) => c.mainsnak?.datavalue?.value).filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * What the article's own Wikidata item says (`articleItemFrom`), for an article the
 * lookup surely matched to the request. Null when it has no item or nothing to tell.
 * Never throws.
 */
export async function articleItem(page: string, artist: string[], titles: string[] = []): Promise<ArticleItem> {
  try {
    const { entity, labels } = await pageItem(page);
    let item = entity ? articleItemFrom(entity, labels, artist, titles, await anyBoxOf(page)) : null;
    // The article's infobox, the fuller source, dates the song another year or none when the
    // item gives only a year, or its album came out earlier (the year is a single's): no year,
    // and none from MusicBrainz after the album's.
    if (item?.kind === "song") {
      const box = await songBoxOf(page, artist);
      const told = box ? boxYear(box) : null;
      const album = box ? await albumYear(box) : null;
      const knownBy = [item.year, told].filter((y): y is string => Boolean(y)).sort()[0] ?? null;
      if (item.year && ((told ? told !== item.year : item.yearOnly) || (album && album < item.year))) item = { ...item, year: null };
      if (knownBy && knownBy !== item.year) item = { ...item, knownBy };
      if (album) item = { ...item, albumYear: album };
    }
    console.log(`[Wikidata] "${page}" -> ${entity?.id ?? "no item"}: ${item ? (item.kind === "song" ? "a song" : "the artist") : "nothing to tell"}`);
    return item;
  } catch (err) {
    console.warn(`[Wikidata] Item lookup failed for "${page}": ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// --- A place or a team named like the song or its artist ----------------------

/**
 * What a place's or a sports team's item is an instance of, by the class's label:
 * "city", "commune of France", "U.S. state", "sovereign state", "region",
 * "basketball team". Labels, not ids, because places come in thousands of
 * national classes ("municipality of Brazil", "city in the United States").
 */
const PLACE_CLASS =
  /\b(?:city|city-state|town|village|hamlet|capital|country|sovereign state|state|province|prefecture|municipality|commune|borough|county|county seat|metropolis|megacity|human settlement|settlement|region|continent|island|territory|district|neighbou?rhood|suburb|administrative)\b/i;
const TEAM_CLASS = /\b(?:sports|football|basketball|baseball|hockey|cricket|rugby|volleyball|soccer|handball)\b.*\b(?:team|club)\b/i;

/**
 * The class that makes an article's item a place or a sports team ("city"), or
 * "": never a song's reference. A fictional place ("fictional city") isn't one:
 * a game's world may be what its music is about. An item that is also a piece
 * of music, a release or a performer isn't either.
 */
export function placeOrTeamFrom(e: Entity, labels: Record<string, Entity>): string {
  const classes = itemIds(e, "P31");
  if (classes.some((c) => SONG_CLASSES.has(c) || NOT_ONE_PIECE.has(c) || GROUP_CLASSES.has(c) || c === HUMAN)) return "";
  for (const c of classes) {
    const label = anyLabel(labels[c]);
    if (label && !/\bfictional\b/i.test(label) && (PLACE_CLASS.test(label) || TEAM_CLASS.test(label))) return label;
  }
  return "";
}

/**
 * Whether an English Wikipedia article is a city's, a country's, a region's or a
 * sports team's (`placeOrTeamFrom`): its item's class ("city"), or "". The item is
 * read once and kept for `articleItem`. "" when Wikidata can't be read. Never throws.
 */
export async function placeOrTeam(page: string): Promise<string> {
  try {
    const { entity, labels } = await pageItem(page);
    return entity ? placeOrTeamFrom(entity, labels) : "";
  } catch {
    return "";
  }
}

/**
 * Whether an English Wikipedia article's item is a person's (an instance of human). True when
 * Wikidata can't be read, so a caller that refuses people refuses then too. Never throws.
 */
export async function isPersonPage(page: string): Promise<boolean> {
  try {
    const { entity } = await pageItem(page);
    return !!entity && itemIds(entity, "P31").includes(HUMAN);
  } catch {
    return true;
  }
}

export function clearArticleItemCache(): void {
  pageItemCache.clear();
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
