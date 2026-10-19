import { config } from "./config";
import { artistNames, mentionsName, normalizeTitle, resolveGameAndTrack, USER_AGENT } from "./fact-verifier";
import { SSLSong } from "./types";
import { escapeRe } from "./text";

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

async function entities(ids: string[], props: string): Promise<Record<string, Entity>> {
  if (!ids.length) return {};
  const data = await get<{ entities?: Record<string, Entity> }>({ action: "wbgetentities", ids: ids.join("|"), props, languages: "en" });
  return data.entities ?? {};
}

const label = (e: Entity | undefined) => e?.labels?.en?.value ?? "";
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

function year(e: Entity): string | null {
  const times = rankedClaims(e, "P577")
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
  const isSingle = (e: Entity | undefined) => /\bsingle\b/i.test(e?.descriptions?.en?.value ?? "");
  const yearOf = (e: Entity | undefined) => Number(/^(\d{4})\b/.exec(e?.descriptions?.en?.value ?? "")?.[1]) || null;
  const singles = (prop: string, earlier: boolean) => {
    const ids = itemIds(song, prop);
    const mine = yearOf(song);
    const ok = ids.filter((id) => {
      const theirs = yearOf(labels[id]);
      return isSingle(labels[id]) && !(mine && theirs && (earlier ? theirs > mine : theirs < mine));
    });
    return isSingle(song) && ids.length === 1 && ok.length === 1 ? [cleanLabel(label(labels[ok[0]]))].filter((l) => l && !sameName(l)) : [];
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
  return facts;
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
    const item = (await entities([id], "claims|labels|descriptions"))[id];
    // A few of the long lists, so a song with many covers doesn't crowd out the rest.
    const refs = [["P86", 50], ["P676", 50], ["P361", 50], ["P162", 50], ["P166", 50], ["P2291", 50], ["P144", 3], ["P4969", 6], ["P155", 3], ["P156", 3], ["P407", 3]]
      .flatMap(([p, n]) => itemIds(item, p as string).slice(0, n as number));
    const labels = await entities([...new Set(refs)].slice(0, 50), "labels|descriptions");
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
