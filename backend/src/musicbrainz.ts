import { config } from "./config";
import { artistNames, looksLikeArtistName, normalizeTitle, resolveGameAndTrack, USER_AGENT } from "./fact-verifier";
import { SSLSong } from "./types";

/**
 * Plain facts from MusicBrainz, after Wikipedia and Wikidata come up empty
 * (issue #23). Only core data is used (names, dates, release titles), which
 * MusicBrainz releases as public domain (CC0); its tags, annotations and
 * reviews are licensed differently and are never read.
 *
 * - A performer's song: the earliest recording with the exact title and the
 *   artist in its credit gives the year and the album it first came out on.
 * - A game's track: only its composer, and only when the same name is
 *   credited on several releases naming the game (see gameFacts). A
 *   soundtrack's date isn't the game's, so no year is stated.
 *
 * MusicBrainz asks for at most one request a second from each user; lookups
 * are queued to keep to that.
 */

const API = "https://musicbrainz.org/ws/2/recording";
const MIN_GAP_MS = 1100;
const NEGATIVE_TTL_MS = 30 * 60 * 1000;
/** Compilations and live albums are poor answers to "which album is it on". */
const NOT_AN_ALBUM = /\b(live|greatest hits|best of|finest|collection|anthology|hits|remixed|instrumentals?|vol\.?\s*\d+|volume)\b/i;

interface Recording {
  score?: number;
  title?: string;
  "first-release-date"?: string;
  "artist-credit"?: Array<{ name?: string; artist?: { name?: string; "sort-name"?: string } }>;
  releases?: Array<{ title?: string; status?: string; date?: string; "release-group"?: { "secondary-types"?: string[] } }>;
}

const cache = new Map<string, { facts: string[]; at: number }>();
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

/** One request at a time, at least MIN_GAP_MS apart. */
function throttled<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return run();
  });
  queue = next.catch(() => undefined);
  return next;
}

async function search(query: string): Promise<Recording[]> {
  return throttled(async () => {
    const url = `${API}?${new URLSearchParams({ query, fmt: "json", limit: "25" })}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(config.groundingTimeoutMs), headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
    return ((await res.json()) as { recordings?: Recording[] }).recordings ?? [];
  });
}

const quote = (s: string) => `"${s.replace(/["\\]/g, " ")}"`;
const date = (r: Recording) => r["first-release-date"] || "9999";

/** A credited name in Latin letters: "近藤浩治" becomes "Koji Kondo" from its sort name, "Kondo, Koji". */
export function readableName(credit: { name?: string; artist?: { name?: string; "sort-name"?: string } }): string {
  const name = credit.name || credit.artist?.name || "";
  if (/\p{Script=Latin}/u.test(name) || !/\p{L}/u.test(name)) return name;
  const sort = credit.artist?.["sort-name"] ?? "";
  if (!/^[\p{Script=Latin}\s.'’-]+,\s*[\p{Script=Latin}\s.'’-]+$/u.test(sort)) return "";
  const [last, first] = sort.split(/,\s*/);
  return `${first} ${last}`;
}

function names(list: string[]): string {
  const n = [...new Set(list.filter(Boolean))].slice(0, 3);
  return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** Facts for a performer's song from the matching recordings. */
export function performerFacts(recordings: Recording[], title: string, artist: string): string[] {
  const want = normalizeTitle(title);
  const names = artistNames(artist);
  const matches = recordings
    .filter((r) => (r.score ?? 0) >= 90 && normalizeTitle(r.title ?? "") === want)
    .filter((r) => (r["artist-credit"] ?? []).some((c) => names.includes(normalizeTitle(c.name ?? c.artist?.name ?? ""))))
    .sort((a, b) => date(a).localeCompare(date(b)));
  const first = matches[0];
  if (!first) return [];
  const facts: string[] = [];
  const q = `"${title}"`;
  const year = /^\d{4}/.exec(first["first-release-date"] ?? "")?.[0];
  if (year) facts.push(`${q} came out in ${year}.`);
  const album = [...(first.releases ?? [])]
    .filter((r) => r.status === "Official" && r.title && normalizeTitle(r.title) !== want && !NOT_AN_ALBUM.test(r.title))
    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"))[0]?.title;
  if (album) facts.push(`${q} first came out on ${album}.`);
  return facts;
}

/**
 * The composer of a game's track. Fan covers crowd the results and are even
 * tagged "Soundtrack", so no single recording can be trusted. The original
 * composer shows up on several different releases naming the game; a cover
 * artist usually on one. So a name is only stated when it's credited on at
 * least two different releases and on more than any other name. Remix
 * albums don't count.
 */
export function gameFacts(recordings: Recording[], title: string, game: string): string[] {
  const want = normalizeTitle(title);
  const gameKey = normalizeTitle(game);
  const releasesBy = new Map<string, { names: string[]; releases: Set<string> }>();
  for (const r of recordings) {
    if ((r.score ?? 0) < 85 || normalizeTitle(r.title ?? "") !== want) continue;
    const releases = (r.releases ?? []).filter(
      (rel) => normalizeTitle(rel.title ?? "").includes(gameKey) && !(rel["release-group"]?.["secondary-types"] ?? []).includes("Remix")
    );
    if (!releases.length) continue;
    const credits = (r["artist-credit"] ?? []).map(readableName).filter(Boolean);
    const key = credits.map((c) => normalizeTitle(c)).sort().join("|");
    if (!key) continue;
    const entry = releasesBy.get(key) ?? { names: credits, releases: new Set<string>() };
    for (const rel of releases) entry.releases.add(normalizeTitle(rel.title ?? ""));
    releasesBy.set(key, entry);
  }
  const ranked = [...releasesBy.values()].sort((a, b) => b.releases.size - a.releases.size);
  const [top, second] = ranked;
  if (!top || top.releases.size < 2 || (second && second.releases.size >= top.releases.size)) return [];
  return [`"${title}" from ${game} was composed by ${names(top.names)}.`];
}

/** Facts for a song from MusicBrainz, or [] when nothing clearly matches. Never throws. */
export async function musicbrainzFacts(song: SSLSong): Promise<string[]> {
  const { game, track } = resolveGameAndTrack(song);
  const title = track || game;
  if (!title || !game || title === game) return [];
  const key = `${normalizeTitle(game)}\0${normalizeTitle(title)}`;
  const hit = cache.get(key);
  if (hit && (hit.facts.length || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.facts;

  // A music video names a performer; a song list's "artist" may be a game.
  const performer = song.performer || looksLikeArtistName(game);
  try {
    let facts = performer ? [] : gameFacts(await search(`recording:${quote(title)} AND release:${quote(game)}`), title, game);
    if (!facts.length) facts = performerFacts(await search(`recording:${quote(title)} AND artist:${quote(game)}`), title, game);
    console.log(`[MusicBrainz] "${title}" by ${game}: ${facts.length} facts`);
    cache.set(key, { facts, at: Date.now() });
    return facts;
  } catch (err) {
    console.warn(`[MusicBrainz] Lookup failed for "${title}": ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export function clearMusicBrainzCache(): void {
  cache.clear();
}
