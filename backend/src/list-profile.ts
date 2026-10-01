import { SSLSong } from "./types";

/**
 * How one streamer writes their song list, worked out from the list itself.
 *
 * Song lists have a title and an "artist" field, and streamers use them
 * differently. Seen across eight public lists (about 10,800 songs):
 *
 *   artist = the game or show     "Kefka" / "Final Fantasy VI"
 *   "Source - Track" + composer   "Final Fantasy VI - Kefka" / "Nobuo Uematsu"
 *   "Track - Source" + performer  "Into the Unknown - Frozen 2" / "Aurora and Idina Menzel"
 *   "Track (Source)" + composer   "Departure to the West (Princess Mononoke)" / "Joe Hisaishi"
 *   "Track from Source"           "The Perfect Year from Sunset Boulevard" / "Andrew Lloyd Webber"
 *
 * Sources repeat across a list and track names don't, so which side of a
 * dash repeats says which side is the source. That makes each convention
 * detectable without asking the streamer.
 */
export interface ListProfile {
  /** Which side of "A - B" holds the game, film or show, when the list is consistent about it. */
  dash: "source-first" | "track-first" | null;
  /** Names in a trailing "(...)" that recur, so they are sources: "princess mononoke". */
  parenSources: Set<string>;
}

const EMPTY: ListProfile = { dash: null, parenSources: new Set() };
let profile: ListProfile = EMPTY;

const key = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const DASH = /\s[-–—]\s/;
const PAREN = /^(.+?)\s*\(([^()]{3,})\)\s*$/;
/** A bracket that describes the version, or tells the requester something: never a source. */
const NOT_A_SOURCE =
  /^(arr\b|arr\.|arrang|remix|cover|medley|reprise|remaster|ost\b|ver\b|ver\.|version|act\s*\d|part\s*\d|\d{4}\b|live\b|acoustic|piano|vocal|instrumental|original|theme|main theme|day|night|duet|solo|short|full|extended|easy|hard|slow|fast|specify|ask|request|aircheck|feat\b|ft\b|with\b)/i;

/** "(80's Remix)", "(Radio Edit)": a version wherever the word falls. */
const VERSION_WORD = /\b(remix|mix|edit|version|cover|remaster\w*|demo|live)\b/i;

const MIN_DASH_TITLES = 8;
const MIN_PAREN_SONGS = 3;

/** Work out a list's conventions from its titles. A list with no clear habit gets an empty profile. */
export function buildProfile(songs: Array<{ title?: string | null }>): ListProfile {
  const left = new Map<string, number>();
  const right = new Map<string, number>();
  const paren = new Map<string, number>();
  let dashTitles = 0;
  for (const s of songs) {
    const title = (s.title ?? "").trim();
    const p = PAREN.exec(title);
    if (p && !NOT_A_SOURCE.test(p[2].trim()) && !VERSION_WORD.test(p[2])) paren.set(key(p[2]), (paren.get(key(p[2])) ?? 0) + 1);
    if (!DASH.test(title)) continue;
    dashTitles++;
    const [l, ...rest] = title.split(DASH);
    left.set(key(l), (left.get(key(l)) ?? 0) + 1);
    const r = key(rest.join(" - "));
    right.set(r, (right.get(r) ?? 0) + 1);
  }
  const repeats = (m: Map<string, number>) => [...m.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0);
  const l = repeats(left);
  const r = repeats(right);
  // One side must repeat in a good share of the dash titles, and clearly more than the other side.
  const strong = (mine: number, other: number) => dashTitles >= MIN_DASH_TITLES && mine >= dashTitles * 0.25 && mine >= other * 3;
  return {
    dash: strong(l, r) ? "source-first" : strong(r, l) ? "track-first" : null,
    parenSources: new Set([...paren].filter(([name, n]) => n >= MIN_PAREN_SONGS && name.split(" ").length >= 2).map(([name]) => name)),
  };
}

export function setListProfile(next: ListProfile | null): void {
  profile = next ?? EMPTY;
}

export function listProfile(): ListProfile {
  return profile;
}

/**
 * Other ways to read a song, as { title: track, artist: source }: the form
 * the rest of the pipeline already understands. Most likely first. Empty
 * when the title names no source.
 *
 * "Track from Source" is always read that way. A dash is read the way the
 * streamer's list uses it; with no clear habit, both ways are offered and
 * the lookup keeps whichever finds an article. A bracket is a source only
 * when it recurs in the list.
 */
export function otherReadings(song: SSLSong, p: ListProfile = profile): SSLSong[] {
  const title = song.title.trim();
  const artist = (song.artist ?? "").trim();
  const out: SSLSong[] = [];
  const add = (track: string, source: string) => {
    const t = track.trim();
    const s = source.trim();
    // Nothing new if the source is what the artist field already says.
    if (!t || !s || key(s) === key(artist) || key(t) === key(s)) return;
    if (!out.some((o) => o.title === t && o.artist === s)) out.push({ ...song, title: t, artist: s, performer: undefined, artistUncertain: undefined });
  };

  const from = /^(.+?)\s+from\s+(?:the\s+(?:film|movie|musical|game|show|series)\s+)?["“]?(\p{Lu}.+?)["”]?$/u.exec(title);
  if (from) add(from[1], from[2]);

  const par = PAREN.exec(title);
  if (par && p.parenSources.has(key(par[2]))) add(par[1], par[2]);

  if (DASH.test(title)) {
    const [l, ...rest] = title.split(DASH);
    const r = rest.join(" - ");
    if (p.dash === "source-first") add(r, l);
    else if (p.dash === "track-first") add(l, r);
    else if (artist && !/^unknown$/i.test(artist)) {
      // No habit to go by: try both, source-first first (the commoner form for game music).
      add(r, l);
      add(l, r);
    }
  }
  return out;
}

/**
 * Every way to read a song, in the order to try them. A reading the title
 * or the list makes plain ("from Source", a recurring bracket, the list's
 * dash habit) goes before the song as written; a guess goes after it.
 */
export function readings(song: SSLSong, p: ListProfile = profile): SSLSong[] {
  const others = otherReadings(song, p);
  if (!others.length) return [song];
  const title = song.title.trim();
  const par = PAREN.exec(title);
  const plain = / from \p{Lu}/u.test(title) || Boolean(par && p.parenSources.has(key(par[2]))) || (p.dash !== null && DASH.test(title));
  return plain ? [...others, song] : [song, ...others];
}
