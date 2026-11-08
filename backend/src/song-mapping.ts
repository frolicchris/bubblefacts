import { config } from "./config";
import { SSLQueueItem, SSLSong } from "./types";
import { cleanRequestText, withoutRequestCredit } from "./text";

// A queue entry read the way the fact pipeline needs it; every song source maps its entries with these

/** The title without who asked or paid ("Some Song (requested by Name)"): a viewer's name goes no further */
export function displayTitle(item: SSLQueueItem): string {
  return withoutRequestCredit(cleanRequestText(item.nonlistTitle?.trim() || item.nonlistSong || item.song?.title || "")) || "Unknown";
}

/** An off-list request: the API sets `nonlistSong`, or the newer `nonlistTitle`, to the typed-in title */
export function isLiveLearn(item: SSLQueueItem): boolean {
  return Boolean(item.nonlistSong?.trim() || item.nonlistTitle?.trim());
}

export function requesterName(item: SSLQueueItem): string | undefined {
  const r = item.requests?.[0];
  return cleanRequestText(r?.name || r?.user?.username || "") || undefined;
}

/** The song object broadcast to the overlay */
export function toSong(item: SSLQueueItem): SSLSong {
  const song: SSLSong = {
    title: displayTitle(item),
    // "Some Band, Commissioned by Name" is Some Band's: the credit goes, as from the title
    artist: withoutRequestCredit(cleanRequestText((isLiveLearn(item) && item.nonlistArtist?.trim()) || item.song?.artist || ""), true) || "Unknown",
  };
  if (isLiveLearn(item) && config.liveLearns) song.liveLearn = true;
  const by = requesterName(item);
  if (by) song.requestedBy = by;
  if (typeof item.songId === "number" && item.songId > 0) song.songId = item.songId;
  return song;
}
