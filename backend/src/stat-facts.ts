import { SSLQueueItem } from "./types";

/**
 * Facts built from the queue entry itself: the streamer's note, play count,
 * last played, duration, requesters. True by construction, and the only
 * song-specific facts available for originals and songs with no article.
 */

/** Notes that add nothing beyond the "original composition" line. */
const GENERIC_NOTE = /^(original(\s+composition)?|improvised(\s+piece)?|own\s+composition)\.?$/i;
const ORIGINALS_ATTRIBUTE = /original/i;
const MAX_NOTE_CHARS = 120;
const STALE_AFTER_DAYS = 14;
const DAY_MS = 86_400_000;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Tagged with an "original" attribute, or credited to the streamer. */
export function isOriginal(entry: SSLQueueItem | null, streamerName: string): boolean {
  if (!entry) return false;
  if (entry.song?.attributes?.some((a) => a?.name && ORIGINALS_ATTRIBUTE.test(a.name))) return true;
  return (entry.song?.artist ?? "").toLowerCase().includes(streamerName.toLowerCase());
}

/** Drop a leading "Artist:" that repeats the artist field. */
export function cleanTitle(title: string, artist?: string | null): string {
  const t = title.trim();
  const prefix = artist ? `${artist.trim()}:` : "";
  return prefix && t.toLowerCase().startsWith(prefix.toLowerCase()) ? t.slice(prefix.length).trim() : t;
}

function daysSince(iso: string): number | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const days = Math.floor((Date.now() - then) / DAY_MS);
  return days >= 0 ? days : null;
}

/** Each fact is emitted only when its field is present; the API often returns nulls. */
export function buildStatFacts(
  entry: SSLQueueItem | null,
  opts: { streamerName: string; isOriginalSong?: boolean }
): string[] {
  if (!entry) return [];
  const facts: string[] = [];
  const song = entry.song ?? ({} as SSLQueueItem["song"]);
  const display = cleanTitle(entry.nonlistSong || song.title || "", song.artist);
  const who = opts.streamerName;

  const note = (song.comment ?? entry.note ?? "").trim();
  if (note.length > 3 && !GENERIC_NOTE.test(note)) {
    facts.push(note.length <= MAX_NOTE_CHARS ? note : `${note.slice(0, MAX_NOTE_CHARS - 3)}…`);
  }

  if (opts.isOriginalSong) {
    facts.push(`"${display}" is an original composition by ${(song.artist ?? "").trim() || who}.`);
    facts.push("You're hearing this one straight from the person who wrote it.");
  }

  const played = song.timesPlayed;
  if (played === 0) {
    facts.push(`First time on stream — you're hearing the debut of "${display}".`);
  } else if (typeof played === "number" && played > 0) {
    facts.push(`${who} has played "${display}" ${played} ${plural(played, "time", "times")} on stream.`);
  }

  const days = song.lastPlayed ? daysSince(song.lastPlayed) : null;
  if (days !== null && days >= STALE_AFTER_DAYS) facts.push(`This one hasn't come up in ${days} days.`);

  const dur = song.durationSeconds ?? song.duration;
  if (typeof dur === "number" && dur >= 30 && dur <= 3600) {
    facts.push(`Runs about ${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}.`);
  }

  const requesters = (entry.requests ?? []).map((r) => r?.name?.trim()).filter((n): n is string => Boolean(n));
  if (requesters.length === 1) {
    facts.push(`Requested by ${requesters[0]}.`);
  } else if (requesters.length > 1) {
    const others = requesters.length - 1;
    facts.push(`Requested by ${requesters[0]} and ${others} ${plural(others, "other", "others")}.`);
  }

  return facts;
}
