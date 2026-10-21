import { config } from "./config";
import {
  artistNames,
  editDistance,
  foldSymbols,
  isPieceArticle,
  isInitials,
  looksLikeArtistName,
  MAX_CONTEXT_CHARS,
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
import { hasNoArtist } from "./text";
import { SSLSong } from "./types";
import { fitOrSplit } from "./data-facts";

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

const API_BASE = "https://musicbrainz.org/ws/2";
const MIN_GAP_MS = process.env.NODE_ENV === "test" ? 0 : 1100;
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

/** One throttled request to the MusicBrainz API, as JSON. */
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

async function search(query: string, limit = 25): Promise<Recording[]> {
  return (await mbGet<{ recordings?: Recording[] }>("recording", { query, limit: String(limit) })).recordings ?? [];
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

/** "A", "A and B" or "A, B and C": at most three names, without repeats. */
function joinNames(list: string[]): string {
  const n = [...new Set(list.filter(Boolean))].slice(0, 3);
  return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** Release groups that reissue or record live what came out before: their date isn't the song's. */
const REISSUE_TYPES = /^(compilation|live|dj-mix|remix|mixtape\/street)$/i;

/** The recordings of this title credited to this artist, earliest first. */
function matchingRecordings(recordings: Recording[], title: string, artist: string): Recording[] {
  const want = normalizeTitle(title);
  const artistKeys = artistNames(artist);
  return recordings
    .filter((r) => (r.score ?? 0) >= 90 && normalizeTitle(r.title ?? "") === want)
    .filter((r) => (r["artist-credit"] ?? []).some((c) => artistKeys.includes(normalizeTitle(c.name ?? c.artist?.name ?? ""))))
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
  const artistKeys = artistNames(artist);
  return matchingRecordings(recordings, title, artist)[0]?.["artist-credit"]?.find((c) => artistKeys.includes(normalizeTitle(c.name ?? c.artist?.name ?? "")))?.artist?.id;
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
  // One bubble when both are known and fit. "And is on", not "on": the song may have come out earlier, as a single.
  if (year && album) facts.push(...fitOrSplit(`${q} came out in ${year} and is on the album ${album}.`, [`${q} came out in ${year}.`, `${q} is on the album ${album}.`]));
  else if (year) facts.push(`${q} came out in ${year}.`);
  else if (album) facts.push(`${q} is on the album ${album}.`);
  return facts;
}

/** The year `performerFacts` gave a song, or null. */
export function statedYear(facts: string[]): string | null {
  for (const f of facts) {
    const m = / came out in (\d{4})\b/.exec(f);
    if (m) return m[1];
  }
  return null;
}

/** Whether `performerFacts` named the song's album. */
export const statesAlbum = (facts: string[]): boolean => facts.some((f) => / is on the album /.test(f));

/** `performerFacts` without the year: its album alone, as it would read with no year known. */
export function withoutYear(facts: string[]): string[] {
  return facts
    .filter((f) => !/^".*" came out in \d{4}\.$/.test(f))
    .map((f) => f.replace(/^(".*") came out in \d{4} and is on the album /, "$1 is on the album "));
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
 * credit is never taken as composition. Most game tracks
 * have no such link yet; then nothing is said.
 */
async function gameComposer(recordings: Recording[], title: string, game: string): Promise<string[]> {
  for (const id of gameCandidates(recordings, title, game).slice(0, MAX_CANDIDATES)) {
    const rec = await lookup<{ relations?: Array<{ "target-type"?: string; work?: { id?: string } }> }>(`recording/${id}`, "work-rels");
    const workId = rec.relations?.find((r) => r["target-type"] === "work" && r.work?.id)?.work?.id;
    if (!workId) continue;
    const composers = composersOf(await lookup(`work/${workId}`, "artist-rels"));
    if (composers.length) return [`"${title}" from ${game} was composed by ${joinNames(composers)}.`];
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
      const id = facts.some((f) => / came out in \d{4}\b/.test(f)) ? creditedArtistId(recordings, title, game) : undefined;
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

// --- The artist of a title with no artist ---------------------------------------

/**
 * A now playing file can name only the song: a YouTube video titled just
 * "Song - Official Music Video", or a player that knows no artist. When
 * MusicBrainz has that exact title (case, accents and punctuation aside) from
 * one artist only, that artist is taken; from two or more, none: "Alone" or
 * "Nightmare" never resolve. Placeholder credits ("[unknown]", "Various
 * Artists", "Traditional") count as no artist, so none is named from them.
 */

/** Recordings read for one title. A title with more is too common to settle. */
const TITLE_LIMIT = 100;
const PLACEHOLDER_ARTIST = /^\[.*\]$|^various artists$/i;
const titleCache = new Map<string, { artist: string; at: number }>();

/**
 * The one artist every recording of exactly this title is by, or "". `complete`:
 * the search returned every recording it found. Otherwise one not read may be
 * by someone else (search ranks don't put exact titles first), so none is named.
 */
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

/** The artist already found for a title (see artistByTitle), or "" when none is or it hasn't been looked up. */
export function cachedArtistByTitle(title: string): string {
  return titleCache.get(normalizeTitle(title))?.artist ?? "";
}

/** The artist of a song known only by its title, when MusicBrainz has the title from one artist only; else "". Never throws. */
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

// --- MusicBrainz's own link to the article (issue #245) -----------------------

/**
 * When every reading misses, the article MusicBrainz itself links to: the
 * recording's (or its work's) Wikidata item, else the artist's, and that
 * item's English Wikipedia article. Never a search on what MusicBrainz
 * returns: "Halocene" searched on Wikipedia finds "Holocene (song)", but
 * MusicBrainz's link names the right page or none. Each page must still
 * pass a gate:
 * - a song's page: its title is the request's, it opens as a piece of
 *   music, and its intro names the artist. A song Wikidata credits only to
 *   someone else is the original of a cover: its intro must name that
 *   performer, and the reference says it is originally theirs, so no
 *   caption credits it to the artist on the list;
 * - an artist's page: it opens as a band's, singer's or musician's, not a
 *   film's, show's or album's, under the typed name, a respelling of it or
 *   its initials ("CCR");
 * - a respelling MusicBrainz knows as another artist ("Halocene" is not
 *   "Holocene") is never taken.
 */

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
/** Search results read for a pick, as MusicBrainz ranks them. */
const MAX_PICKS = 5;
const MIN_SCORE = 80;

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
  claims?: Record<string, Array<{ rank?: string; mainsnak?: { datavalue?: { value?: { id?: string } } } }>>;
}

/** Within about a third of the edits of the longer name, spaces ignored: "Girls Got Rythm" is "Girls Got Rhythm". */
export function closeName(a: string, b: string, share = 0.34): boolean {
  const x = normalizeTitle(a).replace(/ /g, "");
  const y = normalizeTitle(b).replace(/ /g, "");
  return Boolean(x && y) && editDistance(x, y) <= Math.max(1, Math.floor(share * Math.max(x.length, y.length)));
}

/** Lucene terms that forgive a typo or two: "girls~ got rythm~". */
function fuzzy(s: string): string {
  return normalizeTitle(s)
    .split(" ")
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 3 ? `${w}~` : w))
    .join(" ");
}

/** The lead name of a credit: "Some Singer" in "Some Singer feat. Another". */
const leadName = (artist: string) => artist.split(/\s*,\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0] ?? artist;

/** The typed artist, a respelling of it, or the initials it stands for: "CCR". */
const namesTheArtist = (typed: string[], name: string) => typed.some((n) => closeName(n, name) || isInitials(n, name));

/** A credit's names: each artist's, then the whole credit ("Some Duo & Another"). */
function creditNames(r: Recording): Array<{ name: string; id?: string }> {
  const credits = r["artist-credit"] ?? [];
  const whole = credits.map((c) => (c.name ?? c.artist?.name ?? "") + (c.joinphrase ?? "")).join("").trim();
  return [...credits.map((c) => ({ name: c.name ?? c.artist?.name ?? "", id: c.artist?.id })), { name: whole, id: credits[0]?.artist?.id }];
}

/**
 * Recordings that are the request: a score of at least 80, a title within a
 * third of the edits of the typed one, and a credit naming the typed artist,
 * a respelling of it, or what its initials stand for. Best ranked first.
 */
export function pickRecordings(recordings: Recording[], title: string, artist: string): Array<{ recording: Recording; credit: { name: string; id?: string } }> {
  const typed = artistNames(artist);
  return recordings.slice(0, MAX_PICKS).flatMap((recording) => {
    if ((recording.score ?? 0) < MIN_SCORE || !closeName(title, recording.title ?? "")) return [];
    const credit = creditNames(recording).find((c) => c.name && namesTheArtist(typed, c.name));
    return credit ? [{ recording, credit }] : [];
  });
}

/** The Wikidata item an entity's own "wikidata" link names: "Q123". */
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

/** Whether MusicBrainz has an artist under exactly this name: then a respelling of it is someone else. */
async function knownArtist(name: string): Promise<boolean> {
  const artists = (await mbGet<{ artists?: Array<{ name?: string; score?: number }> }>("artist", { query: `artist:${quote(name)}`, limit: "3" })).artists ?? [];
  return artists.some((a) => (a.score ?? 0) >= 95 && normalizeTitle(a.name ?? "") === normalizeTitle(name));
}

/** The English article a recording's (or its work's) Wikidata item names, and who Wikidata says performs the song. */
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

/**
 * Whether a song's page fits the request: the title, a piece of music, and
 * an intro naming the artist. `performers` are Wikidata's: when none of them
 * is the artist, the page is the original of a cover, and `original` names
 * who it is by (the intro must name them too).
 */
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

/** What a performer's page opens by calling them, or its brackets. */
const AN_ACT = /\b(band|singer|singer-songwriter|musician|rapper|songwriter|duo|trio|quartet|group|DJ|producer|composer|vocalist|guitarist|pianist|drummer|bassist)s?\b/i;
const NOT_AN_ACT = /\b(film|movie|television|TV|series|show|album|EP|song|single|novel|character|fictional|brand|company|footballer|soccer|player|game)s?\b/i;

/** Whether an artist's page fits: it opens as a performer's, under the typed name, a respelling of it (a quarter of the edits), or its initials. */
export function artistPageFit(page: string, full: string, artists: string[]): { ok: boolean; why?: string } {
  const qualifier = /\(([^)]*)\)\s*$/.exec(page)?.[1];
  const what = openingSays(full);
  if ((qualifier && !AN_ACT.test(qualifier)) || !AN_ACT.test(what) || NOT_AN_ACT.test(what)) return { ok: false, why: "doesn't open like a performer's article" };
  const base = withoutQualifier(page);
  const opening = normalizeTitle(leadOf(full).slice(0, 300));
  return artists.some((n) => closeName(n, base, 0.25) || isInitials(n, base) || mentionsName(opening, [n])) ? { ok: true } : { ok: false, why: "is under another name" };
}

const linkCache = new Map<string, { text: string; at: number }>();

/** The gated reference from MusicBrainz's links, or "". */
async function findLinked(title: string, track: string, artist: string, usable: (page: string) => boolean): Promise<string> {
  const lead = foldSymbols(leadName(artist));
  const [t, a] = [fuzzy(track), fuzzy(lead)];
  if (!t || !a) return "";
  const picks = pickRecordings(await search(`recording:(${t}) AND artist:(${a})`, MAX_PICKS), track, artist);
  if (!picks.length) return "";
  const { credit } = picks[0];
  const typed = artistNames(artist);
  // A respelling MusicBrainz knows as someone else is that someone else: "Halocene" isn't "Holocene".
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
      // A cover: the article is about the original, and says so first.
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
  const page = qid ? (await wikidata([qid], "sitelinks"))[qid]?.sitelinks?.enwiki?.title : undefined;
  if (!page || !usable(page)) return "";
  const full = await wikiExtract(page);
  const fit = full ? artistPageFit(page, full, artists) : { ok: false, why: "is a disambiguation page" };
  if (!full || !fit.ok) {
    console.log(`[Grounding] MusicBrainz's link "${page}" ${fit.why}, skipping`);
    return "";
  }
  const extract = orderExtract(full, MAX_CONTEXT_CHARS - page.length - 1, [track], false);
  if (extract.length < MIN_CONTEXT_CHARS) return "";
  console.log(`[Grounding] "${title}" -> ${page} (${extract.length} chars, MusicBrainz's link to the artist)`);
  return `${page}\n${extract}`;
}

/**
 * A reference for a request no reading found, from the article MusicBrainz
 * links to (see above), or "". Never throws.
 */
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
