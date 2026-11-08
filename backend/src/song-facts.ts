import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write";
import { config } from "./config";
import { songIdentity, withoutArtistNote } from "./text";
import { SSLSong } from "./types";

// The streamer's facts for particular songs, shown as written (no AI), and the No facts switches (#262),
// in song-facts.json (ARCHITECTURE.md: Files in the data folder; Notes, switches and Wrong)
// A writing credit only when the streamer typed one, never inferred from a tag or who's playing

export interface SongFacts {
  title: string;
  artist: string;
  songId?: number;
  videoId?: string;
  /** Other "artist - title" spellings of this song */
  aliases?: string[];
  /** Confirmed by the streamer; empty = no writing credit */
  songwriters?: string[];
  link?: string;
  facts: string[];
  /** "No facts for this song": only the streamer's own facts */
  noFacts?: boolean;
  /** "No facts for this artist": the same, for every song by this artist */
  noArtistFacts?: boolean;
}

const file = () => path.join(config.dataDir, "song-facts.json");
/** The file before its first switch, which an older version reads in full */
export const BEFORE_SWITCHES = "song-facts.before-switches.json";
let store: SongFacts[] | null = null;
let storeMtime = 0;

/** Re-read when the file changes, so a save from the app applies at once */
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

/** An artist as the switch compares it: ignores case, accents, punctuation and a bracketed note */
const artistKey = (artist: string) => songIdentity(withoutArtistNote(artist));
const FEATURING = new Set(["feat", "feat.", "ft", "ft.", "featuring"]);
/** Artists a request names: the whole field and the lead of "A feat. B"; split by words, so nothing backtracks */
function requestArtists(artist: string): string[] {
  const words = artist.split(" ").filter(Boolean);
  const at = words.findIndex((w, i) => i > 0 && FEATURING.has(w.toLowerCase()));
  const lead = at > 0 ? words.slice(0, at).join(" ") : artist;
  return [...new Set([artist, lead].map(artistKey).filter(Boolean))];
}
/** Artists an entry stands for: its own and each alias's */
function entryArtists(entry: SongFacts): string[] {
  const aliases = (entry.aliases ?? []).map((a) => a.split(" - ")).filter((p) => p.length > 1).map((p) => p[0]);
  return [entry.artist, ...aliases].map(artistKey).filter(Boolean);
}

/** Whether the streamer turned facts off for this song, or its artist */
export function factsOff(song: SSLSong): { song: boolean; artist: boolean } {
  const wanted = requestArtists(song.artist ?? "");
  return {
    song: findSongFacts(song)?.noFacts === true,
    artist: wanted.length > 0 && load().some((e) => e.noArtistFacts === true && entryArtists(e).some((a) => wanted.includes(a))),
  };
}

/** An entry has something to show (facts, a writer or a link), not just a switch */
export const hasOwnFacts = (entry: SongFacts | null): boolean =>
  !!entry && (entry.facts.some((f) => f.trim()) || (entry.songwriters ?? []).some((w) => w.trim()) || Boolean(entry.link?.trim()));

/** Lines to show: a confirmed writing credit, then the facts as written */
export function songFactLines(entry: SongFacts, max = Infinity): string[] {
  const writers = (entry.songwriters ?? []).map((w) => w.trim()).filter(Boolean);
  const lines: string[] = [];
  // A confirmed writer is always credited, even when it's the requested artist (final QA #4)
  if (writers.length) {
    const list = writers.length === 1 ? writers[0] : `${writers.slice(0, -1).join(", ")} and ${writers[writers.length - 1]}`;
    lines.push(`"${entry.title}" was written by ${list}.`);
  }
  lines.push(...entry.facts.map((f) => f.trim()).filter(Boolean));
  // The creator's link is promised: it keeps a slot when facts fill them, and names no writer when none is given
  const url = entry.link?.trim() ?? "";
  const link = url ? `More from ${writers.length ? writers[0] : "this song's creator"}: ${url}` : "";
  return link ? [...lines.slice(0, Math.max(0, max - 1)), link] : lines.slice(0, max);
}

/** The editor's limits (counts, characters), so nothing typed is cut short on save */
export const SONG_FACT_LIMITS = { facts: 20, factLength: 300, songwriters: 5, songwriterLength: 300, link: 200 } as const;

/** A fact as saved and shown: line breaks become spaces (one fact, one bubble) */
export const cleanFact = (f: string) => f.replace(/\s+/g, " ").trim();

/** Why a save can't be taken as typed, in the editor's words, or null; over-limit input is refused, never trimmed */
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
 * Add or replace a song's facts; with nothing left (facts, writers, link, switch) it goes. `noArtistFacts: false`
 * clears the artist's switch wherever saved (the editor shows it on for all their songs); left out, others are untouched
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
  // A link or switch alone is kept; an entry left with nothing (artist switch cleared from another song) goes
  if (hasOwnFacts(clean) || clean.noFacts || clean.noArtistFacts) list.push(clean);
  const kept = list.filter((e) => hasOwnFacts(e) || e.noFacts || e.noArtistFacts);
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (kept.some((e) => e.noFacts || e.noArtistFacts)) keepCopyBeforeSwitches(before);
  writeFileAtomic(file(), JSON.stringify(kept, null, 2) + "\n");
  store = kept;
  storeMtime = fs.statSync(file()).mtimeMs;
}

/** Before the file first holds a switch, copies it beside, once, for an older version */
function keepCopyBeforeSwitches(before: SongFacts[]): void {
  const copy = path.join(config.dataDir, BEFORE_SWITCHES);
  if (before.some((e) => e.noFacts || e.noArtistFacts) || fs.existsSync(copy) || !fs.existsSync(file())) return;
  try {
    fs.copyFileSync(file(), copy, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    // Not worth refusing the save over: the app's backups hold it too
    console.warn(`[SongFacts] Couldn't keep a copy from before the switches: ${err instanceof Error ? err.message : err}`);
  }
}

/** Turn one switch on or off for a song, its facts untouched */
export function setFactsOff(song: SSLSong, kind: "song" | "artist", on: boolean): void {
  const entry = findSongFacts(song);
  const base: SongFacts = entry ?? { title: song.title, artist: song.artist ?? "", ...(song.songId ? { songId: song.songId } : {}), ...(song.videoId ? { videoId: song.videoId } : {}), facts: [] };
  const off = factsOff(song);
  saveSongFacts({
    ...base,
    noFacts: kind === "song" ? on : off.song,
    // Left out unless changing: false would clear it for the artist's other songs too
    noArtistFacts: kind === "artist" ? on : base.noArtistFacts === true ? true : undefined,
  });
}

/** For tests */
export function resetSongFacts(): void {
  store = null;
  storeMtime = 0;
}
