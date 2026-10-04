import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write";
import { config } from "./config";
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
export const songIdentity = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const ident = songIdentity;
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
export function songFactsProblem(input: { facts?: unknown; songwriters?: unknown; link?: unknown }): string | null {
  const L = SONG_FACT_LIMITS;
  const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
  const facts = list(input.facts)?.map(cleanFact).filter(Boolean);
  const writers = list(input.songwriters)?.map((w) => w.trim()).filter(Boolean);
  if (!facts || !writers || (input.link !== undefined && typeof input.link !== "string")) return "Couldn't read that. Try again in a moment.";
  if (facts.length > L.facts) return `A song can have up to ${L.facts} facts. Remove ${facts.length - L.facts} to save.`;
  const long = facts.findIndex((f) => f.length > L.factLength);
  if (long >= 0) return `Fact ${long + 1} is ${facts[long].length} characters. Shorten it to ${L.factLength} or fewer to save.`;
  if (writers.length > L.songwriters) return `Up to ${L.songwriters} songwriters can be credited.`;
  if (writers.some((w) => w.length > L.songwriterLength)) return `A songwriter's name can be up to ${L.songwriterLength} characters.`;
  if (typeof input.link === "string" && input.link.trim().length > L.link) return `Their link can be up to ${L.link} characters.`;
  return null;
}

/** Add or replace the facts for a song. No facts, writers or link removes it. */
export function saveSongFacts(entry: SongFacts): void {
  const list = load().filter((e) => !matches(e, { title: entry.title, artist: entry.artist, songId: entry.songId, videoId: entry.videoId }));
  const clean: SongFacts = {
    ...entry,
    facts: entry.facts.map(cleanFact).filter(Boolean),
    songwriters: (entry.songwriters ?? []).map((w) => w.trim()).filter(Boolean),
    link: entry.link?.trim() ?? "",
  };
  // A link alone is kept: it still gets its own bubble.
  if (clean.facts.length || clean.songwriters?.length || clean.link) list.push(clean);
  fs.mkdirSync(config.dataDir, { recursive: true });
  writeFileAtomic(file(), JSON.stringify(list, null, 2) + "\n");
  store = list;
  storeMtime = fs.statSync(file()).mtimeMs;
}

/** For tests. */
export function resetSongFacts(): void {
  store = null;
  storeMtime = 0;
}
