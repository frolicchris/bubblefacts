import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { SSLSong } from "./types";

/**
 * Facts the streamer wrote for one particular song: another streamer's
 * original, a local band, anything no source knows. Kept in
 * song-facts.json in the app's data folder.
 *
 * A song matches by its StreamerSongList song ID or YouTube video ID when
 * the entry has one, otherwise by title and artist (or an alias). The facts
 * go on stream exactly as written; no AI touches them. A writing credit is
 * only stated when the streamer typed one in, never inferred from a tag or
 * from who's playing it.
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
}

const file = () => path.join(config.dataDir, "song-facts.json");
let store: SongFacts[] | null = null;
let storeMtime = 0;

/** Re-read when the file changes, so a save from the app applies right away. */
function load(): SongFacts[] {
  try {
    const mtime = fs.statSync(file()).mtimeMs;
    if (store && mtime === storeMtime) return store;
    const parsed: unknown = JSON.parse(fs.readFileSync(file(), "utf8"));
    store = Array.isArray(parsed) ? (parsed as SongFacts[]).filter((e) => e && typeof e.title === "string" && Array.isArray(e.facts)) : [];
    storeMtime = mtime;
  } catch {
    store = [];
    storeMtime = 0;
  }
  return store;
}

/**
 * Identity for the streamer's own records: case, accents and punctuation
 * don't count, but the words do, including a version in brackets. "Night
 * Drive (Acoustic)" isn't "Night Drive (Remix)"; Wikipedia's lookup
 * normalization, which drops brackets, is deliberately not used here.
 */
const ident = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const key = (artist: string, title: string) => `${ident(artist)}\0${ident(title)}`;

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
  const link = entry.link?.trim() && writers.length ? `More from ${writers[0]}: ${entry.link.trim()}` : "";
  return link ? [...lines.slice(0, Math.max(0, max - 1)), link] : lines.slice(0, max);
}

/** Add or replace the facts for a song. Empty facts and no writers removes it. */
export function saveSongFacts(entry: SongFacts): void {
  const list = load().filter((e) => !matches(e, { title: entry.title, artist: entry.artist, songId: entry.songId, videoId: entry.videoId }));
  const clean: SongFacts = {
    ...entry,
    // A line break inside a fact is a space: one fact, one bubble.
    facts: entry.facts.map((f) => f.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 20),
    songwriters: (entry.songwriters ?? []).map((w) => w.trim()).filter(Boolean),
  };
  if (clean.facts.length || clean.songwriters?.length) list.push(clean);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(list, null, 2) + "\n");
  store = list;
  storeMtime = fs.statSync(file()).mtimeMs;
}

/** For tests. */
export function resetSongFacts(): void {
  store = null;
  storeMtime = 0;
}
