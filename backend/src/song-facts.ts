import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write";
import { config } from "./config";
import { songIdentity, withoutArtistNote } from "./text";
import { SSLSong } from "./types";

/**
 * Facts the streamer wrote for one particular song: another music content creator's
 * original, a local band, anything no source knows. Kept in
 * song-facts.json in the app's data folder.
 *
 * A song matches by its StreamerSongList song ID or YouTube video ID when
 * the entry has one, otherwise by title and artist (or an alias). The facts
 * go on stream exactly as written; no AI touches them. A writing credit is
 * only stated when the streamer typed one in, never inferred from a tag or
 * from who's playing it.
 *
 * Two switches live here too (issue #262): "No facts for this song" (`noFacts`)
 * and "No facts for this artist" (`noArtistFacts`, for every song by the entry's
 * artist). Either one leaves only the streamer's own facts: nothing is looked
 * up and the AI writes nothing. An entry may hold a switch and no facts.
 *
 * The file stays the same list it always was, so any 2.x reads it: an older
 * version shows nothing for a song that has only a switch. Before the first save
 * with a switch, the file as it was is copied to song-facts.before-switches.json.
 */

export interface SongFacts {
  title: string;
  artist: string;
  songId?: number;
  videoId?: string;
  /** Other "artist - title" spellings that mean this song. */
  aliases?: string[];
  /** Confirmed by the streamer. Empty: no writing credit is shown. */
  songwriters?: string[];
  link?: string;
  facts: string[];
  /** "No facts for this song": only the streamer's own facts show for it. */
  noFacts?: boolean;
  /** "No facts for this artist": only the streamer's own facts show for any song by this entry's artist. */
  noArtistFacts?: boolean;
}

const file = () => path.join(config.dataDir, "song-facts.json");
/** The file as it was before it first held a switch: what an older version reads in full. */
export const BEFORE_SWITCHES = "song-facts.before-switches.json";
let store: SongFacts[] | null = null;
let storeMtime = 0;

/** Re-read when the file changes, so a save from the app applies right away. */
function load(): SongFacts[] {
  try {
    const mtime = fs.statSync(file()).mtimeMs;
    if (store && mtime === storeMtime) return store;
    const parsed: unknown = JSON.parse(fs.readFileSync(file(), "utf8"));
    store = Array.isArray(parsed) ? (parsed as SongFacts[]).filter((e) => e && typeof e.title === "string" && typeof e.artist === "string" && Array.isArray(e.facts)) : [];
    storeMtime = mtime;
  } catch {
    store = [];
    storeMtime = 0;
  }
  return store;
}

export { songIdentity };
const key = (artist: string, title: string) => `${songIdentity(artist)}\0${songIdentity(title)}`;

function matches(entry: SongFacts, song: SSLSong): boolean {
  if (entry.songId && song.songId) return entry.songId === song.songId;
  if (entry.videoId && song.videoId) return entry.videoId === song.videoId;
  const want = key(song.artist ?? "", song.title);
  if (key(entry.artist, entry.title) === want) return true;
  return (entry.aliases ?? []).some((a) => {
    const [artist, ...rest] = a.split(" - ");
    return rest.length > 0 && key(artist, rest.join(" - ")) === want;
  });
}

export function findSongFacts(song: SSLSong): SongFacts | null {
  return load().find((e) => matches(e, song)) ?? null;
}

/** An artist as the switch compares it: case, accents, punctuation and a note in brackets don't count. */
const artistKey = (artist: string) => songIdentity(withoutArtistNote(artist));
const FEATURING = new Set(["feat", "feat.", "ft", "ft.", "featuring"]);
/** The artists a request names: the whole field, and the lead of "A feat. B". Split by words, so nothing backtracks. */
function requestArtists(artist: string): string[] {
  const words = artist.split(" ").filter(Boolean);
  const at = words.findIndex((w, i) => i > 0 && FEATURING.has(w.toLowerCase()));
  const lead = at > 0 ? words.slice(0, at).join(" ") : artist;
  return [...new Set([artist, lead].map(artistKey).filter(Boolean))];
}
/** The artists an entry stands for: its own, and each alias's. */
function entryArtists(entry: SongFacts): string[] {
  const aliases = (entry.aliases ?? []).map((a) => a.split(" - ")).filter((p) => p.length > 1).map((p) => p[0]);
  return [entry.artist, ...aliases].map(artistKey).filter(Boolean);
}

