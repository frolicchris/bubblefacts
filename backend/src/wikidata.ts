import { config } from "./config";
import { artistNames, mentionsName, normalizeTitle, resolveGameAndTrack, USER_AGENT } from "./fact-verifier";
import { SSLSong } from "./types";

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
const MUSIC_ITEM = /\b(song|single|track|instrumental|composition|recording|theme|piece|anthem)\b/i;
const MAX_NAMES = 3;
const NEGATIVE_TTL_MS = 30 * 60 * 1000;

interface Entity {
  id: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
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
const itemIds = (e: Entity, prop: string): string[] =>
  (e.claims?.[prop] ?? [])
    .map((c) => (c.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id)
    .filter((id): id is string => typeof id === "string");

function year(e: Entity): string | null {
  const times = (e.claims?.P577 ?? [])
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
    return normalizeTitle(h.label ?? "") === want && MUSIC_ITEM.test(desc) && mentionsName(normalizeTitle(desc), names);
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
      action: "wbsearchentities", search: title, language: "en", type: "item", limit: "10",
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

export function clearWikidataCache(): void {
  cache.clear();
}
