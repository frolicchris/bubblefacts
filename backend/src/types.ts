/** A song identified for fact generation */
export interface SSLSong {
  title: string;
  artist: string;
  /**
   * True for a Live Learn: a request that is not on the song list. The
   * rebuilt API marks these with `nonlistSong` set (the typed-in title) and
   * `songId: null` on the queue entry. Never grounded, never gets facts.
   */
  liveLearn?: boolean;
  /** Display name of the first requester, when the entry carries one. */
  requestedBy?: string;
}

/**
 * A song as embedded in a queue entry (new API schema: `QueueSong`).
 * Note there is no `id` here — the song's own id lives on the entry as
 * `songId`, and is null for off-list ("nonlist") requests.
 */
export interface SSLQueueSong {
  title: string;
  artist: string;
  comment?: string | null;
  duration?: number | null;
  /** What the live API actually returns on the embedded song. */
  durationSeconds?: number | null;
  timesPlayed?: number;
  lastPlayed?: string | null;
  attributes?: Array<{ name?: string }> | null;
}

/** Who requested a queue entry (new API schema: `Request`). */
export interface SSLRequest {
  id: number;
  name: string;
  source?: string;
  user?: { username: string; platform: string };
}

/**
 * A queue entry. Covers both `QueueDetails` (entries in `items`) and
 * `NowPlayingDetails` (the `playing` slot) — they differ only in that
 * queued entries carry `position` and the now-playing entry carries
 * `nowPlayingStartedAt`.
 *
 * `comment` from the old API is now `note`.
 */
export interface SSLQueueItem {
  id: number;
  songId: number | null;
  song: SSLQueueSong;
  nonlistSong: string | null;
  note: string | null;
  streamerId: number;
  createdAt: string;
  requests: SSLRequest[] | null;
  /** Queued entries only. */
  position?: number;
  /** Now-playing entry only. */
  nowPlayingStartedAt?: string | null;
}

/** `GET /queue` response (new API schema: `QueueResponseBody`). */
export interface SSLQueueResponse {
  items: SSLQueueItem[] | null;
  /** The dedicated now-playing slot. Null when nothing is playing. */
  playing?: SSLQueueItem | null;
  total: number;
}

/**
 * `GET /streamers` response. The full `StreamerDetails` schema is large;
 * we only depend on these fields.
 */
export interface SSLStreamerInfo {
  id: number;
  requestsActive: boolean;
  /** Whether the streamer auto-promotes the #1 queued song when one ends. */
  promoteQueueToPlaying?: boolean;
}

/** A single pop-up fact bubble */
export interface PopUpFact {
  id: string;
  text: string;
  appearAtSecond: number;
  durationSeconds: number;
  position: {
    top: string;   // CSS percentage, e.g. "20%"
    left: string;  // CSS percentage, e.g. "35%"
  };
}

/** The payload sent over the WebSocket to the overlay */
export interface FactsPayload {
  type: "new_song" | "facts_ready" | "clear";
  song?: SSLSong;
  facts?: PopUpFact[];
}

