import type { SongSource } from "./song-source";

/** "15 seconds", or "second" for one: rounded up, so it never promises faster than it checks. */
function every(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds === 1 ? "second" : `${seconds} seconds`;
}

/**
 * One short line for the dashboard on how BubbleFacts hears about songs, in
 * a musician's words: live when the service's change notices are connected,
 * otherwise by looking every so often (the real interval). A now playing
 * file has no notices; it is only ever looked at.
 */
export function listeningLine(source: Pick<SongSource, "name" | "isEventStreamConnected" | "pollIntervalMs">): string {
  const what = source.name === "StreamerSongList" ? "queue" : source.name === "StreamElements" ? "song requests" : "file";
  if (what !== "file" && source.isEventStreamConnected()) return `Hearing your ${what} live`;
  return `Checking your ${what === "queue" ? "list" : what} every ${every(source.pollIntervalMs())}`;
}

/** "Facts took 45 s" for the dashboard (issue #314), or nothing when the AI wrote nothing for this song. */
export function factsTookLine(ms: number | null): string {
  return ms === null ? "" : `Facts took ${Math.max(1, Math.round(ms / 1000))} s`;
}
