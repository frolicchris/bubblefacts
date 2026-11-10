import type { SongSource } from "./song-source";

/** "15 seconds", or "second" for one; rounded up, never promising faster than it checks */
function every(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds === 1 ? "second" : `${seconds} seconds`;
}

/** The dashboard's line on how songs are heard: live with events connected, else the real poll interval (a file is always polled) */
export function listeningLine(source: Pick<SongSource, "name" | "isEventStreamConnected" | "pollIntervalMs">): string {
  const what = source.name === "StreamerSongList" ? "queue" : source.name === "StreamElements" ? "song requests" : "file";
  if (what !== "file" && source.isEventStreamConnected()) return `Hearing your ${what} live`;
  return `Checking your ${what === "queue" ? "list" : what} every ${every(source.pollIntervalMs())}`;
}

/** "Facts took 45 s" for the dashboard (#314), or "" when the AI wrote nothing for this song */
export function factsTookLine(ms: number | null): string {
  return ms === null ? "" : `Facts took ${Math.max(1, Math.round(ms / 1000))} s`;
}
