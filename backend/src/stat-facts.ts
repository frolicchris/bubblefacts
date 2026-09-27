import { SSLQueueItem } from "./types";
import { topic } from "./topic";

/**
 * Facts built from the StreamerSongList entry itself.
 *
 * Every `GET /queue` already returns play counts, the streamer's own comment,
 * duration, attributes and requester names — and all three construction sites
 * were throwing them away, reducing the entry to `{title, artist}`.
 *
 * These matter most for the case grounding cannot serve at all. The streamer's own
 * compositions have no Wikipedia article and never will, so before this the
 * only option was CURATED_FACTS — Zelda and Tetris trivia over an original
 * piano piece. The entry's own data is song-specific AND deterministically
 * true, with no model call and nothing to screen.
 *
 * Attribution note: these are facts about the performance, not the work, so
 * they read as "what's happening on this stream" rather than trivia. That is
 * the right register for a request-driven music stream.
 */

/**
 * Notes that carry no information beyond what the originals lines already
 * state. Anything more specific ("Jazz standard arrangement") is kept.
 */
const GENERIC_NOTE = /^(original(\s+composition)?|improvised(\s+piece)?|own\s+composition)\.?$/i;

/** Attribute the streamer tags their own compositions with. */
const ORIGINALS_ATTRIBUTE = /original/i;

/**
 * Is this the streamer's own composition?
 *
 * Driven by the song's attributes rather than a hardcoded title list, so
 * adding a new original to the song list is enough — no code change. The
 * attribute is authoritative; the artist name is a weaker fallback for
 * entries that predate the tag.
 */
export function isOriginal(entry: SSLQueueItem | null, streamerName: string): boolean {
  if (!entry) return false;

  const attrs = entry.song?.attributes ?? [];
  if (attrs.some((a) => a?.name && ORIGINALS_ATTRIBUTE.test(a.name))) return true;

  const artist = entry.song?.artist ?? "";
  return artist.toLowerCase().includes(streamerName.toLowerCase());
}

/**
 * Song lists often repeat the artist inside the title
 * ("Jane Composer: Laura's Wedding"). Showing that on screen under a
 * banner that already names the artist reads as a stutter.
 */
export function cleanTitle(title: string, artist?: string | null): string {
  if (!artist) return title.trim();
  const prefix = `${artist.trim()}:`;
  const t = title.trim();
  return t.toLowerCase().startsWith(prefix.toLowerCase())
    ? t.slice(prefix.length).trim()
    : t;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Build deterministic facts from a queue entry.
 *
 * Every line is gated on its field actually being present — the API returns
 * null for `durationSeconds` on plenty of entries, and a fact reading
 * "runs null minutes" is worse than one fewer fact.
 */
export function buildStatFacts(
  entry: SSLQueueItem | null,
  opts: { streamerName: string; isOriginalSong?: boolean }
): string[] {
  if (!entry) return [];

  const facts: string[] = [];
  const song = entry.song ?? ({} as SSLQueueItem["song"]);
  const display = cleanTitle(entry.nonlistSong || song.title || "", song.artist);
  const who = opts.streamerName;

  // Prefer the credited artist name over the channel handle: "an original by
  // Jane Composer" reads better under a banner than "by janestreams".
  const composer = (song.artist ?? "").trim() || who;

  // The streamer's own note. Their words beat anything generated — but the
  // boilerplate ones ("Original composition") only restate what the next
  // line says properly, and two near-identical bubbles look like a bug.
  const note = (song.comment ?? entry.note ?? "").trim();
  if (note && note.length > 3 && !GENERIC_NOTE.test(note)) {
    facts.push(note.length <= 120 ? note : `${note.slice(0, 117)}…`);
  }

  if (opts.isOriginalSong) {
    facts.push(`"${display}" is an original composition by ${composer}.`);
    facts.push(`You're hearing this one straight from the person who wrote it.`);
  }

  const played = song.timesPlayed;
  if (typeof played === "number") {
    if (played === 0) {
      facts.push(`First time on stream — you're hearing the debut of "${display}".`);
    } else if (played >= 1) {
      facts.push(
        `${who} has played "${display}" ${played} ${plural(played, "time", "times")} on stream.`
      );
    }
  }

  if (song.lastPlayed) {
    const days = daysSince(song.lastPlayed);
    if (days !== null && days >= 14) {
      facts.push(`This one hasn't come up in ${days} days.`);
    }
  }

  const dur = song.durationSeconds ?? song.duration;
  if (typeof dur === "number" && dur >= 30 && dur <= 3600) {
    const mins = Math.floor(dur / 60);
    const secs = dur % 60;
    facts.push(`Runs about ${mins}:${String(secs).padStart(2, "0")}.`);
  }

  const requesters = (entry.requests ?? [])
    .map((r) => r?.name)
    .filter((n): n is string => Boolean(n && n.trim()));
  if (requesters.length === 1) {
    facts.push(`Requested by ${requesters[0]}.`);
  } else if (requesters.length > 1) {
    facts.push(`Requested by ${requesters[0]} and ${requesters.length - 1} others.`);
  }

  return facts;
}

function daysSince(iso: string): number | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  return days >= 0 ? days : null;
}

/**
 * Hand-written facts about the originals as a body of work. Used to top up
 * when the entry alone doesn't yield enough, so an original never falls
 * through to game trivia.
 */
/**
 * Hand-written facts about the originals as a body of work, from the topic
 * pack. Used to top up when the entry alone doesn't yield enough, so an
 * original never falls through to unrelated trivia.
 */
export const ORIGINALS_FACTS: string[] = topic.originalsFacts;