/** Whether the streamer turned facts off for this song, or for its artist. */
export function factsOff(song: SSLSong): { song: boolean; artist: boolean } {
  const wanted = requestArtists(song.artist ?? "");
  return {
    song: findSongFacts(song)?.noFacts === true,
    artist: wanted.length > 0 && load().some((e) => e.noArtistFacts === true && entryArtists(e).some((a) => wanted.includes(a))),
  };
}

/** Whether an entry has anything to show: facts, a writer or a link (not just a switch). */
export const hasOwnFacts = (entry: SongFacts | null): boolean =>
  !!entry && (entry.facts.some((f) => f.trim()) || (entry.songwriters ?? []).some((w) => w.trim()) || Boolean(entry.link?.trim()));

/** The lines to show: a confirmed writing credit first, then the facts as written. */
export function songFactLines(entry: SongFacts, max = Infinity): string[] {
  const writers = (entry.songwriters ?? []).map((w) => w.trim()).filter(Boolean);
  const lines: string[] = [];
  // A writer the streamer confirmed is always credited, even when it's the artist on the request (final QA #4).
  if (writers.length) {
    const list = writers.length === 1 ? writers[0] : `${writers.slice(0, -1).join(", ")} and ${writers[writers.length - 1]}`;
    lines.push(`"${entry.title}" was written by ${list}.`);
  }
  lines.push(...entry.facts.map((f) => f.trim()).filter(Boolean));
  // The creator's link is promised, so it keeps its place when the facts fill every slot.
  // With no songwriter named, it still gets its bubble, without naming anyone as the writer.
  const url = entry.link?.trim() ?? "";
  const link = url ? `More from ${writers.length ? writers[0] : "this song's creator"}: ${url}` : "";
  return link ? [...lines.slice(0, Math.max(0, max - 1)), link] : lines.slice(0, max);
}

/** What the editor allows, so nothing typed is ever cut short on save. */
export const SONG_FACT_LIMITS = { facts: 20, factLength: 300, songwriters: 5, songwriterLength: 300, link: 200 } as const;

/** A fact as it's saved and shown: a line break inside it is a space. One fact, one bubble. */
export const cleanFact = (f: string) => f.replace(/\s+/g, " ").trim();

/**
 * Why a save can't be taken as typed, in words for the editor, or null when
 * it can. Over-limit input is refused rather than trimmed, so what's saved is
 * always what the streamer wrote.
 */
export function songFactsProblem(input: { facts?: unknown; songwriters?: unknown; link?: unknown; noFacts?: unknown; noArtistFacts?: unknown }): string | null {
  const L = SONG_FACT_LIMITS;
  const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
  const facts = list(input.facts)?.map(cleanFact).filter(Boolean);
  const writers = list(input.songwriters)?.map((w) => w.trim()).filter(Boolean);
  const flag = (v: unknown) => v === undefined || typeof v === "boolean";
  if (!facts || !writers || (input.link !== undefined && typeof input.link !== "string") || !flag(input.noFacts) || !flag(input.noArtistFacts)) {
    return "Couldn't read that. Try again in a moment.";
  }
  if (facts.length > L.facts) return `A song can have up to ${L.facts} facts. Remove ${facts.length - L.facts} to save.`;
  const long = facts.findIndex((f) => f.length > L.factLength);
  if (long >= 0) return `Fact ${long + 1} is ${facts[long].length} characters. Shorten it to ${L.factLength} or fewer to save.`;
  if (writers.length > L.songwriters) return `Up to ${L.songwriters} songwriters can be credited.`;
  if (writers.some((w) => w.length > L.songwriterLength)) return `A songwriter's name can be up to ${L.songwriterLength} characters.`;
  if (typeof input.link === "string" && input.link.trim().length > L.link) return `Their link can be up to ${L.link} characters.`;
  return null;
}

