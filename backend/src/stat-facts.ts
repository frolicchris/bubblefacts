import { escapeRe } from "./text";
import { SSLQueueItem } from "./types";

/**
 * Facts built from the queue entry itself: the streamer's note, play count,
 * last played, requesters. True by construction, and the only
 * song-specific facts available for originals and songs with no article.
 */

/** Notes that add nothing beyond the "original composition" line. */
const GENERIC_NOTE = /^(original(\s+composition)?|improvised(\s+piece)?|own\s+composition)\.?$/i;
/** "Originals" or "Jane's Originals", but not "Original Soundtrack". */
const ORIGINALS_ATTRIBUTE = /\boriginals\b|^\s*original\s*$/i;
const MAX_NOTE_CHARS = 120;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Credited to the streamer: the artist field is one of their names, or
 * contains "@name". A bare name inside a longer credit doesn't count;
 * streamer "Joe" doesn't own "Joe Hisaishi".
 */
export function creditedToStreamer(entry: SSLQueueItem | null, names: string[]): boolean {
  const artist = (entry?.song?.artist ?? "").trim().toLowerCase();
  return names.some((n) => {
    const name = n.trim().toLowerCase();
    return Boolean(name) && (artist === name || new RegExp(`@${escapeRe(name)}\\b`).test(artist));
  });
}

/**
 * "Jane's Originals" names Jane: it counts only when "Jane" is exactly one of
 * the streamer's configured names. No prefix matching: "Christina's
 * Originals" isn't Chris's.
 */
function tagNamesStreamer(tag: string, names: string[]): boolean {
  const owner = /^\s*(.+?)['’]s?\s+originals\b/i.exec(tag)?.[1]?.trim().toLowerCase();
  if (!owner || /^(my|our)$/.test(owner)) return true;
  return names.some((n) => n.trim().toLowerCase() === owner);
}

/**
 * The streamer's own song: tagged "Originals" (or "<their name>'s
 * Originals"), or credited to them. A tag naming someone else ("Jane's
 * Originals" on Chris's list) is another streamer's original, played as a
 * cover: it gets no authorship claims.
 */
export function isOriginal(entry: SSLQueueItem | null, names: string[]): boolean {
  if (!entry) return false;
  const tags = (entry.song?.attributes ?? []).map((a) => a?.name ?? "").filter((t) => ORIGINALS_ATTRIBUTE.test(t));
  if (tags.some((t) => tagNamesStreamer(t, names))) return true;
  return creditedToStreamer(entry, names);
}

/**
 * The streamer's own piece, so their notes about their compositions go with
 * it: only when the artist is one of their names (channel name, or the name
 * they gave in Settings). A tag isn't enough: streamers tag friends' pieces
 * "Originals" too, and those must never carry the streamer's own notes.
 */
export function isOwnOriginal(entry: SSLQueueItem | null, names: string[]): boolean {
  return creditedToStreamer(entry, names);
}

/** Drop a leading "Artist:" that repeats the artist field. */
export function cleanTitle(title: string, artist?: string | null): string {
  const t = title.trim();
  const prefix = artist ? `${artist.trim()}:` : "";
  return prefix && t.toLowerCase().startsWith(prefix.toLowerCase()) ? t.slice(prefix.length).trim() : t;
}

/** Each fact is emitted only when its field is present; the API often returns nulls. */
export function buildStatFacts(
  entry: SSLQueueItem | null,
  opts: { streamerName: string; isOriginalSong?: boolean; names?: string[] }
): string[] {
  if (!entry) return [];
  const facts: string[] = [];
  const song = entry.song;
  const display = cleanTitle(entry.nonlistSong || song.title || "", song.artist);
  const who = opts.streamerName;

  const note = (song.comment ?? entry.note ?? "").trim();
  if (note.length > 3 && !GENERIC_NOTE.test(note)) {
    facts.push(note.length <= MAX_NOTE_CHARS ? note : `${note.slice(0, MAX_NOTE_CHARS - 3)}…`);
  }

  if (opts.isOriginalSong) {
    // Only the song list's artist field names a writer; a tag alone never does.
    // A missing or "Unknown" credit stays unknown: no writer is named or implied.
    const credit = (song.artist ?? "").trim();
    const known = Boolean(credit) && !/^unknown$/i.test(credit);
    if (known && creditedToStreamer(entry, [who, ...(opts.names ?? [])])) {
      facts.push(`"${display}" is an original composition by ${credit.replace(/\s*@\S+/, "")}.`);
      facts.push("You're hearing this one straight from the person who wrote it.");
    } else if (known) {
      facts.push(`"${display}" is an original, credited to ${credit}.`);
    }
  }

  const played = song.timesPlayed;
  if (played === 0) {
    facts.push(`First time on stream — you're hearing the debut of "${display}".`);
  } else if (typeof played === "number" && played > 0) {
    facts.push(`${who} has played "${display}" ${played} ${plural(played, "time", "times")} on stream.`);
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
