import { config } from "./config";
import { SSLQueueItem, SSLSong } from "./types";
import { cleanRequestText, withoutRequestCredit } from "./text";

/**
 * Reading a queue entry the way the fact pipeline needs it. Every song
 * source hands over entries in StreamerSongList's shape (see song-source.ts),
 * so the StreamerSongList, StreamElements and now playing file clients all
 * map them with these.
 */

/**
 * The title, without a note naming who asked or paid for the song ("Some Song (requested by
 * Name)"): from here on, a viewer's name is never searched, sent to the AI, logged or shown.
 */
export function displayTitle(item: SSLQueueItem): string {
  return withoutRequestCredit(cleanRequestText(item.nonlistTitle?.trim() || item.nonlistSong || item.song?.title || "")) || "Unknown";
}

/** An off-list request: the API sets `nonlistSong`, or the newer `nonlistTitle`, to the typed-in title. */
export function isLiveLearn(item: SSLQueueItem): boolean {
  return Boolean(item.nonlistSong?.trim() || item.nonlistTitle?.trim());
}

export function requesterName(item: SSLQueueItem): string | undefined {
  const r = item.requests?.[0];
  return cleanRequestText(r?.name || r?.user?.username || "") || undefined;
}

/** The song object broadcast to the overlay. */
export function toSong(item: SSLQueueItem): SSLSong {
  const song: SSLSong = {
    title: displayTitle(item),
    // "Some Band, Commissioned by Name" is Some Band's: who commissioned it goes, as from the title.
    artist: withoutRequestCredit(cleanRequestText((isLiveLearn(item) && item.nonlistArtist?.trim()) || item.song?.artist || ""), true) || "Unknown",
  };
  if (isLiveLearn(item) && config.liveLearns) song.liveLearn = true;
  const by = requesterName(item);
  if (by) song.requestedBy = by;
  if (typeof item.songId === "number" && item.songId > 0) song.songId = item.songId;
  return song;
}
