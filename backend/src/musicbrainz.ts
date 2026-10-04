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
 * - A game's track: only its composer, and only from an explicit composer
 *   relationship (see gameComposer). A soundtrack's date isn't the game's,
 *   so no year is stated.
 *
 * MusicBrainz asks for at most one request a second from each user; lookups
 * are queued to keep to that.
 */

const API = "https://musicbrainz.org/ws/2/recording";
const MIN_GAP_MS = 1100;
/** Recordings checked for a composer link, two lookups each. */
const MAX_CANDIDATES = 2;
const NEGATIVE_TTL_MS = 30 * 60 * 1000;
/** Compilations and live albums are poor answers to "which album is it on". */
const NOT_AN_ALBUM = /\b(live|greatest hits|best of|finest|collection|anthology|hits|remixed|instrumentals?|vol\.?\s*\d+|volume)\b/i;

interface Recording {
  id?: string;
  score?: number;
  title?: string;
  "first-release-date"?: string;
  "artist-credit"?: Array<{ name?: string; artist?: { id?: string; name?: string; "sort-name"?: string } }>;
  releases?: Array<{
    title?: string;
    status?: string;
    date?: string;
    "release-group"?: { "primary-type"?: string; "secondary-types"?: string[] };
  }>;
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

const BUSY_RETRY_MS = process.env.NODE_ENV === "test" ? 1 : 1500;

/** One request, tried once more after a pause when MusicBrainz says it's busy (503). */
async function mbFetch(url: string): Promise<Response> {
  const once = () => fetch(url, { signal: AbortSignal.timeout(config.groundingTimeoutMs), headers: { "User-Agent": USER_AGENT } });
  let res = await once();
  if (res.status === 503) {
    await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
    res = await once();
  }
  return res;
}

async function lookup<T>(path: string, inc: string): Promise<T> {
  return throttled(async () => {
    const url = `https://musicbrainz.org/ws/2/${path}?${new URLSearchParams(inc ? { inc, fmt: "json" } : { fmt: "json" })}`;
    const res = await mbFetch(url);
    if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
    return (await res.json()) as T;
  });
}

async function search(query: string): Promise<Recording[]> {
  return throttled(async () => {
    const url = `${API}?${new URLSearchParams({ query, fmt: "json", limit: "25" })}`;
    const res = await mbFetch(url);
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

/** Release groups that reissue or record live what came out before: their date isn't the song's. */
const REISSUE_TYPES = /^(compilation|live|dj-mix|remix|mixtape\/street)$/i;

/** The recordings of this title credited to this artist, earliest first. */
function matchingRecordings(recordings: Recording[], title: string, artist: string): Recording[] {
  const want = normalizeTitle(title);
  const names = artistNames(artist);
  return recordings
    .filter((r) => (r.score ?? 0) >= 90 && normalizeTitle(r.title ?? "") === want)
    .filter((r) => (r["artist-credit"] ?? []).some((c) => names.includes(normalizeTitle(c.name ?? c.artist?.name ?? ""))))
    .sort((a, b) => date(a).localeCompare(date(b)));
}

/**
 * The year the song first came out, from releases that aren't compilations,
 * live albums or remixes: "It's Only a Paper Moon" (1933) isn't from 1988
 * because a 1988 jazz compilation is the earliest one MusicBrainz lists.
 * None when the artist had died by then: a Satie piece on a 1995 album.
 */
export function firstYear(matches: Recording[], diedIn?: number): string | undefined {
  const years = matches.flatMap((r) => {
    const original = (r.releases ?? []).filter(
      (rel) => rel.status === "Official" && !(rel["release-group"]?.["secondary-types"] ?? []).some((t) => REISSUE_TYPES.test(t)) && !NOT_AN_ALBUM.test(rel.title ?? "")
    );
    const dated = original.map((rel) => /^\d{4}/.exec(rel.date ?? "")?.[0]).filter((y): y is string => Boolean(y));
    // Releases listed without dates: the recording's own first date, if it has an original release at all.
    const own = original.length ? /^\d{4}/.exec(r["first-release-date"] ?? "")?.[0] : undefined;
    return dated.length ? dated : own ? [own] : [];
  });
  const year = years.sort()[0];
  return year && !(diedIn && Number(year) > diedIn) ? year : undefined;
}

/** The credited artist's MusicBrainz id, to look up when they died. */
export function creditedArtistId(recordings: Recording[], title: string, artist: string): string | undefined {
  const names = artistNames(artist);
  return matchingRecordings(recordings, title, artist)[0]?.["artist-credit"]?.find((c) => names.includes(normalizeTitle(c.name ?? c.artist?.name ?? "")))?.artist?.id;
}

/** Facts for a performer's song from the matching recordings. `diedIn`: the year the credited artist died, if they have. */
export function performerFacts(recordings: Recording[], title: string, artist: string, diedIn?: number): string[] {
  const want = normalizeTitle(title);
  const matches = matchingRecordings(recordings, title, artist);
  const first = matches[0];
  if (!first) return [];
  const facts: string[] = [];
  const q = `"${title}"`;
  const year = firstYear(matches, diedIn);
  if (year) facts.push(`${q} came out in ${year}.`);
  // A studio album only (no compilations, live or soundtrack albums), and no
  // claim that it came out there first: an earlier single may not be listed.
  const album = [...(first.releases ?? [])]
    .filter(
      (r) =>
        r.status === "Official" &&
        r.title &&
        normalizeTitle(r.title) !== want &&
        r["release-group"]?.["primary-type"] === "Album" &&
        !(r["release-group"]?.["secondary-types"] ?? []).length &&
        !NOT_AN_ALBUM.test(r.title)
    )
    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"))[0]?.title;
  if (album) facts.push(`${q} is on the album ${album}.`);
  return facts;
}

/**
 * Recordings that may be the original of a game's track: the exact title, on
 * a release naming the game, not on a remix album. Earliest first.
 */
export function gameCandidates(recordings: Recording[], title: string, game: string): string[] {
  const want = normalizeTitle(title);
  const gameKey = normalizeTitle(game);
  return recordings
    .filter((r) => r.id && (r.score ?? 0) >= 85 && normalizeTitle(r.title ?? "") === want)
    .filter((r) =>
      (r.releases ?? []).some(
        (rel) => normalizeTitle(rel.title ?? "").includes(gameKey) && !(rel["release-group"]?.["secondary-types"] ?? []).includes("Remix")
      )
    )
    .sort((a, b) => date(a).localeCompare(date(b)))
    .map((r) => r.id as string);
}

/**
 * Composers and writers a work names through explicit relationships. An
 * "additional" composer is left out: Alexander Courage's fanfare quoted in a
 * James Horner cue doesn't make him its co-composer.
 */
export function composersOf(work: { relations?: Array<{ type?: string; "target-type"?: string; attributes?: string[]; artist?: { name?: string; "sort-name"?: string } }> }): string[] {
  return (work.relations ?? [])
    .filter((r) => r["target-type"] === "artist" && /^(composer|writer)$/i.test(r.type ?? "") && r.artist && !(r.attributes ?? []).some((a) => /additional/i.test(a)))
    .map((r) => readableName({ name: r.artist?.name, artist: r.artist }))
    .filter(Boolean);
}

/**
 * The composer of a game's track, only from an explicit composer
 * relationship: recording -> the work it performs -> that work's composer.
 * Recording credits name performers, and fan covers crowd the results, so a
 * credit is never taken as composition (issue from review). Most game tracks
 * have no such link yet; then nothing is said.
 */
async function gameComposer(recordings: Recording[], title: string, game: string): Promise<string[]> {
  for (const id of gameCandidates(recordings, title, game).slice(0, MAX_CANDIDATES)) {
    const rec = await lookup<{ relations?: Array<{ "target-type"?: string; work?: { id?: string } }> }>(`recording/${id}`, "work-rels");
    const workId = rec.relations?.find((r) => r["target-type"] === "work" && r.work?.id)?.work?.id;
    if (!workId) continue;
    const composers = composersOf(await lookup(`work/${workId}`, "artist-rels"));
    if (composers.length) return [`"${title}" from ${game} was composed by ${names(composers)}.`];
  }
  return [];
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
    let facts = performer ? [] : await gameComposer(await search(`recording:${quote(title)} AND release:${quote(game)}`), title, game);
    if (!facts.length) {
      const recordings = await search(`recording:${quote(title)} AND artist:${quote(game)}`);
      facts = performerFacts(recordings, title, game);
      // A year is only stated when the artist was alive for it: one more lookup, only then.
      const id = facts.some((f) => / came out in \d{4}\.$/.test(f)) ? creditedArtistId(recordings, title, game) : undefined;
      if (id) {
        const died = /^\d{4}/.exec((await lookup<{ "life-span"?: { end?: string } }>(`artist/${id}`, ""))["life-span"]?.end ?? "")?.[0];
        if (died) facts = performerFacts(recordings, title, game, Number(died));
      }
    }
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
