import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write";
import { config } from "./config";
import { fetchGrounding, looksLikeArtistName, normalizeTitle } from "./fact-verifier";
import { SSLSong } from "./types";

/**
 * "Check my song list" (#258), the part that runs in the background: the
 * article lookup for every song on a list, no AI, a few seconds apart, never
 * while a song is playing. What it finds is kept in `song-list-check.json` in
 * the data folder, so the next run only checks songs that are new or changed.
 * Private like the rest of the data folder: it stays on this computer and goes
 * with "Remove my data". `scripts/check-song-list.mjs` uses the same
 * `suspicion` so the two never disagree about what looks wrong.
 */
export const CHECK_FILE = "song-list-check.json";
/** Raise when the lookup changes in a way that makes old answers stale: every cached song is then checked again. */
export const CHECK_VERSION = 1;
/** Time between songs: each takes several Wikipedia requests, and one list is thousands. */
export const DEFAULT_PACE_MS = 5000;
/** How often a paused check looks again to see whether the song has ended. */
export const DEFAULT_PAUSE_POLL_MS = 2000;

export interface LookupResult {
  /** Title of the article BubbleFacts would use, or "" when there is none. */
  article: string;
  /** The article came from the title alone, not from the game or artist: a likelier wrong match. */
  fallback: boolean;
  /** Wikipedia asked us to slow down: a miss says nothing. */
  throttled: boolean;
}

export interface CheckedSong {
  title: string;
  artist: string;
  article: string;
  /** Why the song looks risky, or "" when nothing stands out. */
  why: string;
  checkedAt: string;
}

interface CacheFile {
  version: number;
  songs: Record<string, CheckedSong>;
}

const words = (s: string) => normalizeTitle(s ?? "").split(" ").filter((w) => w.length > 2);

/** Why an article looks wrong for a song, or "" when nothing stands out. */
export function suspicion(song: { title: string; artist?: string }, article: string): string {
  if (!article) return "";
  const a = new Set(words(article));
  const shared = [...words(song.title), ...words(song.artist ?? "")].filter((w) => a.has(w));
  if (!shared.length) return "shares no words with the title or artist";
  if (/\b(video game|game)\)?$/i.test(article) && looksLikeArtistName(song.artist ?? "")) return "a game, for what looks like an artist";
  return "";
}

/** Why a song is risky, counting a missing article and a match from the title alone. "" means it looks fine. */
export function riskReason(song: { title: string; artist?: string }, result: Pick<LookupResult, "article" | "fallback">): string {
  if (!result.article) return "no article";
  return suspicion(song, result.article) || (result.fallback ? "matched from the title alone" : "");
}

/** The same song, however the list spells its case, accents or "(Live)" tags. */
export function songKey(song: { title: string; artist?: string }): string {
  return `${normalizeTitle(song.title)}\0${normalizeTitle(song.artist ?? "")}`;
}

const cacheFile = () => path.join(config.dataDir, CHECK_FILE);

export function loadCheckCache(): Record<string, CheckedSong> {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as CacheFile;
    if (parsed?.version === CHECK_VERSION && parsed.songs && typeof parsed.songs === "object") return parsed.songs;
  } catch {
    // No cache yet, or one that can't be read: everything is checked again.
  }
  return {};
}

export function saveCheckCache(songs: Record<string, CheckedSong>): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    writeFileAtomic(cacheFile(), JSON.stringify({ version: CHECK_VERSION, songs } satisfies CacheFile), { mode: 0o600 });
  } catch (err) {
    console.warn(`[SongListCheck] Could not save ${cacheFile()}: ${err instanceof Error ? err.message : err}`);
  }
}

/** The risky songs among the cached results, for the list the streamer reads. */
export function riskySongs(cache: Record<string, CheckedSong>, songs?: readonly SSLSong[]): CheckedSong[] {
  const keys = songs ? new Set(songs.map(songKey)) : null;
  return Object.entries(cache)
    .filter(([key, c]) => c.why && (!keys || keys.has(key)))
    .map(([, c]) => c);
}

/** The lookup the server uses, with its log lines read for the article's source and for throttling. */
export async function lookupArticle(song: SSLSong): Promise<LookupResult> {
  const lines: string[] = [];
  const real = { log: console.log, warn: console.warn };
  const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.log = console.warn = capture;
  let text = "";
  try {
    text = await fetchGrounding({ title: song.title, artist: song.artist ?? "" });
  } catch (err) {
    lines.push(`error: ${err instanceof Error ? err.message : err}`);
  } finally {
    console.log = real.log;
    console.warn = real.warn;
  }
  const pick = lines.filter((l) => /\[Grounding\] .* -> /.test(l)).slice(-1)[0] ?? "";
  return {
    article: text ? text.split("\n")[0] : "",
    fallback: !!text && /the song by its title alone/.test(pick),
    throttled: lines.some((l) => /rate-limited/.test(l)),
  };
}

export interface CheckOptions {
  songs: readonly SSLSong[];
  lookup?: (song: SSLSong) => Promise<LookupResult>;
  /** True while a song is playing: the check waits. */
  isPlaying?: () => boolean;
  /** Return true to end the check early (the window closed, the streamer pressed Stop). */
  shouldStop?: () => boolean;
  paceMs?: number;
  pausePollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  now?: () => Date;
}

export interface CheckSummary {
  total: number;
  checked: number;
  /** Songs answered from the cache without a lookup. */
  cached: number;
  stopped: boolean;
  risky: CheckedSong[];
}

let running = false;
export const isCheckRunning = () => running;

/**
 * Check every song not already in the cache. Results are saved after each song,
 * so stopping or crashing loses nothing. Only one check runs at a time; a second
 * call returns at once with `stopped: true`.
 */
export async function runSongListCheck(opts: CheckOptions): Promise<CheckSummary> {
  const lookup = opts.lookup ?? lookupArticle;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const pace = opts.paceMs ?? DEFAULT_PACE_MS;
  const poll = opts.pausePollMs ?? DEFAULT_PAUSE_POLL_MS;
  const now = opts.now ?? (() => new Date());
  const stop = () => !!opts.shouldStop?.();
  const total = opts.songs.filter((s) => s && typeof s.title === "string" && s.title.trim()).length;
  if (running) return { total, checked: 0, cached: 0, stopped: true, risky: [] };
  running = true;
  try {
    const cache = loadCheckCache();
    let checked = 0;
    let cached = 0;
    let stopped = false;
    const seen = new Set<string>();
    for (const song of opts.songs) {
      if (!song || typeof song.title !== "string" || !song.title.trim()) continue;
      const key = songKey(song);
      if (seen.has(key)) {
        cached++;
        continue;
      }
      seen.add(key);
      if (cache[key]) {
        cached++;
        continue;
      }
      let result: LookupResult | undefined;
      for (let wait = 60_000; !result; wait = Math.min(wait * 2, 600_000)) {
        // Never during a stream: wait out the song, then look.
        while (opts.isPlaying?.() && !stop()) await sleep(poll);
        if (stop()) break;
        const r = await lookup(song);
        // A throttled miss isn't a real answer: wait and ask again, longer each time.
        if (!r.throttled) result = r;
        else await sleep(wait);
      }
      if (!result) {
        stopped = true;
        break;
      }
      cache[key] = { title: song.title, artist: song.artist ?? "", article: result.article, why: riskReason(song, result), checkedAt: now().toISOString() };
      saveCheckCache(cache);
      checked++;
      opts.onProgress?.(checked + cached, total);
      await sleep(pace);
    }
    return { total, checked, cached, stopped, risky: riskySongs(cache, opts.songs) };
  } finally {
    running = false;
  }
}
