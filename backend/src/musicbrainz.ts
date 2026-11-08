import { config } from "./config";
import {
  artistNames,
  editDistance,
  foldSymbols,
  initialsDiffer,
  isPieceArticle,
  isInitials,
  looksLikeArtistName,
  MAX_CONTEXT_CHARS,
  MAX_FACT_CHARS,
  mentionsName,
  MIN_CONTEXT_CHARS,
  normalizeTitle,
  openingSays,
  orderExtract,
  ownArticleExtract,
  resolveGameAndTrack,
  USER_AGENT,
  wikiExtract,
} from "./fact-verifier";
import { pageArtistIds } from "./wikidata";
import { hasNoArtist } from "./text";
import { SSLSong } from "./types";
import { fitOrSplit } from "./data-facts";
import { otherOrder } from "./youtube-title";
import { preparing } from "./prep-context";

// Plain facts from MusicBrainz when Wikipedia and Wikidata come up empty (#23)
// Only CC0 core data (names, dates, release titles), never tags, annotations or reviews
// (ARCHITECTURE.md: Where structured facts come from)

const API_BASE = "https://musicbrainz.org/ws/2";
const MIN_GAP_MS = process.env.NODE_ENV === "test" ? 0 : 1100; // ms between requests: MusicBrainz asks one a second
const MAX_CANDIDATES = 2; // recordings checked for a composer link, two lookups each
const NEGATIVE_TTL_MS = 30 * 60 * 1000; // ms an empty result stays cached
// Compilations and live albums: poor answers to "which album is it on"
const NOT_AN_ALBUM = /\b(live|greatest hits|best of|finest|collection|anthology|hits|remixed|instrumentals?|vol\.?\s*\d+|volume)\b/i;