/**
 * Add or replace the facts for a song. No facts, writers, link or switch removes it.
 * `noArtistFacts: false` turns the artist's switch off wherever it was saved, since the
 * editor shows it on for every song by that artist; left out, other songs are untouched.
 */
export function saveSongFacts(entry: SongFacts): void {
  const before = load();
  const list = before.filter((e) => !matches(e, { title: entry.title, artist: entry.artist, songId: entry.songId, videoId: entry.videoId }));
  const { noFacts, noArtistFacts, ...rest } = entry;
  const clean: SongFacts = {
    ...rest,
    facts: entry.facts.map(cleanFact).filter(Boolean),
    songwriters: (entry.songwriters ?? []).map((w) => w.trim()).filter(Boolean),
    link: entry.link?.trim() ?? "",
    ...(noFacts === true ? { noFacts: true } : {}),
    ...(noArtistFacts === true ? { noArtistFacts: true } : {}),
  };
  if (noArtistFacts === false) {
    const theirs = requestArtists(entry.artist);
    for (let i = 0; i < list.length; i++) {
      if (!list[i].noArtistFacts || !entryArtists(list[i]).some((a) => theirs.includes(a))) continue;
      const { noArtistFacts: _off, ...kept } = list[i];
      list[i] = kept;
    }
  }
  // A link alone is kept: it still gets its own bubble. A switch alone is kept too. An entry left
  // with nothing (its artist's switch turned off from another song) goes.
  if (hasOwnFacts(clean) || clean.noFacts || clean.noArtistFacts) list.push(clean);
  const kept = list.filter((e) => hasOwnFacts(e) || e.noFacts || e.noArtistFacts);
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (kept.some((e) => e.noFacts || e.noArtistFacts)) keepCopyBeforeSwitches(before);
  writeFileAtomic(file(), JSON.stringify(kept, null, 2) + "\n");
  store = kept;
  storeMtime = fs.statSync(file()).mtimeMs;
}

/**
 * The first time the file is to hold a switch, the file as it was is copied beside it, once:
 * an older version can be given that copy, and nothing is ever copied twice.
 */
function keepCopyBeforeSwitches(before: SongFacts[]): void {
  const copy = path.join(config.dataDir, BEFORE_SWITCHES);
  if (before.some((e) => e.noFacts || e.noArtistFacts) || fs.existsSync(copy) || !fs.existsSync(file())) return;
  try {
    fs.copyFileSync(file(), copy, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    // Not worth refusing the streamer's save over: the app's own backups hold it too.
    console.warn(`[SongFacts] Couldn't keep a copy from before the switches: ${err instanceof Error ? err.message : err}`);
  }
}

/** Turn one switch on or off for a song, leaving its facts as they are. */
export function setFactsOff(song: SSLSong, kind: "song" | "artist", on: boolean): void {
  const entry = findSongFacts(song);
  const base: SongFacts = entry ?? { title: song.title, artist: song.artist ?? "", ...(song.songId ? { songId: song.songId } : {}), ...(song.videoId ? { videoId: song.videoId } : {}), facts: [] };
  const off = factsOff(song);
  saveSongFacts({
    ...base,
    noFacts: kind === "song" ? on : off.song,
    // Left out unless it's the one changing: false would turn it off for the artist's other songs too.
    noArtistFacts: kind === "artist" ? on : base.noArtistFacts === true ? true : undefined,
  });
}

/** For tests. */
export function resetSongFacts(): void {
  store = null;
  storeMtime = 0;
}
