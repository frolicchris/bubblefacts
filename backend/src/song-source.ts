import { SSLQueueItem, SSLSong } from "./types";

/**
 * Where the server learns what's playing. StreamerSongList is the default;
 * StreamElements' song request player is the other choice (SONG_SOURCE).
 *
 * Every source hands the server a queue entry in StreamerSongList's shape,
 * because that's what the fact pipeline reads (title, artist field,
 * requester, duration). A source that has less to say leaves fields empty.
 */
export interface SongSource {
  /** For logs, /health and the desktop app: "StreamerSongList" or "StreamElements". */
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): void;
  onCurrentSongChange(callback: (current: SSLQueueItem | null) => void): void;
  getCurrentSong(): SSLQueueItem | null;
  /** The song as the overlay shows it. */
  toSong(item: SSLQueueItem): SSLSong;
  displayTitle(item: SSLQueueItem): string;
  lastSuccessfulFetchAgeMs(): number | null;
  /** How often the source is polled right now; health allows three misses. */
  pollIntervalMs(): number;
  isEventStreamConnected(): boolean;
  /** The service turned the token down on the last request: waiting won't fix it. */
  authRejected(): boolean;
  /** Why no song is followed although the service says one is playing, or null. Optional. */
  followingProblem?(): string | null;
}