interface Recording {
  id?: string;
  score?: number;
  title?: string;
  disambiguation?: string;
  "first-release-date"?: string;
  "artist-credit"?: Array<{ name?: string; joinphrase?: string; artist?: { id?: string; name?: string; "sort-name"?: string } }>;
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

/** One request at a time, at least MIN_GAP_MS apart */
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

const BUSY_RETRY_MS = process.env.NODE_ENV === "test" ? 1 : 1500; // ms before retrying a busy answer

/** One request, tried once more after a pause when MusicBrainz is busy (503) */
async function mbFetch(url: string): Promise<Response> {
  const once = () => fetch(url, { signal: AbortSignal.timeout(config.groundingTimeoutMs), headers: { "User-Agent": USER_AGENT } });
  let res = await once();
  if (res.status === 503) {
    await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
    res = await once();
    // Answered the second time: the "busy" cost nothing, so a song being prepared isn't put off for it
    const ctx = preparing();
    if (res.ok && ctx && ctx.trouble > 0) ctx.trouble--;
  }
  return res;
}

/** One throttled request to the MusicBrainz API, as JSON */
function mbGet<T>(path: string, params: Record<string, string>): Promise<T> {
  return throttled(async () => {
    const res = await mbFetch(`${API_BASE}/${path}?${new URLSearchParams({ ...params, fmt: "json" })}`);
    if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
    return (await res.json()) as T;
  });
}

function lookup<T>(path: string, inc: string): Promise<T> {
  return mbGet<T>(path, inc ? { inc } : {});
}

/** One recording search, best first; `complete`: every usable one came back (no more, or the last scores under 90) */
async function search(query: string, limit = 25): Promise<{ recordings: Recording[]; complete: boolean }> {
  const data = await mbGet<{ recordings?: Recording[]; count?: number }>("recording", { query, limit: String(limit) });
  const recordings = data.recordings ?? [];
  const last = recordings[recordings.length - 1];
  return { recordings, complete: (data.count ?? 0) <= recordings.length || (last?.score ?? 0) < 90 };
}

const quote = (s: string) => `"${s.replace(/["\\]/g, " ")}"`;
const date = (r: Recording) => r["first-release-date"] || "9999";

/** A credited name in Latin letters: "近藤浩治" becomes "Koji Kondo" from its sort name, "Kondo, Koji" */
export function readableName(credit: { name?: string; artist?: { name?: string; "sort-name"?: string } }): string {
  const name = credit.name || credit.artist?.name || "";
  if (/\p{Script=Latin}/u.test(name) || !/\p{L}/u.test(name)) return name;
  const sort = credit.artist?.["sort-name"] ?? "";
  if (!/^[\p{Script=Latin}\s.'’-]+,\s*[\p{Script=Latin}\s.'’-]+$/u.test(sort)) return "";
  const [last, first] = sort.split(/,\s*/);
  return `${first} ${last}`;
}

/** "A", "A and B" or "A, B and C", no repeats: every name, as a cut credit reads as the whole list */
function joinNames(list: string[]): string {
  const n = [...new Set(list.filter(Boolean))];
  return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

// Reissues and live records of what came out before: their date isn't the song's
const REISSUE_TYPES = /^(compilation|live|dj-mix|remix|mixtape\/street)$/i;

/** The same title, also when brackets hold part of it: "Falling Down" and "Falling (Down)" */
function sameRecordingTitle(a: string, b: string): boolean {
  const words = (s: string) => normalizeTitle(s.replace(/[()[\]]/g, " "));
  return normalizeTitle(a) === normalizeTitle(b) || words(a) === words(b);
}

/** Recordings of this title credited to this artist, earliest first */
function matchingRecordings(recordings: Recording[], title: string, artist: string): Recording[] {
  const artistKeys = artistNames(artist);
  return recordings
    .filter((r) => (r.score ?? 0) >= 90 && sameRecordingTitle(r.title ?? "", title))
    .filter((r) => (r["artist-credit"] ?? []).some((c) => artistKeys.includes(normalizeTitle(c.name ?? c.artist?.name ?? ""))))
    .sort((a, b) => date(a).localeCompare(date(b)));
}

// MusicBrainz's mark for not the original: a live take, a re-recording, a demo or a remix
const NOT_THE_ORIGINAL = /\b(live|re-?record(ed|ing)?|new recording|demo|remix(ed)?|rehearsal|concert)\b/i;

/**
 * Whether the artist has a recording of the title before `year` (any release, any score): then the earliest
 * original found is a later one ("Dreamgift" on a 2008 album, first recorded in 1986), so no year
 */
export function knownEarlier(recordings: Recording[], title: string, artist: string, year: string): boolean {
  const artistKeys = artistNames(artist);
  return recordings
    .filter((r) => sameRecordingTitle(r.title ?? "", title))
    .filter((r) => (r["artist-credit"] ?? []).some((c) => artistKeys.includes(normalizeTitle(c.name ?? c.artist?.name ?? ""))))
    .some((r) => [r["first-release-date"], ...(r.releases ?? []).map((rel) => rel.date)].some((d) => /^\d{4}/.test(d ?? "") && (d ?? "").slice(0, 4) < year));
}

/** First year from original releases (no compilations, live, remixes, re-recordings); none if the artist had died */
export function firstYear(matches: Recording[], diedIn?: number): string | undefined {
  const years = matches.filter((r) => !NOT_THE_ORIGINAL.test(r.disambiguation ?? "")).flatMap((r) => {
    const original = (r.releases ?? []).filter(
      (rel) => rel.status === "Official" && !(rel["release-group"]?.["secondary-types"] ?? []).some((t) => REISSUE_TYPES.test(t)) && !NOT_AN_ALBUM.test(rel.title ?? "")
    );
    const dated = original.map((rel) => /^\d{4}/.exec(rel.date ?? "")?.[0]).filter((y): y is string => Boolean(y));
    // Releases without dates: the recording's own first date, if it has an original release at all
    const own = original.length ? /^\d{4}/.exec(r["first-release-date"] ?? "")?.[0] : undefined;
    return dated.length ? dated : own ? [own] : [];
  });
  const year = years.sort()[0];
  return year && !(diedIn && Number(year) > diedIn) ? year : undefined;
}

/** The credited artist's MusicBrainz id, to look up when they died */
export function creditedArtistId(recordings: Recording[], title: string, artist: string): string | undefined {
  const artistKeys = artistNames(artist);
  return matchingRecordings(recordings, title, artist)[0]?.["artist-credit"]?.find((c) => artistKeys.includes(normalizeTitle(c.name ?? c.artist?.name ?? "")))?.artist?.id;
}

const creditCache = new Map<string, string>();

/**
 * Whether MusicBrainz credits the song to a same-named artist the article's Wikidata item doesn't name;
 * false when either is unknown, so a song MusicBrainz lacks keeps its article. Never throws
 */
export async function anotherArtist(page: string, title: string, artist: string): Promise<boolean> {
  try {
    const ids = await pageArtistIds(page);
    if (!ids.length) return false;
    const key = `${normalizeTitle(artist)}\0${normalizeTitle(title)}`;
    let credited = creditCache.get(key);
    if (credited === undefined) {
      const { recordings } = await search(`recording:${quote(title)} AND artist:${quote(artist)}`);
      credited = creditedArtistId(recordings, title, artist) ?? "";
      creditCache.set(key, credited);
      if (creditCache.size > 500) creditCache.delete(creditCache.keys().next().value as string);
    }
    return Boolean(credited) && !ids.includes(credited);
  } catch {
    return false;
  }
}

/**
 * A performer's song facts. `diedIn`: the artist's death year; `yearKnown` false: the search missed some
 * recordings and the earliest seen may be a re-recording, so no year
 */
export function performerFacts(recordings: Recording[], title: string, artist: string, diedIn?: number, yearKnown = true): string[] {
  const want = normalizeTitle(title);
  const matches = matchingRecordings(recordings, title, artist);
  const first = matches[0];
  if (!first) return [];
  const facts: string[] = [];
  const q = `"${title}"`;
  const found = yearKnown ? firstYear(matches, diedIn) : undefined;
  // A month-less date is often a copyright year, a soundtrack's a month before its film
  const dated = matches.some((r) => [r["first-release-date"], ...(r.releases ?? []).map((rel) => rel.date)].some((d) => d?.startsWith(`${found}-`)));
  const year = found && dated && !knownEarlier(recordings, title, artist, found) ? found : undefined;
  // A studio album, never claimed as the first release. One over a year after the song may
  // hold it only as an edition's bonus track: side by side the two read as one release
  const earliest = Number((year ?? /^\d{4}/.exec(first["first-release-date"] ?? "")?.[0]) ?? 0);
  const firstAlbum = [...(first.releases ?? [])]
    .filter(
      (r) =>
        r.status === "Official" &&
        r.title &&
        normalizeTitle(r.title) !== want &&
        r["release-group"]?.["primary-type"] === "Album" &&
        !(r["release-group"]?.["secondary-types"] ?? []).length &&
        !NOT_AN_ALBUM.test(r.title)
    )
    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"))[0];
  const albumYear = Number(/^\d{4}/.exec(firstAlbum?.date ?? "")?.[0] ?? 0);
  const album = earliest && albumYear > earliest + 1 ? undefined : firstAlbum?.title;
  // One bubble when both fit; "and is on", not "on": it may have come out earlier as a single
  if (year && album) facts.push(...fitOrSplit(`${q} came out in ${year} and is on the album ${album}.`, [`${q} came out in ${year}.`, `${q} is on the album ${album}.`]));
  else if (year) facts.push(`${q} came out in ${year}.`);
  else if (album) facts.push(`${q} is on the album ${album}.`);
  return facts;
}

/** Whether MusicBrainz credits this title to an artist of this name (a game may share a band's). Never throws */
export async function creditsSong(title: string, artist: string): Promise<boolean> {
  try {
    const { recordings } = await search(`recording:${quote(title)} AND artist:${quote(artist)}`);
    return matchingRecordings(recordings, title, artist).length > 0;
  } catch {
    return false;
  }
}

/** The year performerFacts gave a song, or null */
export function statedYear(facts: string[]): string | null {
  for (const f of facts) {
    const m = / came out in (\d{4})\b/.exec(f);
    if (m) return m[1];
  }
  return null;
}

/** Whether performerFacts named the song's album */
export const statesAlbum = (facts: string[]): boolean => facts.some((f) => / is on the album /.test(f));

/** performerFacts without the year: the album alone, as with no year known */
export function withoutYear(facts: string[]): string[] {
  return facts
    .filter((f) => !/^".*" came out in \d{4}\.$/.test(f))
    .map((f) => f.replace(/^(".*") came out in \d{4} and is on the album /, "$1 is on the album "));
}

/** Possible originals of a game's track: exact title, on a release naming the game, not a remix album; earliest first */
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

/** Composers and writers a work names by relationship; never an "additional" one (a fanfare quoted in a cue) */
export function composersOf(work: { relations?: Array<{ type?: string; "target-type"?: string; attributes?: string[]; artist?: { name?: string; "sort-name"?: string } }> }): string[] {
  return (work.relations ?? [])
    .filter((r) => r["target-type"] === "artist" && /^(composer|writer)$/i.test(r.type ?? "") && r.artist && !(r.attributes ?? []).some((a) => /additional/i.test(a)))
    .map((r) => readableName({ name: r.artist?.name, artist: r.artist }))
    .filter(Boolean);
}

/** A game track's composer only via recording -> work -> composer, never a credit; most have no link: nothing */
async function gameComposer(recordings: Recording[], title: string, game: string): Promise<string[]> {
  for (const id of gameCandidates(recordings, title, game).slice(0, MAX_CANDIDATES)) {
    const rec = await lookup<{ relations?: Array<{ "target-type"?: string; work?: { id?: string } }> }>(`recording/${id}`, "work-rels");
    const workId = rec.relations?.find((r) => r["target-type"] === "work" && r.work?.id)?.work?.id;
    if (!workId) continue;
    const composers = composersOf(await lookup(`work/${workId}`, "artist-rels"));
    // All of them, or none when they don't fit a bubble
    const said = `"${title}" from ${game} was composed by ${joinNames(composers)}.`;
    if (composers.length) return said.length <= MAX_FACT_CHARS ? [said] : [];
  }
  return [];
}

/** Facts for a song from MusicBrainz, or [] when nothing clearly matches. Never throws */
export async function musicbrainzFacts(song: SSLSong): Promise<string[]> {
  const { game, track } = resolveGameAndTrack(song);
  const title = track || game;
  if (!title || !game || title === game) return [];
  const key = `${normalizeTitle(game)}\0${normalizeTitle(title)}`;
  const hit = cache.get(key);
  if (hit && (hit.facts.length || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.facts;

  // A music video names a performer; a song list's "artist" may be a game
  const performer = song.performer || looksLikeArtistName(game);
  try {
    let facts = performer ? [] : await gameComposer((await search(`recording:${quote(title)} AND release:${quote(game)}`)).recordings, title, game);
    if (!facts.length) {
      const { recordings, complete } = await search(`recording:${quote(title)} AND artist:${quote(game)}`);
      // "Vampire Killer" by "Castlevania" on an album "Castlevania": the game's soundtrack, so only a composer
      const soundtrack = !performer && matchingRecordings(recordings, title, game).some((r) => (r.releases ?? []).some((rel) => normalizeTitle(rel.title ?? "") === normalizeTitle(game)));
      facts = soundtrack ? [] : performerFacts(recordings, title, game, undefined, complete);
      // A year only when the artist was alive for it: one more lookup, only then
      const id = facts.some((f) => / came out in \d{4}\b/.test(f)) ? creditedArtistId(recordings, title, game) : undefined;
      if (id) {
        const died = /^\d{4}/.exec((await lookup<{ "life-span"?: { end?: string } }>(`artist/${id}`, ""))["life-span"]?.end ?? "")?.[0];
        if (died) facts = performerFacts(recordings, title, game, Number(died), complete);
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

// --- The artist of a title with no artist ---
// Taken only when MusicBrainz has the exact title from one artist; a placeholder credit ("[unknown]") names none

const TITLE_LIMIT = 100; // recordings read per title; a title with more is too common to settle
const PLACEHOLDER_ARTIST = /^\[.*\]$|^various artists$/i;
const titleCache = new Map<string, { artist: string; at: number }>();

/** The one artist of every recording of this title, or ""; none unless `complete` (ranks don't put exact titles first) */
export function soleArtist(recordings: Recording[], title: string, complete: boolean): string {
  const want = normalizeTitle(title);
  if (!want || !complete) return "";
  const matches = recordings.filter((r) => normalizeTitle(r.title ?? "") === want);
  const artists = new Map<string, string>();
  for (const r of matches) {
    const lead = r["artist-credit"]?.[0];
    const name = lead?.artist?.name || lead?.name || "";
    if (!name || PLACEHOLDER_ARTIST.test(name.trim()) || hasNoArtist(name)) return "";
    artists.set(lead?.artist?.id || normalizeTitle(name), name.trim());
  }
  return artists.size === 1 ? [...artists.values()][0] : "";
}

/** The artist artistByTitle already found for a title, or "" */
export function cachedArtistByTitle(title: string): string {
  return titleCache.get(normalizeTitle(title))?.artist ?? "";
}

/** The artist of a title-only song when MusicBrainz has the title from one artist, else "". Never throws */
export async function artistByTitle(title: string): Promise<string> {
  const key = normalizeTitle(title);
  if (!key) return "";
  const hit = titleCache.get(key);
  if (hit && (hit.artist || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.artist;
  try {
    const found = await mbGet<{ count?: number; recordings?: Recording[] }>("recording", { query: `recording:${quote(title)}`, limit: String(TITLE_LIMIT) });
    const recordings = found.recordings ?? [];
    const artist = soleArtist(recordings, title, (found.count ?? 0) <= recordings.length);
    console.log(`[MusicBrainz] "${title}" with no artist: ${artist ? `only ${artist} has this title` : "no single artist has this title"}`);
    titleCache.set(key, { artist, at: Date.now() });
    return artist;
  } catch (err) {
    console.warn(`[MusicBrainz] Title lookup failed for "${title}": ${err instanceof Error ? err.message : err}`);
    return "";
  }
}

export function clearTitleCache(): void {
  titleCache.clear();
}

// --- Which side of "X - Y" is the artist ---

const ORDER_WAIT_MS = process.env.NODE_ENV === "test" ? 200 : 1500; // ms a song change waits; a later answer is kept
const orderLookups = new Map<string, Promise<"keep" | "swap" | null>>();

/** "keep" when MusicBrainz has Y by X and not X by Y, "swap" for the reverse, null when both or neither */
export function recordingOrder(recordings: Recording[], artist: string, title: string): "keep" | "swap" | null {
  const fits = (t: string, a: string) => {
    const want = normalizeTitle(t);
    const names = artistNames(a);
    return recordings.some(
      (r) => normalizeTitle(r.title ?? "") === want && (r["artist-credit"] ?? []).some((c) => names.includes(normalizeTitle(c.name ?? c.artist?.name ?? "")))
    );
  };
  const keep = fits(title, artist);
  const swap = fits(artist, title);
  return keep === swap ? null : keep ? "keep" : "swap";
}

function lookUpOrder(artist: string, title: string): Promise<"keep" | "swap" | null> {
  const key = `${normalizeTitle(artist)}\0${normalizeTitle(title)}`;
  const known = orderLookups.get(key);
  if (known) return known;
  const query = `(recording:${quote(title)} AND artist:${quote(artist)}) OR (recording:${quote(artist)} AND artist:${quote(title)})`;
  const pending = mbGet<{ recordings?: Recording[] }>("recording", { query, limit: "50" })
    .then((found) => recordingOrder(found.recordings ?? [], artist, title))
    .catch((err) => {
      // Not kept: MusicBrainz may answer next time
      orderLookups.delete(key);
      console.warn(`[MusicBrainz] Order lookup failed for "${artist} - ${title}": ${err instanceof Error ? err.message : err}`);
      return null;
    });
  orderLookups.set(key, pending);
  return pending;
}

/** An orderUnsure reading turned round when MusicBrainz has only the other order (within ORDER_WAIT_MS). Never throws */
export async function settleTitleOrder<T extends { title: string; artist: string; orderUnsure?: boolean }>(reading: T): Promise<T> {
  if (!reading.orderUnsure || !config.factVerification || !reading.title || !reading.artist) return reading;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ORDER_WAIT_MS);
    timer.unref?.();
  });
  const order = await Promise.race([lookUpOrder(reading.artist, reading.title), late]);
  clearTimeout(timer);
  if (order !== "swap") return reading;
  console.log(`[MusicBrainz] "${reading.artist} - ${reading.title}" read as "${reading.artist}" by ${reading.title}: MusicBrainz has that recording, not the other way round`);
  return otherOrder(reading);
}

export function clearOrderCache(): void {
  orderLookups.clear();
}

// --- MusicBrainz's own link to the article (#245) ---
// When every reading misses: the article its Wikidata link names, gated, never a search on its results
// (ARCHITECTURE.md: Why is choosing the article so careful?)

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const MAX_PICKS = 5; // search results read, as MusicBrainz ranks them
const MIN_SCORE = 80; // search score a pick needs

interface Relation {
  type?: string;
  "target-type"?: string;
  url?: { resource?: string };
  work?: { id?: string };
}
type Linked = { relations?: Relation[] };
interface Item {
  sitelinks?: { enwiki?: { title?: string } };
  labels?: { en?: { value?: string } };
  descriptions?: { en?: { value?: string } };
  claims?: Record<string, Array<{ rank?: string; mainsnak?: { datavalue?: { value?: { id?: string } } } }>>;
}

/** Within about a third of the edits of the longer name, spaces ignored: "Girls Got Rythm" is "Girls Got Rhythm" */
export function closeName(a: string, b: string, share = 0.34): boolean {
  const x = normalizeTitle(a).replace(/ /g, "");
  const y = normalizeTitle(b).replace(/ /g, "");
  if (initialsDiffer(a, b)) return false;
  return Boolean(x && y) && editDistance(x, y) <= Math.max(1, Math.floor(share * Math.max(x.length, y.length)));
}

/** Search terms that forgive a typo or two: "girls~ got rythm~" */
function fuzzy(s: string): string {
  return normalizeTitle(s)
    .split(" ")
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 3 ? `${w}~` : w))
    .join(" ");
}

/** The lead name of a credit: "Some Singer" in "Some Singer feat. Another" */
const leadName = (artist: string) => artist.split(/\s*,\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0] ?? artist;

/** The typed artist, a respelling of it, or the initials it stands for: "CCR" */
const namesTheArtist = (typed: string[], name: string) => typed.some((n) => closeName(n, name) || isInitials(n, name));

/** A credit's names: each artist's, then the whole credit ("Some Duo & Another") */
function creditNames(r: Recording): Array<{ name: string; id?: string }> {
  const credits = r["artist-credit"] ?? [];
  const whole = credits.map((c) => (c.name ?? c.artist?.name ?? "") + (c.joinphrase ?? "")).join("").trim();
  return [...credits.map((c) => ({ name: c.name ?? c.artist?.name ?? "", id: c.artist?.id })), { name: whole, id: credits[0]?.artist?.id }];
}

/** Recordings that are the request (MIN_SCORE, a close title, a credit naming the artist), best first */
export function pickRecordings(recordings: Recording[], title: string, artist: string): Array<{ recording: Recording; credit: { name: string; id?: string } }> {
  const typed = artistNames(artist);
  return recordings.slice(0, MAX_PICKS).flatMap((recording) => {
    if ((recording.score ?? 0) < MIN_SCORE || !closeName(title, recording.title ?? "")) return [];
    const credit = creditNames(recording).find((c) => c.name && namesTheArtist(typed, c.name));
    return credit ? [{ recording, credit }] : [];
  });
}

/** The Wikidata item an entity's own "wikidata" link names: "Q123" */
export function wikidataId(entity: Linked): string | undefined {
  const url = entity.relations?.find((r) => r.type === "wikidata")?.url?.resource ?? "";
  return /\/(Q\d+)$/.exec(url)?.[1];
}

async function wikidata(ids: string[], props: string): Promise<Record<string, Item>> {
  const params = new URLSearchParams({ action: "wbgetentities", ids: ids.join("|"), props, sitefilter: "enwiki", languages: "en", format: "json" });
  const res = await fetch(`${WIKIDATA_API}?${params}`, { signal: AbortSignal.timeout(config.groundingTimeoutMs), headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  return ((await res.json()) as { entities?: Record<string, Item> }).entities ?? {};
}

/** Whether MusicBrainz has an artist under exactly this name: then a respelling of it is someone else */
async function knownArtist(name: string): Promise<boolean> {
  const artists = (await mbGet<{ artists?: Array<{ name?: string; score?: number }> }>("artist", { query: `artist:${quote(name)}`, limit: "3" })).artists ?? [];
  return artists.some((a) => (a.score ?? 0) >= 95 && normalizeTitle(a.name ?? "") === normalizeTitle(name));
}

/** The English article a recording's (or its work's) Wikidata item names, and its performers (P175) */
async function songItem(recordings: Recording[]): Promise<{ page: string; performers: string[] } | null> {
  for (const r of recordings) {
    if (!r.id) continue;
    const rec = await lookup<Linked>(`recording/${r.id}`, "url-rels+work-rels");
    const workId = rec.relations?.find((x) => x["target-type"] === "work" && x.work?.id)?.work?.id;
    const qid = wikidataId(rec) ?? (workId ? wikidataId(await lookup<Linked>(`work/${workId}`, "url-rels")) : undefined);
    if (!qid) continue;
    const item = (await wikidata([qid], "sitelinks|claims"))[qid];
    const page = item?.sitelinks?.enwiki?.title;
    if (!page) return null;
    const ids = (item?.claims?.P175 ?? []).filter((c) => c.rank !== "deprecated").map((c) => c.mainsnak?.datavalue?.value?.id).filter((id): id is string => Boolean(id)).slice(0, 5);
    const labels = ids.length ? await wikidata(ids, "labels") : {};
    return { page, performers: ids.map((id) => labels[id]?.labels?.en?.value ?? "").filter(Boolean) };
  }
  return null;
}

const leadOf = (full: string) => full.split(/\n==/)[0].slice(0, 1500);
const withoutQualifier = (page: string) => page.replace(/\s*\([^)]*\)\s*$/, "");

/** Whether a song's page fits; when Wikidata's `performers` aren't the artist, it's a cover's `original` */
export function songPageFit(page: string, full: string, titles: string[], artists: string[], performers: string[]): { ok: boolean; original?: string; why?: string } {
  if (!isPieceArticle(page, full)) return { ok: false, why: "isn't about a piece of music" };
  const base = withoutQualifier(page);
  const titled = titles.some((t) => closeName(t, base) || (normalizeTitle(t).split(" ").length >= 2 && mentionsName(normalizeTitle(base), [normalizeTitle(t)])));
  if (!titled) return { ok: false, why: "is another title" };
  const intro = normalizeTitle(leadOf(full));
  const theirs = !performers.length || performers.some((p) => artistNames(p).some((n) => artists.some((a) => closeName(a, n, 0.25))));
  if (theirs) return mentionsName(intro, artists) ? { ok: true } : { ok: false, why: "never names the artist" };
  const original = performers.find((p) => mentionsName(intro, artistNames(p)));
  return original ? { ok: true, original } : { ok: false, why: "is by someone its intro never names" };
}

// What a performer's page opens by calling them, or its brackets
const AN_ACT = /\b(band|singer|singer-songwriter|musician|rapper|songwriter|duo|trio|quartet|group|DJ|producer|composer|vocalist|guitarist|pianist|drummer|bassist)s?\b/i;
const NOT_AN_ACT = /\b(film|movie|television|TV|series|show|album|EP|song|single|novel|character|fictional|brand|company|footballer|soccer|player|game)s?\b/i;

/**
 * Whether an artist's page opens as a performer's, under the typed name, a respelling or its initials.
 * `description` (Wikidata's) stands in when the content standard dropped the opening ("a Cuban-American musician")
 */
export function artistPageFit(page: string, full: string, artists: string[], description = ""): { ok: boolean; why?: string } {
  const qualifier = /\(([^)]*)\)\s*$/.exec(page)?.[1];
  const what = openingSays(full) || description;
  if ((qualifier && !AN_ACT.test(qualifier)) || !AN_ACT.test(what) || NOT_AN_ACT.test(what)) return { ok: false, why: "doesn't open like a performer's article" };
  const base = withoutQualifier(page);
  const opening = normalizeTitle(leadOf(full).slice(0, 300));
  return artists.some((n) => closeName(n, base, 0.25) || isInitials(n, base) || mentionsName(opening, [n])) ? { ok: true } : { ok: false, why: "is under another name" };
}

const linkCache = new Map<string, { text: string; at: number }>();

/** The gated reference from MusicBrainz's links, or "" */
async function findLinked(title: string, track: string, artist: string, usable: (page: string) => boolean): Promise<string> {
  const lead = foldSymbols(leadName(artist));
  const [t, a] = [fuzzy(track), fuzzy(lead)];
  if (!t || !a) return "";
  const picks = pickRecordings((await search(`recording:(${t}) AND artist:(${a})`, MAX_PICKS)).recordings, track, artist);
  if (!picks.length) return "";
  const { credit } = picks[0];
  const typed = artistNames(artist);
  // A respelling MusicBrainz knows as someone else is that someone else: "Halocene" isn't "Holocene"
  if (!typed.includes(normalizeTitle(credit.name)) && !typed.some((n) => isInitials(n, credit.name)) && (await knownArtist(lead))) {
    console.log(`[MusicBrainz] "${title}": ${credit.name} isn't ${artist}, not following its links`);
    return "";
  }
  const artists = [...new Set([...typed, ...artistNames(credit.name)])];

  const song = await songItem(picks.slice(0, MAX_CANDIDATES).map((p) => p.recording));
  if (song && usable(song.page)) {
    const full = await wikiExtract(song.page);
    const fit = full ? songPageFit(song.page, full, [track, picks[0].recording.title ?? ""], artists, song.performers) : { ok: false, why: "is a disambiguation page" };
    if (full && fit.ok) {
      const quoted = track.replace(/"/g, "'");
      // A cover: the article is about the original, and says so first
      const note = fit.original ? `About this piece: "${quoted}" is originally by ${fit.original}. The version playing is a cover.` : "";
      const budget = MAX_CONTEXT_CHARS - song.page.length - 1 - (note ? note.length + 2 : 0);
      const extract = ownArticleExtract(full, budget, [track, fit.original ?? credit.name]);
      if (extract.length >= MIN_CONTEXT_CHARS) {
        console.log(`[Grounding] "${title}" -> ${song.page} (${extract.length} chars, MusicBrainz's link to the song${fit.original ? `, the original of a cover, by ${fit.original}` : ""})`);
        return `${song.page}\n${note ? `${note}\n\n` : ""}${extract}`;
      }
    } else console.log(`[Grounding] MusicBrainz's link "${song.page}" ${fit.why}, skipping`);
  }

  if (!credit.id) return "";
  const qid = wikidataId(await lookup<Linked>(`artist/${credit.id}`, "url-rels"));
  const item = qid ? (await wikidata([qid], "sitelinks|descriptions"))[qid] : undefined;
  const page = item?.sitelinks?.enwiki?.title;
  if (!page || !usable(page)) return "";
  const full = await wikiExtract(page);
  const fit = full ? artistPageFit(page, full, artists, item?.descriptions?.en?.value) : { ok: false, why: "is a disambiguation page" };
  if (!full || !fit.ok) {
    console.log(`[Grounding] MusicBrainz's link "${page}" ${fit.why}, skipping`);
    return "";
  }
  const extract = orderExtract(full, MAX_CONTEXT_CHARS - page.length - 1, [track], false);
  if (extract.length < MIN_CONTEXT_CHARS) return "";
  console.log(`[Grounding] "${title}" -> ${page} (${extract.length} chars, MusicBrainz's link to the artist)`);
  return `${page}\n${extract}`;
}

/** A reference from the article MusicBrainz links to, when no reading found one, or "". Never throws */
export async function linkedGrounding(song: SSLSong, usable: (page: string) => boolean = () => true): Promise<string> {
  if (song.artistUncertain) return "";
  const { game: artist, track } = resolveGameAndTrack(song);
  if (!artist || !track || track === artist) return "";
  const key = `${normalizeTitle(artist)}\0${normalizeTitle(track)}`;
  const hit = linkCache.get(key);
  if (hit && (hit.text || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.text && usable(hit.text.split("\n")[0]) ? hit.text : "";
  try {
    const text = await findLinked(song.title, track, artist, usable);
    linkCache.set(key, { text, at: Date.now() });
    return text;
  } catch (err) {
    console.warn(`[MusicBrainz] Link lookup failed for "${song.title}": ${err instanceof Error ? err.message : err}`);
    return "";
  }
}

export function clearLinkCache(): void {
  linkCache.clear();
}
