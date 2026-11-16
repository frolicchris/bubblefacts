import { SSLQueueItem, SSLSong } from "./types";
import type { ListedSong, ListSong } from "./song-search";

/**
 * Where the server learns what's playing (SONG_SOURCE): StreamerSongList, StreamElements or a now playing file
 * Each hands over a queue entry in StreamerSongList's shape, leaving empty what it doesn't know
 */
export interface SongSource {
  /** For logs, /health and the app: "StreamerSongList", "StreamElements", "Streamling" or "Now playing file" */
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): void;
  onCurrentSongChange(callback: (current: SSLQueueItem | null) => void): void;
  getCurrentSong(): SSLQueueItem | null;
  /** The song as the overlay shows it */
  toSong(item: SSLQueueItem): SSLSong;
  displayTitle(item: SSLQueueItem): string;
  lastSuccessfulFetchAgeMs(): number | null;
  /** ms since the poll loop last tried, worked or not (null: not started); only a stuck loop lets it grow */
  lastPollAttemptAgeMs?(): number | null;
  /** ms between polls right now; health allows three misses */
  pollIntervalMs(): number;
  isEventStreamConnected(): boolean;
  /** The service turned the token down on the last request: waiting won't fix it */
  authRejected(): boolean;
  /** The service asked us to wait (Retry-After), so a quiet spell isn't stale */
  backingOff?(): boolean;
  /** Why no song is followed although the service says one is playing, or null */
  followingProblem?(): string | null;
  /** List songs matching what was typed, for the song facts editor; sources with a list only */
  searchSongs?(query: string, limit: number): ListSong[] | null;
  /** Every list song with its play count, for preparing (#293); null until read; sources with a list only */
  listedSongs?(): ListedSong[] | null;
}
